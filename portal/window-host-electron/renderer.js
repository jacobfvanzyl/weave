const { ipcRenderer } = require('electron');

let currentSession;

const isRecord = (value) => Boolean(value && typeof value === 'object');

const optionalString = (value) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const toErrorMessage = (error) => {
  if (error instanceof Error && error.message) return error.message;
  const direct = optionalString(error);
  if (direct) return direct;
  if (isRecord(error)) {
    const nested = optionalString(error.message) ?? optionalString(error.error) ?? optionalString(error.reason);
    if (nested) return nested;
    try {
      return JSON.stringify(error);
    } catch {
      // Fall through to String().
    }
  }
  return String(error);
};

const sendEvent = (sessionId, event) => {
  ipcRenderer.send('window-host:event', { sessionId, event });
};

const log = (message) => {
  ipcRenderer.send('window-host:log', message);
};

const closeCurrentSession = () => {
  if (!currentSession) return;
  for (const track of currentSession.stream?.getTracks?.() ?? []) {
    track.stop();
  }
  currentSession.controlChannel?.close();
  currentSession.peerConnection?.close();
  const sessionId = currentSession.sessionId;
  currentSession = undefined;
  sendEvent(sessionId, { type: 'stopped' });
};

const assertSession = (sessionId) => {
  if (!currentSession || currentSession.sessionId !== sessionId) {
    throw new Error(`No active window stream session: ${sessionId}`);
  }
  return currentSession;
};

const createCaptureStream = async (sourceId) => {
  return await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxFrameRate: 30,
      },
    },
  });
};

const normalizeRemoteDescription = (description) => {
  if (!description?.sdp) return description;
  const sdp = description.sdp.replace(/\r\n|\n/g, '\r\n');
  return {
    ...description,
    sdp: sdp.endsWith('\r\n') ? sdp : `${sdp}\r\n`,
  };
};

window.weaveWindowHost = {
  async startSession(input) {
    closeCurrentSession();

    const sessionId = input.sessionId;
    const stream = await createCaptureStream(input.sourceId);
    const peerConnection = new RTCPeerConnection({
      iceServers: Array.isArray(input.iceServers) ? input.iceServers : [],
    });
    const controlChannel = peerConnection.createDataChannel('control', { ordered: true });

    controlChannel.onopen = () => {
      log(`control channel open: ${sessionId}`);
    };
    controlChannel.onmessage = (event) => {
      let type = 'unknown';
      try {
        const payload = JSON.parse(String(event.data));
        type = typeof payload.type === 'string' ? payload.type : type;
      } catch {
        type = 'invalid-json';
      }
      ipcRenderer.send('window-host:control', { sessionId, type });
    };
    controlChannel.onerror = () => {
      log(`control channel error: ${sessionId}`);
    };

    peerConnection.onicecandidate = (event) => {
      sendEvent(sessionId, {
        type: 'ice-candidate',
        candidate: event.candidate?.toJSON?.() ?? null,
      });
    };
    peerConnection.onconnectionstatechange = () => {
      log(`peer connection ${sessionId}: ${peerConnection.connectionState}`);
    };

    for (const track of stream.getTracks()) {
      peerConnection.addTrack(track, stream);
    }

    currentSession = { sessionId, stream, peerConnection, controlChannel };

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    return {
      type: 'offer',
      sdp: peerConnection.localDescription?.sdp ?? offer.sdp,
    };
  },

  async applyAnswer(input) {
    const session = assertSession(input.sessionId);
    if (!input.answer || input.answer.type !== 'answer' || typeof input.answer.sdp !== 'string') {
      throw new Error('Answer SDP is required.');
    }
    await session.peerConnection.setRemoteDescription(normalizeRemoteDescription(input.answer));
    sendEvent(input.sessionId, { type: 'started' });
  },

  async addIceCandidate(input) {
    const session = assertSession(input.sessionId);
    const candidate = input.candidate;
    if (!candidate || !candidate.candidate) return;
    await session.peerConnection.addIceCandidate(candidate);
  },

  async stopSession(input) {
    if (!currentSession || currentSession.sessionId !== input.sessionId) return;
    closeCurrentSession();
  },
};

window.addEventListener('error', (event) => {
  log(`renderer error: ${toErrorMessage(event.error ?? event.message)}`);
});

window.addEventListener('unhandledrejection', (event) => {
  log(`renderer rejection: ${toErrorMessage(event.reason)}`);
});
