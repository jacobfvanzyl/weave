import { clientBrowserInitialUrl, parseWorkspaceComposition, type WorkspaceComposition } from './composition.ts';

export const CLIENT_BROWSER_PANES_CAPABILITY = 'client-browser.panes.v1';
export const CLIENT_BROWSER_PANE_RPC_METHODS = ['client-browser.pane.create', 'client-browser.pane.move', 'client-browser.pane.close', 'client-browser.pane.reconcile'] as const;
export type ClientBrowserPaneRpcMethod = typeof CLIENT_BROWSER_PANE_RPC_METHODS[number];
type Target = { hostId: string; expectedRevision: number; paneId: string };
type Placement = { workspaceId: string; sourcePaneId?: string; axis: 'horizontal' | 'vertical' };
type Result = { composition: WorkspaceComposition };
export type ClientBrowserPaneRpcContracts = {
  'client-browser.pane.reconcile': { params: { hostId: string; paneIds: string[] }; result: { closedPaneIds: string[] } };
  'client-browser.pane.create': { params: Target & Placement & { initialUrl: string }; result: Result };
  'client-browser.pane.move': { params: Target & Placement; result: Result };
  'client-browser.pane.close': { params: Target & { confirmed: boolean }; result: Result };
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Client Browser request.');
  return value as Record<string, unknown>;
};
const identity = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || value.includes('\0')) throw new Error('Invalid Client Browser identity.');
  return value;
};
export function parseClientBrowserPaneRpcParams<M extends ClientBrowserPaneRpcMethod>(method: M, value: unknown): ClientBrowserPaneRpcContracts[M]['params'] {
  const p = object(value);
  if (method === 'client-browser.pane.reconcile') {
    if (Object.keys(p).some(key => !['hostId', 'paneIds'].includes(key)) || !Array.isArray(p.paneIds) || p.paneIds.length > 128) throw new Error('Invalid Client Browser reconciliation.');
    return { hostId: identity(p.hostId), paneIds: p.paneIds.map(identity) } as ClientBrowserPaneRpcContracts[M]['params'];
  }
  const keys = ['hostId', 'expectedRevision', 'paneId', ...(method === 'client-browser.pane.close' ? ['confirmed'] : ['workspaceId', 'sourcePaneId', 'axis', ...(method === 'client-browser.pane.create' ? ['initialUrl'] : [])])];
  if (Object.keys(p).some(key => !keys.includes(key))) throw new Error('Unexpected Client Browser parameter.');
  if (!Number.isSafeInteger(p.expectedRevision) || Number(p.expectedRevision) < 0 || Number(p.expectedRevision) >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid Client Browser revision.');
  const base = { hostId: identity(p.hostId), paneId: identity(p.paneId), expectedRevision: Number(p.expectedRevision) };
  if (method === 'client-browser.pane.close') {
    if (typeof p.confirmed !== 'boolean') throw new Error('Client Browser close confirmation is required.');
    return { ...base, confirmed: p.confirmed } as ClientBrowserPaneRpcContracts[M]['params'];
  }
  if (p.axis !== 'horizontal' && p.axis !== 'vertical') throw new Error('Invalid Client Browser split direction.');
  return { ...base, workspaceId: identity(p.workspaceId), axis: p.axis, ...(p.sourcePaneId === undefined ? {} : { sourcePaneId: identity(p.sourcePaneId) }), ...(method === 'client-browser.pane.create' ? { initialUrl: clientBrowserInitialUrl(p.initialUrl) } : {}) } as ClientBrowserPaneRpcContracts[M]['params'];
}
export function parseClientBrowserPaneRpcResult<M extends ClientBrowserPaneRpcMethod>(method: M, value: unknown): ClientBrowserPaneRpcContracts[M]['result'] {
  const result = object(value);
  if (method === 'client-browser.pane.reconcile') {
    if (!Array.isArray(result.closedPaneIds) || result.closedPaneIds.length > 128) throw new Error('Invalid closed Client Browser identities.');
    return { closedPaneIds: result.closedPaneIds.map(identity) } as ClientBrowserPaneRpcContracts[M]['result'];
  }
  return { composition: parseWorkspaceComposition(result.composition) } as ClientBrowserPaneRpcContracts[M]['result'];
}
