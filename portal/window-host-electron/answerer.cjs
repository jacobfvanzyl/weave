const { app, BrowserWindow, ipcMain } = require('electron');
const readline = require('node:readline');

let answerWindow;

const writeJsonLine = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const isRecord = (value) => Boolean(value && typeof value === 'object');

const optionalString = (value) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const stringifyError = (error) => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error.trim();
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const createWindow = async () => {
  if (answerWindow && !answerWindow.isDestroyed()) return answerWindow;
  await app.whenReady();
  answerWindow = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: false,
      nodeIntegration: true,
    },
  });
  answerWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) process.stderr.write(`[window-answerer] renderer: ${message}\n`);
  });
  await answerWindow.loadURL('data:text/html,<html><body></body></html>');
  return answerWindow;
};

const callRenderer = async (method, payload) => {
  const win = await createWindow();
  const source = `
    (async () => {
      const input = ${JSON.stringify(payload)};
      const method = ${JSON.stringify(method)};
      const { ipcRenderer } = require('electron');
      window.__weaveAnswererSessions = window.__weaveAnswererSessions || new Map();
      const sanitizeOffer = (offer) => ({
        ...offer,
        sdp: offer.sdp
          .split(/\\r\\n|\\n/)
          .filter((line) => line && !line.startsWith('a=max-message-size:'))
          .join('\\r\\n') + '\\r\\n',
      });
      if (method === 'answer.create') {
        const sessionId = input.sessionId || 'answerer';
        const offer = input.sanitizeOffer ? sanitizeOffer(input.offer) : input.offer;
        const peerConnection = new RTCPeerConnection({ iceServers: [] });
        const previous = window.__weaveAnswererSessions.get(sessionId);
        previous?.peerConnection?.close?.();

        peerConnection.ontrack = () => {};
        peerConnection.onicecandidate = event => {
          ipcRenderer.send('window-answerer:event', {
            sessionId,
            event: {
              type: 'ice-candidate',
              candidate: event.candidate?.toJSON?.() ?? null,
            },
          });
        };
        peerConnection.ondatachannel = event => {
          if (event.channel.label !== 'control') return;
          event.channel.onopen = () => {
            ipcRenderer.send('window-answerer:event', { sessionId, event: { type: 'control-open' } });
          };
          event.channel.onmessage = message => {
            ipcRenderer.send('window-answerer:event', {
              sessionId,
              event: { type: 'control-message', data: String(message.data ?? '') },
            });
          };
        };
        await peerConnection.setRemoteDescription(offer);
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        await new Promise((resolve) => {
          if (peerConnection.iceGatheringState === 'complete') {
            resolve();
            return;
          }
          peerConnection.onicegatheringstatechange = () => {
            if (peerConnection.iceGatheringState === 'complete') resolve();
          };
        });
        window.__weaveAnswererSessions.set(sessionId, { peerConnection });
        return { type: 'answer', sdp: peerConnection.localDescription.sdp };
      }

      if (method === 'candidate.add') {
        const session = window.__weaveAnswererSessions.get(input.sessionId || 'answerer');
        if (!session) return { added: false };
        if (input.candidate?.candidate) {
          await session.peerConnection.addIceCandidate(input.candidate);
        }
        return { added: true };
      }

      if (method === 'session.close') {
        const session = window.__weaveAnswererSessions.get(input.sessionId || 'answerer');
        session?.peerConnection?.close?.();
        window.__weaveAnswererSessions.delete(input.sessionId || 'answerer');
        return { closed: true };
      }

      throw new Error('Unsupported renderer method: ' + method);
    })()
  `;
  return await win.webContents.executeJavaScript(source, true);
};

const reply = (id, ok = true, fields = {}) => {
  if (!id) return;
  writeJsonLine({ id, ok, ...fields });
};

const handleMessage = async (message) => {
  const id = optionalString(message.id);
  const type = optionalString(message.type);
  try {
    if (type === 'answer.create') {
      if (!isRecord(message.offer) || message.offer.type !== 'offer' || typeof message.offer.sdp !== 'string') {
        throw new Error('Offer SDP is required.');
      }
      const answer = await callRenderer('answer.create', {
        sessionId: optionalString(message.sessionId),
        offer: message.offer,
        sanitizeOffer: message.sanitizeOffer !== false,
      });
      reply(id, true, { answer });
      return;
    }
    if (type === 'candidate.add') {
      await callRenderer('candidate.add', {
        sessionId: optionalString(message.sessionId),
        candidate: message.candidate,
      });
      reply(id);
      return;
    }
    if (type === 'session.close') {
      await callRenderer('session.close', { sessionId: optionalString(message.sessionId) });
      reply(id);
      return;
    }
    if (type === 'shutdown') {
      reply(id);
      app.quit();
      return;
    }
    throw new Error('Unsupported command.');
  } catch (error) {
    reply(id, false, { error: stringifyError(error) });
  }
};

const startCommandLoop = () => {
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      process.stderr.write(`[window-answerer] invalid json: ${trimmed}\n`);
      return;
    }
    void handleMessage(message);
  });
  lines.on('close', () => {
    app.quit();
  });
};

ipcMain.on('noop', () => {});
ipcMain.on('window-answerer:event', (_event, payload) => {
  if (!isRecord(payload)) return;
  writeJsonLine({
    type: 'session.event',
    sessionId: optionalString(payload.sessionId) ?? 'answerer',
    event: isRecord(payload.event) ? payload.event : {},
  });
});

app.whenReady().then(startCommandLoop).catch((error) => {
  process.stderr.write(`[window-answerer] startup failed: ${stringifyError(error)}\n`);
  process.exit(1);
});
