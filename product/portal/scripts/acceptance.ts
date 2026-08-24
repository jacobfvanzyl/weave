import { PORTAL_TOKEN_PROTOCOL_PREFIX } from '@weave/product-protocol';
import { idKey, type JsonRpcMessage, parseJsonRpcMessage } from '../src/json-rpc.ts';

const required = (name: string) => {
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

class RpcSocket {
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
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
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

const baseUrl = required('PORTAL_URL').replace(/\/$/, '');
const token = required('PORTAL_ACCESS_TOKEN');
const workspaceId = required('PORTAL_WORKSPACE_ID');
const agentId = required('PORTAL_AGENT_ID');
const marker = required('PORTAL_ACCEPTANCE_MARKER');
const rpc = await RpcSocket.open(`${baseUrl}/rpc`, token);
try {
  const created = await rpc.request('thread.create', { workspaceId, agentId, title: `Acceptance ${marker}` }) as {
    thread: { threadId: string; acpSessionId: string };
  };
  const attachment = await rpc.request('thread.attach', { threadId: created.thread.threadId }) as {
    connection: { path: string; threadId: string; cwd: string };
  };
  const acp = await RpcSocket.open(
    `${baseUrl}${attachment.connection.path}?threadId=${encodeURIComponent(attachment.connection.threadId)}`,
    token,
  );
  try {
    await acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await acp.request('session/load', {
      sessionId: created.thread.acpSessionId,
      cwd: attachment.connection.cwd,
      mcpServers: [],
    });
    await acp.request('session/prompt', {
      sessionId: created.thread.acpSessionId,
      prompt: [{ type: 'text', text: `Reply with exactly ${marker}` }],
    });
    const transcript = acp.notifications.map((message) => JSON.stringify(message)).join('\n');
    if (!transcript.includes(marker)) throw new Error(`Agent transcript did not contain ${marker}.`);
    console.log(JSON.stringify({ ok: true, threadId: created.thread.threadId, marker }));
  } finally {
    acp.close();
  }
} finally {
  rpc.close();
}
