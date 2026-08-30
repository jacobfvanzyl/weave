import {
  BROWSER_CONTROL_ERROR_CODES,
  type BrowserControlErrorCode,
  type BrowserControlInvokeParams,
  parseBrowserControlInvokeResult,
  type BrowserControlInvokeResult,
} from '@weave/product-protocol';

export class AlphaBrowserControlError extends Error {
  constructor(
    readonly code: BrowserControlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AlphaBrowserControlError';
  }
}

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
  tabId?: string;
  generation?: number;
  controlRevision?: number;
  agentControlEnabled: boolean;
  agentAccess: 'off' | 'observe' | 'control';
  controlTarget?: { threadId: string; title: string; controller: string };
  visible: boolean;
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
  | { type: 'reset' }
  | { type: 'control'; request: BrowserControlInvokeParams }
  | { type: 'control.cancel'; requestId: string };

export type AlphaBrowserSession = {
  getSnapshot(): AlphaBrowserState;
  subscribe(listener: () => void): () => void;
  send(command: AlphaBrowserCommand): boolean;
  execute(request: BrowserControlInvokeParams, signal?: AbortSignal): Promise<BrowserControlInvokeResult>;
  setVisible(visible: boolean): void;
  setAgentControlEnabled(enabled: boolean): void;
  setAgentAccess(access: 'off' | 'observe' | 'control'): void;
  setControlTarget(target?: { threadId: string; title: string; controller: string }): void;
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
const browserControlResultEvent = 'weave:alpha-browser-control-result';
const defaultBrowserUrl = 'https://example.com';

const initialState = (target: Window): AlphaBrowserState => ({
  supported: Boolean(target.webkit?.messageHandlers?.alphaBrowser),
  url: defaultBrowserUrl,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  agentControlEnabled: false,
  agentAccess: 'off',
  visible: false,
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
    tabId: typeof input.tabId === 'string' ? input.tabId : undefined,
    generation: Number.isSafeInteger(input.generation) ? Number(input.generation) : undefined,
    controlRevision: Number.isSafeInteger(input.controlRevision) ? Number(input.controlRevision) : undefined,
    agentControlEnabled: false,
    agentAccess: 'off',
    visible: false,
  };
};

export function createAlphaBrowserSession(
  target: Window = window,
  onUnused?: () => void,
): AlphaBrowserSession {
  let snapshot = initialState(target);
  let listening = false;
  let enabledAtRevision = 0;
  const listeners = new Set<() => void>();
  const pending = new Map<string, {
    resolve(value: BrowserControlInvokeResult): void;
    reject(cause: Error): void;
  }>();

  const receive = (event: Event) => {
    const next = browserState((event as CustomEvent).detail);
    if (!next) return;
    const controlRevision = next.controlRevision ?? snapshot.controlRevision ?? 0;
    const interrupted = snapshot.agentControlEnabled && controlRevision > enabledAtRevision;
    const replacedTab = snapshot.agentControlEnabled && Boolean(
      snapshot.tabId && next.tabId &&
        (snapshot.tabId !== next.tabId || snapshot.generation !== next.generation),
    );
    snapshot = {
      ...next,
      agentControlEnabled: interrupted || replacedTab ? false : snapshot.agentControlEnabled,
      agentAccess: interrupted || replacedTab ? 'off' : snapshot.agentAccess,
      controlTarget: snapshot.controlTarget,
      visible: snapshot.visible,
    };
    listeners.forEach((listener) => listener());
  };

  const receiveControlResult = (event: Event) => {
    const detail = (event as CustomEvent).detail as Record<string, unknown> | undefined;
    const requestId = typeof detail?.requestId === 'string' ? detail.requestId : undefined;
    if (!requestId) return;
    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId);
    try {
      if (detail?.error && typeof detail.error === 'object') {
        const error = detail.error as { code?: unknown; message?: unknown };
        const code = BROWSER_CONTROL_ERROR_CODES.includes(error.code as BrowserControlErrorCode)
          ? error.code as BrowserControlErrorCode
          : 'CONTROL_INTERRUPTED';
        request.reject(new AlphaBrowserControlError(
          code,
          typeof error.message === 'string' ? error.message : 'Browser control failed.',
        ));
      } else request.resolve(parseBrowserControlInvokeResult(detail?.result));
    } catch (cause) {
      request.reject(cause instanceof Error ? cause : new Error(String(cause)));
    }
  };

  const send = (command: AlphaBrowserCommand) => {
    const handler = target.webkit?.messageHandlers?.alphaBrowser;
    if (!handler) return false;
    handler.postMessage(command);
    if (
      command.type !== 'status' && command.type !== 'present' && command.type !== 'hide' &&
      command.type !== 'control' && command.type !== 'control.cancel' && snapshot.agentControlEnabled
    ) {
      snapshot = { ...snapshot, agentControlEnabled: false };
      snapshot.agentAccess = 'off';
      listeners.forEach((listener) => listener());
    }
    return true;
  };

  const start = () => {
    if (listening) return;
    listening = true;
    const supported = Boolean(target.webkit?.messageHandlers?.alphaBrowser);
    if (snapshot.supported !== supported) snapshot = { ...snapshot, supported };
    target.addEventListener(browserStateEvent, receive);
    target.addEventListener(browserControlResultEvent, receiveControlResult);
    send({ type: 'status' });
  };

  const stop = () => {
    if (!listening || listeners.size > 0) return;
    listening = false;
    target.removeEventListener(browserStateEvent, receive);
    target.removeEventListener(browserControlResultEvent, receiveControlResult);
    onUnused?.();
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
    execute: (request, signal) => {
      const needsControl = request.command.kind === 'act' || Boolean(request.command.url);
      if (
        !snapshot.agentControlEnabled || !snapshot.visible || snapshot.agentAccess === 'off' ||
        (needsControl && snapshot.agentAccess !== 'control')
      ) {
        return Promise.reject(new Error('Browser agent control is not enabled for the visible pane.'));
      }
      if (signal?.aborted) return Promise.reject(signal.reason);
      return new Promise((resolve, reject) => {
        const cancel = () => {
          pending.delete(request.requestId);
          send({ type: 'control.cancel', requestId: request.requestId });
          reject(signal?.reason instanceof Error ? signal.reason : new Error('Browser control was cancelled.'));
        };
        signal?.addEventListener('abort', cancel, { once: true });
        pending.set(request.requestId, {
          resolve: (value) => {
            signal?.removeEventListener('abort', cancel);
            resolve(value);
          },
          reject: (cause) => {
            signal?.removeEventListener('abort', cancel);
            reject(cause);
          },
        });
        if (!send({ type: 'control', request })) cancel();
      });
    },
    setVisible: (visible) => {
      if (snapshot.visible === visible) return;
      snapshot = { ...snapshot, visible };
      if (!visible) {
        snapshot.agentControlEnabled = false;
        snapshot.agentAccess = 'off';
      }
      listeners.forEach((listener) => listener());
    },
    setAgentControlEnabled: (enabled) => {
      const next = enabled && snapshot.supported && snapshot.visible;
      if (snapshot.agentControlEnabled === next) return;
      enabledAtRevision = snapshot.controlRevision ?? 0;
      snapshot = { ...snapshot, agentControlEnabled: next, agentAccess: next ? 'control' : 'off' };
      listeners.forEach((listener) => listener());
    },
    setAgentAccess: (access) => {
      const next = snapshot.supported && snapshot.visible && snapshot.controlTarget ? access : 'off';
      if (snapshot.agentAccess === next) return;
      enabledAtRevision = snapshot.controlRevision ?? 0;
      snapshot = { ...snapshot, agentControlEnabled: next !== 'off', agentAccess: next };
      listeners.forEach((listener) => listener());
    },
    setControlTarget: (target) => {
      if (
        snapshot.controlTarget?.threadId === target?.threadId &&
        snapshot.controlTarget?.controller === target?.controller &&
        snapshot.controlTarget?.title === target?.title
      ) return;
      const changedThread = snapshot.controlTarget?.threadId !== target?.threadId;
      snapshot = {
        ...snapshot,
        controlTarget: target,
        ...(changedThread ? { agentControlEnabled: false, agentAccess: 'off' as const } : {}),
      };
      listeners.forEach((listener) => listener());
    },
  };
}

let sharedSession: AlphaBrowserSession | undefined;
export const alphaBrowserSession = () =>
  sharedSession ??= createAlphaBrowserSession(window, () => sharedSession = undefined);
