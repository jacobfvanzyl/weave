import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopConnectionInput,
  DesktopConnectionSettings,
  DesktopConnectionTestResult,
  WeaveDesktopBridge,
} from '../shared/desktop-api';
import type { EditorFile, EditorListResult, EditorTarget, EditorWriteResult } from '../shared/editor';
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
  terminalInput: (demiplaneId: string, data: string) =>
    ipcRenderer.invoke('terminal:input', demiplaneId, data) as Promise<void>,
  terminalResize: (demiplaneId: string, cols: number, rows: number) =>
    ipcRenderer.invoke('terminal:resize', demiplaneId, cols, rows) as Promise<void>,
  terminalClose: (demiplaneId: string) => ipcRenderer.invoke('terminal:close', demiplaneId) as Promise<void>,
  terminalDetach: (demiplaneId: string) => ipcRenderer.invoke('terminal:detach', demiplaneId) as Promise<void>,
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
};

contextBridge.exposeInMainWorld('weaveDesktop', bridge);
