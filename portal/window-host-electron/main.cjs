const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const textEncoder = new TextEncoder();
let mainWindow;
let activeSessionId;
let captureBackend;
let sckClient;

const writeJsonLine = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const writeDiagnostic = (message) => {
  process.stderr.write(`[window-host] ${message}\n`);
};

const isRecord = (value) => Boolean(value && typeof value === 'object');

const optionalString = (value) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const normalizeCaptureBackend = (value) => {
  const normalized = optionalString(value)?.toLowerCase();
  if (normalized === 'electron') return 'electron';
  return process.platform === 'darwin' ? 'screencapturekit' : 'electron';
};

const firstExistingPath = (candidates) => {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return undefined;
};

const defaultSckHelperPath = () => firstExistingPath([
  process.env.WEAVE_WINDOW_CAPTURE_HELPER,
  path.join(__dirname, '../native/window-capture-sck/.build/release/weave-window-capture-sck'),
  path.join(__dirname, '../dist/weave-window-capture-sck'),
  path.join(__dirname, 'weave-window-capture-sck'),
]);

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

const reply = (id, ok = true, fields = {}) => {
  if (!id) return;
  writeJsonLine({ id, ok, ...fields });
};

const sendSessionEvent = (sessionId, event) => {
  if (!sessionId) return;
  writeJsonLine({
    type: 'session.event',
    sessionId,
    event: { sessionId, ...event },
  });
};

class ScreenCaptureKitClient {
  constructor(options = {}) {
    this.helperPath = options.helperPath ?? defaultSckHelperPath();
    this.nextRequestId = 0;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.frameListeners = new Set();
    this.process = undefined;
  }

  isAvailable() {
    return Boolean(this.helperPath && fs.existsSync(this.helperPath));
  }

  onFrame(listener) {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  async request(type, fields = {}, timeoutMs = 15_000) {
    await this.ensureStarted();
    const id = `sck_${++this.nextRequestId}`;
    const result = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ScreenCaptureKit helper timed out: ${type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });
    this.process.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    return result;
  }

  async shutdown() {
    if (!this.process) return;
    try {
      await this.request('shutdown', {}, 1_000);
    } catch {
      // The helper may already be gone.
    }
    this.process.kill('SIGTERM');
    this.process = undefined;
  }

  async ensureStarted() {
    if (this.process) return;
    if (!this.isAvailable()) {
      throw new Error(`ScreenCaptureKit helper is unavailable. Set WEAVE_WINDOW_CAPTURE_HELPER or build ${path.join(__dirname, '../native/window-capture-sck')}.`);
    }

    this.process = spawn(this.helperPath, [], {
      cwd: path.dirname(this.helperPath),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process.stdout.on('data', (chunk) => this.handleStdout(chunk));
    this.process.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) writeDiagnostic(text);
    });
    this.process.on('exit', (code, signal) => {
      const error = new Error(`ScreenCaptureKit helper exited: code=${code} signal=${signal ?? ''}`.trim());
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.pending.clear();
      this.process = undefined;
    });
  }

  handleStdout(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      const jsonLength = this.buffer.readUInt32LE(0);
      const payloadLength = this.buffer.readUInt32LE(4);
      const totalLength = 8 + jsonLength + payloadLength;
      if (this.buffer.length < totalLength) return;

      const jsonBuffer = this.buffer.subarray(8, 8 + jsonLength);
      const payload = this.buffer.subarray(8 + jsonLength, totalLength);
      this.buffer = this.buffer.subarray(totalLength);

      let message;
      try {
        message = JSON.parse(jsonBuffer.toString('utf8'));
      } catch (error) {
        writeDiagnostic(`ScreenCaptureKit helper emitted invalid frame header: ${toErrorMessage(error)}`);
        continue;
      }
      this.handleMessage(message, payload);
    }
  }

  handleMessage(message, payload) {
    if (typeof message.id === 'string' && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.ok === false) {
        pending.reject(new Error(message.error === undefined ? 'ScreenCaptureKit helper request failed.' : toErrorMessage(message.error)));
      } else {
        pending.resolve(message);
      }
      return;
    }

    if (message.type === 'frame') {
      for (const listener of this.frameListeners) listener(message, Buffer.from(payload));
      return;
    }

    if (message.type === 'event' && message.event === 'error') {
      sendSessionEvent(optionalString(message.sessionId) ?? activeSessionId, {
        type: 'error',
        error: optionalString(message.error) ?? 'ScreenCaptureKit capture failed.',
      });
    }
  }
}

