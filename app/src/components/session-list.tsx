import { useRef, useState, type TouchEvent } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon, BubbleChatIcon, ComputerIcon, Delete02Icon, GitBranchIcon, LaptopIcon, Search01Icon, StopIcon, ViewIcon, ViewOffIcon } from '@hugeicons/core-free-icons';
import type { AppController, HostStatus, PairedHost, SessionSummary } from '@/app/app-controller';
import { type DirectoryGroup, sessionListView, subdirectory } from '@/app/session-list';
import { ActivityIndicator } from '@/components/activity-indicator';
import { DeleteSessionDialog } from '@/components/delete-session-dialog';
import { type NewSessionTarget, NewSessionDialog } from '@/components/new-session-dialog';
import { RemoveWorktreeDialog } from '@/components/remove-worktree-dialog';
import { Badge } from '@/components/ui/badge';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { directoryName } from '@/lib/display-path';
import { cn } from '@/lib/utils';

export const sinceLabel = (at: number | undefined, now = Date.now()) => {
  if (at === undefined) return '';
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
};

/** Where a thread runs in its repository: its branch, or its worktree's directory when detached. */
const branchLabel = (session: SessionSummary) =>
  session.git && (session.git.branch ?? directoryName(session.git.worktree));

/**
 * One session in the list: a tile with its activity, its title, and its agent and branch under it.
 * A long press, or a right-click, offers Close for an open session, Delete for any, so an old one
 * goes without being opened again, and Remove worktree for one in a worktree of its own.
 */
