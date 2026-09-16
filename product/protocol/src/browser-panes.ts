import { browserProfileId } from './browser-profiles.ts';
import { browserPageUrl, parseBrowserPage, type HostBrowserPage } from './browser-pages.ts';
import { parseWorkspaceComposition, type WorkspaceComposition } from './composition.ts';
export const HOST_BROWSER_PANES_CAPABILITY = 'browser.panes.v1';
export const HOST_BROWSER_PANE_RPC_METHODS = ['browser.pane.create', 'browser.pane.close', 'browser.pane.move', 'browser.pane.profile'] as const;
export type HostBrowserPaneRpcMethod = typeof HOST_BROWSER_PANE_RPC_METHODS[number];
export type HostBrowserPaneRpcContracts = {
  'browser.pane.create': { params: { hostId: string; workspaceId: string; workspaceName?: string; expectedRevision: number; paneId: string; profileId?: string; url: string; sourcePaneId?: string; axis: 'horizontal' | 'vertical' }; result: { composition: WorkspaceComposition; page: HostBrowserPage } };
  'browser.pane.profile': { params: { hostId: string; expectedRevision: number; paneId: string; profileId: string; selectedProfileId?: string }; result: { composition: WorkspaceComposition; page: HostBrowserPage } };
  'browser.pane.close': { params: { hostId: string; expectedRevision: number; paneId: string; profileId: string; generation?: string; confirmed: boolean }; result: { composition: WorkspaceComposition } };
  'browser.pane.move': { params: { hostId: string; expectedRevision: number; paneId: string; profileId: string; workspaceId: string; sourcePaneId?: string; axis: 'horizontal' | 'vertical' }; result: { composition: WorkspaceComposition } };
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Browser Pane request');
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 200 || value.includes('\0')) throw new Error('Invalid Browser Pane target');
  return value;
};
export function parseHostBrowserPaneRpcParams<M extends HostBrowserPaneRpcMethod>(method: M, value: unknown): HostBrowserPaneRpcContracts[M]['params'] {
  const p = object(value);
  const keys = ['hostId', 'expectedRevision', 'paneId', 'profileId', ...(method === 'browser.pane.profile' ? ['selectedProfileId'] : method === 'browser.pane.close' ? ['confirmed', 'generation'] : ['workspaceId', 'sourcePaneId', 'axis', ...(method === 'browser.pane.create' ? ['url', 'workspaceName'] : [])])];
  if (Object.keys(p).some(key => !keys.includes(key))) throw new Error('Unexpected Browser Pane parameter');
  if (!Number.isSafeInteger(p.expectedRevision) || (Number(p.expectedRevision) < 0 || Number(p.expectedRevision) >= Number.MAX_SAFE_INTEGER)) throw new Error('Invalid Browser Pane revision');
  const base = { hostId: text(p.hostId), expectedRevision: Number(p.expectedRevision), paneId: browserProfileId(p.paneId), profileId: method === 'browser.pane.create' && p.profileId === undefined ? undefined : browserProfileId(p.profileId) };
  if (method === 'browser.pane.profile') return { ...base, ...(p.selectedProfileId === undefined ? {} : { selectedProfileId: browserProfileId(p.selectedProfileId) }) } as HostBrowserPaneRpcContracts[M]['params'];
  if (method === 'browser.pane.close') {
    if (typeof p.confirmed !== 'boolean') throw new Error('Browser close confirmation is required');
    return { ...base, confirmed: p.confirmed, ...(p.generation === undefined ? {} : { generation: browserProfileId(p.generation) }) } as HostBrowserPaneRpcContracts[M]['params'];
  }
  if (p.workspaceName !== undefined && (typeof p.workspaceName !== 'string' || !p.workspaceName.trim() || p.workspaceName.length > 120)) throw new Error('Invalid Browser Workspace name');
  if (p.axis !== 'horizontal' && p.axis !== 'vertical') throw new Error('Invalid Browser split direction');
  return { ...base, workspaceId: text(p.workspaceId), axis: p.axis, ...(p.sourcePaneId === undefined ? {} : { sourcePaneId: text(p.sourcePaneId) }), ...(method === 'browser.pane.create' ? { url: browserPageUrl(p.url), ...(p.workspaceName === undefined ? {} : { workspaceName: String(p.workspaceName).trim() }) } : {}) } as HostBrowserPaneRpcContracts[M]['params'];
}
export function parseHostBrowserPaneRpcResult<M extends HostBrowserPaneRpcMethod>(method: M, value: unknown): HostBrowserPaneRpcContracts[M]['result'] {
  const result = object(value);
  return { composition: parseWorkspaceComposition(result.composition), ...((method === 'browser.pane.create' || method === 'browser.pane.profile') ? { page: parseBrowserPage(result.page) } : {}) } as HostBrowserPaneRpcContracts[M]['result'];
}
