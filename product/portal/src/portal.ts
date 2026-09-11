import { assertLegacyCutover } from './terminal-service/maintenance.ts';
import { createHash } from 'node:crypto';
import { realpath } from './host-files.ts';
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
  type Workspace,
  THREAD_ATTENTION_CAPABILITY,
  WORKSPACE_FILE_RPC_METHODS,
  WORKSPACE_CONTEXT_CAPABILITY,
  COMPOSITION_RPC_METHODS,
  WORKSPACE_LIFECYCLE_RPC_METHODS,
  type WorkspaceClosePlan,
  type WorkspaceComposition,
  COMPOSITION_TERMINAL_CREATION_CAPABILITY,
  type TerminalLayoutNode,
  terminalPaneTargets,
  type WorkspaceFileWatchNotification,
} from '@weave/product-protocol';
import { isAbsolute, relative } from 'node:path';
import { ThreadCatalog, ThreadMembershipError } from './catalog.ts';
import type { AgentDefinition, PortalConfig, ExecutionContextDefinition } from './config.ts';
import type { JsonRpcMessage } from './json-rpc.ts';
import { RuntimeStateStore } from './runtime-state.ts';
import { type PortalAction, type PortalPrincipal, PortalSecurity, PortalSecurityError } from './security.ts';
import { ThreadEventJournal } from './thread-journal.ts';
import { TerminalServiceConnection } from './terminal-service/connection.ts';
import { type PortalTerminalSession, type TerminalExecution, TerminalAccess } from './terminals.ts';
import { HostedThread, type ThreadAttachment, ThreadPromptActiveError } from './thread-runtime.ts';
import { type RegisteredExecutionContext, ExecutionContextCatalog, workspaceSummary } from './workspace-catalog.ts';
import { WorkspaceFileService, type WorkspaceFileWatchSession } from './workspace-files.ts';
import { CompositionError, CompositionStore } from './composition-store.ts';

export class PortalRpcSession {
  readonly #portal: Portal;
  readonly #watches: WorkspaceFileWatchSession;
  readonly #terminals?: PortalTerminalSession;
  #closed = false;

  constructor(
    portal: Portal,
    watches: WorkspaceFileWatchSession,
    terminals: PortalTerminalSession | undefined,
    readonly principal: PortalPrincipal,
  ) {
    this.#portal = portal;
    this.#watches = watches;
    this.#terminals = terminals;
  }

  async request<Method extends PortalRpcMethod>(
    method: Method,
    params: PortalRpcParams<Method>,
  ): Promise<PortalRpcResult<Method>> {
    if (this.#closed) throw new Error('Portal RPC session is closed.');
    await this.#portal.authorizeRequest(this.principal, method, params);
    if (method === 'context.file.watch.start') {
      return await this.#watches.start(
        params as PortalRpcParams<'context.file.watch.start'>,
      ) as PortalRpcResult<
        Method
      >;
    }
    if (method === 'context.file.watch.update') {
      return await this.#watches.update(
        params as PortalRpcParams<'context.file.watch.update'>,
      ) as PortalRpcResult<
        Method
      >;
    }
    if (method === 'context.file.watch.stop') {
      return await this.#watches.stop(
        params as PortalRpcParams<'context.file.watch.stop'>,
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
  executionContextId: string;
  workspaceName: string;
  cwd: string;
};

export class Portal {
  readonly #catalog: ThreadCatalog;
  readonly #journal: ThreadEventJournal;
  readonly #runtimeStates: RuntimeStateStore;
  readonly #workspaceFiles: WorkspaceFileService;
  readonly #terminals?: TerminalAccess;
  readonly #workspaceCatalog: ExecutionContextCatalog;
  readonly #compositions: CompositionStore;
  readonly security: PortalSecurity;
  readonly #executionContexts: Map<string, RegisteredExecutionContext>;
  readonly #agents: Map<string, AgentDefinition>;
  readonly #runtimes = new Map<string, Promise<HostedThread>>();
  readonly #liveRuntimes = new Map<string, HostedThread>();
  readonly #drafts = new Map<string, ThreadSummary>();
  #lifecycleQueue = Promise.resolve();
  readonly #closingWorkspaces = new Set<string>();

