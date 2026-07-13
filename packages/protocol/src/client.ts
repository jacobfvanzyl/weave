import {
  type RpcHandler,
  type RpcNotificationHandler,
  RpcPeer,
  type RpcSocket,
} from "./peer.ts";
import {
  type RpcInitializeParams,
  type RpcInitializeResult,
  rpcInitializeResultSchema,
  rpcMethodNameSchema,
  WEAVE_RPC_PATH,
} from "./schema.ts";

export type RpcConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed";

export type RpcWebSocket = RpcSocket & {
  addEventListener(
    type: "open",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
  addEventListener(
    type: "error",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
};

export type RpcConnectionOptions = {
  serverUrl: string;
  initialize:
    | RpcInitializeParams
    | (() => RpcInitializeParams | Promise<RpcInitializeParams>);
  createSocket?: (url: string) => RpcWebSocket;
  reconnect?: boolean;
  reconnectDelayMs?: (attempt: number) => number;
};

type DurableSubscription = {
  method: string;
  params: () => unknown;
  onResult?: (result: unknown) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
};

const rpcUrl = (serverUrl: string) => {
  const url = new URL(serverUrl);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("RPC server URL must use http(s) or ws(s).");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${WEAVE_RPC_PATH}`;
  url.search = "";
  url.hash = "";
  return url.toString();
};

const defaultSocket = (url: string) =>
  new WebSocket(url) as unknown as RpcWebSocket;
const delayForAttempt = (attempt: number) =>
  Math.min(10_000, 250 * 2 ** Math.min(attempt, 5));

export class RpcConnection {
  private peer?: RpcPeer;
  private socket?: RpcWebSocket;
  private connecting?: Promise<RpcInitializeResult>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private stateValue: RpcConnectionState = "idle";
  private explicitlyClosed = false;
  private readonly notificationHandlers = new Map<
    string,
    Set<RpcNotificationHandler>
  >();
  private readonly anyNotificationHandlers = new Set<RpcNotificationHandler>();
  private readonly requestHandlers = new Map<string, RpcHandler>();
  private readonly stateHandlers = new Set<
    (state: RpcConnectionState) => void
  >();
  private readonly durableSubscriptions = new Map<
    string,
    DurableSubscription
  >();
  private initializeResult?: RpcInitializeResult;

  constructor(private options: RpcConnectionOptions) {}

  get state() {
    return this.stateValue;
  }

  get initialized() {
    return this.initializeResult;
  }

  configure(options: RpcConnectionOptions) {
    const changed =
      rpcUrl(options.serverUrl) !== rpcUrl(this.options.serverUrl) ||
      options.initialize !== this.options.initialize;
    this.options = options;
    if (changed) this.disconnect("RPC connection reconfigured.");
  }

  onState(handler: (state: RpcConnectionState) => void) {
    this.stateHandlers.add(handler);
    handler(this.stateValue);
    return () => this.stateHandlers.delete(handler);
  }

  onNotification(method: string, handler: RpcNotificationHandler) {
    const handlers = this.notificationHandlers.get(method) ??
      new Set<RpcNotificationHandler>();
    handlers.add(handler);
    this.notificationHandlers.set(method, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.notificationHandlers.delete(method);
    };
  }

  onAnyNotification(handler: RpcNotificationHandler) {
    this.anyNotificationHandlers.add(handler);
    return () => this.anyNotificationHandlers.delete(handler);
  }

  register(method: string, handler: RpcHandler) {
    rpcMethodNameSchema.parse(method);
    if (this.requestHandlers.has(method)) {
      throw new Error(`RPC handler already registered: ${method}`);
    }
    this.requestHandlers.set(method, handler);
    const detach = this.peer?.register(method, handler);
    return () => {
      detach?.();
      this.requestHandlers.delete(method);
    };
  }

  addDurableSubscription(key: string, subscription: DurableSubscription) {
    this.durableSubscriptions.set(key, subscription);
    if (this.stateValue === "connected") {
      void this.resumeSubscription(subscription);
    }
    return () => this.durableSubscriptions.delete(key);
  }

  async connect() {
    if (this.peer && this.stateValue === "connected" && this.initializeResult) {
      return this.initializeResult;
    }
    if (this.connecting) return await this.connecting;
    this.explicitlyClosed = false;
    this.setState(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");
    this.connecting = this.open();
    try {
      return await this.connecting;
    } catch (error) {
      if (!this.reconnectTimer) this.failOpen(this.socket, this.peer);
      throw error;
    } finally {
      this.connecting = undefined;
    }
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ) {
    rpcMethodNameSchema.parse(method);
    await this.connect();
    if (!this.peer || this.stateValue !== "connected") {
      throw new Error("RPC connection is not connected.");
    }
    return await this.peer.request<T>(method, params, options);
  }

  notify(method: string, params?: unknown, priority?: number) {
    rpcMethodNameSchema.parse(method);
    if (!this.peer || this.stateValue !== "connected") {
      throw new Error("RPC connection is not connected.");
    }
    this.peer.notify(method, params, priority);
  }

  disconnect(reason = "RPC connection disconnected.") {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.initializeResult = undefined;
    this.peer?.close(1000, reason);
    this.peer = undefined;
    this.socket = undefined;
    this.reconnectAttempt = 0;
    if (!this.explicitlyClosed) this.setState("idle");
  }

  close(reason = "RPC connection closed.") {
    this.explicitlyClosed = true;
    this.disconnect(reason);
    this.setState("closed");
  }

  private async open() {
    const socket = (this.options.createSocket ?? defaultSocket)(
      rpcUrl(this.options.serverUrl),
    );
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("RPC WebSocket connection failed.")),
        { once: true },
      );
    });
    if (this.socket !== socket) {
      throw new Error("RPC connection was superseded.");
    }

    const peer = new RpcPeer(socket, {
      onUnhandledNotification: async (params, method) => {
        const handlers = this.notificationHandlers.get(method);
        if (handlers) {
          for (const handler of handlers) await handler(params, method);
        }
        for (const handler of this.anyNotificationHandlers) {
          await handler(params, method);
        }
      },
      onClose: () => this.handleClosed(peer),
    });
    this.peer = peer;
    for (const [method, handler] of this.requestHandlers) {
      peer.register(method, handler);
    }
    peer.onNotification("connection.ping", (params) => {
      const nonce = params && typeof params === "object" && "nonce" in params
        ? (params as { nonce?: unknown }).nonce
        : undefined;
      peer.notify("connection.pong", {
        ...(typeof nonce === "string" ? { nonce } : {}),
        at: new Date().toISOString(),
      }, 0);
    });
    socket.addEventListener(
      "message",
      (event) => void peer.receive(event.data),
    );
    socket.addEventListener(
      "close",
      (event) =>
        peer.socketClosed(
          event.reason || `RPC socket closed (${event.code ?? 1006}).`,
        ),
    );

    const initialize = typeof this.options.initialize === "function"
      ? await this.options.initialize()
      : this.options.initialize;
    const rawResult = await peer.request("initialize", initialize, {
      timeoutMs: 5_000,
    });
    const result = rpcInitializeResultSchema.parse(rawResult);
    if (this.peer !== peer) {
      throw new Error("RPC connection was superseded during initialization.");
    }
    this.initializeResult = result;
    this.reconnectAttempt = 0;
    this.setState("connected");
    for (const subscription of this.durableSubscriptions.values()) {
      await this.resumeSubscription(subscription);
    }
    return result;
  }

  private failOpen(
    socket: RpcWebSocket | undefined,
    peer: RpcPeer | undefined,
  ) {
    this.initializeResult = undefined;
    if (this.peer === peer) this.peer = undefined;
    if (this.socket === socket) this.socket = undefined;
    if (peer) peer.close(1002, "RPC initialization failed.");
    else {
      try {
        socket?.close(1000, "RPC connection failed.");
      } catch {
        // The transport never reached an open state.
      }
    }
    if (this.explicitlyClosed || this.options.reconnect === false) {
      this.setState(this.explicitlyClosed ? "closed" : "idle");
      return;
    }
    this.reconnectAttempt += 1;
    this.setState("reconnecting");
    clearTimeout(this.reconnectTimer);
    const delay = (this.options.reconnectDelayMs ?? delayForAttempt)(
      this.reconnectAttempt,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => undefined);
    }, delay);
  }

  private async resumeSubscription(subscription: DurableSubscription) {
    try {
      const result = await this.peer?.request(
        subscription.method,
        subscription.params(),
      );
      if (result !== undefined) await subscription.onResult?.(result);
    } catch (error) {
      await subscription.onError?.(error);
      // The next reconnect will retry durable subscriptions. Mutations are never kept here.
    }
  }

  private handleClosed(peer: RpcPeer) {
    if (this.peer !== peer) return;
    this.peer = undefined;
    this.socket = undefined;
    this.initializeResult = undefined;
    if (this.explicitlyClosed || this.options.reconnect === false) {
      this.setState(this.explicitlyClosed ? "closed" : "idle");
      return;
    }
    this.reconnectAttempt += 1;
    this.setState("reconnecting");
    const delay = (this.options.reconnectDelayMs ?? delayForAttempt)(
      this.reconnectAttempt,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => undefined);
    }, delay);
  }

  private setState(state: RpcConnectionState) {
    if (this.stateValue === state) return;
    this.stateValue = state;
    for (const handler of this.stateHandlers) handler(state);
  }
}

export const weaveRpcUrl = rpcUrl;
