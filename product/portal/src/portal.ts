import {
  PORTAL_ACP_PATH,
  PORTAL_PROTOCOL_VERSION,
  type PortalRpcMethod,
  type PortalRpcParams,
  type PortalRpcResult,
  TERMINAL_RPC_METHODS,
  type TerminalNotification,
  type TerminalRpcMethod,
  type ThreadSummary,
  WORKSPACE_FILE_RPC_METHODS,
  type WorkspaceFileWatchNotification,
} from '@weave/product-protocol';
import { isAbsolute, relative } from 'jsr:@std/path@1.1.2';
import { ThreadCatalog } from './catalog.ts';
import type { AgentDefinition, PortalConfig, WorkspaceDefinition } from './config.ts';
import type { JsonRpcMessage } from './json-rpc.ts';
import { RuntimeStateStore } from './runtime-state.ts';
import { type PortalAction, type PortalPrincipal, PortalSecurity, PortalSecurityError } from './security.ts';
import { ThreadEventJournal } from './thread-journal.ts';
import { TmuxTerminalBackend } from './tmux-terminal-backend.ts';
import { type PortalTerminalSession, type TerminalBackend, TerminalService } from './terminals.ts';
import { HostedThread, type ThreadAttachment, ThreadPromptActiveError } from './thread-runtime.ts';
import { type RegisteredWorkspace, WorkspaceCatalog, workspaceSummary } from './workspace-catalog.ts';
import { WorkspaceFileService, type WorkspaceFileWatchSession } from './workspace-files.ts';
import { BrowserControlBroker, type BrowserHostConnection } from './browser-control.ts';
import { BrowserMcpBridge } from './browser-mcp.ts';

export class PortalRpcSession {
  readonly #portal: Portal;
  readonly #watches: WorkspaceFileWatchSession;
  readonly #terminals?: PortalTerminalSession;
  readonly #browserHost?: BrowserHostConnection;
  #closed = false;

  constructor(
    portal: Portal,
    watches: WorkspaceFileWatchSession,
    terminals: PortalTerminalSession | undefined,
    browserHost: BrowserHostConnection | undefined,
    readonly principal: PortalPrincipal,
  ) {
    this.#portal = portal;
    this.#watches = watches;
    this.#terminals = terminals;
    this.#browserHost = browserHost;
  }

  async request<Method extends PortalRpcMethod>(
    method: Method,
    params: PortalRpcParams<Method>,
  ): Promise<PortalRpcResult<Method>> {
    if (this.#closed) throw new Error('Portal RPC session is closed.');
    await this.#portal.authorizeRequest(this.principal, method, params);
    if (method === 'browser.provider.attach') {
      if (!this.#browserHost) throw new Error('Browser provider transport is unavailable.');
      const input = params as PortalRpcParams<'browser.provider.attach'>;
      return this.#portal.browserControl.attach(
        this.principal.principalId,
        input.threadId,
        input.offer,
        this.#browserHost,
      ) as PortalRpcResult<Method>;
    }
    if (method === 'browser.provider.detach') {
      const input = params as PortalRpcParams<'browser.provider.detach'>;
      const lease = this.#portal.browserControl.statusForLease(input.leaseId);
      if (lease && lease.principalId !== this.principal.principalId) {
        throw new PortalSecurityError('ACCESS_DENIED', 'Browser control lease is unavailable.');
      }
      this.#portal.browserControl.detach(input.leaseId);
      return { detached: true } as PortalRpcResult<Method>;
    }
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
    if (TERMINAL_RPC_METHODS.includes(method as TerminalRpcMethod)) {
      if (!this.#terminals) {
        throw new Error('Portal Terminal service is unavailable.');
      }
      return await this.#terminals.request(
        method as TerminalRpcMethod,
        params as PortalRpcParams<TerminalRpcMethod>,
      ) as PortalRpcResult<Method>;
    }
    return await this.#portal.request(this.principal, method, params, true);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#watches.close();
    this.#terminals?.close();
    if (this.#browserHost) this.#portal.browserControl.detachConnection(this.#browserHost.connectionId);
  }
}

export class PortalThreadLifecycleError extends Error {
  readonly data: { domain: 'thread-lifecycle'; code: 'THREAD_BUSY' };

