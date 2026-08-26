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
import { type PortalAction, type PortalPrincipal, PortalSecurity, PortalSecurityError } from './security.ts';
import { ThreadEventJournal } from './thread-journal.ts';
import { HostedThread, type ThreadAttachment } from './thread-runtime.ts';
import { WorkspaceFileService, type WorkspaceFileWatchSession } from './workspace-files.ts';

export class PortalRpcSession {
  readonly #portal: Portal;
  readonly #watches: WorkspaceFileWatchSession;
  #closed = false;

  constructor(
    portal: Portal,
    watches: WorkspaceFileWatchSession,
    readonly principal: PortalPrincipal,
  ) {
    this.#portal = portal;
    this.#watches = watches;
  }

  async request<Method extends PortalRpcMethod>(
    method: Method,
    params: PortalRpcParams<Method>,
  ): Promise<PortalRpcResult<Method>> {
    if (this.#closed) throw new Error('Portal RPC session is closed.');
    await this.#portal.authorizeRequest(this.principal, method, params);
    if (method === 'workspace.file.watch.start') {
      return await this.#watches.start(
        params as PortalRpcParams<'workspace.file.watch.start'>,
      ) as PortalRpcResult<
        Method
      >;
    }
    if (method === 'workspace.file.watch.update') {
      return await this.#watches.update(
        params as PortalRpcParams<'workspace.file.watch.update'>,
      ) as PortalRpcResult<
        Method
      >;
    }
    if (method === 'workspace.file.watch.stop') {
      return await this.#watches.stop(
        params as PortalRpcParams<'workspace.file.watch.stop'>,
      ) as PortalRpcResult<
        Method
      >;
    }
    return await this.#portal.request(this.principal, method, params, true);
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
  readonly security: PortalSecurity;
  readonly #workspaces: Map<string, WorkspaceDefinition>;
  readonly #agents: Map<string, AgentDefinition>;
  readonly #runtimes = new Map<string, Promise<HostedThread>>();

  private constructor(
    readonly config: PortalConfig,
    catalog: ThreadCatalog,
    journal: ThreadEventJournal,
    runtimeStates: RuntimeStateStore,
    workspaceFiles: WorkspaceFileService,
    security: PortalSecurity,
  ) {
    this.#catalog = catalog;
    this.#journal = journal;
    this.#runtimeStates = runtimeStates;
    this.#workspaceFiles = workspaceFiles;
    this.security = security;
    this.#workspaces = new Map(
      config.workspaces.map((workspace) => [workspace.workspaceId, workspace]),
    );
    this.#agents = new Map(
      config.agents.map((agent) => [agent.agentId, agent]),
    );
  }

  static async open(config: PortalConfig) {
    const catalog = new ThreadCatalog(config.stateDirectory);
    const [, journal, runtimeStates, workspaceFiles, security] = await Promise
      .all([
        catalog.load(),
        ThreadEventJournal.open(
          config.stateDirectory,
          config.threadEventRetentionLimit,
        ),
        RuntimeStateStore.open(config.stateDirectory),
        WorkspaceFileService.open(config.workspaces),
        PortalSecurity.open(config),
      ]);
    return new Portal(
      config,
      catalog,
      journal,
      runtimeStates,
      workspaceFiles,
      security,
    );
  }

  async request<Method extends PortalRpcMethod>(
    principal: PortalPrincipal,
    method: Method,
    params: PortalRpcParams<Method>,
    authorized = false,
  ): Promise<PortalRpcResult<Method>> {
    if (!authorized) await this.authorizeRequest(principal, method, params);
    switch (method) {
      case 'portal.capabilities':
        return {
          protocolVersion: PORTAL_PROTOCOL_VERSION,
          hostId: this.security.hostId,
          displayName: this.config.displayName,
          principal: {
            principalId: principal.principalId,
            credentialId: principal.credentialId,
            label: principal.label,
          },
          capabilities: [
            'workspace.list',
            'agent.list',
            'thread.list',
            'thread.create',
            'thread.attach',
            'credential.rotate',
            'credential.revoke',
            ...WORKSPACE_FILE_RPC_METHODS,
            'acp.v1',
          ],
        } as PortalRpcResult<Method>;
      case 'workspace.list':
        return {
          workspaces: this.config.workspaces
            .filter(({ workspaceId }) =>
              this.security.allows(principal, 'workspace.inspect', {
                workspaceId,
              })
            )
            .map(({ workspaceId, name }) => ({ workspaceId, name })),
        } as PortalRpcResult<Method>;
      case 'agent.list':
        return {
          agents: this.config.agents
            .filter(({ agentId }) => this.security.allows(principal, 'agent.use', { agentId }))
            .map(({ agentId, name }) => ({ agentId, name })),
        } as PortalRpcResult<
          Method
        >;
      case 'thread.list':
        return {
          threads: this.#catalog.list().filter((thread) =>
            this.security.allows(principal, 'thread.inspect', {
              threadId: thread.threadId,
              workspaceId: thread.workspaceId,
              agentId: thread.agentId,
            })
          ),
        } as PortalRpcResult<Method>;
      case 'thread.create': {
        const input = params as PortalRpcParams<'thread.create'>;
        const workspace = this.#workspace(input.workspaceId);
        const agent = this.#agent(input.agentId);
        const runtime = await HostedThread.create(
          workspace,
          agent,
          input.title,
          (thread) => this.#catalog.put(thread),
          this.#journal,
          this.#runtimeStates,
        );
        this.#runtimes.set(runtime.thread.threadId, Promise.resolve(runtime));
        await this.#catalog.put(runtime.thread);
        return { thread: runtime.thread } as PortalRpcResult<Method>;
      }
      case 'thread.attach': {
        const input = params as PortalRpcParams<'thread.attach'>;
        const thread = (await this.#runtime(input.threadId)).thread;
        return {
          thread,
          connection: {
            path: PORTAL_ACP_PATH,
            threadId: thread.threadId,
            cwd: this.#workspace(thread.workspaceId).path,
          },
        } as PortalRpcResult<Method>;
      }
      case 'credential.rotate': {
        const input = params as PortalRpcParams<'credential.rotate'>;
        return {
          credentialId: await this.security.rotate(
            principal,
            input.publicKey,
            input.label,
          ),
        } as PortalRpcResult<Method>;
      }
      case 'credential.revoke':
        await this.security.revoke(principal);
        return { revoked: true } as PortalRpcResult<Method>;
      case 'workspace.file.list':
        return await this.#workspaceFiles.list(
          params as PortalRpcParams<'workspace.file.list'>,
        ) as PortalRpcResult<
          Method
        >;
      case 'workspace.file.read':
        return await this.#workspaceFiles.read(
          params as PortalRpcParams<'workspace.file.read'>,
        ) as PortalRpcResult<
          Method
        >;
      case 'workspace.file.hash':
        return await this.#workspaceFiles.hash(
          params as PortalRpcParams<'workspace.file.hash'>,
        ) as PortalRpcResult<
          Method
        >;
      case 'workspace.file.write':
        return await this.#workspaceFiles.write(
          params as PortalRpcParams<'workspace.file.write'>,
        ) as PortalRpcResult<
          Method
        >;
      case 'workspace.directory.create':
        return await this.#workspaceFiles.createDirectory(
          params as PortalRpcParams<'workspace.directory.create'>,
        ) as PortalRpcResult<Method>;
      case 'workspace.file.move':
        return await this.#workspaceFiles.move(
          params as PortalRpcParams<'workspace.file.move'>,
        ) as PortalRpcResult<
          Method
        >;
      case 'workspace.file.delete':
        return await this.#workspaceFiles.delete(
          params as PortalRpcParams<'workspace.file.delete'>,
        ) as PortalRpcResult<
          Method
        >;
      case 'workspace.file.search':
        return await this.#workspaceFiles.search(
          params as PortalRpcParams<'workspace.file.search'>,
        ) as PortalRpcResult<
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

  async authorizeRequest<Method extends PortalRpcMethod>(
    principal: PortalPrincipal,
    method: Method,
    params: PortalRpcParams<Method>,
  ) {
    const input = params as {
      workspaceId?: string;
      agentId?: string;
      threadId?: string;
    };
    if (method === 'thread.create') {
      await this.security.authorize(principal, 'thread.create', input);
      await this.security.authorize(principal, 'agent.use', input);
      return;
    }
    if (method === 'thread.attach') {
      let thread: ThreadSummary;
      try {
        thread = this.#thread(input.threadId ?? '');
      } catch {
        throw new PortalSecurityError('RESOURCE_UNAVAILABLE', 'Resource is unavailable.');
      }
      await this.security.authorize(principal, 'thread.attach', {
        threadId: thread.threadId,
        workspaceId: thread.workspaceId,
        agentId: thread.agentId,
      });
      return;
    }
    const action: PortalAction = method === 'portal.capabilities'
      ? 'portal.inspect'
      : method === 'workspace.list'
      ? 'workspace.inspect'
      : method === 'agent.list'
      ? 'agent.use'
      : method === 'thread.list'
      ? 'thread.inspect'
      : method === 'credential.rotate'
      ? 'credential.rotate'
      : method === 'credential.revoke'
      ? 'credential.revoke'
      : method === 'workspace.file.read' || method === 'workspace.file.hash' ||
          method === 'workspace.file.list' ||
          method === 'workspace.file.search' ||
          method === 'workspace.file.watch.start' ||
          method === 'workspace.file.watch.update' ||
          method === 'workspace.file.watch.stop'
      ? 'workspace.file.read'
      : 'workspace.file.write';
    await this.security.authorize(principal, action, input);
  }

  connectRpc(
    principal: PortalPrincipal,
    send: (notification: WorkspaceFileWatchNotification) => void,
  ) {
    return new PortalRpcSession(
      this,
      this.#workspaceFiles.openWatchSession(send),
      principal,
    );
  }

  async connectThread(
    principal: PortalPrincipal,
    threadId: string,
    send: (message: JsonRpcMessage) => void,
  ): Promise<ThreadAttachment> {
    const thread = this.#thread(threadId);
    await this.security.authorize(principal, 'thread.attach', {
      threadId,
      workspaceId: thread.workspaceId,
      agentId: thread.agentId,
    });
    return (await this.#runtime(threadId)).connect(send);
  }

  async close() {
    const runtimes = await Promise.allSettled(this.#runtimes.values());
    await Promise.all(
      runtimes.flatMap((result) => result.status === 'fulfilled' ? [result.value.close()] : []),
    );
    this.#runtimes.clear();
    this.#workspaceFiles.close();
  }

  #thread(threadId: string): ThreadSummary {
    const thread = this.#catalog.get(threadId);
    if (!thread || thread.status !== 'active') {
      throw new Error(`Thread is unavailable: ${threadId}`);
    }
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
        (changed) => this.#catalog.put(changed),
        this.#journal,
        this.#runtimeStates,
      );
      this.#runtimes.set(threadId, runtime);
      runtime.catch(() => this.#runtimes.delete(threadId));
    }
    return runtime;
  }
}
