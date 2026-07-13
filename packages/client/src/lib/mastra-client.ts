import {
  RpcConnection,
  type RpcConnectionState,
  type RpcHandler,
  type RpcNotificationHandler,
  WEAVE_RPC_PROTOCOL_VERSION,
} from '@weave/protocol';
import { getBuildClientAppId } from './client-app';
import { createClientId } from './client-id';

type MastraConnectionConfig = {
  mastraUrl?: string;
  authToken?: string | null;
};

type DesktopRpcBridge = {
  rpcRequest?: <T = unknown>(method: string, params?: unknown, options?: {
    timeoutMs?: number;
    requestId?: string;
  }) => Promise<T>;
  cancelRpcRequest?: (requestId: string) => void;
  rpcNotify?: (method: string, params?: unknown) => Promise<void>;
  onRpcConnectionState?: (listener: (state: RpcConnectionState) => void) => () => void;
  onRpcNotification?: (listener: (method: string, params: unknown) => void) => () => void;
  onRpcReverseRequest?: (listener: (requestId: string, method: string, params: unknown) => void) => () => void;
  respondRpcReverseRequest?: (requestId: string, result?: unknown, error?: { message: string }) => Promise<void>;
};

const getDefaultMastraUrl = () => {
  if (typeof window === 'undefined') return 'http://localhost:4111';
  return `${window.location.protocol}//${window.location.hostname}:4111`;
};

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');
const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};
const clientInstanceId = createClientId('client');

const initialMastraUrl = viteEnv.VITE_MASTRA_URL ?? getDefaultMastraUrl();
const initialAuthToken =
  typeof __WEAVE_AUTH_TOKEN__ === 'string' && __WEAVE_AUTH_TOKEN__.trim()
    ? __WEAVE_AUTH_TOKEN__.trim()
    : viteEnv.VITE_WEAVE_AUTH_TOKEN ?? null;

let connectionConfig = {
  mastraUrl: trimTrailingSlash(initialMastraUrl),
  authToken: initialAuthToken as string | null,
};

export const agentId = viteEnv.VITE_AGENT_ID ?? 'mage-hand';

const directConnection = new RpcConnection({
  serverUrl: connectionConfig.mastraUrl,
  initialize: () => ({
    protocolVersion: WEAVE_RPC_PROTOCOL_VERSION,
    role: 'client',
    token: connectionConfig.authToken ?? '',
    capabilities: ['client.editorContext.get'],
    client: {
      clientAppId: getBuildClientAppId(),
      clientInstanceId,
      name: typeof navigator === 'undefined' ? 'Weave client' : navigator.userAgent,
      active: true,
    },
  }),
});

const desktopBridge = (): DesktopRpcBridge | undefined => {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { weaveDesktop?: DesktopRpcBridge }).weaveDesktop;
};

const notificationHandlers = new Map<string, Set<RpcNotificationHandler>>();
let detachDesktopNotifications: (() => void) | undefined;
const reverseHandlers = new Map<string, RpcHandler>();
let detachDesktopReverseRequests: (() => void) | undefined;

const ensureDesktopNotificationBridge = () => {
  const bridge = desktopBridge();
  if (!bridge?.onRpcNotification || detachDesktopNotifications) return;
  detachDesktopNotifications = bridge.onRpcNotification((method, params) => {
    for (const handler of notificationHandlers.get(method) ?? []) void handler(params, method);
  });
};

const ensureDesktopReverseBridge = () => {
  const bridge = desktopBridge();
  if (!bridge?.onRpcReverseRequest || detachDesktopReverseRequests) return;
  detachDesktopReverseRequests = bridge.onRpcReverseRequest((requestId, method, params) => {
    const handler = reverseHandlers.get(method);
    if (!handler) {
      void bridge.respondRpcReverseRequest?.(requestId, undefined, { message: `Method not found: ${method}` });
      return;
    }
    const controller = new AbortController();
    void Promise.resolve(handler(params, { id: requestId, method, signal: controller.signal }))
      .then(result => bridge.respondRpcReverseRequest?.(requestId, result))
      .catch(error => bridge.respondRpcReverseRequest?.(requestId, undefined, {
        message: error instanceof Error ? error.message : String(error),
      }));
  });
};

