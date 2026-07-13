import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopConnectionInput,
  DesktopConnectionSettings,
  DesktopConnectionTestResult,
  DesktopChatGPTAuthStatus,
  DesktopPortalStatus,
  WeaveDesktopBridge,
} from '../shared/desktop-api';
import type {
  NativeNotificationAction,
  NativeNotificationShowResult,
  WeaveNotificationEvent,
} from '@weave/client/lib/notifications/types';
import type {
  WorkspaceFileFile,
  WorkspaceFileDiffPreviewResult,
  WorkspaceFileHashResult,
  WorkspaceFileIndexResult,
  WorkspaceFileListResult,
  WorkspaceFileOperationResult,
  WorkspaceFileTarget,
  WorkspaceFileWatchEventEnvelope,
  WorkspaceFileWatchStartResult,
  WorkspaceFileWriteResult,
} from '../shared/workspace-file';
import type {
  TerminalHostEvent,
  TerminalStartInput,
  TerminalStartResult,
  TerminalTargetInput,
  TerminalWindowRecord,
} from '../shared/terminal';

type IpcErrorResult = {
  __weaveIpcError: true;
  message: string;
};

const unwrapIpcResult = async <T>(promise: Promise<T | IpcErrorResult>): Promise<T> => {
  const result = await promise;
  if (
    result
    && typeof result === 'object'
    && '__weaveIpcError' in result
    && result.__weaveIpcError === true
  ) {
    throw new Error(typeof result.message === 'string' ? result.message : 'Desktop IPC request failed.');
  }
  return result as T;
};

