import { useRef, useState, type TouchEvent } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon, ComputerIcon, Folder01Icon, GitBranchIcon, LaptopIcon, Search01Icon } from '@hugeicons/core-free-icons';
import type { AppController, DispatcherSummary, HostStatus, HostSummary, ProjectSummary, SessionSummary } from '@/app/app-controller';
import { ActivityIndicator } from '@/components/activity-indicator';
import { RemoveWorktreeDialog } from '@/components/remove-worktree-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
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
import { cn } from '@/lib/utils';
import { sessionLabel, sessionListView } from '@/session/sessions';

export const sinceLabel = (at: number | undefined, now = Date.now()) => {
  if (at === undefined) return '';
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
};

/**
 * One Session in the list: a tile with its name, where it is, and a mark when a thread in it
 * waits on the person, runs, or ended a turn they haven't seen. What else a tile shows of what's
 * inside is still to come (WVE-192). A long press, or a right-click, offers Remove worktree for a
 * worktree other than its repository's first.
 */
function SessionRow({ session, host, label, selected, onOpen, actions }: {
  session: SessionSummary;
  host?: HostSummary;
  /** Under its name: its branch, with its Host's name under a Project. */
  label: string;
  selected: boolean;
  onOpen(): void;
  actions: AppController['actions'];
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const unreachable = host !== undefined && host.status !== 'connected';
  const { git } = session;
  const removable = git !== undefined && session.directory !== git.repo && !unreachable && host?.canWorktree === true;
  const activity = session.waiting > 0 ? 'waiting' : session.running > 0 ? 'running' : undefined;
  const state = session.waiting > 0
    ? `${session.waiting} waiting on you`
    : session.running > 0
      ? `${session.running} running`
      : undefined;
  const tile = (
    <SidebarMenuButton
      size='lg'
      isActive={selected}
      aria-current={selected ? 'page' : undefined}
      className='h-auto min-h-12 gap-2.5 rounded-xl border border-transparent py-1.5 pl-1.5 data-active:border-sidebar-border'
      onClick={onOpen}
    >
      <span className='relative grid size-7 shrink-0 place-items-center rounded-md border border-sidebar-border bg-sidebar-accent text-sidebar-foreground/80'>
        <HugeiconsIcon icon={git ? GitBranchIcon : Folder01Icon} strokeWidth={2} className='size-3.5!' aria-hidden />
        <ActivityIndicator activity={activity} unread={session.unread} className='absolute -top-1 -right-1 size-2.5 ring-2 ring-sidebar' />
      </span>
      <span className='flex min-w-0 flex-1 flex-col gap-0.5'>
        <span className='flex min-w-0 items-center gap-2'>
          <span className='truncate font-medium text-sidebar-foreground'>{session.name}</span>
          <span className='ml-auto shrink-0 text-[0.6875rem] text-muted-foreground'>{sinceLabel(session.lastActivityAt)}</span>
        </span>
        <span className='flex min-w-0 items-center gap-1.5 text-[0.6875rem] text-muted-foreground'>
          <span className='truncate' title={session.directory}>{label}</span>
          {state && <span className='shrink-0'>· {state}</span>}
        </span>
      </span>
    </SidebarMenuButton>
  );
  return (
    <SidebarMenuItem>
      {removable
        ? (
          <ContextMenu>
            <ContextMenuTrigger className='[-webkit-touch-callout:none]'>{tile}</ContextMenuTrigger>
            <ContextMenuContent aria-label={`${session.name} ${label} actions`}>
              <ContextMenuItem variant='destructive' onClick={() => setConfirmRemove(true)}>
                <HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} />
                Remove worktree…
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )
        : tile}
      {git && removable && (
        <RemoveWorktreeDialog hostId={session.hostId} worktree={{ repo: git.repo, worktree: session.directory, ...(git.branch ? { branch: git.branch } : {}) }}
          actions={actions} open={confirmRemove} onOpenChange={setConfirmRemove} />
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

/** A Project's heading: its name, over its Sessions on every Host. */
function ProjectHeading({ project }: { project: ProjectSummary }) {
  return (
    <SidebarGroupLabel className='h-9 gap-2 text-sm font-medium text-sidebar-foreground [&>svg]:size-4.5'>
      <HugeiconsIcon icon={Folder01Icon} strokeWidth={1.75} className='text-icon-muted' aria-hidden />
      <span className='min-w-0 truncate'>{project.name}</span>
    </SidebarGroupLabel>
  );
}

/**
 * The Dispatcher can't be reached, or won't take this device: no Host is reached through it until
 * it can, so the list below is as it last was.
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

/** Pulling the list down from its top, past a threshold, lists everything again. */
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
 * The person's Sessions (ADR 0031, WVE-203): under their Projects, on whichever Host each is, and
 * then under their Hosts for those no Project has. While the Dispatcher can't be reached, a
 * banner says so, and the Hosts it last listed stay, greyed out unless one is still connected.
 */
export function SessionList({ controller, sessions, selected, onOpen, onOpenHosts, onNewThread }: {
  controller: AppController;
  sessions: SessionSummary[];
  /** The Session on screen, by key. */
  selected?: string;
  onOpen(key: string): void;
  onOpenHosts(): void;
  /** Starts a thread, on a Host when one is named, which opens its Session. */
  onNewThread(hostId?: string): void;
}) {
  const { model, actions } = controller;
  const [query, setQuery] = useState('');
  const pull = usePullToRefresh(actions.refresh);
  const view = sessionListView(sessions, model.hosts, model.projects, { query });
  const host = (id: string) => model.hosts.find((item) => item.id === id);
  const listed = view.projects.length > 0 || view.hosts.some(({ sessions: under }) => under.length > 0);
  const { dispatcher } = model;
  const away = dispatcher !== undefined && dispatcher.status !== 'connected';
  // A Host still connected while the Dispatcher is away, as the Mac's own over its socket, isn't greyed out.
  const hostAway = (listedHost?: HostSummary) => away && listedHost?.status !== 'connected';
  const unreachable = model.hosts.filter(({ status }) => status !== 'connected').length + (away ? 1 : 0);
  const row = (session: SessionSummary, label: string) => (
    <SessionRow key={session.key} session={session} host={host(session.hostId)} label={label}
      selected={session.key === selected} onOpen={() => onOpen(session.key)} actions={actions} />
  );

  return (
    <div data-slot='session-list' className='flex h-full min-h-0 w-full flex-col bg-sidebar text-sidebar-foreground'>
      {/* As tall as the Session's tab bar beside it, so their edges line up. */}
      <SidebarHeader className='h-[calc(env(safe-area-inset-top)+var(--title-bar-height))] shrink-0 flex-row items-center gap-1 border-b border-sidebar-border pt-[env(safe-area-inset-top)] pr-1.5 pb-0 pl-3'>
        <h1 className='sr-only'>Sessions</h1>
        {model.hosts.length > 0 && (
          <div className='relative min-w-0 flex-1'>
            <HugeiconsIcon icon={Search01Icon} strokeWidth={2}
              className='pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-icon-muted' />
            <SidebarInput type='search' aria-label='Filter Sessions' placeholder='Filter Sessions' className='pl-7'
              value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
        )}
        <Button size='icon' variant='ghost' aria-label='New thread' data-sidebar='header-action' className='ml-auto shrink-0'
          disabled={!model.hosts.some(({ status }) => status === 'connected')} onClick={() => onNewThread()}>
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
        {model.error && !selected && (
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
        {view.projects.map(({ project, sessions: under }) => (
          <SidebarGroup key={project.id} role='group' aria-label={project.name} className='py-1.5'>
            <ProjectHeading project={project} />
            <SidebarMenu className='gap-0.5'>
              {under.map(({ session, host: on }) => (
                <div key={session.key} data-away={hostAway(on) || undefined} className={cn(hostAway(on) && 'opacity-60')}>
                  {row(session, [on?.name, sessionLabel(session)].filter(Boolean).join(' · '))}
                </div>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
        {listed && view.hosts.map(({ host: paired, sessions: under }) => (
          <SidebarGroup key={paired.id} role='group' aria-label={paired.name} data-away={hostAway(paired) || undefined}
            className={cn('py-1.5', hostAway(paired) && 'opacity-60')}>
            <HostHeading host={paired} onNewThread={() => onNewThread(paired.id)} />
            {!hostAway(paired) && paired.status !== 'connected' && paired.error && (
              <p className='px-2 pb-1 text-[0.6875rem] text-muted-foreground'>{paired.error}</p>
            )}
            <SidebarMenu className='gap-0.5'>{under.map((session) => row(session, sessionLabel(session)))}</SidebarMenu>
            {under.length === 0 && (
              <p className='px-2 pb-1 text-[0.6875rem] text-muted-foreground'>{view.projects.length > 0 ? 'Nothing outside your Projects' : 'No Sessions'}</p>
            )}
          </SidebarGroup>
        ))}
        {model.hosts.length > 0 && !listed && (
          <Empty className='p-6'>
            <EmptyHeader>
              <EmptyTitle>{query ? 'No matching Sessions' : 'No Sessions'}</EmptyTitle>
              <EmptyDescription>
                {query ? 'Try another filter.' : 'A Session is a directory you work in. Start a thread in one with New thread.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </SidebarContent>

      <SidebarFooter className='shrink-0 flex-row items-center gap-1 border-t border-sidebar-border px-2 pt-1.5 pb-[calc(env(safe-area-inset-bottom)+0.375rem)]'>
        <Button variant='ghost' size='lg' className='ml-auto' onClick={onOpenHosts}>
          <HugeiconsIcon icon={ComputerIcon} strokeWidth={2} />
          Hosts
          {unreachable > 0 && <Badge variant='destructive' aria-label={`${unreachable} unreachable`}>{unreachable}</Badge>}
        </Button>
      </SidebarFooter>
    </div>
  );
}
