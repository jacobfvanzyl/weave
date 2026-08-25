import {
  PORTAL_ACP_PATH,
  PORTAL_PROTOCOL_VERSION,
  type PortalRpcMethod,
  type PortalRpcParams,
  type PortalRpcResult,
  type ThreadSummary,
  WORKSPACE_FILE_RPC_METHODS,
  type WorkspaceFileWatchNotification,
} from '@weave/product-protocol';
import { ThreadCatalog } from './catalog.ts';
import type { AgentDefinition, PortalConfig, WorkspaceDefinition } from './config.ts';
import type { JsonRpcMessage } from './json-rpc.ts';
import { RuntimeStateStore } from './runtime-state.ts';
import { ThreadEventJournal } from './thread-journal.ts';
import { HostedThread, type ThreadAttachment } from './thread-runtime.ts';
import { WorkspaceFileService, type WorkspaceFileWatchSession } from './workspace-files.ts';

export class PortalRpcSession {
  readonly #portal: Portal;
  readonly #watches: WorkspaceFileWatchSession;
  #closed = false;

  constructor(portal: Portal, watches: WorkspaceFileWatchSession) {
    this.#portal = portal;
    this.#watches = watches;
  }

  async request<Method extends PortalRpcMethod>(
    method: Method,
    params: PortalRpcParams<Method>,
  ): Promise<PortalRpcResult<Method>> {
    if (this.#closed) throw new Error('Portal RPC session is closed.');
    if (method === 'workspace.file.watch.start') {
      return await this.#watches.start(params as PortalRpcParams<'workspace.file.watch.start'>) as PortalRpcResult<
        Method
      >;
    }
    if (method === 'workspace.file.watch.update') {
      return await this.#watches.update(params as PortalRpcParams<'workspace.file.watch.update'>) as PortalRpcResult<
        Method
      >;
    }
    if (method === 'workspace.file.watch.stop') {
      return await this.#watches.stop(params as PortalRpcParams<'workspace.file.watch.stop'>) as PortalRpcResult<
        Method
      >;
    }
    return await this.#portal.request(method, params);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#watches.close();
  }
}

export class Portal {
  readonly #catalog: ThreadCatalog;
  readonly #journal: ThreadEventJournal;
  readonly #runtimeStates: RuntimeStateStore;
  readonly #workspaceFiles: WorkspaceFileService;
  readonly #workspaces: Map<string, WorkspaceDefinition>;
  readonly #agents: Map<string, AgentDefinition>;
  readonly #runtimes = new Map<string, Promise<HostedThread>>();

  private constructor(
    readonly config: PortalConfig,
    catalog: ThreadCatalog,
    journal: ThreadEventJournal,
    runtimeStates: RuntimeStateStore,
    workspaceFiles: WorkspaceFileService,
  ) {
    this.#catalog = catalog;
    this.#journal = journal;
    this.#runtimeStates = runtimeStates;
    this.#workspaceFiles = workspaceFiles;
    this.#workspaces = new Map(config.workspaces.map((workspace) => [workspace.workspaceId, workspace]));
    this.#agents = new Map(config.agents.map((agent) => [agent.agentId, agent]));
  }

  static async open(config: PortalConfig) {
    const catalog = new ThreadCatalog(config.stateDirectory);
    const [, journal, runtimeStates, workspaceFiles] = await Promise.all([
      catalog.load(),
      ThreadEventJournal.open(config.stateDirectory, config.threadEventRetentionLimit),
      RuntimeStateStore.open(config.stateDirectory),
      WorkspaceFileService.open(config.workspaces),
    ]);
    return new Portal(config, catalog, journal, runtimeStates, workspaceFiles);
  }

  async request<Method extends PortalRpcMethod>(
    method: Method,
    params: PortalRpcParams<Method>,
  ): Promise<PortalRpcResult<Method>> {
    switch (method) {
      case 'portal.capabilities':
        return {
          protocolVersion: PORTAL_PROTOCOL_VERSION,
          capabilities: [
            'workspace.list',
            'agent.list',
            'thread.list',
            'thread.create',
            'thread.attach',
            ...WORKSPACE_FILE_RPC_METHODS,
            'acp.v1',
          ],
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
          this.#journal,
          this.#runtimeStates,
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
      case 'workspace.file.list':
        return await this.#workspaceFiles.list(params as PortalRpcParams<'workspace.file.list'>) as PortalRpcResult<
          Method
        >;
      case 'workspace.file.read':
        return await this.#workspaceFiles.read(params as PortalRpcParams<'workspace.file.read'>) as PortalRpcResult<
          Method
        >;
      case 'workspace.file.hash':
        return await this.#workspaceFiles.hash(params as PortalRpcParams<'workspace.file.hash'>) as PortalRpcResult<
          Method
        >;
      case 'workspace.file.write':
        return await this.#workspaceFiles.write(params as PortalRpcParams<'workspace.file.write'>) as PortalRpcResult<
          Method
        >;
      case 'workspace.directory.create':
        return await this.#workspaceFiles.createDirectory(
          params as PortalRpcParams<'workspace.directory.create'>,
        ) as PortalRpcResult<Method>;
      case 'workspace.file.move':
        return await this.#workspaceFiles.move(params as PortalRpcParams<'workspace.file.move'>) as PortalRpcResult<
          Method
        >;
      case 'workspace.file.delete':
        return await this.#workspaceFiles.delete(params as PortalRpcParams<'workspace.file.delete'>) as PortalRpcResult<
          Method
        >;
      case 'workspace.file.search':
        return await this.#workspaceFiles.search(params as PortalRpcParams<'workspace.file.search'>) as PortalRpcResult<
          Method
        >;
      case 'workspace.file.watch.start':
      case 'workspace.file.watch.update':
      case 'workspace.file.watch.stop':
        throw new Error('Workspace file watches require an RPC session.');
      default:
        throw new Error(`Unknown Portal method: ${String(method)}`);
    }
  }

  connectRpc(send: (notification: WorkspaceFileWatchNotification) => void) {
    return new PortalRpcSession(this, this.#workspaceFiles.openWatchSession(send));
  }

  async connectThread(threadId: string, send: (message: JsonRpcMessage) => void): Promise<ThreadAttachment> {
    return (await this.#runtime(threadId)).connect(send);
  }

  async close() {
    const runtimes = await Promise.allSettled(this.#runtimes.values());
    await Promise.all(runtimes.flatMap((result) => result.status === 'fulfilled' ? [result.value.close()] : []));
    this.#runtimes.clear();
    this.#workspaceFiles.close();
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
        this.#journal,
        this.#runtimeStates,
      );
      this.#runtimes.set(threadId, runtime);
      runtime.catch(() => this.#runtimes.delete(threadId));
    }
    return runtime;
  }
}