  constructor() {
    super('Stop the active prompt before archiving this Thread.');
    this.name = 'PortalThreadLifecycleError';
    this.data = { domain: 'thread-lifecycle', code: 'THREAD_BUSY' };
  }
}

export type LocalAcpContext = {
  hostId: string;
  agentId: string;
  agentName: string;
  workspaceId: string;
  workspaceName: string;
  cwd: string;
};

export class Portal {
  readonly #catalog: ThreadCatalog;
  readonly #journal: ThreadEventJournal;
  readonly #runtimeStates: RuntimeStateStore;
  readonly #workspaceFiles: WorkspaceFileService;
  readonly #terminals?: TerminalService;
  readonly #workspaceCatalog: WorkspaceCatalog;
  readonly security: PortalSecurity;
  readonly browserControl: BrowserControlBroker;
  readonly browserMcp: BrowserMcpBridge;
  readonly #workspaces: Map<string, RegisteredWorkspace>;
  readonly #agents: Map<string, AgentDefinition>;
  readonly #runtimes = new Map<string, Promise<HostedThread>>();
  readonly #drafts = new Map<string, ThreadSummary>();
  #lifecycleQueue = Promise.resolve();

  private constructor(
    readonly config: PortalConfig,
    catalog: ThreadCatalog,
    journal: ThreadEventJournal,
    runtimeStates: RuntimeStateStore,
    workspaceCatalog: WorkspaceCatalog,
    workspaceFiles: WorkspaceFileService,
    terminals: TerminalService | undefined,
    security: PortalSecurity,
  ) {
    this.#catalog = catalog;
    this.#journal = journal;
    this.#runtimeStates = runtimeStates;
    this.#workspaceCatalog = workspaceCatalog;
    this.#workspaceFiles = workspaceFiles;
    this.#terminals = terminals;
    this.security = security;
    this.browserControl = new BrowserControlBroker(security.hostId);
    this.browserMcp = new BrowserMcpBridge(config.stateDirectory, this.browserControl);
    this.#workspaces = new Map(
      workspaceCatalog.list().map((
        workspace,
      ) => [workspace.workspaceId, workspace]),
    );
    this.#agents = new Map(
      config.agents.map((agent) => [agent.agentId, agent]),
    );
  }

  static async open(
    config: PortalConfig,
    options: { terminalBackend?: TerminalBackend | false } = {},
  ) {
    const catalog = new ThreadCatalog(config.stateDirectory);
    const workspaceCatalog = await WorkspaceCatalog.open(
      config.stateDirectory,
      config.workspaces,
    );
    const workspaces = workspaceCatalog.list();
    const [, journal, runtimeStates, workspaceFiles, security] = await Promise
      .all([
        catalog.load(),
        ThreadEventJournal.open(
          config.stateDirectory,
          config.threadEventRetentionLimit,
        ),
        RuntimeStateStore.open(config.stateDirectory),
        WorkspaceFileService.open(workspaces),
        PortalSecurity.open(
          config,
          workspaces.map(({ workspaceId }) => workspaceId),
        ),
      ]);
    const terminalBackend = options.terminalBackend === false ? undefined : options.terminalBackend ??
      (await TmuxTerminalBackend.available()
        ? new TmuxTerminalBackend({ stateDirectory: config.stateDirectory })
        : undefined);
    const terminals = terminalBackend
      ? new TerminalService({
        backend: terminalBackend,
        resolveWorkspace: (workspaceId) =>
          workspaceCatalog.list().find((workspace) => workspace.workspaceId === workspaceId),
      })
      : undefined;
    return new Portal(
      config,
      catalog,
      journal,
      runtimeStates,
      workspaceCatalog,
      workspaceFiles,
      terminals,
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
            'workspace.add',
            'workspace.remove',
            'agent.list',
            'thread.list',
            'thread.create',
            'thread.draft',
            'thread.attach',
            'thread.archive',
            'thread.restore',
            'browser.provider.attach',
            'browser.provider.detach',
            'credential.rotate',
            'credential.revoke',
            ...WORKSPACE_FILE_RPC_METHODS,
            ...(this.#terminals ? TERMINAL_RPC_METHODS : []),
            'acp.v1',
          ],
        } as PortalRpcResult<Method>;
      case 'workspace.list':
        return {
          workspaces: [...this.#workspaces.values()]
            .filter(({ workspaceId }) =>
              this.security.allows(principal, 'workspace.inspect', {
                workspaceId,
              })
            )
            .map(workspaceSummary),
        } as PortalRpcResult<Method>;
      case 'workspace.add': {
        const input = params as PortalRpcParams<'workspace.add'>;
        const workspace = await this.#workspaceCatalog.add(input);
        if (!this.#workspaces.has(workspace.workspaceId)) {
          await this.#workspaceFiles.addRoot(workspace);
          this.#workspaces.set(workspace.workspaceId, workspace);
        }
        await this.security.registerWorkspace(principal, workspace.workspaceId);
        return { workspace: workspaceSummary(workspace) } as PortalRpcResult<
          Method
        >;
      }
      case 'workspace.remove': {
        const input = params as PortalRpcParams<'workspace.remove'>;
        const workspace = await this.#workspaceCatalog.remove(
          input.workspaceId,
        );
        if (!workspace) {
          throw new PortalSecurityError(
            'RESOURCE_UNAVAILABLE',
            'Resource is unavailable.',
          );
        }
        this.#workspaceFiles.removeRoot(workspace.workspaceId);
        this.#workspaces.delete(workspace.workspaceId);
        await this.security.unregisterWorkspace(
          principal,
          workspace.workspaceId,
        );
        return { removed: true } as PortalRpcResult<Method>;
      }
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
          threads: this.#catalog.list(
            (params as PortalRpcParams<'thread.list'>).status ?? 'active',
          ).filter((thread) =>
            this.security.allows(principal, 'thread.inspect', {
              threadId: thread.threadId,
              workspaceId: thread.workspaceId,
              agentId: thread.agentId,
            })
          ),
        } as PortalRpcResult<Method>;
      case 'thread.create': {
        const input = params as PortalRpcParams<'thread.create'>;
        return {
          thread: await this.#createThread(
            input.workspaceId,
            input.agentId,
            input.title,
          ),
        } as PortalRpcResult<Method>;
      }
      case 'thread.draft.create': {
        const input = params as PortalRpcParams<'thread.draft.create'>;
        return {
          thread: await this.#createDraftThread(
            input.workspaceId,
            input.agentId,
            input.title,
          ),
        } as PortalRpcResult<Method>;
      }
      case 'thread.draft.discard': {
        const input = params as PortalRpcParams<'thread.draft.discard'>;
        await this.#discardDraftThread(input.threadId);
        return { discarded: true } as PortalRpcResult<Method>;
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
      case 'thread.archive': {
        const input = params as PortalRpcParams<'thread.archive'>;
        return await this.#mutateLifecycle(async () => {
          const current = this.#catalogThread(input.threadId);
          const changed = current.status !== 'archived';
          if (changed) {
            const runtime = this.#runtimes.get(input.threadId);
            if (runtime) {
              try {
                await (await runtime).archive();
              } catch (cause) {
                if (cause instanceof ThreadPromptActiveError) {
                  throw new PortalThreadLifecycleError();
                }
                throw cause;
              }
              this.#runtimes.delete(input.threadId);
            }
          }
          const thread = changed ? await this.#catalog.setArchived(input.threadId, true) : current;
          if (!thread) throw new Error('Thread is unavailable.');
          await this.security.auditThreadLifecycle(
            principal,
            'thread.archived',
            thread,
            changed,
          );
          return { thread } as PortalRpcResult<Method>;
        });
      }
      case 'thread.restore': {
        const input = params as PortalRpcParams<'thread.restore'>;
        return await this.#mutateLifecycle(async () => {
          const current = this.#catalogThread(input.threadId);
          const changed = current.status === 'archived';
          const thread = changed ? await this.#catalog.setArchived(input.threadId, false) : current;
          if (!thread) throw new Error('Thread is unavailable.');
          await this.security.auditThreadLifecycle(
            principal,
            'thread.restored',
            thread,
            changed,
          );
          return { thread } as PortalRpcResult<Method>;
        });
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
      case 'terminal.list':
      case 'terminal.create':
      case 'terminal.snapshot':
      case 'terminal.attach':
      case 'terminal.input':
      case 'terminal.resize':
      case 'terminal.detach':
      case 'terminal.close':
        throw new Error('Terminal requests require an RPC session.');
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
      terminalId?: string;
      mode?: 'observe' | 'control';
    };
    if (method === 'browser.provider.attach') {
      const thread = this.#thread(input.threadId ?? '');
      await this.security.authorize(principal, 'thread.attach', {
        threadId: thread.threadId,
        workspaceId: thread.workspaceId,
        agentId: thread.agentId,
      });
      await this.security.authorize(principal, 'browser.control', { threadId: thread.threadId });
      return;
    }
    if (method === 'browser.provider.detach') {
      await this.security.authorize(principal, 'browser.control', input);
      return;
    }
    if (method === 'thread.create' || method === 'thread.draft.create') {
      await this.security.authorize(principal, 'thread.create', input);
      await this.security.authorize(principal, 'agent.use', input);
      return;
    }
    if (
      method === 'thread.attach' || method === 'thread.draft.discard' ||
      method === 'thread.archive' ||
      method === 'thread.restore'
    ) {
      let thread: ThreadSummary;
      try {
        thread = method === 'thread.attach' || method === 'thread.draft.discard'
          ? this.#thread(input.threadId ?? '')
          : this.#catalogThread(input.threadId ?? '');
      } catch {
        throw new PortalSecurityError(
          'RESOURCE_UNAVAILABLE',
          'Resource is unavailable.',
        );
      }
      await this.security.authorize(principal, 'thread.attach', {
        threadId: thread.threadId,
        workspaceId: thread.workspaceId,
        agentId: thread.agentId,
      });
      return;
    }
    if (TERMINAL_RPC_METHODS.includes(method as TerminalRpcMethod)) {
      const action: PortalAction = method === 'terminal.create' ||
          method === 'terminal.input' || method === 'terminal.resize' ||
          method === 'terminal.close' ||
          (method === 'terminal.attach' && input.mode === 'control')
        ? 'terminal.control'
        : 'terminal.observe';
      await this.security.authorize(principal, action, input);
      return;
    }
    const action: PortalAction = method === 'portal.capabilities'
      ? 'portal.inspect'
      : method === 'workspace.list'
      ? 'workspace.inspect'
      : method === 'workspace.add' || method === 'workspace.remove'
      ? 'workspace.manage'
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
    sendTerminal?: (notification: TerminalNotification) => unknown,
    browserHost?: BrowserHostConnection,
  ) {
    return new PortalRpcSession(
      this,
      this.#workspaceFiles.openWatchSession(send),
      this.#terminals?.openSession(
        crypto.randomUUID(),
        sendTerminal ?? (() => undefined),
      ),
      browserHost,
      principal,
    );
  }

  async connectThread(
    principal: PortalPrincipal,
    threadId: string,
    send: (message: JsonRpcMessage) => void,
    disconnect?: (reason: string) => void,
  ): Promise<ThreadAttachment> {
    const thread = this.#thread(threadId);
    await this.security.authorize(principal, 'thread.attach', {
      threadId,
      workspaceId: thread.workspaceId,
      agentId: thread.agentId,
    });
    return (await this.#runtime(threadId)).connect(send, disconnect);
  }

  async resolveLocalAcpContext(input: {
    agentId: string;
    workspaceId?: string;
    workspacePath?: string;
  }): Promise<LocalAcpContext> {
    const agent = this.#agent(input.agentId);
    let workspace: WorkspaceDefinition | undefined;
    if (input.workspaceId) {
      workspace = this.#workspace(input.workspaceId);
    } else if (input.workspacePath) {
      const path = await Deno.realPath(input.workspacePath);
      const candidates = await Promise.all(
        [...this.#workspaces.values()].map(async (candidate) => ({
          definition: candidate,
          path: await Deno.realPath(candidate.path),
        })),
      );
      workspace = candidates
        .filter((candidate) => {
          const fromRoot = relative(candidate.path, path);
          return fromRoot === '' ||
            (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
        })
        .sort((left, right) => right.path.length - left.path.length)[0]
        ?.definition;
    }
    if (!workspace) throw new Error('Workspace is unavailable.');
    return {
      hostId: this.security.hostId,
      agentId: agent.agentId,
      agentName: agent.name,
      workspaceId: workspace.workspaceId,
      workspaceName: workspace.name,
      cwd: workspace.path,
    };
  }

  listLocalAcpThreads(context: LocalAcpContext) {
    this.#assertLocalAcpContext(context);
    return this.#catalog.list('all').filter((thread) =>
      thread.status !== 'closed' &&
      thread.agentId === context.agentId &&
      thread.workspaceId === context.workspaceId
    );
  }

  async createLocalAcpThread(context: LocalAcpContext, title?: string) {
    this.#assertLocalAcpContext(context);
    return await this.#createThread(
      context.workspaceId,
      context.agentId,
      title,
    );
  }

  async connectLocalAcpThread(
    context: LocalAcpContext,
    threadId: string,
    send: (message: JsonRpcMessage) => void,
  ) {
    this.#assertLocalAcpContext(context);
    const thread = this.#thread(threadId);
    if (
      thread.workspaceId !== context.workspaceId ||
      thread.agentId !== context.agentId
    ) {
      throw new Error('Thread is unavailable.');
    }
    const runtime = await this.#runtime(threadId);
    return Object.assign(runtime.connect(send), {
      acpSessionId: runtime.thread.acpSessionId,
    });
  }

  async close() {
    const runtimes = await Promise.allSettled(this.#runtimes.values());
    await Promise.all(
      runtimes.flatMap((result) => result.status === 'fulfilled' ? [result.value.close()] : []),
    );
    this.#runtimes.clear();
    const draftIds = [...this.#drafts.keys()];
    this.#drafts.clear();
    await Promise.all(draftIds.map(async (threadId) => {
      await this.#journal.clearIfNoConversation(threadId).catch(() => undefined);
      await this.#runtimeStates.delete(threadId).catch(() => undefined);
    }));
    this.#workspaceFiles.close();
    await this.#terminals?.close();
  }

  #thread(threadId: string): ThreadSummary {
    const draft = this.#drafts.get(threadId);
    if (draft) return draft;
    const thread = this.#catalogThread(threadId);
    if (thread.status !== 'active') {
      throw new Error(`Thread is unavailable: ${threadId}`);
    }
    return thread;
  }

  #catalogThread(threadId: string): ThreadSummary {
    const thread = this.#catalog.get(threadId);
    if (!thread || thread.status === 'closed') {
      throw new Error(`Thread is unavailable: ${threadId}`);
    }
    return thread;
  }

  async #mutateLifecycle<Result>(operation: () => Promise<Result>) {
    const result = this.#lifecycleQueue.then(operation);
    this.#lifecycleQueue = result.then(() => undefined, () => undefined);
    return await result;
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

  #assertLocalAcpContext(context: LocalAcpContext) {
    if (
      context.hostId !== this.security.hostId ||
      this.#workspace(context.workspaceId).path !== context.cwd ||
      this.#agent(context.agentId).name !== context.agentName
    ) {
      throw new Error('Local ACP context is unavailable.');
    }
  }

  async #createThread(workspaceId: string, agentId: string, title?: string) {
    const workspace = this.#workspace(workspaceId);
    const agent = this.#agent(agentId);
    const runtime = await HostedThread.create(
      workspace,
      agent,
      title,
      (thread) => this.#catalog.put(thread),
      this.#journal,
      this.#runtimeStates,
      (threadId) => this.browserMcp.servers(threadId),
    );
    this.#runtimes.set(runtime.thread.threadId, Promise.resolve(runtime));
    await this.#catalog.put(runtime.thread);
    return runtime.thread;
  }

  async #createDraftThread(
    workspaceId: string,
    agentId: string,
    title?: string,
  ) {
    const workspace = this.#workspace(workspaceId);
    const agent = this.#agent(agentId);
    const runtime = await HostedThread.create(
      workspace,
      agent,
      title,
      async (thread) => {
        if (this.#catalog.get(thread.threadId)) await this.#catalog.put(thread);
      },
      this.#journal,
      this.#runtimeStates,
      (threadId) => this.browserMcp.servers(threadId),
      (thread) => this.#promoteDraftThread(thread),
    );
    this.#drafts.set(runtime.thread.threadId, runtime.thread);
    this.#runtimes.set(runtime.thread.threadId, Promise.resolve(runtime));
    return runtime.thread;
  }

  async #promoteDraftThread(thread: ThreadSummary) {
    await this.#mutateLifecycle(async () => {
      if (!this.#drafts.delete(thread.threadId)) return;
      thread.updatedAt = new Date().toISOString();
      await this.#catalog.put(thread);
    });
  }

  async #discardDraftThread(threadId: string) {
    await this.#mutateLifecycle(async () => {
      if (!this.#drafts.has(threadId)) {
        throw new Error(`Thread draft is unavailable: ${threadId}`);
      }
      const runtime = this.#runtimes.get(threadId);
      if (runtime) await (await runtime).close('Thread draft was discarded.');
      this.#runtimes.delete(threadId);
      this.#drafts.delete(threadId);
      if (!await this.#journal.clearIfNoConversation(threadId)) {
        throw new Error(`Thread draft contains conversation data: ${threadId}`);
      }
      await this.#runtimeStates.delete(threadId);
    });
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
        (restoredThreadId) => this.browserMcp.servers(restoredThreadId),
      );
      this.#runtimes.set(threadId, runtime);
      runtime.catch(() => this.#runtimes.delete(threadId));
    }
    return runtime;
  }
}
