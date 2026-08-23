import {
  type HostAgentSummary,
  type HostRpcMethod,
  type HostRpcParams,
  type HostRpcResult,
  type HostThreadSummary,
  type HostWorkspaceSummary,
  parseHostRpcResult,
  WEAVE_HOST_RPC_PATH,
} from '@weave/protocol';

type JsonRpcId = number;
type PendingRequest = { method: string; resolve(value: unknown): void; reject(error: Error): void };
type NotificationHandler = (method: string, params: unknown) => void;

const base64Url = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

const tokenProtocol = (token: string) => `weave-acp-token.${base64Url(token)}`;

class JsonRpcWebSocket {
  private nextId = 0;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private opened: Promise<void>;

  constructor(
    private readonly socket: WebSocket,
    private readonly onNotification?: NotificationHandler,
  ) {
    this.opened = new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('The Host WebSocket could not be opened.'));
    });
    socket.onmessage = (event) => this.receive(String(event.data));
    socket.onclose = (event) => {
      const error = new Error(event.reason || `The Host WebSocket closed (${event.code}).`);
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    };
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    await this.opened;
    const id = ++this.nextId;
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }));
    });
  }

  close() {
    this.socket.close(1000, 'Alpha disconnected.');
  }

  private receive(text: string) {
    const message = JSON.parse(text) as Record<string, unknown>;
    if (typeof message.method === 'string') {
      if (typeof message.id === 'number') {
        this.socket.send(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `Method not supported by Alpha: ${message.method}` },
        }));
      } else {
        this.onNotification?.(message.method, message.params);
      }
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error && typeof message.error === 'object') {
      const error = message.error as { message?: unknown };
      pending.reject(new Error(typeof error.message === 'string' ? error.message : `${pending.method} failed.`));
    } else {
      pending.resolve(message.result);
    }
  }
}

const rpcUrl = (hostUrl: string) => {
  const url = new URL(hostUrl.trim());
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('Host URL must use ws, wss, http, or https.');
  url.pathname = WEAVE_HOST_RPC_PATH;
  url.search = '';
  url.hash = '';
  return url;
};

export type HostSnapshot = {
  capabilities: string[];
  workspaces: HostWorkspaceSummary[];
  agents: HostAgentSummary[];
  threads: HostThreadSummary[];
};

export type ConversationItem = {
  id: string;
  role: 'user' | 'agent' | 'tool' | 'system';
  text: string;
  append?: boolean;
};

export class DirectHostClient {
  private readonly baseUrl: URL;
  private readonly protocol: string;
  private rpc: JsonRpcWebSocket;
  private acp?: JsonRpcWebSocket;
  private activeThread?: HostThreadSummary;
  private updateSequence = 0;

  constructor(hostUrl: string, token: string, private readonly onConversationItem: (item: ConversationItem) => void) {
    if (!token) throw new Error('Host token is required.');
    this.baseUrl = rpcUrl(hostUrl);
    this.protocol = tokenProtocol(token);
    this.rpc = new JsonRpcWebSocket(new WebSocket(this.baseUrl, this.protocol));
  }

  async snapshot(): Promise<HostSnapshot> {
    const [capabilities, workspaces, agents, threads] = await Promise.all([
      this.request('host.capabilities.get', {}),
      this.request('workspace.list', {}),
      this.request('agent.list', {}),
      this.request('thread.list', {}),
    ]);
    return {
      capabilities: capabilities.capabilities,
      workspaces: workspaces.workspaces,
      agents: agents.agents,
      threads: threads.threads,
    };
  }

  async attach(threadId: string) {
    const prepared = await this.request('thread.attach', { threadId });
    this.acp?.close();
    this.activeThread = prepared.thread;
    const url = new URL(this.baseUrl);
    url.pathname = prepared.connection.path;
    url.searchParams.set('threadId', prepared.connection.threadId);
    this.acp = new JsonRpcWebSocket(new WebSocket(url, this.protocol), (method, params) => {
      if (method === 'session/update') this.receiveSessionUpdate(params);
    });
    await this.acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'Alpha', version: '0.1.0' },
    });
    await this.acp.request('session/load', {
      sessionId: prepared.thread.acpSessionId,
      cwd: prepared.connection.cwd,
      mcpServers: [],
    });
    return prepared.thread;
  }

  async prompt(text: string) {
    if (!this.acp || !this.activeThread) throw new Error('Attach to a Thread first.');
    this.onConversationItem({ id: `local-${++this.updateSequence}`, role: 'user', text });
    await this.acp.request('session/prompt', {
      sessionId: this.activeThread.acpSessionId,
      prompt: [{ type: 'text', text }],
    });
  }

  close() {
    this.acp?.close();
    this.rpc.close();
  }

  private async request<Method extends HostRpcMethod>(
    method: Method,
    params: HostRpcParams<Method>,
  ): Promise<HostRpcResult<Method>> {
    return parseHostRpcResult(method, await this.rpc.request(method, params));
  }

  private receiveSessionUpdate(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const update = (value as { update?: unknown }).update;
    if (!update || typeof update !== 'object' || Array.isArray(update)) return;
    const record = update as Record<string, unknown>;
    const kind = typeof record.sessionUpdate === 'string' ? record.sessionUpdate : 'update';
    const content = record.content && typeof record.content === 'object' ? record.content as Record<string, unknown> : undefined;
    const text = typeof content?.text === 'string'
      ? content.text
      : typeof record.title === 'string'
      ? record.title
      : kind.replaceAll('_', ' ');
    const role = kind.includes('user_message') ? 'user' : kind.includes('agent_message') ? 'agent' : 'tool';
    this.onConversationItem({
      id: `update-${++this.updateSequence}`,
      role,
      text,
      append: kind.endsWith('_chunk'),
    });
  }
}
