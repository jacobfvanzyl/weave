import {
  getRpcContract,
  type JsonRpcErrorObject,
  type JsonRpcId,
  type JsonRpcMessage,
  jsonRpcMessageSchema,
  type JsonValue,
  parseRpcNotificationParams,
  parseRpcRequestParams,
  parseRpcRequestResult,
  rpcCloseCode,
  RpcContractError,
  rpcErrorCode,
  type RpcRequestOptions,
  type RpcRole,
  WEAVE_RPC_MAX_FRAME_BYTES,
} from "./schema.ts";

export type RpcSocket = {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type RpcHandlerContext<Method extends string = string> = {
  id: JsonRpcId;
  method: Method;
  signal: AbortSignal;
};

export type RpcHandler = (
  params: unknown,
  context: RpcHandlerContext,
) => unknown | Promise<unknown>;
export type RpcNotificationHandler = (
  params: unknown,
  method: string,
) => void | Promise<void>;

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

type OutboundItem = {
  data: string;
  priority: number;
};

export type RpcPeerOptions = {
  localRole?: RpcRole;
  remoteRole?: RpcRole;
  maxFrameBytes?: number;
  requestTimeoutMs?: number;
  highWatermarkBytes?: number;
  hardLimitBytes?: number;
  onUnhandledNotification?: RpcNotificationHandler;
  onError?: (error: Error) => void;
  onClose?: (info?: { code?: number; reason?: string }) => void;
  createId?: () => JsonRpcId;
};

export class RpcRemoteError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: JsonValue,
  ) {
    super(message);
    this.name = "RpcRemoteError";
  }
}

export class RpcApplicationError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcApplicationError";
  }
}

const jsonByteLength = (value: string) =>
  new TextEncoder().encode(value).byteLength;

const awaitJsonValue = (value: unknown): JsonValue | undefined => {
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const parsed = awaitJsonValue(item);
      if (parsed === undefined) return undefined;
      items.push(parsed);
    }
    return items;
  }
  if (value && typeof value === "object") {
    const record: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const parsed = awaitJsonValue(item);
      if (parsed === undefined) return undefined;
      record[key] = parsed;
    }
    return record;
  }
  return undefined;
};

export class RpcPeer {
  private readonly handlers = new Map<string, RpcHandler>();
  private readonly notificationHandlers = new Map<
    string,
    Set<RpcNotificationHandler>
  >();
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly active = new Map<JsonRpcId, AbortController>();
  private readonly outbound: OutboundItem[] = [];
  private readonly maxFrameBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly highWatermarkBytes: number;
  private readonly hardLimitBytes: number;
  private readonly createId: () => JsonRpcId;
  private queuedBytes = 0;
  private nextId = 0;
  private flushing = false;
  private closed = false;
  private localRole?: RpcRole;
  private remoteRole?: RpcRole;

  constructor(
    private readonly socket: RpcSocket,
    private readonly options: RpcPeerOptions = {},
  ) {
    this.maxFrameBytes = options.maxFrameBytes ?? WEAVE_RPC_MAX_FRAME_BYTES;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.highWatermarkBytes = options.highWatermarkBytes ?? 4 * 1024 * 1024;
    this.hardLimitBytes = options.hardLimitBytes ?? 16 * 1024 * 1024;
    this.createId = options.createId ?? (() => `${++this.nextId}`);
    this.localRole = options.localRole;
    this.remoteRole = options.remoteRole;
  }

  setRoles(localRole: RpcRole, remoteRole: RpcRole) {
    if (
      (this.localRole && this.localRole !== localRole) ||
      (this.remoteRole && this.remoteRole !== remoteRole)
    ) {
      throw new Error("RPC peer roles cannot change after assignment.");
    }
    this.localRole = localRole;
    this.remoteRole = remoteRole;
  }

  register(method: string, handler: RpcHandler) {
    if (this.handlers.has(method)) {
      throw new Error(`RPC handler already registered: ${method}`);
    }
    this.handlers.set(method, handler);
    return () => this.handlers.delete(method);
  }

