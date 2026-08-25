import { PORTAL_TOKEN_PROTOCOL_PREFIX } from '@weave/product-protocol';
import { idKey, type JsonRpcMessage, parseJsonRpcMessage } from '../src/json-rpc.ts';

export const required = (name: string) => {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const tokenProtocol = (token: string) => {
  const bytes = new TextEncoder().encode(token);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${PORTAL_TOKEN_PROTOCOL_PREFIX}${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
};

export class RpcResponseError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

export class RpcSocket {
  readonly #socket: WebSocket;
  readonly #pending = new Map<string, { resolve(value: unknown): void; reject(cause: unknown): void }>();
  readonly notifications: JsonRpcMessage[] = [];
  #nextId = 0;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.onmessage = (event) => {
      const message = parseJsonRpcMessage(String(event.data));
      if (message.id !== undefined && message.method === undefined) {
        const pending = this.#pending.get(idKey(message.id));
        if (!pending) return;
        this.#pending.delete(idKey(message.id));
        if (message.error) {
          pending.reject(new RpcResponseError(message.error.code, message.error.message, message.error.data));
        } else pending.resolve(message.result);
      } else {
        this.notifications.push(message);
      }
    };
    socket.onclose = (event) => {
      for (const pending of this.#pending.values()) pending.reject(new Error(event.reason || 'WebSocket closed.'));
      this.#pending.clear();
    };
  }

  static async open(url: string, token: string) {
    const socket = new WebSocket(url, tokenProtocol(token));
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error(`Could not open ${url}.`));
    });
    return new RpcSocket(socket);
  }

  request(method: string, params: unknown = {}) {
    const id = ++this.#nextId;
    const response = new Promise<unknown>((resolve, reject) => this.#pending.set(idKey(id), { resolve, reject }));
    this.#socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return response;
  }

  close() {
    this.#socket.close();
  }
}

export const waitFor = async (predicate: () => boolean, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the acceptance condition.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
