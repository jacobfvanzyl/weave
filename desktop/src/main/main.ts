import { app, BrowserWindow, ipcMain, nativeTheme, safeStorage, shell } from 'electron';
import { RpcConnection, WEAVE_RPC_PROTOCOL_VERSION } from '@weave/protocol';
import path from 'node:path';
import type { DesktopConnectionInput, DesktopConnectionTestResult } from '../shared/desktop-api';
import { isHttpUrl, normalizeMastraUrl, parseDesktopConnectionInput } from '../shared/connection';
import { ConnectionSettingsStore } from './settings-store';
import { PortalSupervisor } from './portal-supervisor';
import { startDesktopPerfSampler } from './perf';
import { ChatGPTLoginBroker } from './chatgpt-login';
import { DesktopRpcConnection } from './rpc-connection';
import {
  clearNativeNotifications,
  getNativeNotificationPermissionState,
  parseNativeNotificationEvent,
  requestNativeNotificationPermission,
  showNativeNotification,
} from './native-notifications';

let settingsStore: ConnectionSettingsStore | undefined;
let desktopRpcConnection: DesktopRpcConnection | undefined;
let portalSupervisor: PortalSupervisor | undefined;
let desktopPerfSampler: ReturnType<typeof startDesktopPerfSampler> | undefined;
let chatGPTLoginBroker: ChatGPTLoginBroker | undefined;

const appName = 'Weave';
const appBundleId = 'com.veezee.weave';
const appUserDataPath = process.env.WEAVE_DESKTOP_USER_DATA || path.join(app.getPath('appData'), appName);
const sharedConnectionUserDataPath = process.env.WEAVE_DESKTOP_CONNECTION_USER_DATA
  || process.env.WEAVE_DESKTOP_USER_DATA
  || path.join(app.getPath('appData'), 'Weave');
const devAppIconPath = app.isPackaged ? undefined : path.join(process.cwd(), 'assets', 'icon.png');

process.title = appName;
app.setName(appName);
app.setAboutPanelOptions({ applicationName: appName });
app.setPath('userData', appUserDataPath);
if (process.platform === 'win32') app.setAppUserModelId(appBundleId);

const getSettingsStore = () => {
  if (!settingsStore) throw new Error('Connection settings store is not initialized.');
  return settingsStore;
};

const getRpc = () => {
  if (!desktopRpcConnection) throw new Error('Desktop RPC connection is not initialized.');
  return desktopRpcConnection;
};

const testConnection = async (input?: DesktopConnectionInput): Promise<DesktopConnectionTestResult> => {
  try {
    const store = getSettingsStore();
    const saved = store.getSettings();
    const serverUrl = normalizeMastraUrl(input?.mastraUrl ?? saved.mastraUrl);
    const token = Object.hasOwn(input ?? {}, 'authToken') ? input?.authToken?.trim() : store.getAuthToken();
    if (!token) return { ok: false, error: 'Authentication token is required.' };
    const connection = new RpcConnection({
      serverUrl,
      reconnect: false,
      initialize: {
        protocolVersion: WEAVE_RPC_PROTOCOL_VERSION,
        role: 'client',
        token,
        capabilities: [],
        client: { clientAppId: 'weave', clientInstanceId: `desktop-test_${crypto.randomUUID()}` },
      },
    });
    const response = await connection.request<{ owner: { id?: unknown; name?: unknown } }>('owner.get')
      .finally(() => connection.close());
    if (typeof response.owner?.id !== 'string' || typeof response.owner.name !== 'string') {
      return { ok: false, error: 'Connection response did not include a valid owner.' };
    }
    return { ok: true, user: { id: response.owner.id, name: response.owner.name } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' };
  }
};

const openExternal = async (url: string) => {
  if (!isHttpUrl(url)) throw new Error('Only http and https URLs can be opened externally.');
  await shell.openExternal(url);
};

const getChatGPTLoginBroker = () => {
  if (!chatGPTLoginBroker) {
    chatGPTLoginBroker = new ChatGPTLoginBroker({
      requestRpc: (method, params) => getRpc().request(method, params),
      openExternal,
    });
  }
  return chatGPTLoginBroker;
};

const getPortalSupervisor = () => {
  if (!portalSupervisor) {
    portalSupervisor = new PortalSupervisor({
      settingsStore: getSettingsStore(),
      rpc: getRpc(),
      homePath: app.getPath('home'),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    });
    portalSupervisor.subscribe(status => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.webContents.isDestroyed()) window.webContents.send('portal:status', status);
      }
    });
  }
  return portalSupervisor;
};

const registerIpcHandlers = () => {
  ipcMain.handle('connection:get-settings', () => getSettingsStore().getSettings());
  ipcMain.handle('connection:save-settings', (_event, input: unknown) => {
    const settings = getSettingsStore().saveSettings(parseDesktopConnectionInput(input));
    getRpc().reconnect();
    void getPortalSupervisor().reconcile({ refreshPortalToken: true }).catch(error => console.error('[portal]', error));
    return settings;
  });
  ipcMain.handle('connection:test', (_event, input?: unknown) =>
    testConnection(input === undefined ? undefined : parseDesktopConnectionInput(input)),
  );
  ipcMain.handle('portal:get-status', () => getPortalSupervisor().getStatus());
  ipcMain.handle('portal:retry', async () => {
    await getPortalSupervisor().retry();
    return getPortalSupervisor().getStatus();
  });
  ipcMain.handle('shell:open-external', (_event, url: string) => openExternal(url));
  ipcMain.handle('chatgpt:connect', () => getChatGPTLoginBroker().connect());
  ipcMain.handle('native-notifications:get-permission-state', () => getNativeNotificationPermissionState());
  ipcMain.handle('native-notifications:request-permission', () => requestNativeNotificationPermission());
  ipcMain.handle('native-notifications:show', (_event, input: unknown) =>
    showNativeNotification(parseNativeNotificationEvent(input)),
  );
  ipcMain.handle('native-notifications:clear', (_event, id: unknown) =>
    clearNativeNotifications(typeof id === 'string' ? id : undefined),
  );
};

const createWindow = () => {
  nativeTheme.themeSource = 'dark';
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: appName,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    transparent: true,
    backgroundColor: '#00000000',
    ...(devAppIconPath ? { icon: devAppIconPath } : {}),
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
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else void mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
};

app.whenReady().then(() => {
  settingsStore = new ConnectionSettingsStore({
    userDataPath: sharedConnectionUserDataPath,
    encryption: safeStorage,
  });
  desktopRpcConnection = new DesktopRpcConnection(settingsStore);
  registerIpcHandlers();
  getPortalSupervisor().startMonitoring();
  if (devAppIconPath && process.platform === 'darwin') app.dock?.setIcon(devAppIconPath);
  createWindow();
  desktopPerfSampler = startDesktopPerfSampler({
    sample: () => ({
      rpcState: desktopRpcConnection?.state,
      portalSupervisor: portalSupervisor?.getPerfSnapshot(),
    }),
  });
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

app.on('before-quit', () => {
  desktopPerfSampler?.stop();
  chatGPTLoginBroker?.dispose();
  portalSupervisor?.dispose();
  desktopRpcConnection?.dispose();
});
