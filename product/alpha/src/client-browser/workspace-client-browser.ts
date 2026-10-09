import { nativeClientBrowser, type ClientBrowserBridge } from './native-client-browser';
import type { WorkspaceReference } from '@/app/workspace-presentation';

export const clientBrowserPaneKey = (hostId: string, paneId: string) => JSON.stringify([hostId, paneId]);
export const readClientBrowserPaneKey = (key: string): { hostId: string; paneId: string } | undefined => {
  try { const value = JSON.parse(key); if (Array.isArray(value) && value.length === 2 && value.every(id => typeof id === 'string' && id.length > 0)) return { hostId: value[0], paneId: value[1] }; } catch { /* Ignore unrelated native entries. */ }
};
const hidden = { x: 0, y: 0, width: 0, height: 0, visible: false, blocked: true };
/** Native shell ownership survives React unmount and renderer reload. */
export class WorkspaceClientBrowser {
  private pendingPlacement = new Set<string>();
  constructor(readonly bridge: ClientBrowserBridge) {}
  attach(target: WorkspaceReference & { paneId: string; initialUrl: string }) {
    return this.bridge.create({ address: target.initialUrl, paneKey: clientBrowserPaneKey(target.hostId, target.paneId) });
  }
  /** Sidebar reads never create or present a page, including on another Host. */
  async metadata(hostId: string, paneId: string) {
    const { panes } = await this.bridge.list();
    const entry = panes.find(pane => pane.paneKey === clientBrowserPaneKey(hostId, paneId));
    if (!entry) return;
    const snapshot = await this.bridge.snapshot({ surfaceId: entry.surfaceId });
    return snapshot.closed ? undefined : snapshot;
  }
  async adopt(hostId: string, paneId: string, popupToken: string) {
    const paneKey = clientBrowserPaneKey(hostId, paneId); this.pendingPlacement.add(paneKey);
    try { return await this.bridge.adopt({ paneKey, popupToken }); }
    catch (cause) { this.pendingPlacement.delete(paneKey); throw cause; }
  }
  placementFinished(hostId: string, paneId: string) { this.pendingPlacement.delete(clientBrowserPaneKey(hostId, paneId)); }
  detach(surfaceId: string) { return this.bridge.layout({ surfaceId, ...hidden }); }
  async reconcile(hostId: string, closed: (paneIds: string[]) => Promise<string[]>) {
    const { panes } = await this.bridge.list();
    const owned = panes.flatMap(entry => { const target = readClientBrowserPaneKey(entry.paneKey); return target?.hostId === hostId && !this.pendingPlacement.has(entry.paneKey) ? [{ ...entry, ...target }] : []; });
    if (!owned.length) return false;
    const removed = new Set(await closed(owned.map(entry => entry.paneId)));
    await Promise.all(owned.filter(entry => removed.has(entry.paneId) && !this.pendingPlacement.has(entry.paneKey)).map(entry => this.bridge.close({ surfaceId: entry.surfaceId })));
    return removed.size > 0;
  }
}

export const workspaceClientBrowser = new WorkspaceClientBrowser(nativeClientBrowser);
