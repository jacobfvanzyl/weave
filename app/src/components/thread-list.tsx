import { useRef, useState, type TouchEvent } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon, BubbleChatIcon, ComputerIcon, Delete02Icon, GitBranchIcon, LaptopIcon, Search01Icon, StopIcon, ViewIcon, ViewOffIcon } from '@hugeicons/core-free-icons';
import type { AppController, DispatcherSummary, HostStatus, HostSummary, ThreadSummary } from '@/app/app-controller';
import { type DirectoryGroup, subdirectory, threadListView } from '@/app/thread-list';
import { ActivityIndicator } from '@/components/activity-indicator';
import { DeleteThreadDialog } from '@/components/delete-thread-dialog';
import { type NewThreadTarget, NewThreadDialog } from '@/components/new-thread-dialog';
import { useCommand } from '@/app/commands';
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
const branchLabel = (thread: ThreadSummary) =>
  thread.git && (thread.git.branch ?? directoryName(thread.git.worktree));

/**
 * One thread in the list: a tile with its activity, its title, and its agent and branch under it.
 * A long press, or a right-click, offers Close for an open thread, Delete for any, so an old one
 * goes without being opened again, and Remove worktree for one in a worktree of its own.
 */
function ThreadRow({ thread, host, selected, unread, onOpen, actions }: {
  thread: ThreadSummary;
  host?: HostSummary;
  selected: boolean;
  unread: boolean;
  onOpen(): void;
  actions: AppController['actions'];
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const closed = thread.state === 'closed';
  const unreachable = host !== undefined && host.status !== 'connected';
  const { git } = thread;
  const removable = git !== undefined && git.worktree !== git.repo && !unreachable && host?.canWorktree === true;
  const branch = branchLabel(thread);
  const within = subdirectory(thread);
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
            data-state-thread={thread.state}
            onClick={onOpen}
          >
            <span className='relative grid size-7 shrink-0 place-items-center rounded-md border border-sidebar-border bg-sidebar-accent text-sidebar-foreground/80'>
              <HugeiconsIcon icon={BubbleChatIcon} strokeWidth={2} className='size-3.5!' aria-hidden />
              <ActivityIndicator activity={thread.activity} unread={unread} className='absolute -top-1 -right-1 size-2.5 ring-2 ring-sidebar' />
            </span>
            <span className='flex min-w-0 flex-1 flex-col gap-0.5'>
              <span className='flex min-w-0 items-center gap-2'>
                <span className='truncate font-medium text-sidebar-foreground'>{thread.title || 'New thread'}</span>
                <span className='ml-auto shrink-0 text-[0.6875rem] text-muted-foreground'>{sinceLabel(thread.lastActivityAt)}</span>
              </span>
              <span className='flex min-w-0 items-center gap-1.5 text-[0.6875rem] text-muted-foreground'>
                <span className='shrink-0'>{thread.agentName}</span>
                {branch && <span className='truncate'>· {branch}{within && ` / ${within}`}</span>}
                {thread.startedBy && <span className='truncate'>· {thread.startedBy.label}</span>}
                {thread.headless && <Badge variant='outline'>headless</Badge>}
                {closed && <span>closed</span>}
              </span>
            </span>
          </SidebarMenuButton>
        </ContextMenuTrigger>
        <ContextMenuContent aria-label={`${thread.title || 'New thread'} actions`}>
          {thread.state === 'open' && (
            <ContextMenuItem disabled={unreachable} onClick={() => void actions.closeThread(thread.key)}>
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
      <DeleteThreadDialog thread={thread} actions={actions} open={confirmDelete} onOpenChange={setConfirmDelete} />
      {git && removable && (
        <RemoveWorktreeDialog hostId={thread.hostId} worktree={git} actions={actions} open={confirmRemove} onOpenChange={setConfirmRemove} />
      )}
    </SidebarMenuItem>
  );
}

const hostStatus: Record<HostStatus, string | undefined> = {
  connected: undefined,
  connecting: 'connecting',
  reconnecting: 'reconnecting',
  unreachable: 'unreachable',
  disconnected: 'disconnected',
  incompatible: 'incompatible',
};

/** A Host's heading: its name, and how it's connected when it isn't. */
function HostHeading({ host, onNewThread }: { host: HostSummary; onNewThread(): void }) {
  const status = hostStatus[host.status];
  return (
    <>
      <SidebarGroupLabel title={host.error} className='h-9 gap-2 pr-9 text-sm font-medium text-sidebar-foreground [&>svg]:size-4.5'>
        <HugeiconsIcon icon={LaptopIcon} strokeWidth={1.75} className='text-icon-muted' aria-hidden />
        <span className='min-w-0 truncate'>{host.name}</span>
        {status && <span className='shrink-0 text-[0.6875rem] font-normal text-muted-foreground'>· {status}</span>}
      </SidebarGroupLabel>
      <SidebarGroupAction aria-label={`New thread on ${host.name}`} title={`New thread on ${host.name}`}
        className='top-3.5 right-2.5' disabled={host.status !== 'connected'} onClick={onNewThread}>
        <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
      </SidebarGroupAction>
    </>
  );
}

/** A directory's heading, or its repository's, under its Host's. */
function DirectoryHeading({ group, onNewThread }: { group: DirectoryGroup; onNewThread(): void }) {
  return (
    <>
      <SidebarGroupLabel title={group.cwd} className='h-7 pr-9 font-normal text-muted-foreground'>
        <span className='min-w-0 truncate'>{group.name}</span>
      </SidebarGroupLabel>
      <SidebarGroupAction aria-label={`New thread in ${group.name}`} title={`New thread in ${group.cwd}`} className='top-1 right-0.5' onClick={onNewThread}>
        <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
      </SidebarGroupAction>
    </>
  );
}

/**
 * The Dispatcher can't be reached, or won't take this device: no Host can be reached until it
 * can, so the list below is as it last was.
 */
function DispatcherBanner({ dispatcher, actions, onOpenHosts }: {
  dispatcher: DispatcherSummary;
  actions: AppController['actions'];
  onOpenHosts(): void;
}) {
  const unreachable = dispatcher.status === 'reconnecting';
  const title = unreachable
    ? `Can't reach the Dispatcher on ${dispatcher.name}`
    : dispatcher.status === 'incompatible'
      ? `The Dispatcher on ${dispatcher.name} needs another version of the app`
      : `The Dispatcher on ${dispatcher.name} refused this device`;
  return (
    <div role='alert' data-slot='dispatcher-banner' className='mx-2 mt-2 grid gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[0.6875rem]'>
      <p className='font-medium text-sidebar-foreground'>{title}</p>
      <p className='text-muted-foreground'>
        {unreachable ? 'Your Hosts are shown as it last listed them, until it can be reached. ' : ''}
        {dispatcher.error}
      </p>
      <div className='flex gap-1.5'>
        {unreachable
          ? <Button size='sm' variant='outline' onClick={() => void actions.reconnectDispatcher()}>Try again</Button>
          : <Button size='sm' variant='outline' onClick={onOpenHosts}>Pair again</Button>}
      </div>
    </div>
  );
}

/** Pulling the list down from its top, past a threshold, lists the threads again. */
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

/**
 * The threads of every Host the Dispatcher lists: a group per Host, and under it one per directory
 * or repository. While the Dispatcher can't be reached, a banner says so, and the Hosts it last
 * listed stay, greyed out.
 */
export function ThreadList({ controller, onOpen, onOpenHosts }: {
  controller: AppController;
  onOpen?(): void;
  onOpenHosts(): void;
}) {
  const { model, actions } = controller;
  const [query, setQuery] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const [newThread, setNewThread] = useState<NewThreadTarget>();
  // The Mac's New Thread (⌘N), once a Host can start one.
  useCommand('thread.new', () => { if (model.hosts.some(({ status }) => status === 'connected')) setNewThread({}); });
  const pull = usePullToRefresh(actions.refresh);
  const view = threadListView(model.threads, model.hosts, { query, showClosed });
  const host = (id: string) => model.hosts.find((item) => item.id === id);
  // Hosts show once any has a thread to list.
  const listed = view.hosts.some(({ directories }) => directories.length > 0);
  const { dispatcher } = model;
  const away = dispatcher !== undefined && dispatcher.status !== 'connected';
  // A Host still connected while the Dispatcher is away, as the Mac's own over its socket, isn't greyed out.
  const hostAway = (paired: HostSummary) => away && paired.status !== 'connected';
  const unreachable = model.hosts.filter(({ status }) => status !== 'connected').length + (away ? 1 : 0);
  const open = (key: string) => {
    actions.selectThread(key);
    onOpen?.();
  };
  const row = (thread: ThreadSummary) => (
    <ThreadRow
      key={thread.key}
      thread={thread}
      host={host(thread.hostId)}
      selected={thread.key === model.selectedKey}
      unread={model.unread.has(thread.key)}
      onOpen={() => open(thread.key)}
      actions={actions}
    />
  );

  return (
    <div data-slot='thread-list' className='flex h-full min-h-0 w-full flex-col bg-sidebar text-sidebar-foreground'>
      {/* As tall as the thread's header beside it, so their edges line up; its + sits over the directories' +. */}
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
          disabled={!model.hosts.some(({ status }) => status === 'connected')} onClick={() => setNewThread({})}>
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
        </Button>
      </SidebarHeader>

      <SidebarContent {...pull.handlers}>
        {pull.state !== 'idle' && (
          <p role='status' className='py-2 text-center text-[0.6875rem] text-muted-foreground'>
            {pull.state === 'pulled' ? 'Release to refresh' : 'Refreshing…'}
          </p>
        )}
        {dispatcher && away && dispatcher.status !== 'connecting' && (
          <DispatcherBanner dispatcher={dispatcher} actions={actions} onOpenHosts={onOpenHosts} />
        )}
        {model.error && (
          <p role='alert' className='px-3 py-2 text-[0.6875rem] text-destructive'>{model.error}</p>
        )}
        {dispatcher && model.hosts.length === 0 && (
          <Empty className='p-6'>
            <EmptyHeader>
              <EmptyTitle>No Hosts yet</EmptyTitle>
              <EmptyDescription>
                {away
                  ? 'Your Hosts show once the Dispatcher can be reached.'
                  : <>No Host has joined the Dispatcher. <code>weave hosts add</code> on a computer has its Host join.</>}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={onOpenHosts}>Hosts</Button>
            </EmptyContent>
          </Empty>
        )}
        {listed && view.hosts.map(({ host: paired, directories }) => (
          <SidebarGroup key={paired.id} role='group' aria-label={paired.name} data-away={hostAway(paired) || undefined}
            className={cn('py-1.5', hostAway(paired) && 'opacity-60')}>
            <HostHeading host={paired} onNewThread={() => setNewThread({ hostId: paired.id })} />
            {!hostAway(paired) && paired.status !== 'connected' && paired.error && (
              <p className='px-2 pb-1 text-[0.6875rem] text-muted-foreground'>{paired.error}</p>
            )}
            {directories.map((group) => (
              <div key={group.key} role='group' aria-label={group.name} className='relative'>
                <DirectoryHeading group={group} onNewThread={() => setNewThread({ hostId: group.hostId, cwd: group.cwd })} />
                <SidebarMenu className='gap-0.5'>{group.threads.map(row)}</SidebarMenu>
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

      <NewThreadDialog controller={controller} target={newThread} onClose={() => setNewThread(undefined)} />
    </div>
  );
}