function SessionRow({ session, host, selected, unread, onOpen, actions }: {
  session: SessionSummary;
  host?: PairedHost;
  selected: boolean;
  unread: boolean;
  onOpen(): void;
  actions: AppController['actions'];
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const closed = session.state === 'closed';
  const unreachable = host !== undefined && host.status !== 'connected';
  const { git } = session;
  const removable = git !== undefined && git.worktree !== git.repo && !unreachable && host?.canWorktree === true;
  const branch = branchLabel(session);
  const within = subdirectory(session);
  return (
    <SidebarMenuItem>
      <ContextMenu>
        <ContextMenuTrigger className='[-webkit-touch-callout:none]'>
          <SidebarMenuButton
            size='lg'
            isActive={selected}
            aria-current={selected ? 'page' : undefined}
            className={cn(
              'h-auto min-h-12 gap-2.5 rounded-xl border border-transparent py-1.5 pl-1.5 data-active:border-sidebar-border',
              closed && 'opacity-60',
            )}
            data-state-session={session.state}
            onClick={onOpen}
          >
            <span className='relative grid size-7 shrink-0 place-items-center rounded-md border border-sidebar-border bg-sidebar-accent text-sidebar-foreground/80'>
              <HugeiconsIcon icon={BubbleChatIcon} strokeWidth={2} className='size-3.5!' aria-hidden />
              <ActivityIndicator activity={session.activity} unread={unread} className='absolute -top-1 -right-1 size-2.5 ring-2 ring-sidebar' />
            </span>
            <span className='flex min-w-0 flex-1 flex-col gap-0.5'>
              <span className='flex min-w-0 items-center gap-2'>
                <span className='truncate font-medium text-sidebar-foreground'>{session.title || 'New thread'}</span>
                <span className='ml-auto shrink-0 text-[0.6875rem] text-muted-foreground'>{sinceLabel(session.lastActivityAt)}</span>
              </span>
              <span className='flex min-w-0 items-center gap-1.5 text-[0.6875rem] text-muted-foreground'>
                <span className='shrink-0'>{session.agentName}</span>
                {branch && <span className='truncate'>· {branch}{within && ` / ${within}`}</span>}
                {session.startedBy && <span className='truncate'>· {session.startedBy.label}</span>}
                {session.headless && <Badge variant='outline'>headless</Badge>}
                {closed && <span>closed</span>}
              </span>
            </span>
          </SidebarMenuButton>
        </ContextMenuTrigger>
        <ContextMenuContent aria-label={`${session.title || 'New thread'} actions`}>
          {session.state === 'open' && (
            <ContextMenuItem disabled={unreachable} onClick={() => void actions.closeSession(session.key)}>
              <HugeiconsIcon icon={StopIcon} strokeWidth={2} />
              Close thread
            </ContextMenuItem>
          )}
          <ContextMenuItem variant='destructive' disabled={unreachable} onClick={() => setConfirmDelete(true)}>
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            Delete thread…
          </ContextMenuItem>
          {removable && (
            <ContextMenuItem variant='destructive' onClick={() => setConfirmRemove(true)}>
              <HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} />
              Remove worktree…
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
      <DeleteSessionDialog session={session} actions={actions} open={confirmDelete} onOpenChange={setConfirmDelete} />
      {git && removable && (
        <RemoveWorktreeDialog hostId={session.hostId} worktree={git} actions={actions} open={confirmRemove} onOpenChange={setConfirmRemove} />
      )}
    </SidebarMenuItem>
  );
}

const hostStatus: Record<HostStatus, string | undefined> = {
  connected: undefined,
  connecting: 'connecting',
  reconnecting: 'unreachable',
  disconnected: 'disconnected',
  revoked: 'revoked',
  incompatible: 'incompatible',
};

/** A Host's heading: its name, and how it's connected when it isn't. */
function HostHeading({ host, onNewSession }: { host: PairedHost; onNewSession(): void }) {
  const status = hostStatus[host.status];
  return (
    <>
      <SidebarGroupLabel title={host.url} className='h-9 gap-2 pr-9 text-sm font-medium text-sidebar-foreground [&>svg]:size-4.5'>
        <HugeiconsIcon icon={LaptopIcon} strokeWidth={1.75} className='text-icon-muted' aria-hidden />
        <span className='min-w-0 truncate'>{host.name}</span>
        {status && <span className='shrink-0 text-[0.6875rem] font-normal text-muted-foreground'>· {status}</span>}
      </SidebarGroupLabel>
      <SidebarGroupAction aria-label={`New thread on ${host.name}`} title={`New thread on ${host.name}`}
        className='top-3.5 right-2.5' disabled={host.status !== 'connected'} onClick={onNewSession}>
        <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
      </SidebarGroupAction>
    </>
  );
}

/** A directory's heading, or its repository's, under its Host's. */
function DirectoryHeading({ group, onNewSession }: { group: DirectoryGroup; onNewSession(): void }) {
  return (
    <>
      <SidebarGroupLabel title={group.cwd} className='h-7 pr-9 font-normal text-muted-foreground'>
        <span className='min-w-0 truncate'>{group.name}</span>
      </SidebarGroupLabel>
      <SidebarGroupAction aria-label={`New thread in ${group.name}`} title={`New thread in ${group.cwd}`} className='top-1 right-0.5' onClick={onNewSession}>
        <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
      </SidebarGroupAction>
    </>
  );
}

/** Pulling the list down from its top, past a threshold, lists the sessions again. */
function usePullToRefresh(onRefresh?: () => Promise<void> | void) {
  const start = useRef<number>(undefined);
  const [state, setState] = useState<'idle' | 'pulled' | 'refreshing'>('idle');
  if (!onRefresh) return { state, handlers: {} };
  return {
    state,
    handlers: {
      onTouchStart(event: TouchEvent<HTMLDivElement>) {
        start.current = event.currentTarget.scrollTop <= 0 ? event.touches[0]?.clientY : undefined;
      },
      onTouchMove(event: TouchEvent<HTMLDivElement>) {
        const y = event.touches[0]?.clientY;
        if (start.current !== undefined && y !== undefined && y - start.current > 70 && state === 'idle') setState('pulled');
      },
      async onTouchEnd() {
        start.current = undefined;
        if (state !== 'pulled') return;
        setState('refreshing');
        try {
          await onRefresh();
        } finally {
          setState('idle');
        }
      },
    },
  };
}

/** Every paired Host's sessions: a group per Host, and under it one per directory or repository. */
export function SessionList({ controller, onOpen, onOpenHosts }: {
  controller: AppController;
  onOpen?(): void;
  onOpenHosts(): void;
}) {
  const { model, actions } = controller;
  const [query, setQuery] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const [newSession, setNewSession] = useState<NewSessionTarget>();
  const pull = usePullToRefresh(actions.refresh);
  const view = sessionListView(model.sessions, model.hosts, { query, showClosed });
  const host = (id: string) => model.hosts.find((item) => item.id === id);
  // Hosts show once any has a thread to list.
  const listed = view.hosts.some(({ directories }) => directories.length > 0);
  const unreachable = model.hosts.filter(({ status }) => status !== 'connected').length;
  const open = (key: string) => {
    actions.selectSession(key);
    onOpen?.();
  };
  const row = (session: SessionSummary) => (
    <SessionRow
      key={session.key}
      session={session}
      host={host(session.hostId)}
      selected={session.key === model.selectedKey}
      unread={model.unread.has(session.key)}
      onOpen={() => open(session.key)}
      actions={actions}
    />
  );

  return (
    <div data-slot='session-list' className='flex h-full min-h-0 w-full flex-col bg-sidebar text-sidebar-foreground'>
      {/* As tall as the session's header beside it, so their edges line up; its + sits over the directories' +. */}
      <SidebarHeader className='h-[calc(env(safe-area-inset-top)+var(--title-bar-height))] shrink-0 flex-row items-center gap-1 border-b border-sidebar-border pt-[env(safe-area-inset-top)] pr-1.5 pb-0 pl-3'>
        <h1 className='sr-only'>Threads</h1>
        {model.hosts.length > 0 && (
          <div className='relative min-w-0 flex-1'>
            <HugeiconsIcon icon={Search01Icon} strokeWidth={2}
              className='pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-icon-muted' />
            <SidebarInput type='search' aria-label='Filter threads' placeholder='Filter threads' className='pl-7'
              value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
        )}
        <Button size='icon' variant='ghost' aria-label='New thread' data-sidebar='header-action' className='ml-auto shrink-0'
          disabled={!model.hosts.some(({ status }) => status === 'connected')} onClick={() => setNewSession({})}>
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
        </Button>
      </SidebarHeader>

      <SidebarContent {...pull.handlers}>
        {pull.state !== 'idle' && (
          <p role='status' className='py-2 text-center text-[0.6875rem] text-muted-foreground'>
            {pull.state === 'pulled' ? 'Release to refresh' : 'Refreshing…'}
          </p>
        )}
        {model.error && (
          <p role='alert' className='px-3 py-2 text-[0.6875rem] text-destructive'>{model.error}</p>
        )}
        {model.hosts.length === 0 && (
          <Empty className='p-6'>
            <EmptyHeader>
              <EmptyTitle>No Hosts yet</EmptyTitle>
              <EmptyDescription>Pair this device with a weave Host to see its threads.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={onOpenHosts}>Pair a Host</Button>
            </EmptyContent>
          </Empty>
        )}
        {listed && view.hosts.map(({ host: paired, directories }) => (
          <SidebarGroup key={paired.id} role='group' aria-label={paired.name} className='py-1.5'>
            <HostHeading host={paired} onNewSession={() => setNewSession({ hostId: paired.id })} />
            {directories.map((group) => (
              <div key={group.key} role='group' aria-label={group.name} className='relative'>
                <DirectoryHeading group={group} onNewSession={() => setNewSession({ hostId: group.hostId, cwd: group.cwd })} />
                <SidebarMenu className='gap-0.5'>{group.sessions.map(row)}</SidebarMenu>
              </div>
            ))}
            {directories.length === 0 && <p className='px-2 pb-1 text-[0.6875rem] text-muted-foreground'>No threads</p>}
          </SidebarGroup>
        ))}
        {model.hosts.length > 0 && !listed && (
          <Empty className='p-6'>
            <EmptyHeader>
              <EmptyTitle>{query ? 'No matching threads' : 'No threads'}</EmptyTitle>
              <EmptyDescription>
                {query ? 'Try another filter.' : 'Start one with New thread.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </SidebarContent>

      <SidebarFooter className='shrink-0 flex-row items-center gap-1 border-t border-sidebar-border px-2 pt-1.5 pb-[calc(env(safe-area-inset-bottom)+0.375rem)]'>
        <Button variant='ghost' size='lg' aria-pressed={showClosed} onClick={() => setShowClosed((value) => !value)}>
          <HugeiconsIcon icon={showClosed ? ViewOffIcon : ViewIcon} strokeWidth={2} />
          {showClosed ? 'Hide closed' : 'Show closed'}
        </Button>
        <Button variant='ghost' size='lg' className='ml-auto' onClick={onOpenHosts}>
          <HugeiconsIcon icon={ComputerIcon} strokeWidth={2} />
          Hosts
          {unreachable > 0 && <Badge variant='destructive' aria-label={`${unreachable} unreachable`}>{unreachable}</Badge>}
        </Button>
      </SidebarFooter>

      <NewSessionDialog controller={controller} target={newSession} onClose={() => setNewSession(undefined)} />
    </div>
  );
}
