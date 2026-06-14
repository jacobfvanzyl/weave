import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopConnectionInput,
  DesktopConnectionSettings,
  DesktopConnectionTestResult,
  WeaveDesktopBridge,
} from '../shared/desktop-api';
import type { EditorFile, EditorListResult, EditorOperationResult, EditorTarget, EditorWriteResult } from '../shared/editor';
import type { TerminalHostEvent, TerminalStartInput, TerminalStartResult } from '../shared/terminal';

const bridge: WeaveDesktopBridge = {
  getConnectionSettings: () => ipcRenderer.invoke('connection:get-settings') as Promise<DesktopConnectionSettings>,
  saveConnectionSettings: (input: DesktopConnectionInput) =>
    ipcRenderer.invoke('connection:save-settings', input) as Promise<DesktopConnectionSettings>,
  testConnection: (input?: DesktopConnectionInput) =>
    ipcRenderer.invoke('connection:test', input) as Promise<DesktopConnectionTestResult>,
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url) as Promise<void>,
  getPlatform: () => process.platform,
  terminalStart: (input: TerminalStartInput) =>
    ipcRenderer.invoke('terminal:start', input) as Promise<TerminalStartResult>,
  terminalInput: (terminalId: string, data: string) =>
    ipcRenderer.invoke('terminal:input', terminalId, data) as Promise<void>,
  terminalResize: (terminalId: string, cols: number, rows: number) =>
    ipcRenderer.invoke('terminal:resize', terminalId, cols, rows) as Promise<void>,
  terminalClose: (terminalId: string) => ipcRenderer.invoke('terminal:close', terminalId) as Promise<void>,
  terminalDetach: (terminalId: string) => ipcRenderer.invoke('terminal:detach', terminalId) as Promise<void>,
  onTerminalEvent: listener => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, terminalEvent: TerminalHostEvent) => {
      listener(terminalEvent);
    };
    ipcRenderer.on('terminal:event', wrappedListener);
    return () => ipcRenderer.removeListener('terminal:event', wrappedListener);
  },
  editorList: (target: EditorTarget, path?: string) =>
    ipcRenderer.invoke('editor:list', { target, path }) as Promise<EditorListResult>,
  editorRead: (target: EditorTarget, path: string) =>
    ipcRenderer.invoke('editor:read', { target, path }) as Promise<EditorFile>,
  editorWrite: (target: EditorTarget, path: string, content: string, version?: string) =>
    ipcRenderer.invoke('editor:write', { target, path, content, version }) as Promise<EditorWriteResult>,
  editorMkdir: (target: EditorTarget, path: string) =>
    ipcRenderer.invoke('editor:mkdir', { target, path }) as Promise<EditorOperationResult>,
  editorMove: (target: EditorTarget, fromPath: string, toPath: string, overwrite?: boolean) =>
    ipcRenderer.invoke('editor:move', { target, fromPath, toPath, overwrite }) as Promise<EditorOperationResult>,
  editorDelete: (target: EditorTarget, path: string, recursive?: boolean) =>
    ipcRenderer.invoke('editor:delete', { target, path, recursive }) as Promise<EditorOperationResult>,
};

contextBridge.exposeInMainWorld('weaveDesktop', bridge);
