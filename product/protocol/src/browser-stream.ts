export const BROWSER_STREAM_CAPABILITY = 'browser.stream.v1';
export const BROWSER_EVENT_METHOD = 'browser.event';
export const BROWSER_RPC_METHODS = ['browser.tab.list', 'browser.tab.create', 'browser.tab.navigate', 'browser.tab.close', 'browser.view.attach', 'browser.view.focus', 'browser.view.signal', 'browser.view.frame', 'browser.view.click', 'browser.view.detach'] as const;
export type BrowserRpcMethod = typeof BROWSER_RPC_METHODS[number];
export type BrowserViewport = { width: number; height: number };
export type RemoteBrowserTab = { tabId: string; workspaceId: string; url: string; title: string; generation: number; viewport: BrowserViewport };
export type BrowserViewGrant = { viewId: string; workspaceId: string; tabId: string; expiresAt: number };
export type BrowserIceCandidate = { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null };
export type BrowserAnswer = { type: 'answer'; peer: string; sdp: string } | { type: 'ice'; peer: string; candidate: BrowserIceCandidate };
export type BrowserStreamMessage =
  | { type: 'reset'; tab: string; generation: number; peer?: string }
  | { type: 'offer'; tab: string; generation: number; peer: string; sdp: string }
  | { type: 'ice'; peer: string; candidate: BrowserIceCandidate }
  | { type: 'inputReady'; generation: number }
  | { type: 'revoked'; reason: string };
