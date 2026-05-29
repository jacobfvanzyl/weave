import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopConnectionInput,
  DesktopConnectionSettings,
  DesktopConnectionTestResult,
  WeaveDesktopBridge,
} from '../shared/desktop-api';

const bridge: WeaveDesktopBridge = {
  getConnectionSettings: () => ipcRenderer.invoke('connection:get-settings') as Promise<DesktopConnectionSettings>,
  saveConnectionSettings: (input: DesktopConnectionInput) =>
    ipcRenderer.invoke('connection:save-settings', input) as Promise<DesktopConnectionSettings>,
  testConnection: (input?: DesktopConnectionInput) =>
    ipcRenderer.invoke('connection:test', input) as Promise<DesktopConnectionTestResult>,
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url) as Promise<void>,
  getPlatform: () => 'darwin',
};

contextBridge.exposeInMainWorld('weaveDesktop', bridge);
