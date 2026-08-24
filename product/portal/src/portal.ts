import {
  PORTAL_ACP_PATH,
  PORTAL_PROTOCOL_VERSION,
  type PortalRpcMethod,
  type PortalRpcParams,
  type PortalRpcResult,
  type ThreadSummary,
} from '@weave/product-protocol';
import { ThreadCatalog } from './catalog.ts';
import type { AgentDefinition, PortalConfig, WorkspaceDefinition } from './config.ts';
import type { JsonRpcMessage } from './json-rpc.ts';
import { HostedThread, type ThreadAttachment } from './thread-runtime.ts';

export class Portal {
  readonly #catalog: ThreadCatalog;
  readonly #workspaces: Map<string, WorkspaceDefinition>;
  readonly #agents: Map<string, AgentDefinition>;
  readonly #runtimes = new Map<string, Promise<HostedThread>>();

  private constructor(readonly config: PortalConfig, catalog: ThreadCatalog) {
    this.#catalog = catalog;
    this.#workspaces = new Map(config.workspaces.map((workspace) => [workspace.workspaceId, workspace]));
    this.#agents = new Map(config.agents.map((agent) => [agent.agentId, agent]));
  }

  static async open(config: PortalConfig) {
    const catalog = new ThreadCatalog(config.stateDirectory);
    await catalog.load();
    return new Portal(config, catalog);
  }

  async request<Method extends PortalRpcMethod>(
    method: Method,
    params: PortalRpcParams<Method>,
  ): Promise<PortalRpcResult<Method>> {
    switch (method) {
      case 'portal.capabilities':
        return {
          protocolVersion: PORTAL_PROTOCOL_VERSION,
          capabilities: ['workspace.list', 'agent.list', 'thread.list', 'thread.create', 'thread.attach', 'acp.v1'],
        } as PortalRpcResult<Method>;
      case 'workspace.list':
        return {
          workspaces: this.config.workspaces.map(({ workspaceId, name }) => ({ workspaceId, name })),
        } as PortalRpcResult<Method>;
      case 'agent.list':
        return { agents: this.config.agents.map(({ agentId, name }) => ({ agentId, name })) } as PortalRpcResult<
          Method
        >;
      case 'thread.list':
        return { threads: this.#catalog.list() } as PortalRpcResult<Method>;
      case 'thread.create': {
        const input = params as PortalRpcParams<'thread.create'>;
        const workspace = this.#workspace(input.workspaceId);
        const agent = this.#agent(input.agentId);
        const runtime = await HostedThread.create(
          workspace,
          agent,
          input.title,
          (thread) => void this.#catalog.put(thread),
        );
        this.#runtimes.set(runtime.thread.threadId, Promise.resolve(runtime));
        await this.#catalog.put(runtime.thread);
        return { thread: runtime.thread } as PortalRpcResult<Method>;
      }
      case 'thread.attach': {
        const input = params as PortalRpcParams<'thread.attach'>;
        const thread = this.#thread(input.threadId);
        return {
          thread,
          connection: {
            path: PORTAL_ACP_PATH,
            threadId: thread.threadId,
            cwd: this.#workspace(thread.workspaceId).path,
          },
        } as PortalRpcResult<Method>;
      }
    }
  }

  async connectThread(threadId: string, send: (message: JsonRpcMessage) => void): Promise<ThreadAttachment> {
    return (await this.#runtime(threadId)).connect(send);
  }

  async close() {
    const runtimes = await Promise.allSettled(this.#runtimes.values());
    await Promise.all(runtimes.flatMap((result) => result.status === 'fulfilled' ? [result.value.close()] : []));
    this.#runtimes.clear();
  }

  #thread(threadId: string): ThreadSummary {
    const thread = this.#catalog.get(threadId);
    if (!thread || thread.status !== 'active') throw new Error(`Thread is unavailable: ${threadId}`);
    return thread;
  }

  #workspace(workspaceId: string) {
    const workspace = this.#workspaces.get(workspaceId);
    if (!workspace) throw new Error(`Workspace is unavailable: ${workspaceId}`);
    return workspace;
  }

  #agent(agentId: string) {
    const agent = this.#agents.get(agentId);
    if (!agent) throw new Error(`Agent is unavailable: ${agentId}`);
    return agent;
  }

  #runtime(threadId: string) {
    let runtime = this.#runtimes.get(threadId);
    if (!runtime) {
      const thread = this.#thread(threadId);
      runtime = HostedThread.restore(
        thread,
        this.#workspace(thread.workspaceId),
        this.#agent(thread.agentId),
        (changed) => void this.#catalog.put(changed),
      );
      this.#runtimes.set(threadId, runtime);
      runtime.catch(() => this.#runtimes.delete(threadId));
    }
    return runtime;
  }
}
