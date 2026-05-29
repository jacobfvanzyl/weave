import { app, BrowserWindow, ipcMain, nativeTheme, safeStorage, session, shell } from 'electron';
import path from 'node:path';
import type { DesktopConnectionInput, DesktopConnectionTestResult } from '../shared/desktop-api';
import { getServerOrigin, isHttpUrl, normalizeMastraUrl, parseDesktopConnectionInput } from '../shared/connection';
import { ConnectionSettingsStore } from './settings-store';

let settingsStore: ConnectionSettingsStore | undefined;

const appName = 'Weave';
app.setName(appName);
app.setPath('userData', process.env.WEAVE_DESKTOP_USER_DATA || path.join(app.getPath('appData'), appName));

const getSettingsStore = () => {
  if (!settingsStore) {
    throw new Error('Connection settings store is not initialized.');
  }

  return settingsStore;
};

const isConfiguredServerRequest = (url: string) => {
  try {
    const settings = getSettingsStore().getSettings();
    return new URL(url).origin === getServerOrigin(settings.mastraUrl);
  } catch {
    return false;
  }
};

const installAuthHeaderInjection = () => {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const authToken = getSettingsStore().getAuthToken();

    if (!authToken || !isConfiguredServerRequest(details.url)) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }

    callback({
      requestHeaders: {
        ...details.requestHeaders,
        Authorization: `Bearer ${authToken}`,
      },
    });
  });
};

const testConnection = async (input?: DesktopConnectionInput): Promise<DesktopConnectionTestResult> => {
  try {
    const store = getSettingsStore();
    const savedSettings = store.getSettings();
    const mastraUrl = normalizeMastraUrl(input?.mastraUrl ?? savedSettings.mastraUrl);
    const authToken = Object.hasOwn(input ?? {}, 'authToken') ? input?.authToken?.trim() : store.getAuthToken();
    const headers = authToken ? { Authorization: `Bearer ${authToken}` } : undefined;
    const response = await fetch(`${mastraUrl}/chat-state/me`, { headers });

    if (!response.ok) {
      const error = (await response.text()).trim();
      return { ok: false, status: response.status, error: error || `HTTP ${response.status}` };
    }

    const data = await response.json() as { user?: { id?: unknown; name?: unknown } };
    if (typeof data.user?.id !== 'string' || typeof data.user.name !== 'string') {
      return { ok: false, error: 'Connection response did not include a valid user.' };
    }

    return { ok: true, user: { id: data.user.id, name: data.user.name } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' };
  }
};

const openExternal = async (url: string) => {
  if (!isHttpUrl(url)) throw new Error('Only http and https URLs can be opened externally.');
  await shell.openExternal(url);
};

const registerIpcHandlers = () => {
  ipcMain.handle('connection:get-settings', () => getSettingsStore().getSettings());
  ipcMain.handle('connection:save-settings', (_event, input: unknown) =>
    getSettingsStore().saveSettings(parseDesktopConnectionInput(input)),
  );
  ipcMain.handle('connection:test', (_event, input?: unknown) =>
    testConnection(input === undefined ? undefined : parseDesktopConnectionInput(input)),
  );
  ipcMain.handle('shell:open-external', (_event, url: string) => openExternal(url));
};

const createWindow = () => {
  nativeTheme.themeSource = 'dark';

  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'Weave',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url).catch(() => undefined);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', event => {
    event.preventDefault();
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
};

app.whenReady().then(() => {
  settingsStore = new ConnectionSettingsStore({
    userDataPath: app.getPath('userData'),
    encryption: safeStorage,
  });

  installAuthHeaderInjection();
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(error => {
  console.error(error);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