  private constructor(
    readonly config: PortalConfig,
    catalog: ThreadCatalog,
    journal: ThreadEventJournal,
    runtimeStates: RuntimeStateStore,
    workspaceCatalog: ExecutionContextCatalog,
    workspaceFiles: WorkspaceFileService,
    terminals: TerminalAccess | undefined,
    security: PortalSecurity,
    compositions: CompositionStore,
  ) {
    this.#catalog = catalog;
    this.#journal = journal;
    this.#runtimeStates = runtimeStates;
    this.#workspaceCatalog = workspaceCatalog;
    this.#compositions = compositions;
    this.#workspaceFiles = workspaceFiles;
    this.#terminals = terminals;
    this.security = security;
    this.#executionContexts = new Map(
      workspaceCatalog.list().map((
        workspace,
      ) => [workspace.executionContextId, workspace]),
    );
    this.#agents = new Map(
      config.agents.map((agent) => [agent.agentId, agent]),
    );
  }

  static async open(
    config: PortalConfig,
    options: { terminalBackend?: TerminalExecution | false } = {},
  ) {
    const catalog = new ThreadCatalog(config.stateDirectory);
    const workspaceCatalog = await ExecutionContextCatalog.open(
      config.stateDirectory,
      config.executionContexts,
    );
    const executionContexts = workspaceCatalog.list();
    const [, journal, runtimeStates, workspaceFiles, security] = await Promise
      .all([
        Promise.resolve(),
        ThreadEventJournal.open(
          config.stateDirectory,
          config.threadEventRetentionLimit,
        ),
        RuntimeStateStore.open(config.stateDirectory),
        WorkspaceFileService.open(executionContexts, {}, { resolveWorkspaceRoot: (id) => workspaceCatalog.requireAvailable(id) }),
        PortalSecurity.open(
          config,
          executionContexts.map(({ executionContextId }) => executionContextId),
        ),
      ]);
    if (options.terminalBackend === undefined) await assertLegacyCutover(config.stateDirectory);
    const terminalBackend = options.terminalBackend === false ? undefined : options.terminalBackend ??
      new TerminalServiceConnection({ stateDirectory: config.stateDirectory });
    const compositions = new CompositionStore(config.stateDirectory);
    await compositions.migrate(security.hostId, executionContexts.map((context) => context.executionContextId));
    let portal: Portal | undefined;
    const terminals = terminalBackend
      ? new TerminalAccess({
        backend: terminalBackend,
        onTerminalExit: (terminalId) => { void (portal ? portal.#mutateLifecycle(async () => { await compositions.removeTerminal(security.hostId, terminalId); await portal!.#pruneEmptyWorkspaces(); }) : compositions.removeTerminal(security.hostId, terminalId)).catch((error) => console.error('Could not remove exited terminal pane:', error)); },
        assertWorkspaceAvailable: (id) => workspaceCatalog.requireAvailable(id),
        resolveWorkspace: (executionContextId) =>
          workspaceCatalog.list().find((workspace) => workspace.executionContextId === executionContextId),
      })
      : undefined;
    await catalog.load((id, preferred, assigned) => compositions.ensureThreadWorkspace(security.hostId, id, executionContexts.find((context) => context.executionContextId === id)?.name ?? id, preferred, assigned));
    if (terminals) await compositions.reconcileTerminals(security.hostId, () => terminals.knownTerminalIds());
    portal = new Portal(
      config,
      catalog,
      journal,
      runtimeStates,
      workspaceCatalog,
      workspaceFiles,
      terminals,
      security,
      compositions,
    );
    await portal.#pruneEmptyWorkspaces();
    return portal;
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
            'context.list',
            WORKSPACE_CONTEXT_CAPABILITY,
            ...COMPOSITION_RPC_METHODS,
            ...WORKSPACE_LIFECYCLE_RPC_METHODS,
            ...(this.#terminals ? [COMPOSITION_TERMINAL_CREATION_CAPABILITY] : []),
            'context.add',
            'context.remove',
            'agent.list',
            'thread.list',
            THREAD_ATTENTION_CAPABILITY,
            'thread.assign',
            'thread.create',
            'thread.draft',
            'thread.attach',
            'thread.archive',
            'thread.restore',
            'credential.rotate',
            'credential.revoke',
            ...WORKSPACE_FILE_RPC_METHODS,
            ...(this.#terminals ? TERMINAL_RPC_METHODS : []),
            'acp.v1',
          ],
        } as PortalRpcResult<Method>;
      case 'context.list':
        await this.#workspaceCatalog.refresh();
        return {
          executionContexts: [...this.#executionContexts.values()]
            .filter(({ executionContextId }) =>
              this.security.allows(principal, 'context.inspect', {
                executionContextId,
              })
            )
            .map(workspaceSummary),
        } as PortalRpcResult<Method>;
      case 'context.add': {
        const input = params as PortalRpcParams<'context.add'>;
        const workspace = await this.#workspaceCatalog.add(input);
        if (!this.#executionContexts.has(workspace.executionContextId)) {
          await this.#workspaceFiles.addRoot(workspace);
          this.#executionContexts.set(workspace.executionContextId, workspace);
        }
        await this.security.registerWorkspace(principal, workspace.executionContextId);
        return { workspace: workspaceSummary(workspace) } as PortalRpcResult<
          Method
        >;
      }
      case 'workspace.close': {
        const input = params as PortalRpcParams<'workspace.close'>;
        return await this.#mutateLifecycle(async () => {
          if (input.hostId !== this.security.hostId) throw new CompositionError({ domain: 'composition', code: 'INVALID_TARGET' });
          const current = await this.#compositions.get(input.hostId);
          if (!current.workspaces.some((workspace) => workspace.workspaceId === input.workspaceId)) return { composition: this.#visibleComposition(principal, current) } as PortalRpcResult<Method>;
          // Freeze existing agent input while the Host rechecks a clean close;
          // another attachment must not start a turn during asynchronous checks.
          const releases = this.#workspaceThreads().filter((thread) => thread.workspaceId === input.workspaceId).flatMap((thread) => {
            const runtime = this.#liveRuntimes.get(thread.threadId);
            return runtime ? [runtime.reserveWorkspaceClose()] : [];
          });
          try {
            const plan = await this.#workspaceClosePlan(principal, input.hostId, input.workspaceId);
            if (plan.token !== input.token) throw new Error('The workspace changed. Review its current contents before closing.');
            if (!input.confirmed && [...plan.terminals, ...plan.threads].some((item) => item.dirty)) throw new Error('This workspace has active or uncertain work. Confirmation is required.');
            this.#closingWorkspaces.add(input.workspaceId);
            try {
              const members = this.#workspaceThreads().filter((thread) => thread.workspaceId === input.workspaceId);
              // Stop every runtime before removing membership or structure. On
              // failure, retain the workspace so the remaining work is recoverable.
              const stopped = await Promise.allSettled([
                this.#terminals?.stopWorkspaceTerminals(plan.terminals.map((terminal) => terminal.terminalId)),
                ...members.map(async (thread) => {
                  const runtime = this.#runtimes.get(thread.threadId);
                  if (runtime) await (await runtime).stopForWorkspaceClose();
                  this.#runtimes.delete(thread.threadId);
                  this.#liveRuntimes.delete(thread.threadId);
                }),
              ]);
              const failure = stopped.find((result) => result.status === 'rejected');
              if (failure?.status === 'rejected') throw failure.reason;
              for (const thread of members) {
                // Drafts may contain in-flight journal entries. Archive them too;
                // stopping a workspace never destroys conversation history.
                if (this.#drafts.has(thread.threadId)) await this.#catalog.put(thread);
                this.#drafts.delete(thread.threadId);
                this.#runtimes.delete(thread.threadId);
                this.#liveRuntimes.delete(thread.threadId);
              }
              const archived = await this.#catalog.archiveWorkspace(input.workspaceId);
              const composition = await this.#compositions.replace(input.hostId, current.revision, current.workspaces.filter((workspace) => workspace.workspaceId !== input.workspaceId), async () => undefined);
              for (const thread of archived) await this.security.auditThreadLifecycle(principal, 'thread.archived', thread, true);
              return { composition: this.#visibleComposition(principal, composition) } as PortalRpcResult<Method>;
            } finally { this.#closingWorkspaces.delete(input.workspaceId); }
          } finally { releases.forEach((release) => release()); }
        });
      }
      case 'workspace.close.preview': {
        const { hostId, workspaceId } = params as PortalRpcParams<'workspace.close.preview'>;
        return await this.#mutateLifecycle(async () => ({ plan: await this.#workspaceClosePlan(principal, hostId, workspaceId) })) as PortalRpcResult<Method>;
      }
      case 'workspace.composition.get': {
        const { hostId } = params as PortalRpcParams<'workspace.composition.get'>;
        if (hostId !== this.security.hostId) throw new CompositionError({ domain: 'composition', code: 'INVALID_TARGET' });
        const composition = await this.#mutateLifecycle(async () => {
          if (this.#terminals) await this.#compositions.reconcileTerminals(hostId, () => this.#terminals!.knownTerminalIds());
          return this.#pruneEmptyWorkspaces();
        });
        // Restricted clients must not receive names or paths from other scopes.
        return { composition: this.#visibleComposition(principal, composition) } as PortalRpcResult<Method>;
      }
      case 'workspace.composition.replace': {
        const { hostId, expectedRevision, workspaces } = params as PortalRpcParams<'workspace.composition.replace'>;
        if (hostId !== this.security.hostId) throw new CompositionError({ domain: 'composition', code: 'INVALID_TARGET' });
        const composition = await this.#mutateLifecycle(() => this.#compositions.replace(hostId, expectedRevision, workspaces, async (current, next) => {
          const nextIds = new Set(next.map((workspace) => workspace.workspaceId));
          if (this.#workspaceThreads().some((thread) => !nextIds.has(thread.workspaceId))) throw new Error('Move the workspace’s Threads to another Workspace before deleting it.');
          // A filtered client cannot overwrite arrangements it cannot inspect.
          for (const workspace of [...current.workspaces, ...next]) for (const executionContextId of this.#workspaceContextIds(workspace)) await this.security.authorize(principal, 'context.manage', { executionContextId });
          for (const pane of terminalPaneTargets(next)) {
            this.#workspace(pane.executionContextId);
            const available = await this.#terminals?.knownTerminalIds(pane.executionContextId) ?? new Set<string>();
            if (pane.terminalId !== null && !available.has(pane.terminalId)) throw new CompositionError({ domain: 'composition', code: 'INVALID_TARGET' });
          }
          const retainedTerminals = new Set(terminalPaneTargets(next).map((pane) => pane.terminalId));
          const liveTerminals = await this.#terminals?.knownTerminalIds() ?? new Set<string>();
          if (terminalPaneTargets(current.workspaces).some((pane) => pane.terminalId && liveTerminals.has(pane.terminalId) && !retainedTerminals.has(pane.terminalId))) throw new Error('Close the workspace or terminal before removing its layout.');
          const provision = async (node: TerminalLayoutNode): Promise<TerminalLayoutNode> => {
            if (node.kind === 'split') return { ...node, children: [await provision(node.children[0]), await provision(node.children[1])] };
            if (node.terminalId) return node;
            await this.security.authorize(principal, 'terminal.control', { executionContextId: node.executionContextId });
            if (!this.#terminals) throw new Error('Terminals are unavailable on this Host.');
            const terminal = await this.#terminals.ensurePaneTerminal(node.executionContextId, current.revision, node.paneId, node.launchDirectory);
            return { ...node, terminalId: terminal.terminalId };
          };
          const provisioned = [];
          for (const workspace of next) provisioned.push({ ...workspace, layout: workspace.layout ? await provision(workspace.layout) : null });
          const occupied = new Set(this.#workspaceThreads().map((thread) => thread.workspaceId));
          return provisioned.filter((workspace) => workspace.layout !== null || occupied.has(workspace.workspaceId));
        }));
        return { composition } as PortalRpcResult<Method>;
      }
      case 'context.remove': {
        const input = params as PortalRpcParams<'context.remove'>;
        const workspace = await this.#workspaceCatalog.remove(
          input.executionContextId,
        );
        if (!workspace) {
          throw new PortalSecurityError(
            'RESOURCE_UNAVAILABLE',
            'Resource is unavailable.',
          );
        }
        this.#workspaceFiles.removeRoot(workspace.executionContextId);
        this.#executionContexts.delete(workspace.executionContextId);
        await this.security.unregisterWorkspace(
          principal,
          workspace.executionContextId,
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
              executionContextId: thread.executionContextId,
              agentId: thread.agentId,
            })
          ).map((thread) => ({ ...thread, attention: this.#liveRuntimes.get(thread.threadId)?.attention() ?? { state: 'uncertain', uncertaintyReason: 'runtime_not_loaded', observedAt: new Date().toISOString() } })),
        } as PortalRpcResult<Method>;
      case 'thread.create':
      case 'thread.draft.create': {
        const input = params as PortalRpcParams<'thread.create'>;
        return await this.#mutateLifecycle(async () => {
          const workspaceId = input.workspaceId === undefined ? await this.#ensureThreadWorkspace(input.executionContextId) : input.workspaceId;
          await this.#validateAssignment(principal, this.security.hostId, workspaceId);
          try {
            const thread = method === 'thread.create'
              ? await this.#createThread(input.executionContextId, input.agentId, input.title, workspaceId)
              : await this.#createDraftThread(input.executionContextId, input.agentId, input.title, workspaceId);
            return { thread } as PortalRpcResult<Method>;
          } finally { await this.#pruneEmptyWorkspaces(); }
        });
      }
      case 'thread.draft.discard': {
        const input = params as PortalRpcParams<'thread.draft.discard'>;
        await this.#discardDraftThread(input.threadId);
        return { discarded: true } as PortalRpcResult<Method>;
      }
      case 'thread.assign': {
        const input = params as PortalRpcParams<'thread.assign'>;
        return await this.#mutateLifecycle(async () => {
          await this.#validateAssignment(principal, input.hostId, input.workspaceId);
          const draft = this.#drafts.get(input.threadId);
          if (draft) {
            if (draft.membershipRevision !== input.expectedRevision) throw new ThreadMembershipError();
            draft.workspaceId = input.workspaceId;
            draft.membershipRevision += 1;
            await this.#pruneEmptyWorkspaces();
            return { thread: { ...draft } } as PortalRpcResult<Method>;
          }
          const thread = await this.#catalog.assign(input.threadId, input.workspaceId, input.expectedRevision);
          await this.#pruneEmptyWorkspaces();
          return { thread } as PortalRpcResult<Method>;
        });
      }
      case 'thread.attach': {
        const input = params as PortalRpcParams<'thread.attach'>;
        await this.#runtime(input.threadId);
        const thread = this.#thread(input.threadId);
        return {
          thread,
          connection: {
            path: PORTAL_ACP_PATH,
            threadId: thread.threadId,
            cwd: this.#workspace(thread.executionContextId).path,
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
              this.#liveRuntimes.delete(input.threadId);
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
          await this.#pruneEmptyWorkspaces();
          return { thread } as PortalRpcResult<Method>;
        });
      }
      case 'thread.restore': {
        const input = params as PortalRpcParams<'thread.restore'>;
        return await this.#mutateLifecycle(async () => {
          const current = this.#catalogThread(input.threadId);
          const changed = current.status === 'archived';
          if (changed && !(await this.#compositions.get(this.security.hostId)).workspaces.some((workspace) => workspace.workspaceId === current.workspaceId)) {
            const workspaceId = await this.#ensureThreadWorkspace(current.executionContextId);
            await this.#catalog.assign(current.threadId, workspaceId, current.membershipRevision);
          }
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
      case 'context.file.list':
        return await this.#workspaceFiles.list(
          params as PortalRpcParams<'context.file.list'>,
        ) as PortalRpcResult<
          Method
        >;
      case 'context.file.read':
        return await this.#workspaceFiles.read(
          params as PortalRpcParams<'context.file.read'>,
        ) as PortalRpcResult<
          Method
        >;
      case 'context.file.hash':
        return await this.#workspaceFiles.hash(
          params as PortalRpcParams<'context.file.hash'>,
        ) as PortalRpcResult<
          Method
        >;
      case 'context.file.write':
        return await this.#workspaceFiles.write(
          params as PortalRpcParams<'context.file.write'>,
        ) as PortalRpcResult<
          Method
        >;
      case 'context.directory.create':
        return await this.#workspaceFiles.createDirectory(
          params as PortalRpcParams<'context.directory.create'>,
        ) as PortalRpcResult<Method>;
      case 'context.file.move':
        return await this.#workspaceFiles.move(
          params as PortalRpcParams<'context.file.move'>,
        ) as PortalRpcResult<
          Method
        >;
      case 'context.file.delete':
        return await this.#workspaceFiles.delete(
          params as PortalRpcParams<'context.file.delete'>,
        ) as PortalRpcResult<
          Method
        >;
      case 'context.file.search':
        return await this.#workspaceFiles.search(
          params as PortalRpcParams<'context.file.search'>,
        ) as PortalRpcResult<
          Method
        >;
      case 'context.file.watch.start':
      case 'context.file.watch.update':
      case 'context.file.watch.stop':
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
      executionContextId?: string;
      agentId?: string;
      threadId?: string;
      terminalId?: string;
      mode?: 'observe' | 'control' | 'shared';
    };
    if (method.startsWith('browser.')) throw new Error('Browser is unavailable.');
    if (method === 'thread.create' || method === 'thread.draft.create') {
      const workspaceId = (params as PortalRpcParams<'thread.create'>).workspaceId;
      if (workspaceId !== undefined) await this.#validateAssignment(principal, this.security.hostId, workspaceId);
      await this.security.authorize(principal, 'thread.create', input);
      await this.security.authorize(principal, 'agent.use', input);
      return;
    }
    if (
      method === 'thread.attach' || method === 'thread.draft.discard' ||
      method === 'thread.archive' ||
      method === 'thread.restore' || method === 'thread.assign'
    ) {
      let thread: ThreadSummary;
      try {
        thread = method === 'thread.attach' || method === 'thread.draft.discard' || method === 'thread.assign'
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
        executionContextId: thread.executionContextId,
        agentId: thread.agentId,
      });
      return;
    }
    if (TERMINAL_RPC_METHODS.includes(method as TerminalRpcMethod)) {
      const action: PortalAction = method === 'terminal.create' ||
          method === 'terminal.input' || method === 'terminal.resize' ||
          method === 'terminal.close' ||
          (method === 'terminal.attach' && input.mode !== 'observe')
        ? 'terminal.control'
        : 'terminal.observe';
      await this.security.authorize(principal, action, input);
      return;
    }
    const action: PortalAction = method === 'portal.capabilities'
      ? 'portal.inspect'
      : method === 'context.list' || method === 'workspace.composition.get'
      ? 'context.inspect'
      : method === 'context.add' || method === 'context.remove' || method === 'workspace.composition.replace' || WORKSPACE_LIFECYCLE_RPC_METHODS.includes(method as typeof WORKSPACE_LIFECYCLE_RPC_METHODS[number])
      ? 'context.manage'
      : method === 'agent.list'
      ? 'agent.use'
      : method === 'thread.list'
      ? 'thread.inspect'
      : method === 'credential.rotate'
      ? 'credential.rotate'
      : method === 'credential.revoke'
      ? 'credential.revoke'
      : method === 'context.file.read' || method === 'context.file.hash' ||
          method === 'context.file.list' ||
          method === 'context.file.search' ||
          method === 'context.file.watch.start' ||
          method === 'context.file.watch.update' ||
          method === 'context.file.watch.stop'
      ? 'context.file.read'
      : 'context.file.write';
    await this.security.authorize(principal, action, input);
  }

  connectRpc(
    principal: PortalPrincipal,
    send: (notification: WorkspaceFileWatchNotification) => void,
    sendTerminal?: (notification: TerminalNotification) => unknown,
  ) {
    return new PortalRpcSession(
      this,
      this.#workspaceFiles.openWatchSession(send),
      this.#terminals?.openSession(
        crypto.randomUUID(),
        sendTerminal ?? (() => undefined),
      ),
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
      executionContextId: thread.executionContextId,
      agentId: thread.agentId,
    });
    return (await this.#runtime(threadId)).connect(send, disconnect);
  }

  async resolveLocalAcpContext(input: {
    agentId: string;
    executionContextId?: string;
    workspacePath?: string;
  }): Promise<LocalAcpContext> {
    const agent = this.#agent(input.agentId);
    let workspace: ExecutionContextDefinition | undefined;
    if (input.executionContextId) {
      workspace = await this.#workspaceCatalog.requireAvailable(input.executionContextId);
    } else if (input.workspacePath) {
      const path = await realpath(input.workspacePath);
      await this.#workspaceCatalog.refresh();
      const candidates = this.#workspaceCatalog.list()
        .filter((candidate) => candidate.availability === 'available')
        .map((definition) => ({ definition, path: definition.path }));
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
      executionContextId: workspace.executionContextId,
      workspaceName: workspace.name,
      cwd: workspace.path,
    };
  }

  listLocalAcpThreads(context: LocalAcpContext) {
    this.#assertLocalAcpContext(context);
    return this.#catalog.list('all').filter((thread) =>
      thread.status !== 'closed' &&
      thread.agentId === context.agentId &&
      thread.executionContextId === context.executionContextId
    );
  }

  async createLocalAcpThread(context: LocalAcpContext, title?: string) {
    this.#assertLocalAcpContext(context);
    return await this.#mutateLifecycle(async () => this.#createThread(context.executionContextId, context.agentId, title, await this.#ensureThreadWorkspace(context.executionContextId)));
  }

  async connectLocalAcpThread(
    context: LocalAcpContext,
    threadId: string,
    send: (message: JsonRpcMessage) => void,
  ) {
    this.#assertLocalAcpContext(context);
    const thread = this.#thread(threadId);
    if (
      thread.executionContextId !== context.executionContextId ||
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
    this.#liveRuntimes.clear();
    const draftIds = [...this.#drafts.keys()];
    this.#drafts.clear();
    await Promise.all(draftIds.map(async (threadId) => {
      await this.#journal.clearIfNoConversation(threadId).catch(() => undefined);
      await this.#runtimeStates.delete(threadId).catch(() => undefined);
    }));
    this.#workspaceFiles.close();
    await this.#terminals?.close();
    await this.#compositions.get(this.security.hostId);
  }

  #visibleComposition(principal: PortalPrincipal, composition: WorkspaceComposition) {
    return { ...composition, workspaces: composition.workspaces.filter((workspace) => this.#workspaceContextIds(workspace).every((executionContextId) => this.security.allows(principal, 'context.inspect', { executionContextId }))) };
  }

  #workspaceThreads() { return [...this.#catalog.list('active'), ...this.#drafts.values()]; }

  #pruneEmptyWorkspaces() {
    return this.#compositions.pruneEmpty(this.security.hostId, new Set(this.#workspaceThreads().map((thread) => thread.workspaceId)));
  }

  async #workspaceClosePlan(principal: PortalPrincipal, hostId: string, workspaceId: string): Promise<WorkspaceClosePlan> {
    await this.#validateAssignment(principal, hostId, workspaceId);
    const composition = await this.#compositions.get(hostId);
    const workspace = composition.workspaces.find((workspace) => workspace.workspaceId === workspaceId)!;
    const members = this.#workspaceThreads().filter((thread) => thread.workspaceId === workspaceId);
    const panes = terminalPaneTargets([workspace]);
    // Authorize every consequence before inspecting or stopping any process.
    for (const pane of panes) await this.security.authorize(principal, 'terminal.control', { executionContextId: pane.executionContextId });
    for (const thread of members) await this.security.authorize(principal, 'thread.attach', { executionContextId: thread.executionContextId, threadId: thread.threadId, agentId: thread.agentId });
    if (panes.length && !this.#terminals) throw new Error('Terminal state is unavailable. The workspace cannot be closed.');
    const terminals = await this.#terminals?.closePlan(panes.flatMap((pane) => pane.terminalId ? [pane.terminalId] : [])) ?? [];
    const threads = members.map((thread) => ({ threadId: thread.threadId, title: thread.title || 'Agent', dirty: !['idle', 'completed'].includes(this.#liveRuntimes.get(thread.threadId)?.attention().state ?? 'uncertain') }));
    // A confirmation is tied to exactly these members and their live activity.
    const token = createHash('sha256').update(JSON.stringify([workspace, terminals, threads, members.map((thread) => [thread.threadId, thread.membershipRevision])])).digest('hex');
    return { workspaceId, name: workspace.name, token, terminals, threads };
  }

  #workspaceContextIds(workspace: Workspace) {
    return [...new Set([...terminalPaneTargets([workspace]).map((pane) => pane.executionContextId), ...[...this.#catalog.list(), ...this.#drafts.values()].filter((thread) => thread.workspaceId === workspace.workspaceId).map((thread) => thread.executionContextId)])];
  }

  async #ensureThreadWorkspace(executionContextId: string) {
    const context = await this.#workspaceCatalog.requireAvailable(executionContextId);
    const assigned = this.#workspaceThreads().filter((thread) => thread.executionContextId === executionContextId).map((thread) => thread.workspaceId);
    return await this.#compositions.ensureThreadWorkspace(this.security.hostId, executionContextId, context.name, undefined, assigned);
  }

  async #validateAssignment(principal: PortalPrincipal, hostId: string, workspaceId: string) {
    if (hostId !== this.security.hostId) throw new CompositionError({ domain: 'composition', code: 'INVALID_TARGET' });
    if (this.#closingWorkspaces.has(workspaceId)) throw new Error('Workspace is closing.');
    if (typeof workspaceId !== 'string' || !workspaceId.trim()) throw new Error('A Workspace is required.');
    const workspace = (await this.#compositions.get(hostId)).workspaces.find((item) => item.workspaceId === workspaceId);
    if (!workspace) throw new CompositionError({ domain: 'composition', code: 'INVALID_TARGET' });
    await this.security.authorize(principal, 'context.manage');
    for (const executionContextId of this.#workspaceContextIds(workspace)) await this.security.authorize(principal, 'context.inspect', { executionContextId });
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

  #workspace(executionContextId: string) {
    const workspace = this.#executionContexts.get(executionContextId);
    if (!workspace) throw new Error(`Workspace is unavailable: ${executionContextId}`);
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
      this.#workspace(context.executionContextId).path !== context.cwd ||
      this.#agent(context.agentId).name !== context.agentName
    ) {
      throw new Error('Local ACP context is unavailable.');
    }
  }

  async #createThread(executionContextId: string, agentId: string, title: string | undefined, workspaceId: string) {
    const workspace = await this.#workspaceCatalog.requireAvailable(executionContextId);
    const agent = this.#agent(agentId);
    const runtime = await HostedThread.create(
      workspace,
      agent,
      title,
      (thread) => this.#catalog.put(thread),
      this.#journal,
      this.#runtimeStates,
      () => [],
      undefined,
      () => this.#workspaceCatalog.requireAvailable(executionContextId),
      workspaceId,
    );
    this.#runtimes.set(runtime.thread.threadId, Promise.resolve(runtime));
    this.#liveRuntimes.set(runtime.thread.threadId, runtime);
    await this.#catalog.put(runtime.thread);
    return runtime.thread;
  }

  async #createDraftThread(
    executionContextId: string,
    agentId: string,
    title: string | undefined,
    workspaceId: string,
  ) {
    const workspace = await this.#workspaceCatalog.requireAvailable(executionContextId);
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
      () => [],
      (thread) => this.#promoteDraftThread(thread),
      () => this.#workspaceCatalog.requireAvailable(executionContextId),
      workspaceId,
    );
    this.#drafts.set(runtime.thread.threadId, runtime.thread);
    this.#runtimes.set(runtime.thread.threadId, Promise.resolve(runtime));
    this.#liveRuntimes.set(runtime.thread.threadId, runtime);
    return runtime.thread;
  }

  async #promoteDraftThread(thread: ThreadSummary) {
    if (this.#closingWorkspaces.has(thread.workspaceId)) return;
    if (!this.#drafts.has(thread.threadId)) return;
    // Keep the draft counted until its durable record exists. Do not wait on
    // the lifecycle queue: close drains provider output while holding it.
    // The catalog serializes persistence and retains current membership.
    thread.updatedAt = new Date().toISOString();
    await this.#catalog.put(thread);
    this.#drafts.delete(thread.threadId);
  }

  async #discardDraftThread(threadId: string) {
    await this.#mutateLifecycle(async () => {
      if (!this.#drafts.has(threadId)) {
        throw new Error(`Thread draft is unavailable: ${threadId}`);
      }
      const runtime = this.#runtimes.get(threadId);
      if (runtime) await (await runtime).close('Thread draft was discarded.');
      this.#runtimes.delete(threadId);
      this.#liveRuntimes.delete(threadId);
      this.#drafts.delete(threadId);
      if (!await this.#journal.clearIfNoConversation(threadId)) {
        throw new Error(`Thread draft contains conversation data: ${threadId}`);
      }
      await this.#runtimeStates.delete(threadId);
      await this.#pruneEmptyWorkspaces();
    });
  }

  #runtime(threadId: string) {
    if (this.#closingWorkspaces.has(this.#thread(threadId).workspaceId)) throw new Error('Workspace is closing.');
    let runtime = this.#runtimes.get(threadId);
    if (!runtime) {
      const thread = this.#thread(threadId);
      runtime = this.#workspaceCatalog.requireAvailable(thread.executionContextId).then((workspace) => HostedThread.restore(
        thread,
        workspace,
        this.#agent(thread.agentId),
        (changed) => this.#catalog.put(changed),
        this.#journal,
        this.#runtimeStates,
        () => [],
        () => this.#workspaceCatalog.requireAvailable(thread.executionContextId),
      ));
      this.#runtimes.set(threadId, runtime);
      const restoring = runtime;
      void runtime.then((hosted) => {
        if (this.#runtimes.get(threadId) === restoring) this.#liveRuntimes.set(threadId, hosted);
      }, () => { this.#runtimes.delete(threadId); this.#liveRuntimes.delete(threadId); });
    }
    return runtime;
  }
}
