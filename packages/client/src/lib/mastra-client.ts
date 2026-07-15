import {
  RpcConnection,
  type RpcConnectionHandler,
  type DesktopRpcNotificationEnvelope,
  type DesktopRpcNotifyEnvelope,
  type DesktopRpcRequestEnvelope,
  type DesktopRpcResponseEnvelope,
  type DesktopRpcReverseRequestEnvelope,
  type DesktopRpcReverseResponseEnvelope,
  type RpcConnectionState,
  type RpcHandler,
  type RpcNotificationMethod,
  type RpcNotificationData,
  type RpcNotificationParams,
  type RpcNotificationHandler,
  type RpcRequestArguments,
  type RpcRequestMethod,
  type RpcRequestParams,
  type RpcRequestParsedParams,
  type RpcRequestResult,
  parseDesktopRpcNotifyEnvelope,
  parseDesktopRpcRequestEnvelope,
  parseDesktopRpcReverseResponseEnvelope,
  parseRpcRequestResult,
  RpcRemoteError,
  WEAVE_RPC_PROTOCOL_VERSION,
} from '@weave/protocol';
import { getBuildClientAppId } from './client-app';
import { createClientId } from './client-id';

type MastraConnectionConfig = {
  mastraUrl?: string;
  authToken?: string | null;
};

type DesktopRpcBridge = {
  rpcRequest?: <Method extends RpcRequestMethod<'client', 'server'>>(
    request: DesktopRpcRequestEnvelope<Method>,
  ) => Promise<DesktopRpcResponseEnvelope<Method>>;
  cancelRpcRequest?: (requestId: string) => void;
  rpcNotify?: <Method extends RpcNotificationMethod<'client', 'server'>>(
    notification: DesktopRpcNotifyEnvelope<Method>,
  ) => Promise<void>;
  onRpcConnectionState?: (listener: (state: RpcConnectionState) => void) => () => void;
  onRpcNotification?: (listener: (notification: DesktopRpcNotificationEnvelope) => void) => () => void;
  onRpcReverseRequest?: (listener: (request: DesktopRpcReverseRequestEnvelope) => void) => () => void;
  respondRpcReverseRequest?: (response: DesktopRpcReverseResponseEnvelope) => Promise<void>;
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
  detachDesktopNotifications = bridge.onRpcNotification(({ method, params }) => {
    for (const handler of notificationHandlers.get(method) ?? []) void handler(params, method);
  });
};

const ensureDesktopReverseBridge = () => {
  const bridge = desktopBridge();
  if (!bridge?.onRpcReverseRequest || detachDesktopReverseRequests) return;
  detachDesktopReverseRequests = bridge.onRpcReverseRequest(({ requestId, method, params }) => {
    const handler = reverseHandlers.get(method);
    if (!handler) {
      void bridge.respondRpcReverseRequest?.({
        kind: 'reverse-error', requestId, method, error: { code: -32601, message: `Method not found: ${method}` },
      });
      return;
    }
    const controller = new AbortController();
    void Promise.resolve(handler(params, { id: requestId, method, signal: controller.signal }))
      .then(result => bridge.respondRpcReverseRequest?.(parseDesktopRpcReverseResponseEnvelope({
        kind: 'reverse-success', requestId, method, result,
      }, method)))
      .catch(error => bridge.respondRpcReverseRequest?.({
        kind: 'reverse-error', requestId, method, error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
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

export const rpcRequest = async <Method extends RpcRequestMethod<'client', 'server'>>(
  method: Method,
  ...args: RpcRequestArguments<'client', 'server', Method>
): Promise<RpcRequestResult<'client', 'server', Method>> => {
  const [params, options] = args as [
    RpcRequestParams<'client', 'server', Method>,
    { timeoutMs?: number; signal?: AbortSignal }?,
  ];
  const bridge = desktopBridge();
  if (bridge?.rpcRequest) {
    const signal = options?.signal;
    if (!signal) {
      const request = parseDesktopRpcRequestEnvelope<Method>({
        kind: 'request',
        requestId: `renderer_${crypto.randomUUID()}`,
        method,
        params,
        options: options?.timeoutMs ? { timeoutMs: options.timeoutMs } : undefined,
      }, method);
      const response = await bridge.rpcRequest(request);
      if (response.kind === 'error') {
        throw new RpcRemoteError(response.error.code, response.error.message, response.error.data);
      }
      return parseRpcRequestResult('client', 'server', method, response.result);
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
      const request = parseDesktopRpcRequestEnvelope<Method>({
        kind: 'request',
        requestId,
        method,
        params,
        options: options?.timeoutMs ? { timeoutMs: options.timeoutMs } : undefined,
      }, method);
      const response = await bridge.rpcRequest(request);
      if (response.kind === 'error') {
        throw new RpcRemoteError(response.error.code, response.error.message, response.error.data);
      }
      return parseRpcRequestResult('client', 'server', method, response.result);
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  return await directConnection.request(method, params, options);
};

export const rpcNotify = async <Method extends RpcNotificationMethod<'client', 'server'>>(
  method: Method,
  params: RpcNotificationParams<'client', 'server', Method>,
  priority?: number,
) => {
  const bridge = desktopBridge();
  if (bridge?.rpcNotify) {
    return await bridge.rpcNotify(parseDesktopRpcNotifyEnvelope<Method>(
      { kind: 'notification', method, params },
      method,
    ));
  }
  await directConnection.connect();
  directConnection.notify(method, params, priority);
};

export const onRpcNotification = <Method extends RpcNotificationMethod<'server', 'client'>>(
  method: Method,
  handler: (
    params: RpcNotificationData<'server', 'client', Method>,
    method: Method,
  ) => void | Promise<void>,
) => {
  if (!desktopBridge()?.rpcRequest) return directConnection.onNotification(method, handler);
  const handlers = notificationHandlers.get(method) ?? new Set<RpcNotificationHandler>();
  const rawHandler = handler as RpcNotificationHandler;
  handlers.add(rawHandler);
  notificationHandlers.set(method, handlers);
  ensureDesktopNotificationBridge();
  return () => {
    handlers.delete(rawHandler);
    if (handlers.size === 0) notificationHandlers.delete(method);
  };
};

export const registerRpcHandler = <Method extends RpcRequestMethod<'server', 'client'>>(
  method: Method,
  handler: RpcConnectionHandler<'client', Method>,
) => {
  if (!desktopBridge()?.rpcRequest) return directConnection.register(method, handler);
  if (reverseHandlers.has(method)) throw new Error(`RPC handler already registered: ${method}`);
  reverseHandlers.set(method, handler as RpcHandler);
  ensureDesktopReverseBridge();
  return () => reverseHandlers.delete(method);
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
    return await connection.request('owner.get');
  } finally {
    connection.close();
  }
};