const getCaptureBackend = () => {
  if (!captureBackend) captureBackend = normalizeCaptureBackend(process.env.WEAVE_WINDOW_CAPTURE_BACKEND);
  return captureBackend;
};

const getSckClient = () => {
  if (!sckClient) {
    sckClient = new ScreenCaptureKitClient();
    sckClient.onFrame((frame, payload) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send('window-host:capture-frame', frame, payload);
    });
  }
  return sckClient;
};

const configurePermissions = () => {
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) =>
    permission === 'media' || permission === 'display-capture'
  );
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'display-capture');
  });
};

const createWindow = async () => {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

  await app.whenReady();
  configurePermissions();

  mainWindow = new BrowserWindow({
    show: false,
    width: 640,
    height: 480,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: false,
      nodeIntegration: true,
    },
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    writeDiagnostic(`renderer exited: ${details.reason}`);
  });
  mainWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) writeDiagnostic(`renderer: ${message}`);
  });

  const rendererPath = path.join(__dirname, 'renderer.html');
  await mainWindow.loadFile(rendererPath);
  return mainWindow;
};

const callRenderer = async (method, payload) => {
  const win = await createWindow();
  const source = `
    (async () => {
      const serializeError = (error) => {
        if (error instanceof Error) {
          return {
            name: error.name,
            message: error.message,
            stack: error.stack,
          };
        }
        if (typeof error === 'string') return { message: error };
        if (error && typeof error === 'object') {
          const output = {};
          for (const key of Object.getOwnPropertyNames(error)) {
            try {
              output[key] = error[key];
            } catch {
              // Ignore hostile accessors.
            }
          }
          if (typeof error.message === 'string') output.message = error.message;
          if (typeof error.name === 'string') output.name = error.name;
          return output;
        }
        return { message: String(error) };
      };
      try {
        const api = window.weaveWindowHost;
        if (!api || typeof api[${JSON.stringify(method)}] !== 'function') {
          throw new Error('Unknown renderer method: ${method}');
        }
        return {
          ok: true,
          value: await api[${JSON.stringify(method)}](${JSON.stringify(payload)}),
        };
      } catch (error) {
        return {
          ok: false,
          error: serializeError(error),
        };
      }
    })()
  `;
  const result = await win.webContents.executeJavaScript(source, true);
  if (!isRecord(result)) throw new Error('Electron window host renderer returned an invalid response.');
  if (result.ok === false) throw new Error(toErrorMessage(result.error));
  return result.value;
};

const listWindows = async () => {
  if (getCaptureBackend() === 'screencapturekit') {
    const result = await getSckClient().request('windows.list');
    return Array.isArray(result.windows) ? result.windows : [];
  }

  await app.whenReady();
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
  return sources.map((source) => ({
    id: source.id,
    title: source.name || source.id,
  }));
};

const stopActiveSession = async (sessionId = activeSessionId) => {
  if (!sessionId) return;
  if (getCaptureBackend() === 'screencapturekit' && sckClient) {
    await sckClient.request('capture.stop', {}, 5_000).catch((error) => {
      writeDiagnostic(`ScreenCaptureKit stop failed: ${toErrorMessage(error)}`);
    });
  }
  try {
    await callRenderer('stopSession', { sessionId });
  } catch (error) {
    writeDiagnostic(`stop failed: ${toErrorMessage(error)}`);
  } finally {
    if (activeSessionId === sessionId) activeSessionId = undefined;
  }
};

