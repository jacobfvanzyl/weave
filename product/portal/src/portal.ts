import { CLIENT_BROWSER_PANE_RPC_METHODS, CLIENT_BROWSER_PANES_CAPABILITY, parseClientBrowserPaneRpcParams, type ClientBrowserPaneRpcMethod, type ClientBrowserPaneRpcContracts } from '@weave/product-protocol';
import { insertBrowserPane, removeBrowserPane } from './browser-pane-layout.ts';
import { BrowserAgentGateway } from './browser-agent.ts';
import { insertHostBrowserPane, removeHostBrowserPane, reconcileHostBrowserPanes } from './browser-pane-layout.ts';
import { HOST_BROWSER_PANE_RPC_METHODS, HOST_BROWSER_PANES_CAPABILITY, parseHostBrowserPaneRpcParams, parseBrowserPage, type HostBrowserPaneRpcMethod, type HostBrowserPaneRpcContracts } from '@weave/product-protocol';
import type { ManagedPageSummary } from './browser-service/managed-pages.ts';
import { ManagedBrowserAccess, type ManagedBrowserSession } from './browser-pages.ts';
import { BROWSER_PAGE_RPC_METHODS, BROWSER_PAGES_CAPABILITY, type BrowserPageRpcMethod, type BrowserPageRpcContracts } from '@weave/product-protocol';
import { BrowserProfileAccess } from './browser-profiles.ts';
import { BROWSER_PROFILE_RPC_METHODS, BROWSER_PROFILES_CAPABILITY, type BrowserProfileRpcMethod, type BrowserProfileRpcContracts } from '@weave/product-protocol';
import { assertLegacyCutover } from './terminal-service/maintenance.ts';
import { BrowserAccess, type BrowserBackend, type BrowserSession } from './browsers.ts';
import { BrowserServiceClient } from './browser-service/client.ts';
import { BROWSER_RPC_METHODS, BROWSER_STREAM_CAPABILITY, type BrowserRpcMethod, type BrowserRpcContracts, type BrowserNotification } from '@weave/product-protocol';
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
  paneTargets,
  terminalPaneTargets,
  type WorkspaceFileWatchNotification,
} from '@weave/product-protocol';
import { isAbsolute, relative, join, dirname } from 'node:path';
import { ThreadCatalog, ThreadMembershipError } from './catalog.ts';
import type { AgentDefinition, PortalConfig, ExecutionContextDefinition } from './config.ts';
import type { JsonRpcMessage } from './json-rpc.ts';
import { RuntimeStateStore } from './runtime-state.ts';
import { type PortalAction, type PortalPrincipal, PORTAL_ACTIONS, PortalSecurity, PortalSecurityError } from './security.ts';
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
  readonly #browsers?: BrowserSession;
  readonly #browserPages?: ManagedBrowserSession;
  #closed = false;

  constructor(
    portal: Portal,
    watches: WorkspaceFileWatchSession,
    terminals: PortalTerminalSession | undefined,
    readonly principal: PortalPrincipal,
    browsers?: BrowserSession,
    browserPages?: ManagedBrowserSession,
  ) {
    this.#portal = portal;
    this.#watches = watches;
    this.#terminals = terminals;
    this.#browsers = browsers;
    this.#browserPages = browserPages;
  }

  async request<Method extends PortalRpcMethod>(
    method: Method,
    params: PortalRpcParams<Method>,
  ): Promise<PortalRpcResult<Method>> {
    if (this.#closed) throw new Error('Portal RPC session is closed.');
    if (BROWSER_PAGE_RPC_METHODS.includes(method as BrowserPageRpcMethod)) {
      if (!this.#browserPages) throw new Error('Managed Browser Service is not configured.');
      return await this.#browserPages.request(method as BrowserPageRpcMethod, params as BrowserPageRpcContracts[BrowserPageRpcMethod]['params']) as PortalRpcResult<Method>;
    }
    if (BROWSER_RPC_METHODS.includes(method as BrowserRpcMethod)) {
      if (!this.#browsers) throw new Error('Browser Service is not configured.');
      return await this.#browsers.request(method as BrowserRpcMethod, params as BrowserRpcContracts[BrowserRpcMethod]['params']) as PortalRpcResult<Method>;
    }
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
    void this.#browsers?.close();
    this.#browserPages?.close();
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
  #browserAgent?: BrowserAgentGateway;
  readonly #catalog: ThreadCatalog;
  readonly #journal: ThreadEventJournal;
  readonly #runtimeStates: RuntimeStateStore;
  readonly #workspaceFiles: WorkspaceFileService;
  readonly #terminals?: TerminalAccess;
  readonly #browsers?: BrowserAccess;
  readonly #browserProfiles?: BrowserProfileAccess;
  readonly #browserBackend?: BrowserBackend;
  readonly #browserPages?: ManagedBrowserAccess;
  readonly #workspaceCatalog: ExecutionContextCatalog;
  readonly #compositions: CompositionStore;
  readonly security: PortalSecurity;
  readonly #executionContexts: Map<string, RegisteredExecutionContext>;
  readonly #agents: Map<string, AgentDefinition>;
  readonly #runtimes = new Map<string, Promise<HostedThread>>();
  readonly #liveRuntimes = new Map<string, HostedThread>();
  readonly #drafts = new Map<string, ThreadSummary>();
  #lifecycleQueue = Promise.resolve();
  #browserReconcileTimer?: ReturnType<typeof setInterval>;
  #browserReconcile?: Promise<unknown>;
  #closing = false;
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
    browserBackend?: BrowserBackend,
  ) {
    this.#catalog = catalog;
    this.#journal = journal;
    this.#runtimeStates = runtimeStates;
    this.#workspaceCatalog = workspaceCatalog;
    this.#compositions = compositions;
    this.#workspaceFiles = workspaceFiles;
    this.#terminals = terminals;
    this.#browserBackend = browserBackend;
    this.#browsers = browserBackend && !browserBackend.managedPagesEnabled ? new BrowserAccess(browserBackend) : undefined;
    this.security = security;
    this.#browserPages = browserBackend?.managedPagesEnabled && browserBackend.managedPage ? new ManagedBrowserAccess({ managedPage: browserBackend.managedPage.bind(browserBackend) }, security) : undefined;
    this.#browserProfiles = browserBackend?.profile ? new BrowserProfileAccess({ profile: browserBackend.profile.bind(browserBackend) }, security) : undefined;
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
    options: { terminalBackend?: TerminalExecution | false; browserBackend?: BrowserBackend | false } = {},
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
      options.browserBackend === false ? undefined : options.browserBackend ?? (config.browser ? new BrowserServiceClient(config.stateDirectory, config.browser.executable, config.browser.cefExecutable) : undefined),
    );
    if (portal.#browserPages && config.browser?.nodeExecutable) {
      portal.#browserAgent = new BrowserAgentGateway({
        thread: id => portal!.#thread(id),
        backend: { managedPage: portal.#browserBackend!.managedPage!.bind(portal.#browserBackend) },
        profiles: async () => (await portal!.#browserBackend!.profile!('browser.profile.list', {})).profiles,
        create: (threadId, profileId, url) => portal!.#createAgentBrowserPage(threadId, profileId, url),
        close: (threadId, profileId, targetId) => portal!.#closeAgentBrowserPage(threadId, profileId, targetId),
      }, { node: config.browser.nodeExecutable, script: config.browser.mcpScript ?? (process.execPath.endsWith('/bun') ? join(import.meta.dir, '../browser-tools/runner.mjs') : join(dirname(process.execPath), 'browser-tools/runner.mjs')) });
    }
    await portal.#pruneEmptyWorkspaces();
    if (portal.#browserPages) {
      portal.#browserReconcileTimer = setInterval(() => {
        if (portal!.#browserReconcile || portal!.#closing) return;
        portal!.#browserReconcile = portal!.#mutateLifecycle(() => portal!.#reconcileHostBrowserPanes()).catch(error => console.error('Could not reconcile Browser Panes:', error)).finally(() => { portal!.#browserReconcile = undefined; });
      }, 1000);
      portal.#browserReconcileTimer.unref();
    }
    return portal;
  }

  async request<Method extends PortalRpcMethod>(
    principal: PortalPrincipal,
    method: Method,
    params: PortalRpcParams<Method>,
    authorized = false,
  ): Promise<PortalRpcResult<Method>> {
    if (!authorized) await this.authorizeRequest(principal, method, params);
    if (BROWSER_PROFILE_RPC_METHODS.includes(method as BrowserProfileRpcMethod)) {
      if (!this.#browserProfiles) throw new Error('Browser Profiles are not configured.');
      return await this.#browserProfiles.request(principal, method as BrowserProfileRpcMethod, params as BrowserProfileRpcContracts[BrowserProfileRpcMethod]['params']) as PortalRpcResult<Method>;
    }
    if (CLIENT_BROWSER_PANE_RPC_METHODS.includes(method as ClientBrowserPaneRpcMethod)) return await this.#clientBrowserPaneRequest(principal, method as ClientBrowserPaneRpcMethod, params as ClientBrowserPaneRpcContracts[ClientBrowserPaneRpcMethod]['params']) as PortalRpcResult<Method>;
    if (HOST_BROWSER_PANE_RPC_METHODS.includes(method as HostBrowserPaneRpcMethod)) return await this.#browserPaneRequest(principal, method as HostBrowserPaneRpcMethod, params as HostBrowserPaneRpcContracts[HostBrowserPaneRpcMethod]['params']) as PortalRpcResult<Method>;
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
            CLIENT_BROWSER_PANES_CAPABILITY, ...CLIENT_BROWSER_PANE_RPC_METHODS,
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
            ...(this.#browsers ? [BROWSER_STREAM_CAPABILITY, ...BROWSER_RPC_METHODS] : []),
            ...(this.#browserProfiles ? [BROWSER_PROFILES_CAPABILITY, ...BROWSER_PROFILE_RPC_METHODS] : []),
            ...(this.#browserPages ? [BROWSER_PAGES_CAPABILITY, ...BROWSER_PAGE_RPC_METHODS, HOST_BROWSER_PANES_CAPABILITY, ...HOST_BROWSER_PANE_RPC_METHODS] : []),
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
            if (!input.confirmed && [...plan.terminals, ...plan.threads, ...(plan.browsers ?? []), ...(plan.clientBrowsers ?? [])].some((item) => item.dirty)) throw new Error('This workspace has active or uncertain work. Confirmation is required.');
            this.#closingWorkspaces.add(input.workspaceId);
            try {
              const members = this.#workspaceThreads().filter((thread) => thread.workspaceId === input.workspaceId);
              // Stop every runtime before removing membership or structure. On
              // failure, retain the workspace so the remaining work is recoverable.
              const stopped = await Promise.allSettled([
                this.#terminals?.stopWorkspaceTerminals(plan.terminals.map((terminal) => terminal.terminalId)),
                ...((plan.browsers ?? []).map(async browser => {
                  await this.security.authorize(principal, 'browser.profile.control', { browserProfileId: browser.profileId });
                  await this.#closeBrowserPage(browser.pageId, browser.profileId, browser.generation);
                })),
                ...members.map(async (thread) => {
                  const runtime = this.#runtimes.get(thread.threadId);
                  if (runtime) await (await runtime).stopForClose();
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
          if (paneTargets(current.workspaces).some(pane => pane.kind === 'client-browser') && !this.#clientBrowserAccess(principal)) throw new PortalSecurityError('RESOURCE_UNAVAILABLE', 'Client Browser is unavailable.');
          for (const pane of paneTargets(current.workspaces)) if (pane.kind === 'host-browser') await this.security.authorize(principal, 'browser.profile.control', { browserProfileId: pane.profileId });
          const currentPanes = new Map(paneTargets(current.workspaces).map(pane => [pane.paneId, pane]));
          const nextPanes = new Map(paneTargets(next).map(pane => [pane.paneId, pane]));
          // Content lifetime belongs to its service, never to a layout overwrite.
          for (const pane of currentPanes.values()) {
            if (pane.kind === 'terminal') continue;
            const retained = nextPanes.get(pane.paneId);
            if (!retained || JSON.stringify(retained) !== JSON.stringify(pane)) throw new Error('Close or move the Pane through its content lifecycle before removing it.');
          }
          for (const workspace of next) for (const pane of paneTargets([workspace])) {
            if (pane.kind === 'client-browser') {
              if (currentPanes.get(pane.paneId)?.kind !== 'client-browser') throw new Error('Create Client Browser Panes through their lifecycle.');
              if (!current.workspaces.some(item => item.workspaceId === workspace.workspaceId && paneTargets([item]).some(node => node.paneId === pane.paneId))) throw new Error('Move Client Browser Panes through their lifecycle.');
            }
            if (pane.kind === 'host-browser') {
              if (currentPanes.get(pane.paneId)?.kind !== 'host-browser') throw new Error('Create Browser Panes through the browser content lifecycle.');
              if (!current.workspaces.find(item => item.workspaceId === workspace.workspaceId && paneTargets([item]).some(node => node.paneId === pane.paneId))) throw new Error('Move Browser Panes through the browser content lifecycle.');
            }
            if (pane.kind !== 'agent') continue;
            const thread = this.#workspaceThreads().find(thread => thread.threadId === pane.threadId);
            if (!thread || thread.workspaceId !== workspace.workspaceId || !currentPanes.has(pane.paneId)) throw new CompositionError({ domain: 'composition', code: 'INVALID_TARGET' });
            await this.security.authorize(principal, 'thread.inspect', { threadId: thread.threadId, executionContextId: thread.executionContextId, agentId: thread.agentId });
          }
          const retainedTerminals = new Set(terminalPaneTargets(next).map((pane) => pane.terminalId));
          const liveTerminals = await this.#terminals?.knownTerminalIds() ?? new Set<string>();
          if (terminalPaneTargets(current.workspaces).some((pane) => pane.terminalId && liveTerminals.has(pane.terminalId) && !retainedTerminals.has(pane.terminalId))) throw new Error('Close the workspace or terminal before removing its layout.');
          const provision = async (node: TerminalLayoutNode): Promise<TerminalLayoutNode> => {
            if (node.kind === 'split') return { ...node, children: [await provision(node.children[0]), await provision(node.children[1])] };
            if (node.kind !== 'terminal' || node.terminalId) return node;
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
                const active = await runtime;
                const release = active.reserveWorkspaceClose();
                try {
                  if (input.stopActive) await active.stopForClose('Thread archived.');
                  else await active.archive();
                } finally { release(); }
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
          await this.#pruneEmptyWorkspaces();
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
    if (BROWSER_PROFILE_RPC_METHODS.includes(method as BrowserProfileRpcMethod)) { await this.security.assertActive(principal); return; }
    if (CLIENT_BROWSER_PANE_RPC_METHODS.includes(method as ClientBrowserPaneRpcMethod)) { await this.security.authorize(principal, 'context.manage'); return; }
    if (HOST_BROWSER_PANE_RPC_METHODS.includes(method as HostBrowserPaneRpcMethod)) {
      const profileId = (params as { profileId?: string }).profileId;
      if (profileId) await this.security.authorize(principal, 'browser.profile.control', { browserProfileId: profileId });
      else await this.security.authorize(principal, 'browser.profile.manage');
      await this.security.authorize(principal, 'context.manage'); return;
    }
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
    sendBrowser?: (notification: BrowserNotification) => unknown,
  ) {
    return new PortalRpcSession(
      this,
      this.#workspaceFiles.openWatchSession(send),
      this.#terminals?.openSession(
        crypto.randomUUID(),
        sendTerminal ?? (() => undefined),
      ),
      principal,
      this.#browsers?.connect((workspaceId, control) => this.#authorizeBrowser(principal, workspaceId, control), sendBrowser ?? (() => false)),
      this.#browserPages?.connect(principal),
    );
  }

  bindBrowserStream(principal: PortalPrincipal, ticket: string, close: () => void) {
    if (!this.#browserPages) throw new Error('Managed Browser Service is not configured.');
    return this.#browserPages.bind(principal, ticket, close);
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
    this.#closing = true;
    clearInterval(this.#browserReconcileTimer);
    await this.#browserReconcile;
    await this.#browserAgent?.close();
    this.#browserPages?.close();
    if (this.#browsers) await this.#browsers.close();
    else this.#browserBackend?.dispose();
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

  async #createAgentBrowserPage(threadId: string, profileId: string, url: string) {
    return this.#mutateLifecycle(async () => {
      const thread = this.#thread(threadId);
      if (thread.status !== 'active' || this.#closingWorkspaces.has(thread.workspaceId)) throw new Error('Thread Workspace unavailable');
      const current = await this.#compositions.get(this.security.hostId);
      const workspace = current.workspaces.find(item => item.workspaceId === thread.workspaceId);
      const source = workspace && paneTargets([workspace]).find(pane => pane.kind === 'agent' && pane.threadId === threadId);
      if (!workspace || !source) throw new Error('Agent Pane is unavailable for a Browser split');
      const pageId = crypto.randomUUID();
      const next = insertHostBrowserPane(current.workspaces, workspace.workspaceId, { kind: 'host-browser', nodeId: crypto.randomUUID(), paneId: pageId, profileId, lastCommittedUrl: url }, source.paneId, 'horizontal');
      const page = await this.#browserBackend!.managedPage!<ManagedPageSummary>('page.create', { pageId, profileId, url });
      try {
        await this.#compositions.replace(this.security.hostId, current.revision, next, async () => { this.#thread(threadId); });
        const target = await this.#browserBackend!.managedPage!<{ targetInfo: { targetId: string } }>('page.cdp', { pageId, generation: page.generation, arguments: { method: 'Target.getTargetInfo', arguments: {} } });
        return { targetId: target.targetInfo.targetId };
      } catch (error) { await this.#closeBrowserPage(pageId, profileId, page.generation); throw error; }
    });
  }

  async #closeAgentBrowserPage(threadId: string, profileId: string, targetId: string) {
    return this.#mutateLifecycle(async () => {
      this.#thread(threadId);
      const { pages } = await this.#browserBackend!.managedPage!<{ pages: ManagedPageSummary[] }>('page.list', { profileId });
      for (const page of pages.filter(page => page.available)) {
        const target = await this.#browserBackend!.managedPage!<{ targetInfo: { targetId: string } }>('page.cdp', { pageId: page.pageId, generation: page.generation, arguments: { method: 'Target.getTargetInfo', arguments: {} } });
        if (target.targetInfo.targetId !== targetId) continue;
        this.#thread(threadId);
        await this.#closeBrowserPage(page.pageId, profileId, page.generation);
        await this.#reconcileHostBrowserPanes(); return;
      }
      throw new Error('Target is not an available Browser Pane in this Profile');
    });
  }

  async #reconcileHostBrowserPanes() {
    if (this.#closing || !this.#browserBackend?.managedPage) return;
    const current = await this.#compositions.get(this.security.hostId);
    const profiles = new Set(paneTargets(current.workspaces).flatMap(pane => pane.kind === 'host-browser' ? [pane.profileId] : []));
    if (!profiles.size) return;
    const pages: ManagedPageSummary[] = [];
    for (const profileId of profiles) {
      const result = await this.#browserBackend.managedPage<{ pages: ManagedPageSummary[] }>('page.list', { profileId });
      // Use the same validated metadata that is exposed through public RPC.
      pages.push(...result.pages.map(page => ({ ...parseBrowserPage(page), ...(page.openerPageId ? { openerPageId: page.openerPageId } : {}) })));
    }
    const next = reconcileHostBrowserPanes(current.workspaces, pages, profiles);
    if (next.changed) {
      await this.#compositions.replace(this.security.hostId, current.revision, next.workspaces, async () => undefined);
      await this.#pruneEmptyWorkspaces();
    }
    for (const pageId of next.rejected) {
      const page = pages.find(page => page.pageId === pageId)!;
      await this.#browserBackend.managedPage('page.close', { pageId, generation: page.generation });
      console.error('Browser popup could not be placed because the Workspace layout is full:', pageId);
    }
  }

  async #closeBrowserPage(pageId: string, profileId: string, generation?: string) {
    const backend = this.#browserBackend!;
    await backend.managedPage!('page.close', { pageId, generation });
    // The native close acknowledgement stops the opener from spawning more pages.
    // Close only children that have not acquired their own Pane; placed pages survive.
    const placed = new Set(paneTargets((await this.#compositions.get(this.security.hostId)).workspaces).map(pane => pane.paneId));
    const { pages } = await backend.managedPage!<{ pages: ManagedPageSummary[] }>('page.list', { profileId });
    for (const page of pages) if (page.openerPageId === pageId && !placed.has(page.pageId)) await this.#closeBrowserPage(page.pageId, profileId, page.generation);
  }

  async #clientBrowserPaneRequest(principal: PortalPrincipal, method: ClientBrowserPaneRpcMethod, raw: ClientBrowserPaneRpcContracts[ClientBrowserPaneRpcMethod]['params']) {
    const input = parseClientBrowserPaneRpcParams(method, raw);
    return this.#mutateLifecycle(async () => {
      if (input.hostId !== this.security.hostId) throw new CompositionError({ domain: 'composition', code: 'INVALID_TARGET' });
      await this.security.authorize(principal, 'context.manage');
      if (!this.#clientBrowserAccess(principal)) throw new PortalSecurityError('RESOURCE_UNAVAILABLE', 'Client Browser is unavailable.');
      const current = await this.#compositions.get(input.hostId);
      if ('paneIds' in input) {
        // Absence from a filtered composition is not evidence of shared closure.
        const present = new Set(paneTargets(current.workspaces).filter(pane => pane.kind === 'client-browser').map(pane => pane.paneId));
        return { closedPaneIds: input.paneIds.filter(id => !present.has(id)) };
      }
      const source = current.workspaces.find(workspace => paneTargets([workspace]).some(pane => pane.paneId === input.paneId));
      const existing = source && paneTargets([source]).find(pane => pane.paneId === input.paneId);
      if (existing && existing.kind !== 'client-browser') throw new CompositionError({ domain: 'composition', code: 'INVALID_TARGET' });
      if (source) await this.#validateAssignment(principal, input.hostId, source.workspaceId);
      if ('workspaceId' in input) await this.#validateAssignment(principal, input.hostId, input.workspaceId);
      if (method === 'client-browser.pane.create' && existing && 'initialUrl' in input) {
        if (source!.workspaceId !== input.workspaceId || existing.initialUrl !== input.initialUrl) throw new Error('Client Browser Pane already exists with another initial address or placement.');
        return { composition: this.#visibleComposition(principal, current) };
      }
      if (method === 'client-browser.pane.close' && !existing) return { composition: this.#visibleComposition(principal, current) };
      if (current.revision !== input.expectedRevision) throw new CompositionError({ domain: 'composition', code: 'STALE_REVISION', currentRevision: current.revision });
      let next: Workspace[];
      if ('initialUrl' in input) {
        next = insertBrowserPane(current.workspaces, input.workspaceId, { kind: 'client-browser', nodeId: crypto.randomUUID(), paneId: input.paneId, initialUrl: input.initialUrl }, input.sourcePaneId, input.axis);
      } else {
        if (!existing) throw new Error('Client Browser Pane is unavailable.');
        next = removeBrowserPane(current.workspaces, input.paneId, 'client-browser');
        if ('confirmed' in input) {
          if (!input.confirmed) throw new Error('Confirm Client Browser closure on every device; unsent forms will be lost.');
        } else {
          next = insertBrowserPane(next, input.workspaceId, existing, input.sourcePaneId, input.axis);
        }
      }
      // This operation owns placement only. No Host browser backend is consulted.
      const composition = await this.#compositions.replace(input.hostId, current.revision, next, async () => {
        await this.security.authorize(principal, 'context.manage');
        if (source) await this.#authorizeWorkspaceAssignment(principal, source);
        if ('workspaceId' in input) await this.#authorizeWorkspaceAssignment(principal, current.workspaces.find(workspace => workspace.workspaceId === input.workspaceId)!);
      });
      const pruned = await this.#pruneEmptyWorkspaces();
      return { composition: this.#visibleComposition(principal, pruned.revision >= composition.revision ? pruned : composition) };
    });
  }

  async #browserPaneRequest(principal: PortalPrincipal, method: HostBrowserPaneRpcMethod, raw: HostBrowserPaneRpcContracts[HostBrowserPaneRpcMethod]['params']) {
    const input = parseHostBrowserPaneRpcParams(method, raw);
    const backend = this.#browserBackend;
    if (!this.#browserPages || !backend?.managedPage) throw new Error('Managed Browser Service is not configured.');
    return this.#mutateLifecycle(async () => {
      if (input.hostId !== this.security.hostId) throw new CompositionError({ domain: 'composition', code: 'INVALID_TARGET' });
      if (input.profileId) await this.security.authorize(principal, 'browser.profile.control', { browserProfileId: input.profileId });
      else await this.security.authorize(principal, 'browser.profile.manage');
      const current = await this.#compositions.get(input.hostId);
      const existingWorkspace = current.workspaces.find(workspace => paneTargets([workspace]).some(pane => pane.paneId === input.paneId));
      const existing = existingWorkspace && paneTargets([existingWorkspace]).find(pane => pane.paneId === input.paneId);
      if (existing && (existing.kind !== 'host-browser' || (input.profileId !== undefined && existing.profileId !== input.profileId))) throw new CompositionError({ domain: 'composition', code: 'INVALID_TARGET' });
      if (existingWorkspace) await this.#validateAssignment(principal, input.hostId, existingWorkspace.workspaceId);
      if (method === 'browser.pane.create' && existing && 'url' in input) {
        if (existingWorkspace!.workspaceId !== input.workspaceId) throw new Error('Browser Pane is already in another Workspace');
        const { pages } = await backend.managedPage!<{ pages: ManagedPageSummary[] }>('page.list', { profileId: input.profileId });
        const page = pages.find(page => page.pageId === input.paneId);
        if (!page) throw new Error('Browser page metadata is unavailable');
        if (input.profileId) await this.security.authorize(principal, 'browser.profile.control', { browserProfileId: input.profileId });
      else await this.security.authorize(principal, 'browser.profile.manage');
        await this.#authorizeWorkspaceAssignment(principal, existingWorkspace!);
        return { composition: this.#visibleComposition(principal, current), page: parseBrowserPage(page) };
      }
      if (method === 'browser.pane.close' && !existing) return { composition: this.#visibleComposition(principal, current) };
      if (current.revision !== input.expectedRevision) throw new CompositionError({ domain: 'composition', code: 'STALE_REVISION', currentRevision: current.revision });
      if (method === 'browser.pane.create' && 'url' in input) {
        const workspace = current.workspaces.find(workspace => workspace.workspaceId === input.workspaceId);
        if (!workspace && !input.workspaceName) throw new Error('A name is required for a new Browser Workspace');
        const target: Workspace = workspace ?? { workspaceId: input.workspaceId, name: input.workspaceName!, layout: null };
        if (this.#closingWorkspaces.has(target.workspaceId)) throw new Error('Workspace is closing.');
        await this.#authorizeWorkspaceAssignment(principal, target);
        const pane = { kind: 'host-browser' as const, nodeId: crypto.randomUUID(), paneId: input.paneId, profileId: input.profileId ?? input.paneId, lastCommittedUrl: input.url };
        const next = insertHostBrowserPane(workspace ? current.workspaces : [...current.workspaces, target], input.workspaceId, pane, input.sourcePaneId, input.axis);
        const page = parseBrowserPage(await backend.managedPage!<ManagedPageSummary>('page.create', { profileId: input.profileId, pageId: input.paneId, url: input.url }));
        for (const item of paneTargets(next)) if (item.kind === 'host-browser' && item.paneId === pane.paneId) { item.lastCommittedUrl = page.url; item.profileId = page.profileId; }
        let composition: WorkspaceComposition;
        try {
          composition = await this.#compositions.replace(input.hostId, current.revision, next, async () => {
            if (input.profileId) await this.security.authorize(principal, 'browser.profile.control', { browserProfileId: input.profileId });
            else await this.security.authorize(principal, 'browser.profile.manage');
            await this.#authorizeWorkspaceAssignment(principal, target);
          });
        } catch (error) { await this.#closeBrowserPage(page.pageId,page.profileId,page.generation); throw error; }
        return { composition: this.#visibleComposition(principal, composition), page: parseBrowserPage(page) };
      }
      if (!existing || existing.kind !== 'host-browser') throw new Error('Browser Pane is unavailable');
      if (method === 'browser.pane.profile' && 'profileId' in input && !('workspaceId' in input) && !('confirmed' in input)) {
        if (input.selectedProfileId) await this.security.authorize(principal, 'browser.profile.control', { browserProfileId: input.selectedProfileId });
        else await this.security.authorize(principal, 'browser.profile.manage');
        const page = parseBrowserPage(await backend.managedPage!<ManagedPageSummary>('page.profile', { pageId: input.paneId, profileId: existing.profileId, selectedProfileId: input.selectedProfileId }));
        const next = structuredClone(current.workspaces);
        for (const pane of paneTargets(next)) if (pane.kind === 'host-browser' && pane.paneId === input.paneId) { pane.profileId=page.profileId; pane.lastCommittedUrl=page.url; }
        const composition = await this.#compositions.replace(input.hostId, current.revision, next, async () => { await this.security.assertActive(principal); });
        return { composition: this.#visibleComposition(principal, composition), page };
      }
      if (method === 'browser.pane.close' && 'confirmed' in input) {
        const { pages } = await backend.managedPage!<{ pages: ManagedPageSummary[] }>('page.list', { profileId: input.profileId });
        const page = pages.find(page => page.pageId === input.paneId);
        if (page?.available && !input.confirmed) throw new Error('Confirm closure of the live browser page; unsaved browser work may be lost.');
        if (input.profileId) await this.security.authorize(principal, 'browser.profile.control', { browserProfileId: input.profileId });
      else await this.security.authorize(principal, 'browser.profile.manage');
        await this.#authorizeWorkspaceAssignment(principal, existingWorkspace!);
        await this.#closeBrowserPage(input.paneId, input.profileId, input.generation);
        const composition = await this.#compositions.replace(input.hostId, current.revision, removeHostBrowserPane(current.workspaces, input.paneId), async () => undefined);
        const pruned = await this.#pruneEmptyWorkspaces();
        return { composition: this.#visibleComposition(principal, pruned.revision >= composition.revision ? pruned : composition) };
      }
      if (!('workspaceId' in input)) throw new Error('Invalid Browser Pane operation');
      await this.#validateAssignment(principal, input.hostId, input.workspaceId);
      const removed = removeHostBrowserPane(current.workspaces, input.paneId);
      const next = insertHostBrowserPane(removed, input.workspaceId, existing, input.sourcePaneId, input.axis);
      const composition = await this.#compositions.replace(input.hostId, current.revision, next, async () => {
        if (input.profileId) await this.security.authorize(principal, 'browser.profile.control', { browserProfileId: input.profileId });
      else await this.security.authorize(principal, 'browser.profile.manage');
        await this.#authorizeWorkspaceAssignment(principal, existingWorkspace!);
        await this.#authorizeWorkspaceAssignment(principal, current.workspaces.find(workspace => workspace.workspaceId === input.workspaceId)!);
      });
      const pruned = await this.#pruneEmptyWorkspaces();
      return { composition: this.#visibleComposition(principal, pruned.revision >= composition.revision ? pruned : composition) };
    });
  }

  #clientBrowserAccess(principal: PortalPrincipal) { return principal.grants.trustedHuman === true && PORTAL_ACTIONS.every(action => principal.grants.actions.includes(action)); }

  #visibleComposition(principal: PortalPrincipal, composition: WorkspaceComposition) {
    return { ...composition, workspaces: composition.workspaces.filter((workspace) => this.#workspaceContextIds(workspace).every((executionContextId) => this.security.allows(principal, 'context.inspect', { executionContextId })) && paneTargets([workspace]).every(pane => {
      if (pane.kind === 'client-browser') return this.#clientBrowserAccess(principal);
      if (pane.kind === 'host-browser') return this.security.allows(principal, 'browser.profile.inspect', { browserProfileId: pane.profileId }) || this.security.allows(principal, 'browser.profile.control', { browserProfileId: pane.profileId });
      if (pane.kind !== 'agent') return true;
      const thread = this.#workspaceThreads().find(thread => thread.threadId === pane.threadId);
      return Boolean(thread && this.security.allows(principal, 'thread.inspect', { threadId: thread.threadId, executionContextId: thread.executionContextId, agentId: thread.agentId }));
    })) };
  }

  #workspaceThreads() { return [...this.#catalog.list('active'), ...this.#drafts.values()]; }

  async #pruneEmptyWorkspaces() {
    await this.#compositions.reconcileThreads(this.security.hostId, this.#workspaceThreads());
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
    const browsers = [];
    for (const pane of paneTargets([workspace])) if (pane.kind === 'host-browser') {
      await this.security.authorize(principal, 'browser.profile.control', { browserProfileId: pane.profileId });
      if (!this.#browserBackend?.managedPage) throw new Error('Browser state is unavailable. The Workspace cannot be closed.');
      const { pages } = await this.#browserBackend.managedPage<{ pages: ManagedPageSummary[] }>('page.list', { profileId: pane.profileId });
      const page = pages.find(page => page.pageId === pane.paneId);
      browsers.push({ pageId: pane.paneId, profileId: pane.profileId, title: page?.title || 'Browser', dirty: page?.available ?? true, ...(page?.generation ? { generation: page.generation } : {}) });
    }
    const clientBrowsers = paneTargets([workspace]).filter(pane => pane.kind === 'client-browser').map(pane => ({ paneId: pane.paneId, dirty: true as const }));
    // A confirmation is tied to exactly these members and their live activity.
    const token = createHash('sha256').update(JSON.stringify([workspace, terminals, threads, browsers, clientBrowsers, members.map((thread) => [thread.threadId, thread.membershipRevision])])).digest('hex');
    return { workspaceId, name: workspace.name, token, terminals, threads, ...(clientBrowsers.length ? { clientBrowsers } : {}), ...(browsers.length ? { browsers } : {}) };
  }

  #workspaceContextIds(workspace: Workspace) {
    return [...new Set([...terminalPaneTargets([workspace]).map((pane) => pane.executionContextId), ...[...this.#catalog.list(), ...this.#drafts.values()].filter((thread) => thread.workspaceId === workspace.workspaceId).map((thread) => thread.executionContextId)])];
  }
  async #authorizeBrowser(principal: PortalPrincipal, workspaceId: string, control: boolean) {
    await this.security.authorize(principal, control ? 'browser.control' : 'browser.observe', { workspaceId });
    const workspace = (await this.#compositions.get(this.security.hostId)).workspaces.find(workspace => workspace.workspaceId === workspaceId);
    if (!workspace || this.#closingWorkspaces.has(workspaceId)) throw new PortalSecurityError('RESOURCE_UNAVAILABLE', 'Resource is unavailable.');
    for (const executionContextId of this.#workspaceContextIds(workspace)) await this.security.authorize(principal, 'context.inspect', { executionContextId });
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
    await this.#authorizeWorkspaceAssignment(principal, workspace);
  }

  async #authorizeWorkspaceAssignment(principal: PortalPrincipal, workspace: Workspace) {
    await this.security.authorize(principal, 'context.manage');
    for (const executionContextId of this.#workspaceContextIds(workspace)) await this.security.authorize(principal, 'context.inspect', { executionContextId });
    if (!this.#visibleComposition(principal, { schemaVersion: 4, hostId: this.security.hostId, revision: 0, workspaces: [workspace] }).workspaces.length) throw new PortalSecurityError('RESOURCE_UNAVAILABLE', 'Resource is unavailable.');
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
      threadId => this.#browserAgent?.servers(threadId) ?? [],
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
      threadId => this.#browserAgent?.servers(threadId) ?? [],
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
        threadId => this.#browserAgent?.servers(threadId) ?? [],
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
