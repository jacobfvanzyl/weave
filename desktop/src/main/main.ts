import { app, BrowserWindow, ipcMain, nativeTheme, safeStorage, session, shell } from 'electron';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { DesktopConnectionInput, DesktopConnectionTestResult } from '../shared/desktop-api';
import type { EditorTarget } from '../shared/editor';
import type { TerminalStartInput } from '../shared/terminal';
import { getServerOrigin, isHttpUrl, normalizeMastraUrl, parseDesktopConnectionInput } from '../shared/connection';
import { ConnectionSettingsStore } from './settings-store';
import { EditorManager, parseEditorListInput, parseEditorReadInput, parseEditorWriteInput } from './editor-manager';
import {
  parseTerminalInputData,
  parseTerminalId,
  parseTerminalResize,
  parseTerminalStartInput,
} from './terminal-input';
import { PortalSupervisor, PortalTerminalClient } from './portal-terminal-client';

let settingsStore: ConnectionSettingsStore | undefined;
let portalSupervisor: PortalSupervisor | undefined;
let portalTerminalClient: PortalTerminalClient | undefined;
let editorManager: EditorManager | undefined;

const appName = 'Weave';
const devAppIconPath = app.isPackaged ? undefined : path.join(process.cwd(), 'assets', 'icon.png');

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

type PlaneListing = {
  id?: unknown;
  projectKind?: unknown;
  portalId?: unknown;
  portalRootId?: unknown;
  repoPath?: unknown;
  demiplanes?: unknown;
};

type DemiplaneListing = {
  id?: unknown;
  path?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object');

const resolveGitDemiplane = async (input: EditorTarget, featureName: string) => {
  const store = getSettingsStore();
  const settings = store.getSettings();
  const authToken = store.getAuthToken();
  const headers = authToken ? { Authorization: `Bearer ${authToken}` } : undefined;
  const response = await fetch(`${normalizeMastraUrl(settings.mastraUrl)}/planes`, { headers });

  if (!response.ok) {
    const error = (await response.text()).trim();
    throw new Error(error || `Failed to load Planes for ${featureName}: HTTP ${response.status}`);
  }

  const data = await response.json() as { planes?: PlaneListing[] };
  const planes = Array.isArray(data.planes) ? data.planes : [];
  const plane = planes.find(candidate => candidate.id === input.planeId);
  if (!plane) throw new Error('Plane was not found.');
  if (plane.projectKind !== 'git') throw new Error(`${featureName} is only available for Git/code Planes.`);

  const demiplanes = Array.isArray(plane.demiplanes) ? plane.demiplanes.filter(isRecord) as DemiplaneListing[] : [];
  const demiplane = demiplanes.find(candidate => candidate.id === input.demiplaneId);
  if (!demiplane) throw new Error('Demiplane was not found.');
  if (typeof demiplane.path !== 'string' || !demiplane.path.trim()) {
    throw new Error('Demiplane does not have a local workspace path.');
  }

  return {
    cwd: await realpath(demiplane.path),
    portalId: typeof plane.portalId === 'string' ? plane.portalId : undefined,
    rootId: typeof plane.portalRootId === 'string' ? plane.portalRootId : undefined,
    repoPath: typeof plane.repoPath === 'string' ? plane.repoPath : undefined,
  };
};

const resolveTerminalDemiplane = async (input: TerminalStartInput) => {
  if (!input.planeId || !input.demiplaneId) throw new Error('Plane and Demiplane are required for this terminal.');
  const target = await resolveGitDemiplane({ planeId: input.planeId, demiplaneId: input.demiplaneId }, 'terminal');
  return {
    ...input,
    portalId: input.portalId ?? target.portalId,
    rootId: input.rootId ?? target.rootId,
    repoPath: input.repoPath ?? target.repoPath,
    workspacePath: input.workspacePath ?? target.cwd,
  };
};

const resolveGeneralTerminal = async (input: TerminalStartInput) => ({
  ...input,
  cwd: await realpath(input.cwd?.trim() || app.getPath('home')),
});

const resolveEditorDemiplane = (target: EditorTarget) => resolveGitDemiplane(target, 'editor');

const getPortalTerminalClient = () => {
  if (!settingsStore) throw new Error('Connection settings store is not initialized.');
  if (!portalSupervisor) {
    portalSupervisor = new PortalSupervisor({
      settingsStore,
      homePath: app.getPath('home'),
    });
  }
  if (!portalTerminalClient) portalTerminalClient = new PortalTerminalClient(portalSupervisor);

  return portalTerminalClient;
};

const getEditorManager = () => {
  if (!editorManager) {
    editorManager = new EditorManager({ resolveDemiplane: resolveEditorDemiplane });
  }

  return editorManager;
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
  ipcMain.handle('terminal:start', async (event, input: unknown) => {
    const parsed = parseTerminalStartInput(input);
    const resolved = parsed.kind === 'general'
      ? await resolveGeneralTerminal(parsed)
      : await resolveTerminalDemiplane(parsed);
    return getPortalTerminalClient().start(resolved, event.sender);
  });
  ipcMain.handle('terminal:input', (_event, terminalId: unknown, data: unknown) =>
    getPortalTerminalClient().input(parseTerminalId(terminalId), parseTerminalInputData(data)),
  );
  ipcMain.handle('terminal:resize', (_event, terminalId: unknown, cols: unknown, rows: unknown) => {
    const size = parseTerminalResize(cols, rows);
    return getPortalTerminalClient().resize(parseTerminalId(terminalId), size.cols, size.rows);
  });
  ipcMain.handle('terminal:close', (_event, terminalId: unknown) =>
    getPortalTerminalClient().close(parseTerminalId(terminalId)),
  );
  ipcMain.handle('terminal:detach', (event, terminalId: unknown) =>
    getPortalTerminalClient().detach(parseTerminalId(terminalId), event.sender),
  );
  ipcMain.handle('editor:list', (_event, input: unknown) =>
    getEditorManager().list(parseEditorListInput(input)),
  );
  ipcMain.handle('editor:read', (_event, input: unknown) =>
    getEditorManager().read(parseEditorReadInput(input)),
  );
  ipcMain.handle('editor:write', (_event, input: unknown) =>
    getEditorManager().write(parseEditorWriteInput(input)),
  );
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

  mainWindow.webContents.on('will-navigate', event => {
    event.preventDefault();
  });

  const webContentsId = mainWindow.webContents.id;
  mainWindow.webContents.on('destroyed', () => {
    portalTerminalClient?.detachWebContents(webContentsId);
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
  if (devAppIconPath && process.platform === 'darwin') app.dock?.setIcon(devAppIconPath);
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

app.on('before-quit', () => {
  portalTerminalClient?.dispose();
});
