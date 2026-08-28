import { PORTAL_RPC_PATH } from '@weave/product-protocol';

export const DEFAULT_PORTAL_PORT = '4122';
export const DEFAULT_PORTAL_ADDRESS = '127.0.0.1';

const hasScheme = (value: string) => /^[a-z][a-z\d+.-]*:\/\//i.test(value);
const isLoopbackHost = (hostname: string) => {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized.endsWith('.localhost') ||
    normalized === '[::1]' || normalized === '::1' ||
    normalized === '0.0.0.0' || normalized.startsWith('127.');
};

export function portalWebSocketUrl(address: string) {
  const value = address.trim();
  if (!value) throw new Error('Portal URL is required.');

  const explicitScheme = hasScheme(value);
  const url = new URL(explicitScheme ? value : `ws://${value}`);
  if (!explicitScheme && !isLoopbackHost(url.hostname)) url.protocol = 'wss:';
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('Portal URL must use ws, wss, http, or https.');
  }
  if (!url.port) url.port = DEFAULT_PORTAL_PORT;
  url.pathname = PORTAL_RPC_PATH;
  url.search = '';
  url.hash = '';
  return url;
}

export function portalHostName(address: string) {
  try {
    return portalWebSocketUrl(address).hostname || 'Portal';
  } catch {
    return 'Portal';
  }
}
