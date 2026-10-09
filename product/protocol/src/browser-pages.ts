import { browserProfileId } from './browser-profiles.ts';

export const BROWSER_PAGES_CAPABILITY = 'browser.pages.v1';
export const PORTAL_BROWSER_RFB_PATH = '/browser/rfb';
export const BROWSER_PAGE_RPC_METHODS = [
  'browser.page.list', 'browser.page.get', 'browser.page.restore',
  'browser.page.navigate', 'browser.page.back', 'browser.page.forward', 'browser.page.reload',
  'browser.page.view.attach', 'browser.page.view.focus', 'browser.page.view.resize',
  'browser.page.view.input', 'browser.page.view.interaction', 'browser.page.view.context', 'browser.page.view.detach',
] as const;
export type BrowserPageRpcMethod = typeof BROWSER_PAGE_RPC_METHODS[number];
export type HostBrowserPage = {
  pageId: string; profileId: string; title: string; url: string; available: boolean; faviconUrl?: string;
  generation?: string; openerPageId?: string; width?: number; height?: number; deviceScaleFactor?: number;
  canGoBack?: boolean; canGoForward?: boolean; temporary?: boolean; profileLocked?: boolean;
};
type Address = { profileId: string; pageId: string };
type LiveAddress = Address & { generation: string };
type ViewAddress = { viewId: string };
// Page geometry is in logical pixels; RFB rectangles are physical pixels.
export const BROWSER_FRAMEBUFFER_MAX_DIMENSION = 8192;
export const BROWSER_FRAMEBUFFER_MAX_PIXELS = 16_777_216;
export type BrowserPageViewport = { width: number; height: number; deviceScaleFactor?: number };
export function browserFramebufferSize(viewport: BrowserPageViewport) {
  const scale = Math.fround(viewport.deviceScaleFactor ?? 1);
  return { width: Math.ceil(viewport.width * scale), height: Math.ceil(viewport.height * scale) };
}
export function browserViewportScale(width: number, height: number, requested: number) {
  // Quantize down so rounding up physical dimensions stays within the budget.
  let scale = Math.floor(Math.min(Math.max(1, requested), 2) * 64) / 64;
  while (scale > 1) {
    const pixels = browserFramebufferSize({ width, height, deviceScaleFactor: scale });
    if (pixels.width <= BROWSER_FRAMEBUFFER_MAX_DIMENSION && pixels.height <= BROWSER_FRAMEBUFFER_MAX_DIMENSION && pixels.width * pixels.height <= BROWSER_FRAMEBUFFER_MAX_PIXELS) break;
    scale -= 1 / 64;
  }
  return scale;
}
export type BrowserFocus = BrowserPageViewport & { viewId: string; generation: string; focusEpoch: number };
export type BrowserInputMethod = 'Input.dispatchMouseEvent' | 'Input.dispatchKeyEvent' | 'Input.insertText';
export type BrowserContext = { text:string; canCopy:boolean; canCut:boolean; canPaste:boolean; canSelectAll:boolean };
export type BrowserPageRpcContracts = {
  'browser.page.list': { params: { profileId: string }; result: { pages: HostBrowserPage[] } };
  'browser.page.get': { params: Address; result: { page: HostBrowserPage } };
  'browser.page.restore': { params: Address; result: { page: HostBrowserPage } };
  'browser.page.navigate': { params: LiveAddress & { url: string }; result: { page: HostBrowserPage } };
  'browser.page.back': { params: LiveAddress; result: { page: HostBrowserPage } };
  'browser.page.forward': { params: LiveAddress; result: { page: HostBrowserPage } };
  'browser.page.reload': { params: LiveAddress; result: { page: HostBrowserPage } };
  'browser.page.view.attach': { params: LiveAddress & { mode: 'observe' | 'control' }; result: { viewId: string; ticket: string; expiresAt: number; path: typeof PORTAL_BROWSER_RFB_PATH } };
  'browser.page.view.focus': { params: ViewAddress & BrowserPageViewport; result: BrowserFocus };
  'browser.page.view.resize': { params: ViewAddress & BrowserPageViewport & { focusEpoch: number }; result: BrowserFocus };
  'browser.page.view.input': { params: ViewAddress & { focusEpoch: number; method: BrowserInputMethod; arguments: Record<string, unknown> }; result: Record<string, never> };
  'browser.page.view.interaction': { params: ViewAddress & { focusEpoch: number }; result: { cursor: number; text: string; inputMode:number } };
  'browser.page.view.context': { params: ViewAddress & { focusEpoch:number; x:number; y:number }; result: BrowserContext };
  'browser.page.view.detach': { params: ViewAddress; result: Record<string, never> };
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Browser page object');
  return value as Record<string, unknown>;
};
const keys = (value: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unexpected Browser page parameter');
};
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) throw new Error('Invalid Browser page integer');
  return Number(value);
};
export function browserPageUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid browser URL');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) && value !== 'about:blank' || url.username || url.password) throw new Error('Unsupported browser URL');
  return url.href;
}
/** Optional site metadata must never make the page itself unavailable. */
export function browserFaviconUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 65536) return;
  try {
    const url = new URL(value);
    if (url.username || url.password) return;
    if (['http:', 'https:'].includes(url.protocol) || /^data:image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml)[;,]/i.test(value)) return value;
  } catch { /* Discard malformed icons while retaining page metadata. */ }
}
function viewport(value: Record<string, unknown>): BrowserPageViewport {
  const width = integer(value.width, 4096), height = integer(value.height, 4096);
  if (width * height > 8388608) throw new Error('Browser viewport too large');
  const scale = value.deviceScaleFactor ?? 1;
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 1 || scale > 2) throw new Error('Invalid Browser device scale');
  const pixels = browserFramebufferSize({ width, height, deviceScaleFactor: scale });
  if (pixels.width > BROWSER_FRAMEBUFFER_MAX_DIMENSION || pixels.height > BROWSER_FRAMEBUFFER_MAX_DIMENSION || pixels.width * pixels.height > BROWSER_FRAMEBUFFER_MAX_PIXELS) throw new Error('Browser framebuffer too large');
  return { width, height, ...(value.deviceScaleFactor === undefined ? {} : { deviceScaleFactor: scale }) };
}
export function parseBrowserPage(value: unknown): HostBrowserPage {
  const page = object(value);
  const faviconUrl = browserFaviconUrl(page.faviconUrl);
  if (typeof page.title !== 'string' || page.title.length > 1024 || typeof page.available !== 'boolean') throw new Error('Invalid Browser page');
  return {
    pageId: browserProfileId(page.pageId), profileId: browserProfileId(page.profileId),
    title: page.title, url: browserPageUrl(page.url), available: page.available, temporary: page.temporary === true, profileLocked: page.profileLocked === true,
    ...(faviconUrl ? { faviconUrl } : {}),
    ...(page.openerPageId === undefined ? {} : { openerPageId: browserProfileId(page.openerPageId) }),
    ...(page.available ? { generation: browserProfileId(page.generation), ...viewport(page),
      canGoBack: page.canGoBack === true, canGoForward: page.canGoForward === true } : {}),
  };
}
export function parseBrowserPageRpcParams<M extends BrowserPageRpcMethod>(method: M, value: unknown): BrowserPageRpcContracts[M]['params'] {
  const input = object(value);
  let result: object;
  if (method.startsWith('browser.page.view.') && method !== 'browser.page.view.attach') {
    const viewId = browserProfileId(input.viewId);
    if (method === 'browser.page.view.detach') { keys(input, ['viewId']); result = { viewId }; }
    else if (method === 'browser.page.view.context') { keys(input,['viewId','focusEpoch','x','y']); if(typeof input.x!=='number' || typeof input.y!=='number')throw new Error('Invalid context menu point'); result={viewId,focusEpoch:integer(input.focusEpoch),x:integer(Number(input.x)+1,4097)-1,y:integer(Number(input.y)+1,4097)-1}; }
    else if (method === 'browser.page.view.interaction') { keys(input, ['viewId', 'focusEpoch']); result = { viewId, focusEpoch: integer(input.focusEpoch) }; }
    else if (method === 'browser.page.view.input') {
      keys(input, ['viewId', 'focusEpoch', 'method', 'arguments']);
      if (!['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText'].includes(String(input.method))) throw new Error('Unsupported browser input');
      const args = object(input.arguments);
      if (JSON.stringify(args).length > 32768) throw new Error('Browser input too large');
      result = { viewId, focusEpoch: integer(input.focusEpoch), method: input.method, arguments: args };
    } else {
      keys(input, ['viewId', 'width', 'height', 'deviceScaleFactor', ...(method === 'browser.page.view.resize' ? ['focusEpoch'] : [])]);
      result = { viewId, ...viewport(input), ...(method === 'browser.page.view.resize' ? { focusEpoch: integer(input.focusEpoch) } : {}) };
    }
  } else {
    const profileId = browserProfileId(input.profileId);
    if (method === 'browser.page.list') { keys(input, ['profileId']); result = { profileId }; }
    else {
      const address = { profileId, pageId: browserProfileId(input.pageId) };
      if (method === 'browser.page.get' || method === 'browser.page.restore') { keys(input, ['profileId', 'pageId']); result = address; }
      else {
        const live = { ...address, generation: browserProfileId(input.generation) };
        if (method === 'browser.page.view.attach') {
          keys(input, ['profileId', 'pageId', 'generation', 'mode']);
          if (input.mode !== 'observe' && input.mode !== 'control') throw new Error('Invalid browser view mode');
          result = { ...live, mode: input.mode };
        } else {
          keys(input, ['profileId', 'pageId', 'generation', ...(method === 'browser.page.navigate' ? ['url'] : [])]);
          result = { ...live, ...(method === 'browser.page.navigate' ? { url: browserPageUrl(input.url) } : {}) };
        }
      }
    }
  }
  return result as BrowserPageRpcContracts[M]['params'];
}
export function parseBrowserPageRpcResult<M extends BrowserPageRpcMethod>(method: M, value: unknown): BrowserPageRpcContracts[M]['result'] {
  const input = object(value);
  let result: object;
  if (method === 'browser.page.list') {
    if (!Array.isArray(input.pages) || input.pages.length > 256) throw new Error('Invalid browser page list');
    const pages = input.pages.map(parseBrowserPage);
    if (new Set(pages.map(page => page.pageId)).size !== pages.length) throw new Error('Duplicate browser page');
    result = { pages };
  } else if (method === 'browser.page.view.attach') {
    if (input.path !== PORTAL_BROWSER_RFB_PATH) throw new Error('Invalid browser stream path');
    result = { viewId: browserProfileId(input.viewId), ticket: browserProfileId(input.ticket), expiresAt: integer(input.expiresAt), path: PORTAL_BROWSER_RFB_PATH };
  } else if (method === 'browser.page.view.focus' || method === 'browser.page.view.resize') {
    result = { viewId: browserProfileId(input.viewId), generation: browserProfileId(input.generation), focusEpoch: integer(input.focusEpoch), ...viewport(input) };
  } else if (method === 'browser.page.view.interaction') {
    if (!Number.isInteger(input.cursor) || Number(input.cursor) < 0 || Number(input.cursor) > 50 || typeof input.text !== 'string' || input.text.length > 32768) throw new Error('Invalid Browser interaction');
    if(input.inputMode!==undefined && (!Number.isInteger(input.inputMode) || Number(input.inputMode)<0 || Number(input.inputMode)>8))throw new Error('Invalid Browser input mode');
    result = { cursor: input.cursor, text: input.text, inputMode:input.inputMode ?? 1 };
  } else if(method==='browser.page.view.context') {
    if(input.text!==undefined && (typeof input.text!=='string' || input.text.length>32768))throw new Error('Invalid Browser context');
    result={text:input.text ?? '',canCopy:input.canCopy===true,canCut:input.canCut===true,canPaste:input.canPaste===true,canSelectAll:input.canSelectAll===true};
  } else if (method === 'browser.page.view.input' || method === 'browser.page.view.detach') result = {};
  else result = { page: parseBrowserPage(input.page) };
  return result as BrowserPageRpcContracts[M]['result'];
}
