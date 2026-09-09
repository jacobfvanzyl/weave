import { contextBridge } from 'electron';
// This bridge exposes identity only. Keys remain non-exportable WebCrypto keys
// in the application profile; the renderer receives no Node or general IPC API.
contextBridge.exposeInMainWorld('weaveDesktop', Object.freeze({ runtime: 'electron', platform: 'macos' }));