ipcMain.on('window-host:event', (_event, payload) => {
  if (!isRecord(payload)) return;
  const sessionId = optionalString(payload.sessionId);
  const event = isRecord(payload.event) ? payload.event : undefined;
  if (!sessionId || !event) return;
  sendSessionEvent(sessionId, event);
});

ipcMain.on('window-host:control', (_event, payload) => {
  if (!isRecord(payload)) return;
  const type = optionalString(payload.type) ?? 'unknown';
  const sessionId = optionalString(payload.sessionId) ?? 'unknown';
  writeDiagnostic(`control noop: session=${sessionId} type=${type}`);
});

ipcMain.on('window-host:log', (_event, message) => {
  writeDiagnostic(String(message));
});

const handleMessage = async (message) => {
  const id = optionalString(message.id);
  const type = optionalString(message.type);

  try {
    if (type === 'windows.list') {
      reply(id, true, { windows: await listWindows() });
      return;
    }

    if (type === 'session.start') {
      const sessionId = optionalString(message.sessionId);
      if (!sessionId) throw new Error('sessionId is required.');

      await stopActiveSession();
      const windowId = optionalString(message.windowId);
      const sourceId = windowId ?? (await listWindows())[0]?.id;
      if (!sourceId) throw new Error('No capturable window source was found.');
      const backend = getCaptureBackend();

      activeSessionId = sessionId;
      reply(id);
      void callRenderer('startSession', {
        sessionId,
        backend,
        sourceId,
        iceServers: Array.isArray(message.iceServers) ? message.iceServers : [],
      }).then((offer) => {
        if (backend === 'screencapturekit') {
          return getSckClient().request('capture.start', {
            sessionId,
            windowId: sourceId,
            maxFrameRate: 20,
            maxDimension: 1920,
            quality: 0.75,
          }).then((captureInfo) => {
            writeDiagnostic(`screencapturekit capture started: window=${sourceId} ${captureInfo.width ?? '?'}x${captureInfo.height ?? '?'} cursor=${captureInfo.showsCursor}`);
            return offer;
          });
        }
        return offer;
      }).then((offer) => {
        sendSessionEvent(sessionId, { type: 'offer', offer });
      }).catch((error) => {
        void stopActiveSession(sessionId);
        sendSessionEvent(sessionId, { type: 'error', error: toErrorMessage(error) });
      });
      return;
    }

    if (type === 'session.answer') {
      const sessionId = optionalString(message.sessionId);
      if (!sessionId) throw new Error('sessionId is required.');
      await callRenderer('applyAnswer', { sessionId, answer: message.answer });
      reply(id);
      return;
    }

    if (type === 'session.ice-candidate') {
      const sessionId = optionalString(message.sessionId);
      if (!sessionId) throw new Error('sessionId is required.');
      await callRenderer('addIceCandidate', { sessionId, candidate: message.candidate });
      reply(id);
      return;
    }

    if (type === 'session.ready') {
      reply(id);
      return;
    }

    if (type === 'session.stop') {
      const sessionId = optionalString(message.sessionId);
      await stopActiveSession(sessionId);
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
    reply(id, false, { error: toErrorMessage(error) });
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
      writeDiagnostic(`invalid json: ${trimmed}`);
      return;
    }
    void handleMessage(message);
  });
  lines.on('close', () => {
    app.quit();
  });
};

app.on('before-quit', () => {
  if (activeSessionId) void stopActiveSession(activeSessionId);
  if (sckClient) void sckClient.shutdown();
});

app.whenReady().then(() => {
  startCommandLoop();
}).catch((error) => {
  process.stderr.write(textEncoder.encode(`[window-host] startup failed: ${toErrorMessage(error)}\n`));
  process.exit(1);
});
