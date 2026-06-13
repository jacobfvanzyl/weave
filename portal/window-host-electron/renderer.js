const { ipcRenderer } = require('electron');

let currentSession;
let pendingFrame;

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
  currentSession.canvas?.remove?.();
  const sessionId = currentSession.sessionId;
  currentSession = undefined;
  pendingFrame = undefined;
  sendEvent(sessionId, { type: 'stopped' });
};

const assertSession = (sessionId) => {
  if (!currentSession || currentSession.sessionId !== sessionId) {
    throw new Error(`No active window stream session: ${sessionId}`);
  }
  return currentSession;
};

const createElectronCaptureStream = async (sourceId, frameRate = 30) => {
  return await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxFrameRate: frameRate,
      },
    },
  });
};

const createCanvasCaptureStream = (frameRate = 20) => {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  canvas.style.display = 'none';
  document.body.appendChild(canvas);
  const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
  if (!context) throw new Error('Could not create ScreenCaptureKit canvas context.');
  context.fillStyle = '#000';
  context.fillRect(0, 0, canvas.width, canvas.height);
  return {
    canvas,
    context,
    stream: canvas.captureStream(frameRate),
  };
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
    const backend = input.backend === 'screencapturekit' ? 'screencapturekit' : 'electron';
    const frameRate = input.frameRate ?? (backend === 'screencapturekit' ? 20 : 30);
    const canvasCapture = backend === 'screencapturekit'
      ? createCanvasCaptureStream(frameRate)
      : undefined;
    const stream = canvasCapture?.stream ?? await createElectronCaptureStream(input.sourceId, frameRate);
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

    currentSession = {
      sessionId,
      backend,
      stream,
      peerConnection,
      controlChannel,
      canvas: canvasCapture?.canvas,
      context: canvasCapture?.context,
      drawingFrame: false,
      drawnFrames: 0,
    };

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

const drawCaptureFrame = async (header, payload) => {
  const session = currentSession;
  if (!session || session.backend !== 'screencapturekit') return;
  if (header.sessionId !== session.sessionId) return;
  if (!session.canvas || !session.context) return;

  if (session.drawingFrame) {
    pendingFrame = { header, payload };
    return;
  }

  session.drawingFrame = true;
  try {
    let nextHeader = header;
    let nextPayload = payload;
    do {
      pendingFrame = undefined;
      const blob = new Blob([nextPayload], { type: 'image/jpeg' });
      const image = await createImageBitmap(blob);
      if (session.canvas.width !== image.width || session.canvas.height !== image.height) {
        session.canvas.width = image.width;
        session.canvas.height = image.height;
      }
      session.context.drawImage(image, 0, 0, session.canvas.width, session.canvas.height);
      image.close?.();
      session.drawnFrames += 1;
      if (session.drawnFrames === 1 || session.drawnFrames % 120 === 0) {
        log(`screencapturekit frame: session=${session.sessionId} frames=${session.drawnFrames} size=${session.canvas.width}x${session.canvas.height}`);
      }
      nextHeader = pendingFrame?.header;
      nextPayload = pendingFrame?.payload;
    } while (nextHeader && nextPayload && currentSession === session);
  } catch (error) {
    log(`screencapturekit frame draw failed: ${toErrorMessage(error)}`);
  } finally {
    if (currentSession === session) session.drawingFrame = false;
  }
};

ipcRenderer.on('window-host:capture-frame', (_event, header, payload) => {
  void drawCaptureFrame(header, payload);
});

window.addEventListener('error', (event) => {
  log(`renderer error: ${toErrorMessage(event.error ?? event.message)}`);
});

window.addEventListener('unhandledrejection', (event) => {
  log(`renderer rejection: ${toErrorMessage(event.reason)}`);
});
