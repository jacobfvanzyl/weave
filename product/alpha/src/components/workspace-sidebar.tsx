import { clientBrowserAvailable } from '@/client-browser/native-client-browser';
import { HostBrowserSidebarTile } from './host-browser-sidebar-tile';
import { ClientBrowserSidebarTile } from './client-browser-sidebar-tile';
import type { CompactPane } from '@/app/compact-pane';
import type { TerminalPaneAction } from '@/app/terminal-pane-actions';
import { terminalFocusId } from '@/app/pane-focus';
import { useState, type ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { MoreVerticalIcon, MoreHorizontalIcon, ArrowDown01Icon, ArrowRight01Icon, FileBoxIcon, ComputerTerminal01Icon } from '@hugeicons/core-free-icons';
import { paneTargets, terminalPaneTargets, type Workspace, type WorkspaceClosePlan } from '@weave/product-protocol';
import { ConnectionsButton } from './connections-button';
import { PathLabel, TerminalTitle } from './path-label';
import { compactPath, sidebarTerminalTitle } from '@/lib/display-path';
import { cn } from '@/lib/utils';
import type { AlphaController, AlphaThread } from '@/app/alpha-controller';
import { workspaceKey, type WorkspaceReference } from '@/app/workspace-presentation';
import { workspaceDirectories } from '@/app/workspace-directories';
import { alphaSidebarMinimumWidth } from '@/app/alpha-pane-layout';
import { RenameWorkspaceDialog } from './workspace-arrangement-dialogs';
import { AddExecutionContextDialog } from './add-execution-context-dialog';
import { AgentActivityIndicator } from './agent-activity-indicator';
import { DraftChip } from './draft-chip';
import { CodexIcon } from './codex-icon';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from './ui/dropdown-menu';
import { Sidebar, SidebarHeader, SidebarContent, SidebarGroup, SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarMenuAction } from './ui/sidebar';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';

export function WorkspaceSidebar({ controller, onSelectThread, onSelectTerminal, headerActions, sidebarToggle, compactHeader, compact = false, selectedPane, onSelectWorkspace, onAddTerminal, terminalActions, onActionError }: { compact?: boolean; selectedPane?: CompactPane; onSelectWorkspace?(ref: WorkspaceReference): void; onAddTerminal?(ref: WorkspaceReference, contextId: string): Promise<void>; terminalActions?: Record<string, TerminalPaneAction>; onActionError?(message: string): void; headerActions?: ReactNode; sidebarToggle?: ReactNode; compactHeader?: ReactNode; controller: AlphaController; onSelectThread?(threadId: string): void; onSelectTerminal?(workspace: WorkspaceReference, paneId: string): void }) {
  const { model, actions, workspaceActions } = controller;
  const state = model.workspaceCompositions!;
  const [closing, setClosing] = useState<{ reference: WorkspaceReference; plan: WorkspaceClosePlan }>();
  const [closeBusy, setCloseBusy] = useState(false);
  const [closeError, setCloseError] = useState<string>();
  const requestClose = async (reference: WorkspaceReference) => {
    if (!workspaceActions) return;
    setCloseBusy(true); setCloseError(undefined);
    try {
      const plan = await workspaceActions.previewClose(reference);
      if ([...plan.terminals, ...plan.threads, ...(plan.browsers ?? []), ...(plan.clientBrowsers ?? [])].some((item) => item.dirty)) setClosing({ reference, plan });
      else await workspaceActions.close(reference, plan, false);
    } catch (cause) { setCloseError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setCloseBusy(false); }
  };
  const confirmClose = async () => {
    if (!closing || !workspaceActions) return;
    setCloseBusy(true); setCloseError(undefined);
    try { await workspaceActions.close(closing.reference, closing.plan, true); setClosing(undefined); }
    catch (cause) {
      setCloseError(cause instanceof Error ? cause.message : String(cause));
      try { setClosing({ ...closing, plan: await workspaceActions.previewClose(closing.reference) }); } catch { setClosing(undefined); }
    } finally { setCloseBusy(false); }
  };
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<{ reference: WorkspaceReference; name: string }>();
  const [choosingAgent, setChoosingAgent] = useState<{ reference: WorkspaceReference; directories?: string[] }>();
  const [creationError, setCreationError] = useState<string>();
  const connected = (hostId: string) => model.connections.some((connection) => connection.hostId === hostId && connection.status === 'connected');
  const allWorkspaces = Object.values(state.compositions).flatMap((composition) => composition.workspaces.map((workspace) => ({ workspace, reference: { hostId: composition.hostId, workspaceId: workspace.workspaceId } })));
  const records = (hostId: string) => state.terminals[hostId] ?? [];
  const threads = model.threads ?? [];
  const matches = (thread: AlphaThread) => !model.searchQuery || [thread.title, thread.hostName, thread.workingDirectory].join(' ').toLowerCase().includes(model.searchQuery.toLowerCase());
  const createAgent = (reference: WorkspaceReference, workspace: Workspace) => {
    const directories = workspaceDirectories(workspace, records(reference.hostId));
    const focused = state.presentation.focusedPanes[workspaceKey(reference)];
    const pane = terminalPaneTargets([workspace]).find((pane) => pane.paneId === focused);
    const path = records(reference.hostId).find((record) => record.terminalId === pane?.terminalId)?.currentDirectory;
    const target = path ?? (directories.length === 1 ? directories[0] : undefined);
    const context = model.executionContexts.find((context) => context.hostId === reference.hostId && context.canonicalPath === target && context.availability === 'available');
    if (context) { void actions.createThread(context.id, undefined, reference.workspaceId); return; }
    if (target && actions.createThreadInDirectory) { void actions.createThreadInDirectory(reference.hostId, target, reference.workspaceId); return; }
    setChoosingAgent({ reference, directories });
  };
  const threadRow = (thread: AlphaThread, paneId: string) => {
    const ref = { hostId: thread.hostId, workspaceId: thread.workspaceId ?? '' };
    const workspace = state.compositions[thread.hostId]?.workspaces.find(workspace => workspace.workspaceId === thread.workspaceId);
    const panes = workspace ? paneTargets([workspace]) : [];
    const focused = panes.find(pane => pane.paneId === state.presentation.focusedPanes[workspaceKey(ref)]) ?? panes[0];
    const selected = state.presentation.activeWorkspace === workspaceKey(ref) && focused?.kind === 'agent' && focused.threadId === thread.threadId;
    const available = connected(thread.hostId);
    return <SidebarMenuItem key={paneId} data-pane-id={paneId} data-thread-id={thread.id}>
      <SidebarMenuButton size='default' data-agent-pane-state={selected ? 'visible' : undefined} className='data-active:bg-terminal-focus data-active:text-terminal-focus-foreground data-active:hover:bg-terminal-focus data-active:hover:text-terminal-focus-foreground' isActive={selected} aria-label={`Agent ${thread.title}`} aria-describedby={`agent-activity-${thread.id}`} aria-pressed={selected} onClick={() => onSelectThread ? onSelectThread(thread.id) : void actions.selectThread(thread.id)} disabled={!available || model.busy}>
        <CodexIcon /><span className='flex min-w-0 flex-1 items-center gap-2 pr-0.5'><span className='min-w-0 flex-1 truncate'>{thread.draft || !thread.title.trim() ? <DraftChip /> : thread.title}</span><AgentActivityIndicator id={`agent-activity-${thread.id}`} attention={thread.attention} completionUnread={thread.completionUnread} available={available} selected={selected} /></span>
      </SidebarMenuButton>
      <DropdownMenu><DropdownMenuTrigger render={<SidebarMenuAction className={cn(selected && 'text-primary-foreground peer-hover/menu-button:text-primary-foreground hover:text-primary-foreground')} aria-label={`Actions for ${thread.title}`} />}>⋯</DropdownMenuTrigger>
        <DropdownMenuContent><DropdownMenuGroup>
          {thread.workspaceId && <DropdownMenuItem onClick={() => workspaceActions?.activate({ hostId: thread.hostId, workspaceId: thread.workspaceId! })}>Open workspace</DropdownMenuItem>}
          <DropdownMenuSub><DropdownMenuSubTrigger disabled={!available}>Move to workspace…</DropdownMenuSubTrigger><DropdownMenuSubContent><DropdownMenuGroup>
            {allWorkspaces.filter(({ reference }) => reference.hostId === thread.hostId).map(({ reference, workspace }) => <DropdownMenuItem key={workspace.workspaceId} disabled={thread.workspaceId === workspace.workspaceId} onClick={() => void actions.assignThread?.(thread.id, reference.workspaceId)}>{workspace.name}</DropdownMenuItem>)}
          </DropdownMenuGroup></DropdownMenuSubContent></DropdownMenuSub>
          {thread.draft && <DropdownMenuItem onClick={() => void actions.discardThreadDraft?.(thread.id)}>Discard draft</DropdownMenuItem>}
          {thread.supportsThreadLifecycle && <DropdownMenuItem disabled={!available || model.busy} onClick={() => void actions.archiveThread(thread.id)}>Archive</DropdownMenuItem>}
        </DropdownMenuGroup></DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>;
  };
  return <>
    <Sidebar position='inline' collapsible='offcanvas' mobileWidth={compact ? '100vw' : `${alphaSidebarMinimumWidth}px`} className='min-w-0 flex-1'>
      {compactHeader}
      <SidebarHeader className='h-[var(--rail-height)] shrink-0 justify-center border-b bg-title-bar px-2 py-0'><div className='flex items-center justify-end gap-1'>{sidebarToggle && <span className='mr-auto flex'>{sidebarToggle}</span>}{headerActions}<ConnectionsButton controller={controller} />
        <DropdownMenu><DropdownMenuTrigger render={<Button size='rail' variant='ghost' aria-label='Sidebar actions' title='Sidebar actions' />}><HugeiconsIcon icon={MoreVerticalIcon} strokeWidth={2} /></DropdownMenuTrigger>
          <DropdownMenuContent align='end'>
            <DropdownMenuSub><DropdownMenuSubTrigger disabled={state.loading}>New workspace…</DropdownMenuSubTrigger><DropdownMenuSubContent><DropdownMenuGroup>
              {model.executionContexts.map((context) => <DropdownMenuItem key={context.id} disabled={!connected(context.hostId) || context.availability !== 'available'} onClick={() => void workspaceActions?.open(context.id)}>{model.showHostIdentity && <>{context.hostName} · </>}<PathLabel path={context.canonicalPath ?? context.name} /></DropdownMenuItem>)}
              {model.connections.map(connection => <DropdownMenuItem key={`browser:${connection.hostId}`} data-browser-host={connection.hostId} disabled={!connected(connection.hostId)} onClick={() => actions.newHostBrowserPane?.(connection.hostId)}>Host Browser{model.showHostIdentity ? ` · ${connection.displayName}` : ''}</DropdownMenuItem>)}
              <DropdownMenuItem onClick={() => setAdding(true)}>Add directory…</DropdownMenuItem>
            </DropdownMenuGroup></DropdownMenuSubContent></DropdownMenuSub>
            <DropdownMenuSub><DropdownMenuSubTrigger disabled={!allWorkspaces.length}>New agent…</DropdownMenuSubTrigger><DropdownMenuSubContent><DropdownMenuGroup>{allWorkspaces.map(({ reference, workspace }) => <DropdownMenuItem key={workspaceKey(reference)} disabled={!connected(reference.hostId)} onClick={() => createAgent(reference, workspace)}>{workspace.name}{model.showHostIdentity && <> · {model.connections.find((connection) => connection.hostId === reference.hostId)?.displayName}</>}</DropdownMenuItem>)}</DropdownMenuGroup></DropdownMenuSubContent></DropdownMenuSub>
            <DropdownMenuGroup><DropdownMenuItem onClick={actions.openArchivedThreads}><HugeiconsIcon icon={FileBoxIcon} />Archived Threads</DropdownMenuItem><DropdownMenuItem onClick={() => setAdding(true)}>Add directory…</DropdownMenuItem></DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div></SidebarHeader>
      <SidebarContent>
        {state.presentation.openWorkspaces.map((reference) => {
          const workspace = allWorkspaces.find((item) => workspaceKey(item.reference) === workspaceKey(reference))?.workspace;
          if (!workspace) return null;
          const key = workspaceKey(reference), active = key === state.presentation.activeWorkspace, collapsed = state.presentation.collapsedWorkspaces.includes(key);
          const hostName = model.connections.find((connection) => connection.hostId === reference.hostId)?.displayName;
          const contextPath = (id: string) => model.executionContexts.find((context) => context.hostId === reference.hostId && context.executionContextId === id)?.canonicalPath;
          // Match the main view's split-tree traversal: left/top child before right/bottom.
          const paneTiles = paneTargets([workspace]).map((pane) => {
            if (pane.kind === 'terminal') {
              const terminal = records(reference.hostId).find((terminal) => terminal.terminalId === pane.terminalId);
              const directory = terminal?.currentDirectory ?? pane.launchDirectory ?? terminal?.initialDirectory ?? contextPath(pane.executionContextId);
              const title = sidebarTerminalTitle(terminal?.title ?? 'Terminal', terminal?.processName, directory);
              return <SidebarMenuItem key={pane.paneId} data-pane-id={pane.paneId}><SidebarMenuButton className='data-active:bg-terminal-focus data-active:text-terminal-focus-foreground data-active:hover:bg-terminal-focus data-active:hover:text-terminal-focus-foreground' isActive={active && (compact ? selectedPane?.kind === 'terminal' && selectedPane.id === pane.paneId : state.presentation.focusedPanes[key] === pane.paneId)} aria-label={`Terminal ${title}`} aria-pressed={active && (compact ? selectedPane?.kind === 'terminal' && selectedPane.id === pane.paneId : state.presentation.focusedPanes[key] === pane.paneId)} onClick={() => onSelectTerminal ? onSelectTerminal(reference, pane.paneId) : workspaceActions?.focus(reference, pane.paneId)}><HugeiconsIcon icon={ComputerTerminal01Icon} />{directory && title === compactPath(directory) ? <PathLabel path={directory} className='flex-1' /> : <TerminalTitle title={title} className='flex-1' />}</SidebarMenuButton>{compact && <DropdownMenu><DropdownMenuTrigger render={<SidebarMenuAction aria-label={`Actions for terminal ${title}`} />}>⋯</DropdownMenuTrigger><DropdownMenuContent><DropdownMenuGroup><DropdownMenuItem disabled={!terminalActions?.[terminalFocusId(key, pane.paneId)]?.enabled} onClick={() => void terminalActions?.[terminalFocusId(key, pane.paneId)]?.terminate().catch(error => onActionError?.(error instanceof Error ? error.message : String(error)))}>Terminate terminal</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent></DropdownMenu>}</SidebarMenuItem>;
            }
            if (pane.kind === 'host-browser') return <HostBrowserSidebarTile key={pane.paneId} controller={controller} hostId={reference.hostId} paneId={pane.paneId} profileId={pane.profileId} active={active && state.presentation.focusedPanes[key] === pane.paneId} select={() => onSelectTerminal ? onSelectTerminal(reference, pane.paneId) : workspaceActions?.focus(reference, pane.paneId)} />;
            if (pane.kind === 'client-browser') return <ClientBrowserSidebarTile key={pane.paneId} hostId={reference.hostId} paneId={pane.paneId} initialUrl={pane.initialUrl} active={active && state.presentation.focusedPanes[key] === pane.paneId} select={() => onSelectTerminal ? onSelectTerminal(reference, pane.paneId) : workspaceActions?.focus(reference, pane.paneId)} />;
            const thread = threads.find(thread => thread.hostId === reference.hostId && thread.threadId === pane.threadId);
            return thread && matches(thread) ? threadRow(thread, pane.paneId) : null;
          });
          return <SidebarGroup key={key} data-workspace-id={workspace.workspaceId}><div data-slot='workspace-card' className={cn('rounded-[calc(var(--radius-sm)+2px)]', active && 'bg-sidebar-selected')}><SidebarMenu><SidebarMenuItem>
            <div data-slot='workspace-selection-row' className='grid grid-cols-[2rem_minmax(0,1fr)_2rem] items-center rounded-[calc(var(--radius-sm)+2px)] hover:bg-sidebar-accent'>
              <SidebarMenuButton size='default' className='col-span-3 col-start-1 row-start-1 pr-8 hover:bg-transparent active:bg-transparent data-active:bg-transparent' isActive={active} aria-pressed={active} aria-label={`Workspace ${workspace.name}`} onClick={() => onSelectWorkspace ? onSelectWorkspace(reference) : workspaceActions?.activate(reference)}>
                <span aria-hidden='true' className='size-4 shrink-0' />
                <span className='min-w-0 flex-1 truncate font-bold'>{workspace.name}</span>{model.showHostIdentity && <span className='max-w-1/3 truncate text-xs text-muted-foreground'>{hostName}</span>}{!connected(reference.hostId) && <span className='text-xs text-muted-foreground'>offline</span>}
              </SidebarMenuButton>
              <Button variant='ghost' size='icon' className='col-start-1 row-start-1 hover:bg-transparent aria-expanded:bg-transparent dark:hover:bg-transparent' aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${workspace.name}`} aria-expanded={!collapsed} onClick={() => workspaceActions?.collapse(key)}><HugeiconsIcon icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon} strokeWidth={2} /></Button>
              <DropdownMenu><DropdownMenuTrigger render={<Button size='icon' variant='ghost' className='col-start-3 row-start-1' aria-label={`Workspace actions for ${workspace.name}`} />}><HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} /></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuGroup>
                <DropdownMenuItem disabled={!connected(reference.hostId)} onClick={() => createAgent(reference, workspace)}>New agent thread</DropdownMenuItem>
                <DropdownMenuSub><DropdownMenuSubTrigger disabled={!connected(reference.hostId)}>New terminal…</DropdownMenuSubTrigger><DropdownMenuSubContent><DropdownMenuGroup>{model.executionContexts.filter((context) => context.hostId === reference.hostId).map((context) => <DropdownMenuItem key={context.id} disabled={context.availability !== 'available'} onClick={() => void (onAddTerminal ? onAddTerminal(reference, context.id) : workspaceActions?.addPane(reference, context.id))}><PathLabel path={context.canonicalPath ?? context.name} /></DropdownMenuItem>)}</DropdownMenuGroup></DropdownMenuSubContent></DropdownMenuSub>
                <DropdownMenuItem disabled={!connected(reference.hostId)} onClick={() => actions.newHostBrowserPane?.(reference.hostId,reference.workspaceId)}>New Host Browser</DropdownMenuItem>
                {clientBrowserAvailable && <DropdownMenuItem disabled={!connected(reference.hostId)} onClick={() => void actions.newClientBrowserPane?.(reference).catch(error => onActionError?.(error instanceof Error ? error.message : String(error)))}>New Client Browser</DropdownMenuItem>}
                <DropdownMenuItem disabled={state.pending || !connected(reference.hostId)} onClick={() => setRenaming({ reference, name: workspace.name })}>Rename workspace…</DropdownMenuItem>
                <DropdownMenuItem disabled={state.pending || closeBusy || !connected(reference.hostId)} onClick={() => void requestClose(reference)}>Close workspace</DropdownMenuItem>
              </DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
            </div>
          </SidebarMenuItem></SidebarMenu>
          {!collapsed && <SidebarMenu className='pb-1'>{paneTiles}</SidebarMenu>}
          </div></SidebarGroup>;
        })}

      </SidebarContent>
    </Sidebar>
    <Dialog open={Boolean(closing || closeError)} onOpenChange={(open) => { if (!open && !closeBusy) { setClosing(undefined); setCloseError(undefined); } }}><DialogContent>
      <DialogHeader><DialogTitle>{closing ? `Close ${closing.plan.name}?` : 'Could not close workspace'}</DialogTitle><DialogDescription>Closing stops this workspace’s terminals, agents and browser pages on every device. Running work, pending input and unsaved content may be lost. Agent conversations will be archived.</DialogDescription></DialogHeader>
      {closing && <ul className='max-h-64 overflow-y-auto text-sm'>
        {closing.plan.terminals.map((terminal) => <li key={terminal.terminalId}>{terminal.title} — terminal activity cannot be verified as idle</li>)}
        {closing.plan.threads.map((thread) => <li key={thread.threadId}>{thread.title}{thread.dirty ? ' — active or uncertain agent state' : ' — idle agent'}</li>)}
        {closing.plan.clientBrowsers?.map(pane => <li key={pane.paneId}>Client Browser — closes on every device; unsent forms will be lost</li>)}
        {closing.plan.browsers?.map(page => <li key={page.pageId}>{page.title}{page.dirty ? ' — unsaved browser work may be lost' : ' — unavailable browser page'}</li>)}
      </ul>}
      {closeError && <p role='alert' className='text-destructive'>{closeError}</p>}
      <div className='flex justify-end gap-2'><Button variant='outline' disabled={closeBusy} onClick={() => { setClosing(undefined); setCloseError(undefined); }}>Cancel</Button>{closing && <Button variant='destructive' disabled={closeBusy} onClick={() => void confirmClose()}>{closeBusy ? 'Closing…' : 'Close workspace'}</Button>}</div>
    </DialogContent></Dialog>
    {renaming && <RenameWorkspaceDialog controller={controller} reference={renaming.reference} initialName={renaming.name} onClose={() => setRenaming(undefined)} />}
    <AddExecutionContextDialog controller={controller} open={adding} onOpenChange={setAdding} />
    <Dialog open={Boolean(choosingAgent)} onOpenChange={(open) => { if (!open) { setChoosingAgent(undefined); setCreationError(undefined); } }}><DialogContent><DialogHeader><DialogTitle>Choose agent directory</DialogTitle><DialogDescription>Select the Host directory where this agent will run.</DialogDescription></DialogHeader>
      {creationError && <p role='alert'>{creationError}</p>}
      {choosingAgent?.reference && choosingAgent.directories?.map((path) => <Button key={path} variant='outline' onClick={() => { void actions.createThreadInDirectory?.(choosingAgent.reference!.hostId, path, choosingAgent.reference!.workspaceId); setChoosingAgent(undefined); }}><PathLabel path={path} /></Button>)}
      {!choosingAgent?.directories?.length && model.executionContexts.filter((context) => (!choosingAgent?.reference || context.hostId === choosingAgent.reference.hostId) && (!choosingAgent?.directories?.length || choosingAgent.directories.includes(context.canonicalPath ?? ''))).map((context) => <Button key={context.id} variant='outline' disabled={!connected(context.hostId) || context.availability !== 'available'} onClick={() => { void actions.createThread(context.id, undefined, choosingAgent!.reference.workspaceId); setChoosingAgent(undefined); }}>{model.showHostIdentity && <>{context.hostName} · </>}<PathLabel path={context.canonicalPath ?? context.name} /></Button>)}
      <Button variant='outline' onClick={() => setAdding(true)}>Add directory…</Button>
    </DialogContent></Dialog>
  </>;
}
