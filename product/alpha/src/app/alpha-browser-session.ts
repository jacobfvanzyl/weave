export type AlphaBrowserPolicy = {
  popups: 'same-session';
  uploads: 'system-picker';
  downloads: 'unavailable';
  mediaPermissions: 'denied';
  otherPermissions: 'webkit-default';
};

export type AlphaBrowserState = {
  supported: boolean;
  url: string;
  title?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  notice?: string;
  policy?: AlphaBrowserPolicy;
  error?: string;
};

export type AlphaBrowserFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type AlphaBrowserCommand =
  | { type: 'status' }
  | { type: 'present'; frame: AlphaBrowserFrame }
  | { type: 'hide' }
  | { type: 'navigate'; url: string }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'reload' }
  | { type: 'stop' }
  | { type: 'reset' };

export type AlphaBrowserSession = {
  getSnapshot(): AlphaBrowserState;
  subscribe(listener: () => void): () => void;
  send(command: AlphaBrowserCommand): boolean;
};

type AlphaBrowserMessageHandler = {
  postMessage(command: AlphaBrowserCommand): void;
};

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        alphaBrowser?: AlphaBrowserMessageHandler;
      };
    };
  }
}

const browserStateEvent = 'weave:alpha-browser-state';
const defaultBrowserUrl = 'https://example.com';

const initialState = (target: Window): AlphaBrowserState => ({
  supported: Boolean(target.webkit?.messageHandlers?.alphaBrowser),
  url: defaultBrowserUrl,
  loading: false,
  canGoBack: false,
  canGoForward: false,
});

const browserPolicy = (value: unknown): AlphaBrowserPolicy | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const input = value as Partial<AlphaBrowserPolicy>;
  if (
    input.popups !== 'same-session' ||
    input.uploads !== 'system-picker' ||
    input.downloads !== 'unavailable' ||
    input.mediaPermissions !== 'denied' ||
    input.otherPermissions !== 'webkit-default'
  ) return;
  return {
    popups: input.popups,
    uploads: input.uploads,
    downloads: input.downloads,
    mediaPermissions: input.mediaPermissions,
    otherPermissions: input.otherPermissions,
  };
};

const browserState = (value: unknown): AlphaBrowserState | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const input = value as Partial<AlphaBrowserState>;
  if (
    typeof input.supported !== 'boolean' ||
    typeof input.url !== 'string' ||
    typeof input.loading !== 'boolean' ||
    typeof input.canGoBack !== 'boolean' ||
    typeof input.canGoForward !== 'boolean'
  ) return;
  return {
    supported: input.supported,
    url: input.url,
    title: typeof input.title === 'string' ? input.title : undefined,
    loading: input.loading,
    canGoBack: input.canGoBack,
    canGoForward: input.canGoForward,
    notice: typeof input.notice === 'string' ? input.notice : undefined,
    policy: browserPolicy(input.policy),
    error: typeof input.error === 'string' ? input.error : undefined,
  };
};

export function createAlphaBrowserSession(
  target: Window = window,
): AlphaBrowserSession {
  let snapshot = initialState(target);
  let listening = false;
  const listeners = new Set<() => void>();

  const receive = (event: Event) => {
    const next = browserState((event as CustomEvent).detail);
    if (!next) return;
    snapshot = next;
    listeners.forEach((listener) => listener());
  };

  const send = (command: AlphaBrowserCommand) => {
    const handler = target.webkit?.messageHandlers?.alphaBrowser;
    if (!handler) return false;
    handler.postMessage(command);
    return true;
  };

  const start = () => {
    if (listening) return;
    listening = true;
    const supported = Boolean(target.webkit?.messageHandlers?.alphaBrowser);
    if (snapshot.supported !== supported) snapshot = { ...snapshot, supported };
    target.addEventListener(browserStateEvent, receive);
    send({ type: 'status' });
  };

  const stop = () => {
    if (!listening || listeners.size > 0) return;
    listening = false;
    target.removeEventListener(browserStateEvent, receive);
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
        stop();
      };
    },
    send,
  };
}