export type BrowserNotification = { workspaceId: string; viewId: string; message: BrowserStreamMessage };
type WorkspaceParams = { workspaceId: string };
type TabParams = WorkspaceParams & { tabId: string };
type ViewParams = WorkspaceParams & { viewId: string };
type Empty = Record<string, never>;
export type BrowserRpcContracts = {
  'browser.tab.list': { params: WorkspaceParams; result: { tabs: RemoteBrowserTab[] } };
  'browser.tab.create': { params: WorkspaceParams & { url: string }; result: { tab: RemoteBrowserTab } };
  'browser.tab.navigate': { params: TabParams & { url: string }; result: { tab: RemoteBrowserTab } };
  'browser.tab.close': { params: TabParams; result: Empty };
  'browser.view.attach': { params: TabParams & { mode: 'observe' | 'control' }; result: { grant: BrowserViewGrant } };
  'browser.view.focus': { params: ViewParams & BrowserViewport; result: Empty };
  'browser.view.signal': { params: ViewParams & { signal: BrowserAnswer }; result: Empty };
  'browser.view.frame': { params: ViewParams & BrowserViewport & { peer: string; generation: number }; result: Empty };
  'browser.view.click': { params: ViewParams & { x: number; y: number; generation: number }; result: Empty };
  'browser.view.detach': { params: ViewParams; result: Empty };
};
export function browserObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid browser object');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256, empty = false) {
  if (typeof value !== 'string' || (!empty && !value) || value.length > max || value.includes('\0')) throw new Error('Invalid browser text');
  return value;
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error('Invalid browser number');
  return Number(value);
}
export function parseBrowserViewport(value: unknown): BrowserViewport {
  const input = browserObject(value);
  return { width: integer(input.width, 320, 2560), height: integer(input.height, 240, 1600) };
}
export function browserUrl(value: unknown) {
  const url = text(value, 8192);
  if (url === 'about:blank') return url;
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported browser URL scheme');
  return parsed.href;
}
function candidate(value: unknown): BrowserIceCandidate {
  const input = browserObject(value);
  return { candidate: text(input.candidate, 4096, true),
    ...(input.sdpMid === undefined ? {} : { sdpMid: input.sdpMid === null ? null : text(input.sdpMid, 256, true) }),
    ...(input.sdpMLineIndex === undefined ? {} : { sdpMLineIndex: input.sdpMLineIndex === null ? null : integer(input.sdpMLineIndex, 0, 32) }) };
}
export function parseBrowserAnswer(value: unknown): BrowserAnswer {
  const input = browserObject(value), peer = text(input.peer);
  if (input.type === 'answer') return { type: 'answer', peer, sdp: text(input.sdp, 128 * 1024) };
  if (input.type === 'ice') return { type: 'ice', peer, candidate: candidate(input.candidate) };
  throw new Error('Invalid browser signaling message');
}
export function parseBrowserRpcParams<M extends BrowserRpcMethod>(method: M, value: unknown): BrowserRpcContracts[M]['params'] {
  const input = browserObject(value), workspaceId = text(input.workspaceId);
  let output: object;
  switch (method) {
    case 'browser.tab.list': output = { workspaceId }; break;
    case 'browser.tab.create': output = { workspaceId, url: browserUrl(input.url) }; break;
    case 'browser.tab.navigate': output = { workspaceId, tabId: text(input.tabId), url: browserUrl(input.url) }; break;
    case 'browser.tab.close': output = { workspaceId, tabId: text(input.tabId) }; break;
    case 'browser.view.attach':
      if (input.mode !== 'observe' && input.mode !== 'control') throw new Error('Invalid browser access mode');
      output = { workspaceId, tabId: text(input.tabId), mode: input.mode }; break;
    case 'browser.view.focus': output = { workspaceId, viewId: text(input.viewId), ...parseBrowserViewport(input) }; break;
    case 'browser.view.signal': output = { workspaceId, viewId: text(input.viewId), signal: parseBrowserAnswer(input.signal) }; break;
    case 'browser.view.frame': output = { workspaceId, viewId: text(input.viewId), peer: text(input.peer), generation: integer(input.generation, 1), ...parseBrowserViewport(input) }; break;
    case 'browser.view.click': {
      if (typeof input.x !== 'number' || !Number.isFinite(input.x) || input.x < 0 || input.x > 2560 || typeof input.y !== 'number' || !Number.isFinite(input.y) || input.y < 0 || input.y > 1600) throw new Error('Invalid browser coordinates');
      output = { workspaceId, viewId: text(input.viewId), generation: integer(input.generation, 1), x: input.x, y: input.y }; break;
    }
    case 'browser.view.detach': output = { workspaceId, viewId: text(input.viewId) }; break;
    default: throw new Error('Unknown browser operation');
  }
  return output as BrowserRpcContracts[M]['params'];
}
function tab(value: unknown): RemoteBrowserTab {
  const input = browserObject(value);
  return { workspaceId: text(input.workspaceId), tabId: text(input.tabId), url: text(input.url, 8192, true), title: text(input.title, 8192, true), generation: integer(input.generation, 0), viewport: parseBrowserViewport(input.viewport) };
}
export function parseBrowserRpcResult<M extends BrowserRpcMethod>(method: M, value: unknown): BrowserRpcContracts[M]['result'] {
  const input = browserObject(value);
  let output: object = {};
  if (method === 'browser.tab.list') {
    if (!Array.isArray(input.tabs) || input.tabs.length > 64) throw new Error('Invalid browser tab list');
    output = { tabs: input.tabs.map(tab) };
  } else if (method === 'browser.tab.create' || method === 'browser.tab.navigate') output = { tab: tab(input.tab) };
  else if (method === 'browser.view.attach') {
    const grant = browserObject(input.grant);
    output = { grant: { workspaceId: text(grant.workspaceId), tabId: text(grant.tabId), viewId: text(grant.viewId), expiresAt: integer(grant.expiresAt, 1) } };
  }
  return output as BrowserRpcContracts[M]['result'];
}
export function parseBrowserNotification(value: unknown): BrowserNotification {
  const input = browserObject(value), message = browserObject(input.message);
  let parsed: BrowserStreamMessage;
  switch (message.type) {
    case 'reset': parsed = { type: 'reset', tab: text(message.tab), generation: integer(message.generation, 1), ...(message.peer === undefined ? {} : { peer: text(message.peer) }) }; break;
    case 'offer': parsed = { type: 'offer', tab: text(message.tab), generation: integer(message.generation, 1), peer: text(message.peer), sdp: text(message.sdp, 128 * 1024) }; break;
    case 'ice': parsed = { type: 'ice', peer: text(message.peer), candidate: candidate(message.candidate) }; break;
    case 'inputReady': parsed = { type: 'inputReady', generation: integer(message.generation, 1) }; break;
    case 'revoked': parsed = { type: 'revoked', reason: text(message.reason, 1024) }; break;
    default: throw new Error('Invalid browser event');
  }
  return { workspaceId: text(input.workspaceId), viewId: text(input.viewId), message: parsed };
}
