import {
  type AgentSummary,
  type PortalRpcMethod,
  type PortalRpcParams,
  type PortalRpcResult,
  type ThreadSummary,
  type WorkspaceSummary,
  parsePortalRpcResult,
  PORTAL_RPC_PATH,
  PORTAL_TOKEN_PROTOCOL_PREFIX,
} from '@weave/product-protocol';
import type { ContentBlock, CreateElicitationResponse } from '@agentclientprotocol/sdk';
import { AcpSessionClient } from '@/chat/acp-client';
import type { AcpTranscriptEvent } from '@/chat/acp-transcript';

type JsonRpcId = number;
type PendingRequest = { method: string; resolve(value: unknown): void; reject(error: Error): void };
type NotificationHandler = (method: string, params: unknown) => void;

const base64Url = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

const tokenProtocol = (token: string) => `${PORTAL_TOKEN_PROTOCOL_PREFIX}${base64Url(token)}`;

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
  url.pathname = PORTAL_RPC_PATH;
  url.search = '';
  url.hash = '';
  return url;
};

export type HostSnapshot = {
  capabilities: string[];
  workspaces: WorkspaceSummary[];
  agents: AgentSummary[];
  threads: ThreadSummary[];
};

export class DirectHostClient {
  private readonly baseUrl: URL;
  private readonly protocol: string;
  private rpc: JsonRpcWebSocket;
  private acp?: AcpSessionClient;
  private activeThread?: ThreadSummary;

  constructor(
    hostUrl: string,
    token: string,
    private readonly onAcpEvent: (event: AcpTranscriptEvent) => void,
  ) {
    if (!token) throw new Error('Host token is required.');
    this.baseUrl = rpcUrl(hostUrl);
    this.protocol = tokenProtocol(token);
    this.rpc = new JsonRpcWebSocket(new WebSocket(this.baseUrl, this.protocol));
  }

  async snapshot(): Promise<HostSnapshot> {
    const [capabilities, workspaces, agents, threads] = await Promise.all([
      this.request('portal.capabilities', {}),
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
    this.onAcpEvent({
      type: 'history/reset',
      sessionId: prepared.thread.acpSessionId,
    });
    const url = new URL(this.baseUrl);
    url.pathname = prepared.connection.path;
    url.searchParams.set('threadId', prepared.connection.threadId);
    this.acp = new AcpSessionClient({
      url: url.toString(),
      protocols: [this.protocol],
      onEvent: this.onAcpEvent,
    });
    await this.acp.initializeAndLoad({
      sessionId: prepared.thread.acpSessionId,
      cwd: prepared.connection.cwd,
    });
    return prepared.thread;
  }

  async createThread(workspaceId: string, agentId: string, title?: string) {
    return (await this.request('thread.create', { workspaceId, agentId, ...(title ? { title } : {}) })).thread;
  }

  async prompt(content: ContentBlock[]) {
    if (!this.acp || !this.activeThread) throw new Error('Attach to a Thread first.');
    await this.acp.prompt(content);
  }

  async cancelPrompt() {
    await this.acp?.cancel();
  }

  respondToPermission(requestId: string, optionId: string) {
    return this.acp?.respondToPermission(requestId, {
      outcome: 'selected',
      optionId,
    }) ?? false;
  }

  respondToElicitation(requestId: string, response: CreateElicitationResponse) {
    return this.acp?.respondToElicitation(requestId, response) ?? false;
  }

  async setMode(modeId: string) {
    await this.acp?.setMode(modeId);
  }

  async setConfigOption(optionId: string, value: string | boolean) {
    await this.acp?.setConfigOption(optionId, value);
  }

  close() {
    this.acp?.close();
    this.rpc.close();
  }

  private async request<Method extends PortalRpcMethod>(
    method: Method,
    params: PortalRpcParams<Method>,
  ): Promise<PortalRpcResult<Method>> {
    return parsePortalRpcResult(method, await this.rpc.request(method, params));
  }

}
