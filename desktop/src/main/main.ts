import { app, BrowserWindow, ipcMain, nativeTheme, safeStorage, session, shell } from 'electron';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { DesktopConnectionInput, DesktopConnectionTestResult } from '../shared/desktop-api';
import type { EditorTarget } from '../shared/editor';
import type { TerminalStartInput } from '../shared/terminal';
import { getServerOrigin, isHttpUrl, normalizeMastraUrl, parseDesktopConnectionInput } from '../shared/connection';
import { ConnectionSettingsStore } from './settings-store';
import { parseEditorListInput, parseEditorReadInput, parseEditorWriteInput } from './editor-input';
import { PortalEditorClient } from './portal-editor-client';
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
let portalEditorClient: PortalEditorClient | undefined;

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

type ProjectListing = {
  id?: unknown;
  projectKind?: unknown;
  portalId?: unknown;
  portalRootId?: unknown;
  repoPath?: unknown;
  workspaces?: unknown;
};

type WorkspaceListing = {
  id?: unknown;
  path?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object');

const resolveGitWorkspace = async (input: EditorTarget, featureName: string) => {
  const store = getSettingsStore();
  const settings = store.getSettings();
  const authToken = store.getAuthToken();
  const headers = authToken ? { Authorization: `Bearer ${authToken}` } : undefined;
  const response = await fetch(`${normalizeMastraUrl(settings.mastraUrl)}/projects`, { headers });

  if (!response.ok) {
    const error = (await response.text()).trim();
    throw new Error(error || `Failed to load Projects for ${featureName}: HTTP ${response.status}`);
  }

  const data = await response.json() as { projects?: ProjectListing[] };
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const project = projects.find(candidate => candidate.id === input.projectId);
  if (!project) throw new Error('Project was not found.');
  if (project.projectKind !== 'git') throw new Error(`${featureName} is only available for Git Projects.`);

  const workspaces = Array.isArray(project.workspaces) ? project.workspaces.filter(isRecord) as WorkspaceListing[] : [];
  const workspace = workspaces.find(candidate => candidate.id === input.workspaceId);
  if (!workspace) throw new Error('Workspace was not found.');
  if (typeof workspace.path !== 'string' || !workspace.path.trim()) {
    throw new Error('Workspace does not have a local workspace path.');
  }

  return {
    cwd: workspace.path.trim(),
    portalId: typeof project.portalId === 'string' ? project.portalId : undefined,
    rootId: typeof project.portalRootId === 'string' ? project.portalRootId : undefined,
    repoPath: typeof project.repoPath === 'string' ? project.repoPath : undefined,
  };
};

const resolveTerminalWorkspace = async (input: TerminalStartInput) => {
  if (!input.projectId || !input.workspaceId) throw new Error('Project and Workspace are required for this terminal.');
  const target = await resolveGitWorkspace({ projectId: input.projectId, workspaceId: input.workspaceId }, 'terminal');
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

const resolveEditorWorkspace = (target: EditorTarget) => resolveGitWorkspace(target, 'editor');

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

const getPortalEditorClient = () => {
  if (!settingsStore) throw new Error('Connection settings store is not initialized.');
  if (!portalSupervisor) {
    portalSupervisor = new PortalSupervisor({
      settingsStore,
      homePath: app.getPath('home'),
    });
  }
  if (!portalEditorClient) {
    portalEditorClient = new PortalEditorClient({
      supervisor: portalSupervisor,
      resolveWorkspace: resolveEditorWorkspace,
    });
  }

  return portalEditorClient;
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
      : await resolveTerminalWorkspace(parsed);
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
    getPortalEditorClient().list(parseEditorListInput(input)),
  );
  ipcMain.handle('editor:read', (_event, input: unknown) =>
    getPortalEditorClient().read(parseEditorReadInput(input)),
  );
  ipcMain.handle('editor:write', (_event, input: unknown) =>
    getPortalEditorClient().write(parseEditorWriteInput(input)),
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