const bridge: WeaveDesktopBridge = {
  getConnectionSettings: () => ipcRenderer.invoke('connection:get-settings') as Promise<DesktopConnectionSettings>,
  saveConnectionSettings: (input: DesktopConnectionInput) =>
    ipcRenderer.invoke('connection:save-settings', input) as Promise<DesktopConnectionSettings>,
  testConnection: (input?: DesktopConnectionInput) =>
    ipcRenderer.invoke('connection:test', input) as Promise<DesktopConnectionTestResult>,
  getPortalStatus: () => ipcRenderer.invoke('portal:get-status') as Promise<DesktopPortalStatus>,
  retryPortal: () => unwrapIpcResult<DesktopPortalStatus>(ipcRenderer.invoke('portal:retry')),
  onPortalStatus: listener => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, status: DesktopPortalStatus) => listener(status);
    ipcRenderer.on('portal:status', wrappedListener);
    return () => ipcRenderer.removeListener('portal:status', wrappedListener);
  },
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url) as Promise<void>,
  connectChatGPT: () =>
    unwrapIpcResult<DesktopChatGPTAuthStatus>(ipcRenderer.invoke('chatgpt:connect')),
  getPlatform: () => process.platform,
  terminalSnapshot: () =>
    ipcRenderer.invoke('terminal:snapshot') as Promise<TerminalWindowRecord[]>,
  terminalList: (input: TerminalTargetInput) =>
    ipcRenderer.invoke('terminal:list', input) as Promise<TerminalWindowRecord[]>,
  terminalCreate: (input: TerminalTargetInput) =>
    ipcRenderer.invoke('terminal:create', input) as Promise<TerminalWindowRecord>,
  terminalStart: (input: TerminalStartInput) =>
    ipcRenderer.invoke('terminal:start', input) as Promise<TerminalStartResult>,
  terminalInput: (terminalId: string, data: string) =>
    ipcRenderer.invoke('terminal:input', terminalId, data) as Promise<void>,
  terminalResize: (terminalId: string, cols: number, rows: number) =>
    ipcRenderer.invoke('terminal:resize', terminalId, cols, rows) as Promise<void>,
  terminalClose: (terminalId: string, input?: TerminalTargetInput) =>
    ipcRenderer.invoke('terminal:close', terminalId, input) as Promise<void>,
  terminalDetach: (terminalId: string) => ipcRenderer.invoke('terminal:detach', terminalId) as Promise<void>,
  onTerminalEvent: listener => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, terminalEvent: TerminalHostEvent) => {
      listener(terminalEvent);
    };
    ipcRenderer.on('terminal:event', wrappedListener);
    return () => ipcRenderer.removeListener('terminal:event', wrappedListener);
  },
  workspaceFileList: (target: WorkspaceFileTarget, path?: string) =>
    unwrapIpcResult<WorkspaceFileListResult>(ipcRenderer.invoke('workspace-file:list', { target, path })),
  workspaceFileRead: (target: WorkspaceFileTarget, path: string) =>
    unwrapIpcResult<WorkspaceFileFile>(ipcRenderer.invoke('workspace-file:read', { target, path })),
  workspaceFileHash: (target: WorkspaceFileTarget, path: string) =>
    unwrapIpcResult<WorkspaceFileHashResult>(ipcRenderer.invoke('workspace-file:hash', { target, path })),
  workspaceFileDiffPreview: (target: WorkspaceFileTarget, path: string, diff: string) =>
    unwrapIpcResult<WorkspaceFileDiffPreviewResult>(ipcRenderer.invoke('workspace-file:diff-preview', { target, path, diff })),
  workspaceFileWrite: (target: WorkspaceFileTarget, path: string, content: string, version?: string) =>
    unwrapIpcResult<WorkspaceFileWriteResult>(ipcRenderer.invoke('workspace-file:write', { target, path, content, version })),
  workspaceFileMkdir: (target: WorkspaceFileTarget, path: string) =>
    unwrapIpcResult<WorkspaceFileOperationResult>(ipcRenderer.invoke('workspace-file:mkdir', { target, path })),
  workspaceFileMove: (target: WorkspaceFileTarget, fromPath: string, toPath: string, overwrite?: boolean) =>
    unwrapIpcResult<WorkspaceFileOperationResult>(ipcRenderer.invoke('workspace-file:move', { target, fromPath, toPath, overwrite })),
  workspaceFileDelete: (target: WorkspaceFileTarget, path: string, recursive?: boolean) =>
    unwrapIpcResult<WorkspaceFileOperationResult>(ipcRenderer.invoke('workspace-file:delete', { target, path, recursive })),
  workspaceFileIndex: (target: WorkspaceFileTarget, path?: string) =>
    unwrapIpcResult<WorkspaceFileIndexResult>(ipcRenderer.invoke('workspace-file:index', { target, path })),
  workspaceFileUpload: (target: WorkspaceFileTarget, path: string, base64Content: string, contentType?: string) =>
    unwrapIpcResult<WorkspaceFileOperationResult>(
      ipcRenderer.invoke('workspace-file:upload', { target, path, base64Content, contentType }),
    ),
  workspaceFileWatchStart: (target: WorkspaceFileTarget, paths: string[]) =>
    ipcRenderer.invoke('workspace-file:watch-start', { target, paths }) as Promise<WorkspaceFileWatchStartResult>,
  workspaceFileWatchUpdate: (subscriptionId: string, paths: string[]) =>
    ipcRenderer.invoke('workspace-file:watch-update', { subscriptionId, paths }) as Promise<WorkspaceFileWatchStartResult>,
  workspaceFileWatchStop: (subscriptionId: string) =>
    ipcRenderer.invoke('workspace-file:watch-stop', { subscriptionId }) as Promise<void>,
  onWorkspaceFileWatchEvent: listener => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, watchEvent: WorkspaceFileWatchEventEnvelope) => {
      listener(watchEvent);
    };
    ipcRenderer.on('workspace-file:watch-event', wrappedListener);
    return () => ipcRenderer.removeListener('workspace-file:watch-event', wrappedListener);
  },
  lspCreateSession: (target: WorkspaceFileTarget, path: string, languageId?: string, serverId?: string) =>
    ipcRenderer.invoke('lsp:create-session', { target, path, languageId, serverId }),
  nativeNotificationsGetPermissionState: () =>
    ipcRenderer.invoke('native-notifications:get-permission-state'),
  nativeNotificationsRequestPermission: () =>
    ipcRenderer.invoke('native-notifications:request-permission'),
  nativeNotificationsShow: (event: WeaveNotificationEvent) =>
    ipcRenderer.invoke('native-notifications:show', event) as Promise<NativeNotificationShowResult>,
  nativeNotificationsClear: (id?: string) =>
    ipcRenderer.invoke('native-notifications:clear', id) as Promise<void>,
  onNativeNotificationAction: listener => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, action: NativeNotificationAction) => {
      listener(action);
    };
    ipcRenderer.on('native-notification:action', wrappedListener);
    return () => ipcRenderer.removeListener('native-notification:action', wrappedListener);
  },
};

contextBridge.exposeInMainWorld('weaveDesktop', bridge);
