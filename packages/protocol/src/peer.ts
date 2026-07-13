import {
  type JsonRpcErrorObject,
  type JsonRpcId,
  type JsonRpcMessage,
  jsonRpcMessageSchema,
  rpcErrorCode,
  WEAVE_RPC_MAX_FRAME_BYTES,
} from "./schema.ts";

export type RpcSocket = {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type RpcHandlerContext = {
  id: JsonRpcId;
  method: string;
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
    readonly data?: unknown,
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

  constructor(
    private readonly socket: RpcSocket,
    private readonly options: RpcPeerOptions = {},
  ) {
    this.maxFrameBytes = options.maxFrameBytes ?? WEAVE_RPC_MAX_FRAME_BYTES;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.highWatermarkBytes = options.highWatermarkBytes ?? 4 * 1024 * 1024;
    this.hardLimitBytes = options.hardLimitBytes ?? 16 * 1024 * 1024;
    this.createId = options.createId ?? (() => `${++this.nextId}`);
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
    handlers.add(handler);
    this.notificationHandlers.set(method, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.notificationHandlers.delete(method);
    };
  }

  request<T = unknown>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ) {
    if (this.closed) {
      return Promise.reject(new Error("RPC connection is closed."));
    }
    const id = this.createId();
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        method,
        resolve: (value) => resolve(value as T),
        reject,
      };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          this.notify("connection.cancel", { id });
          reject(new Error(`RPC request timed out: ${method}`));
        }, timeoutMs);
      }
      this.pending.set(id, pending);
      if (options.signal) {
        const abort = () => {
          if (!this.pending.delete(id)) return;
          if (pending.timer) clearTimeout(pending.timer);
          this.notify("connection.cancel", { id });
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

  notify(method: string, params?: unknown, priority = 2) {
    if (this.closed) return;
    this.enqueue({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
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
      this.sendError(
        id,
        rpcErrorCode.invalidRequest,
        "Invalid Request",
        parsed.error.flatten(),
      );
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
      const handlers = this.notificationHandlers.get(message.method);
      if (handlers?.size) {
        for (const handler of handlers) {
          await handler(message.params, message.method);
        }
      } else {
        await this.options.onUnhandledNotification?.(
          message.params,
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
    } else pending.resolve(message.result);
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
    const controller = new AbortController();
    this.active.set(message.id, controller);
    try {
      const result = await handler(message.params, {
        id: message.id,
        method: message.method,
        signal: controller.signal,
      });
      this.enqueue(
        { jsonrpc: "2.0", id: message.id, result: result ?? null },
        0,
      );
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
    const error: JsonRpcErrorObject = {
      code,
      message,
      ...(data === undefined ? {} : { data }),
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