  onNotification(method: string, handler: RpcNotificationHandler) {
    const handlers = this.notificationHandlers.get(method) ??
      new Set<RpcNotificationHandler>();
    const rawHandler = handler as RpcNotificationHandler;
    handlers.add(rawHandler);
    this.notificationHandlers.set(method, handlers);
    return () => {
      handlers.delete(rawHandler);
      if (handlers.size === 0) this.notificationHandlers.delete(method);
    };
  }

  request(
    method: string,
    unvalidatedParams?: unknown,
    options: RpcRequestOptions = {},
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("RPC connection is closed."));
    }
    let params = unvalidatedParams;
    if (this.localRole && this.remoteRole) {
      const contract = getRpcContract(
        "request",
        this.localRole,
        this.remoteRole,
        method,
      );
      if (!contract) {
        return Promise.reject(
          new Error(
            `RPC request is not allowed for ${this.localRole} -> ${this.remoteRole}: ${method}`,
          ),
        );
      }
      try {
        params = parseRpcRequestParams(
          this.localRole,
          this.remoteRole,
          method,
          unvalidatedParams,
        );
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const id = this.createId();
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = {
        method,
        resolve,
        reject,
      };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          this.sendNotification("connection.cancel", { id }, 2);
          reject(new Error(`RPC request timed out: ${method}`));
        }, timeoutMs);
      }
      this.pending.set(id, pending);
      if (options.signal) {
        const abort = () => {
          if (!this.pending.delete(id)) return;
          if (pending.timer) clearTimeout(pending.timer);
          this.sendNotification("connection.cancel", { id }, 2);
          reject(
            options.signal?.reason instanceof Error
              ? options.signal.reason
              : new DOMException("Aborted", "AbortError"),
          );
        };
        if (options.signal.aborted) abort();
        else options.signal.addEventListener("abort", abort, { once: true });
      }
      if (this.pending.has(id)) {
        this.enqueue({
          jsonrpc: "2.0",
          id,
          method,
          ...(params === undefined ? {} : { params }),
        }, 0);
      }
    });
  }

  notify(
    method: string,
    params?: unknown,
    priority = 2,
  ) {
    this.sendNotification(method, params, priority);
  }

  private sendNotification(method: string, params: unknown, priority: number) {
    if (this.closed) return;
    let validatedParams: unknown = params;
    if (this.localRole && this.remoteRole) {
      const contract = getRpcContract(
        "notification",
        this.localRole,
        this.remoteRole,
        method,
      );
      if (!contract) {
        throw new Error(
          `RPC notification is not allowed for ${this.localRole} -> ${this.remoteRole}: ${method}`,
        );
      }
      validatedParams = parseRpcNotificationParams(
        this.localRole,
        this.remoteRole,
        method,
        params,
      );
    }
    this.enqueue({
      jsonrpc: "2.0",
      method,
      ...(validatedParams === undefined ? {} : { params: validatedParams }),
    }, priority);
  }

  async receive(data: unknown) {
    if (this.closed) return;
    let text: string;
    if (typeof data === "string") text = data;
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
    else if (ArrayBuffer.isView(data)) text = new TextDecoder().decode(data);
    else {
      this.sendError(
        null,
        rpcErrorCode.invalidRequest,
        "Expected a text JSON-RPC message.",
      );
      return;
    }
    if (jsonByteLength(text) > this.maxFrameBytes) {
      this.close(4400, "RPC frame exceeds the configured limit.");
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.sendError(null, rpcErrorCode.parseError, "Parse error");
      return;
    }
    if (Array.isArray(raw)) {
      this.sendError(
        null,
        rpcErrorCode.invalidRequest,
        "JSON-RPC batches are not supported.",
      );
      return;
    }
    const parsed = jsonRpcMessageSchema.safeParse(raw);
    if (!parsed.success) {
      const id = raw && typeof raw === "object" && "id" in raw &&
          (typeof raw.id === "string" || typeof raw.id === "number")
        ? raw.id
        : null;
      const responseLike = raw && typeof raw === "object" &&
        !Array.isArray(raw) &&
        "id" in raw && ("result" in raw || "error" in raw);
      const notificationLike = raw && typeof raw === "object" &&
        !Array.isArray(raw) &&
        "method" in raw && !("id" in raw);
      if (responseLike || notificationLike) {
        this.close(
          rpcCloseCode.invalidMessage,
          "Peer sent an invalid RPC response or notification.",
        );
      } else {
        this.sendError(
          id,
          rpcErrorCode.invalidRequest,
          "Invalid Request",
          parsed.error.flatten(),
        );
      }
      return;
    }
    await this.handleMessage(parsed.data);
  }

  close(code = 1000, reason = "RPC peer closed.") {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.active.values()) {
      controller.abort(new Error(reason));
    }
    this.active.clear();
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
    this.outbound.length = 0;
    this.queuedBytes = 0;
    try {
      this.socket.close(code, reason.slice(0, 123));
    } catch {
      // The underlying socket is already closed.
    }
    this.options.onClose?.({ code, reason });
  }

  socketClosed(reason = "RPC socket closed.") {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.active.values()) {
      controller.abort(new Error(reason));
    }
    this.active.clear();
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
    this.outbound.length = 0;
    this.queuedBytes = 0;
    this.options.onClose?.({ reason });
  }

  get stats() {
    return {
      activeRequestCount: this.active.size,
      pendingRequestCount: this.pending.size,
      queuedMessageCount: this.outbound.length,
      queuedBytes: this.queuedBytes,
      bufferedAmount: this.socket.bufferedAmount ?? 0,
      overHighWatermark: this.bufferedBytes >= this.highWatermarkBytes,
    };
  }

  async waitForWritable(signal?: AbortSignal) {
    while (!this.closed && this.bufferedBytes >= this.highWatermarkBytes) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Aborted", "AbortError");
      }
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(
            signal?.reason instanceof Error
              ? signal.reason
              : new DOMException("Aborted", "AbortError"),
          );
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, 10);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (this.closed) throw new Error("RPC connection is closed.");
  }

  private get bufferedBytes() {
    return this.queuedBytes + (this.socket.bufferedAmount ?? 0);
  }

  private async handleMessage(message: JsonRpcMessage) {
    if ("method" in message && "id" in message) {
      await this.handleRequest(message);
      return;
    }
    if ("method" in message) {
      if (message.method === "connection.cancel") {
        if (this.remoteRole && this.localRole) {
          try {
            parseRpcNotificationParams(
              this.remoteRole,
              this.localRole,
              message.method,
              message.params,
            );
          } catch (error) {
            this.options.onError?.(
              error instanceof Error ? error : new Error(String(error)),
            );
            this.close(
              rpcCloseCode.invalidMessage,
              "Peer sent invalid cancellation parameters.",
            );
            return;
          }
        }
        const id = message.params && typeof message.params === "object" &&
            "id" in message.params
          ? (message.params as { id?: unknown }).id
          : undefined;
        if (typeof id === "string" || typeof id === "number") {
          this.active.get(id)?.abort(
            new DOMException("Cancelled", "AbortError"),
          );
        }
        return;
      }
      let params = message.params;
      if (this.remoteRole && this.localRole) {
        const contract = getRpcContract(
          "notification",
          this.remoteRole,
          this.localRole,
          message.method,
        );
        if (!contract) {
          this.close(
            rpcCloseCode.invalidMessage,
            `Peer sent an unsupported notification: ${message.method}`,
          );
          return;
        }
        try {
          params = parseRpcNotificationParams(
            this.remoteRole,
            this.localRole,
            message.method,
            message.params,
          );
        } catch (error) {
          this.options.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
          this.close(
            rpcCloseCode.invalidMessage,
            `Peer sent invalid notification parameters: ${message.method}`,
          );
          return;
        }
      }
      const handlers = this.notificationHandlers.get(message.method);
      if (handlers?.size) {
        for (const handler of handlers) {
          await handler(params, message.method);
        }
      } else {
        await this.options.onUnhandledNotification?.(
          params,
          message.method,
        );
      }
      return;
    }
    if (message.id === null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);
    if ("error" in message) {
      pending.reject(
        new RpcRemoteError(
          message.error.code,
          message.error.message,
          message.error.data,
        ),
      );
    } else {
      let result = message.result;
      if (this.localRole && this.remoteRole) {
        try {
          result = parseRpcRequestResult(
            this.localRole,
            this.remoteRole,
            pending.method,
            message.result,
          );
        } catch (error) {
          pending.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
          this.close(
            rpcCloseCode.invalidMessage,
            `Peer sent an invalid response for ${pending.method}.`,
          );
          return;
        }
      }
      pending.resolve(result);
    }
  }

  private async handleRequest(
    message: { id: JsonRpcId; method: string; params?: unknown },
  ) {
    const handler = this.handlers.get(message.method);
    if (!handler) {
      this.sendError(
        message.id,
        rpcErrorCode.methodNotFound,
        `Method not found: ${message.method}`,
      );
      return;
    }
    let params = message.params;
    if (this.remoteRole && this.localRole) {
      const contract = getRpcContract(
        "request",
        this.remoteRole,
        this.localRole,
        message.method,
      );
      if (!contract) {
        this.sendError(
          message.id,
          rpcErrorCode.methodNotFound,
          `Method not found: ${message.method}`,
        );
        return;
      }
      try {
        params = parseRpcRequestParams(
          this.remoteRole,
          this.localRole,
          message.method,
          message.params,
        );
      } catch (error) {
        this.options.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
        this.sendError(
          message.id,
          rpcErrorCode.invalidParams,
          "Invalid params",
          {
            code: "INVALID_PARAMS",
          },
        );
        return;
      }
    }
    const controller = new AbortController();
    this.active.set(message.id, controller);
    try {
      const result = await handler(params, {
        id: message.id,
        method: message.method,
        signal: controller.signal,
      });
      let validatedResult = result;
      if (this.remoteRole && this.localRole) {
        try {
          validatedResult = parseRpcRequestResult(
            this.remoteRole,
            this.localRole,
            message.method,
            result,
          );
        } catch (error) {
          this.options.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
          this.sendError(
            message.id,
            rpcErrorCode.applicationInternal,
            "Internal error",
            { code: "INTERNAL" },
          );
          return;
        }
      }
      this.enqueue({
        jsonrpc: "2.0",
        id: message.id,
        result: validatedResult ?? null,
      }, 0);
    } catch (error) {
      if (error instanceof RpcApplicationError) {
        this.sendError(message.id, error.code, error.message, error.data);
      } else {
        this.options.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
        this.sendError(
          message.id,
          rpcErrorCode.applicationInternal,
          "Internal error",
          {
            code: "INTERNAL",
          },
        );
      }
    } finally {
      this.active.delete(message.id);
    }
  }

  private sendError(
    id: JsonRpcId | null,
    code: number,
    message: string,
    data?: unknown,
  ) {
    const parsedData = data === undefined
      ? undefined
      : (awaitJsonValue(data) ?? { code: "INTERNAL" });
    const error: JsonRpcErrorObject = {
      code,
      message,
      ...(parsedData === undefined ? {} : { data: parsedData }),
    };
    this.enqueue({ jsonrpc: "2.0", id, error }, 0);
  }

  private enqueue(message: unknown, priority: number) {
    const data = JSON.stringify(message);
    const bytes = jsonByteLength(data);
    if (bytes > this.maxFrameBytes) {
      throw new Error(`RPC frame exceeds ${this.maxFrameBytes} bytes.`);
    }
    if (this.bufferedBytes + bytes > this.hardLimitBytes) {
      this.close(4429, "RPC outbound queue overloaded.");
      return;
    }
    this.outbound.push({ data, priority });
    this.outbound.sort((left, right) => left.priority - right.priority);
    this.queuedBytes += bytes;
    this.flush();
  }

  private flush() {
    if (this.flushing || this.closed) return;
    this.flushing = true;
    queueMicrotask(() => {
      try {
        while (!this.closed && this.outbound.length > 0) {
          if ((this.socket.bufferedAmount ?? 0) >= this.highWatermarkBytes) {
            setTimeout(() => {
              this.flushing = false;
              this.flush();
            }, 10);
            return;
          }
          const item = this.outbound.shift()!;
          this.queuedBytes -= jsonByteLength(item.data);
          this.socket.send(item.data);
        }
      } catch (error) {
        this.options.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
        this.close(1011, "RPC send failed.");
      } finally {
        if (this.outbound.length === 0 || this.closed) this.flushing = false;
      }
    });
  }
}
