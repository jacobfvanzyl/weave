const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require('electron');
const path = require('node:path');
const readline = require('node:readline');

const textEncoder = new TextEncoder();
let mainWindow;
let activeSessionId;

const writeJsonLine = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const writeDiagnostic = (message) => {
  process.stderr.write(`[window-host] ${message}\n`);
};

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
      if (!sourceId) throw new Error('No capturable Electron window source was found.');

      activeSessionId = sessionId;
      reply(id);
      void callRenderer('startSession', {
        sessionId,
        sourceId,
        iceServers: Array.isArray(message.iceServers) ? message.iceServers : [],
      }).then((offer) => {
        sendSessionEvent(sessionId, { type: 'offer', offer });
      }).catch((error) => {
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
});

app.whenReady().then(() => {
  startCommandLoop();
}).catch((error) => {
  process.stderr.write(textEncoder.encode(`[window-host] startup failed: ${toErrorMessage(error)}\n`));
  process.exit(1);
});