export const configureMastraConnection = (config: MastraConnectionConfig) => {
  const next = {
    mastraUrl: config.mastraUrl ? trimTrailingSlash(config.mastraUrl) : connectionConfig.mastraUrl,
    authToken: Object.hasOwn(config, 'authToken') ? config.authToken ?? null : connectionConfig.authToken,
  };
  const changed = next.mastraUrl !== connectionConfig.mastraUrl || next.authToken !== connectionConfig.authToken;
  connectionConfig = next;
  if (changed && !desktopBridge()?.rpcRequest) {
    directConnection.configure({
      serverUrl: connectionConfig.mastraUrl,
      initialize: () => ({
        protocolVersion: WEAVE_RPC_PROTOCOL_VERSION,
        role: 'client',
        token: connectionConfig.authToken ?? '',
        capabilities: ['client.editorContext.get'],
        client: { clientAppId: getBuildClientAppId(), clientInstanceId, active: true },
      }),
    });
  }
};

export const getWeaveServerUrl = () => connectionConfig.mastraUrl;
export const getMastraUrl = getWeaveServerUrl;
export const getChatUrl = () => `${getWeaveServerUrl()}/rpc`;

/** @deprecated Application authentication is carried only by initialize over /rpc. */
export const getAuthHeaders = (): Record<string, string> => ({});

export const rpcRequest = async <T = unknown>(method: string, params?: unknown, options?: {
  timeoutMs?: number;
  signal?: AbortSignal;
}) => {
  const bridge = desktopBridge();
  if (bridge?.rpcRequest) {
    const signal = options?.signal;
    if (!signal) {
      return await bridge.rpcRequest<T>(
        method,
        params,
        options?.timeoutMs ? { timeoutMs: options.timeoutMs } : undefined,
      );
    }
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('Aborted', 'AbortError');
    }
    const requestId = `renderer_${crypto.randomUUID()}`;
    const abort = () => bridge.cancelRpcRequest?.(requestId);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      return await bridge.rpcRequest<T>(method, params, {
        ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        requestId,
      });
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  return await directConnection.request<T>(method, params, options);
};

export const rpcNotify = async (method: string, params?: unknown, priority?: number) => {
  const bridge = desktopBridge();
  if (bridge?.rpcNotify) return await bridge.rpcNotify(method, params);
  await directConnection.connect();
  directConnection.notify(method, params, priority);
};

export const onRpcNotification = (method: string, handler: RpcNotificationHandler) => {
  if (!desktopBridge()?.rpcRequest) return directConnection.onNotification(method, handler);
  const handlers = notificationHandlers.get(method) ?? new Set<RpcNotificationHandler>();
  handlers.add(handler);
  notificationHandlers.set(method, handlers);
  ensureDesktopNotificationBridge();
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) notificationHandlers.delete(method);
  };
};

export const registerRpcHandler = (method: string, handler: RpcHandler) => {
  if (!desktopBridge()?.rpcRequest) return directConnection.register(method, handler);
  if (reverseHandlers.has(method)) throw new Error(`RPC handler already registered: ${method}`);
  reverseHandlers.set(method, handler);
  ensureDesktopReverseBridge();
  return () => reverseHandlers.delete(method);
};

export const addRpcSubscription = (
  key: string,
  method: string,
  params: () => unknown,
  onResult?: (result: unknown) => void | Promise<void>,
  onError?: (error: unknown) => void | Promise<void>,
) => {
  if (desktopBridge()?.rpcRequest) {
    let disposed = false;
    let resuming = false;
    const resume = () => {
      if (disposed || resuming) return;
      resuming = true;
      void rpcRequest(method, params())
        .then(result => onResult?.(result))
        .catch(error => onError?.(error))
        .finally(() => {
          resuming = false;
        });
    };
    const detachState = desktopBridge()?.onRpcConnectionState?.(state => {
      if (state === 'connected') resume();
    });
    resume();
    return () => {
      disposed = true;
      detachState?.();
    };
  }
  return directConnection.addDurableSubscription(key, { method, params, onResult, onError });
};

export const onRpcConnectionState = (handler: (state: RpcConnectionState) => void) => {
  const bridge = desktopBridge();
  if (bridge?.rpcRequest) {
    if (bridge.onRpcConnectionState) return bridge.onRpcConnectionState(handler);
    handler('connected');
    return () => undefined;
  }
  return directConnection.onState(handler);
};

export const testRpcConnection = async (serverUrl: string, token: string) => {
  const connection = new RpcConnection({
    serverUrl,
    reconnect: false,
    initialize: {
      protocolVersion: WEAVE_RPC_PROTOCOL_VERSION,
      role: 'client',
      token,
      capabilities: [],
      client: { clientAppId: getBuildClientAppId(), clientInstanceId: createClientId('connection-test') },
    },
  });
  try {
    await connection.connect();
    return await connection.request<{ owner: { id: string; name: string } }>('owner.get');
  } finally {
    connection.close();
  }
};
