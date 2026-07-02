import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopConnectionInput,
  DesktopConnectionSettings,
  DesktopConnectionTestResult,
  WeaveDesktopBridge,
} from '../shared/desktop-api';
import type {
  EditorFile,
  EditorDiffPreviewResult,
  EditorHashResult,
  EditorListResult,
  EditorOperationResult,
  EditorTarget,
  EditorWatchEventEnvelope,
  EditorWatchStartResult,
  EditorWriteResult,
} from '../shared/editor';
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
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url) as Promise<void>,
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
  editorList: (target: EditorTarget, path?: string) =>
    unwrapIpcResult<EditorListResult>(ipcRenderer.invoke('editor:list', { target, path })),
  editorRead: (target: EditorTarget, path: string) =>
    unwrapIpcResult<EditorFile>(ipcRenderer.invoke('editor:read', { target, path })),
  editorHash: (target: EditorTarget, path: string) =>
    unwrapIpcResult<EditorHashResult>(ipcRenderer.invoke('editor:hash', { target, path })),
  editorDiffPreview: (target: EditorTarget, path: string, diff: string) =>
    unwrapIpcResult<EditorDiffPreviewResult>(ipcRenderer.invoke('editor:diff-preview', { target, path, diff })),
  editorWrite: (target: EditorTarget, path: string, content: string, version?: string) =>
    unwrapIpcResult<EditorWriteResult>(ipcRenderer.invoke('editor:write', { target, path, content, version })),
  editorMkdir: (target: EditorTarget, path: string) =>
    unwrapIpcResult<EditorOperationResult>(ipcRenderer.invoke('editor:mkdir', { target, path })),
  editorMove: (target: EditorTarget, fromPath: string, toPath: string, overwrite?: boolean) =>
    unwrapIpcResult<EditorOperationResult>(ipcRenderer.invoke('editor:move', { target, fromPath, toPath, overwrite })),
  editorDelete: (target: EditorTarget, path: string, recursive?: boolean) =>
    unwrapIpcResult<EditorOperationResult>(ipcRenderer.invoke('editor:delete', { target, path, recursive })),
  editorWatchStart: (target: EditorTarget, paths: string[]) =>
    ipcRenderer.invoke('editor:watch-start', { target, paths }) as Promise<EditorWatchStartResult>,
  editorWatchUpdate: (subscriptionId: string, paths: string[]) =>
    ipcRenderer.invoke('editor:watch-update', { subscriptionId, paths }) as Promise<EditorWatchStartResult>,
  editorWatchStop: (subscriptionId: string) =>
    ipcRenderer.invoke('editor:watch-stop', { subscriptionId }) as Promise<void>,
  onEditorWatchEvent: listener => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, watchEvent: EditorWatchEventEnvelope) => {
      listener(watchEvent);
    };
    ipcRenderer.on('editor:watch-event', wrappedListener);
    return () => ipcRenderer.removeListener('editor:watch-event', wrappedListener);
  },
  lspCreateSession: (target: EditorTarget, path: string, languageId?: string, serverId?: string) =>
    ipcRenderer.invoke('lsp:create-session', { target, path, languageId, serverId }),
};

contextBridge.exposeInMainWorld('weaveDesktop', bridge);
