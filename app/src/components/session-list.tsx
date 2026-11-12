import { useEffect, useId, useRef, useState, type ReactNode, type TouchEvent } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon, Cancel01Icon, ComputerIcon, Folder01Icon, GitBranchIcon, LaptopIcon, Search01Icon } from '@hugeicons/core-free-icons';
import type { AppController, DispatcherSummary, HostStatus, HostSummary, ProjectSummary, SessionSummary } from '@/app/app-controller';
import { dragsWindow, platform } from '@/app/platform';
import { ActivityIndicator } from '@/components/activity-indicator';
import { BotList } from '@/components/bots/bot-list';
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
import type { NewThreadTarget } from '@/components/new-thread-dialog';
import { type ListedSession, sessionLabel, sessionListView } from '@/session/sessions';

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
 * inside is still to come (WVE-192). A long press, or a right-click, offers End Session, which
 * closes what's in it for good, and Remove worktree for a worktree other than its repository's first.
 */
function SessionRow({ session, host, label, selected, onOpen, onEnd, actions }: {
  session: SessionSummary;
  host?: HostSummary;
  /** Under its name: its branch, with its Host's name under a Project. */
  label: string;
  selected: boolean;
  onOpen(): void;
  /** Asks to end the Session; none where its Host can't, or isn't connected. */
  onEnd?(): void;
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
      {removable || onEnd
        ? (
          <ContextMenu>
            <ContextMenuTrigger className='[-webkit-touch-callout:none]'>{tile}</ContextMenuTrigger>
            <ContextMenuContent aria-label={`${session.name} ${label} actions`}>
              {onEnd && (
                <ContextMenuItem variant='destructive' onClick={onEnd}>
                  <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                  End Session…
                </ContextMenuItem>
              )}
              {removable && (
                <ContextMenuItem variant='destructive' onClick={() => setConfirmRemove(true)}>
                  <HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} />
                  Remove worktree…
                </ContextMenuItem>
              )}
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

/** A Host's heading, over its Sessions no Project has: its name, and how it's connected when it isn't. */
function HostHeading({ host, onNewSession }: { host: HostSummary; onNewSession(): void }) {
  const status = hostStatus[host.status];
  return (
    <>
      <SidebarGroupLabel title={host.error} className='h-9 gap-2 pr-9 text-sm font-medium text-sidebar-foreground [&>svg]:size-4.5'>
        <HugeiconsIcon icon={LaptopIcon} strokeWidth={1.75} className='text-icon-muted' aria-hidden />
        <span className='min-w-0 truncate'>{host.name}</span>
        {status && <span className='shrink-0 text-[0.6875rem] font-normal text-muted-foreground'>· {status}</span>}
      </SidebarGroupLabel>
      <SidebarGroupAction aria-label={`New Session on ${host.name}`} title={`New Session on ${host.name}`}
        className='top-3.5 right-2.5' disabled={host.status !== 'connected'} onClick={onNewSession}>
        <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
      </SidebarGroupAction>
    </>
  );
}

/** A Project's heading: its name, over its Sessions on every Host, and a thread to start in it. */
function ProjectHeading({ project, onNewSession }: { project: ProjectSummary; onNewSession?(): void }) {
  return (
    <>
      <SidebarGroupLabel className='h-9 gap-2 pr-9 text-sm font-medium text-sidebar-foreground [&>svg]:size-4.5'>
        <HugeiconsIcon icon={Folder01Icon} strokeWidth={1.75} className='text-icon-muted' aria-hidden />
        <span className='min-w-0 truncate'>{project.name}</span>
      </SidebarGroupLabel>
      <SidebarGroupAction aria-label={`New Session in ${project.name}`} title={`New Session in ${project.name}`}
        className='top-3.5 right-2.5' disabled={!onNewSession} onClick={onNewSession}>
        <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
      </SidebarGroupAction>
    </>
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
 * The person's Sessions (ADR 0031, WVE-203): under their Projects, each saying which Host it's
 * on, and after them, under its Host, each one no Project has. A Host with none of those isn't a
 * heading. Above them all, the Bots, from a Dispatcher that keeps them (WVE-178). While the Dispatcher can't be reached, a banner says so, and the Sessions of the Hosts
 * it last listed stay, greyed out unless their Host is still connected.
 */
export function SessionList({ controller, sessions, selected, selectedBot, leading, onOpen, onOpenBot, onNewBot, onOpenHosts, onNewSession, onEndSession }: {
  controller: AppController;
  /** First in its top rail: the toggle that hides it, beside a Session. */
  leading?: ReactNode;
  sessions: SessionSummary[];
  /** The Session on screen, by key. */
  selected?: string;
  /** The Bot on screen, by id. */
  selectedBot?: string;
  onOpen(key: string): void;
  onOpenBot?(id: string): void;
  onNewBot?(): void;
  onOpenHosts(): void;
  /** Starts a Session: a thread in a directory, a Project's or a Host's when one is named. */
  onNewSession(target?: NewThreadTarget): void;
  /** Asks to end a Session. */
  onEndSession(session: SessionSummary): void;
}) {
  const { model, actions } = controller;
  const [query, setQuery] = useState('');
  // The filter is closed until asked for, on every launch; closing it shows everything again.
  const [filtering, setFiltering] = useState(false);
  const filterId = useId();
  const filterInput = useRef<HTMLInputElement>(null);
  const filterButton = useRef<HTMLButtonElement>(null);
  const showFilter = (show: boolean) => {
    setFiltering(show);
    if (!show) setQuery('');
  };
  useEffect(() => {
    if (filtering) filterInput.current?.focus();
  }, [filtering]);
  const pull = usePullToRefresh(actions.refresh);
  const view = sessionListView(sessions, model.hosts, model.projects, { query });
  const listed = view.projects.length > 0 || view.hosts.length > 0;
  const canStart = model.hosts.some(({ status }) => status === 'connected');
  const { dispatcher } = model;
  const away = dispatcher !== undefined && dispatcher.status !== 'connected';
  // A Host still connected while the Dispatcher is away, as the Mac's own over its socket, isn't greyed out.
  const hostAway = (listedHost?: HostSummary) => away && listedHost?.status !== 'connected';
  const unreachable = model.hosts.filter(({ status }) => status !== 'connected').length + (away ? 1 : 0);
  const kept = (session: SessionSummary) => (model.known ?? []).some((known) => known.hostId === session.hostId && known.directory === session.directory);
  /**
   * A Session's tile. Under a Project it says which Host it's on, a Session being one Host's, and
   * how that Host stands when it isn't connected; under its Host's own heading, that says it.
   */
  const row = ({ session, host }: ListedSession, named: boolean) => {
    const on = named && host ? `${host.name}${hostStatus[host.status] ? `, ${hostStatus[host.status]}` : ''}` : undefined;
    return (
      <div key={session.key} data-away={(named && hostAway(host)) || undefined} className={cn(named && hostAway(host) && 'opacity-60')}
        title={named && host && host.status !== 'connected' ? host.error : undefined}>
        <SessionRow session={session} host={host} label={[on, sessionLabel(session)].filter(Boolean).join(' · ')}
          selected={session.key === selected} onOpen={() => onOpen(session.key)} actions={actions}
          // Only a Session its Host keeps, on a Host that closes what's in it.
          onEnd={kept(session) && host?.status === 'connected' && host.canEndSessions ? () => onEndSession(session) : undefined} />
      </div>
    );
  };
  /** Where a Project's new Session starts: its directory on the first of its Hosts that's connected. */
  const startIn = (project: ProjectSummary) => project.locations.find(({ hostId }) => model.hosts.some(({ id, status }) => id === hostId && status === 'connected'));

  return (
    <div data-slot='session-list' className='flex h-full min-h-0 w-full flex-col bg-sidebar text-sidebar-foreground'>
      {/* As tall as the Session's tab bar beside it, so their edges line up; on the Mac the
          window's title row, after its traffic lights, whose empty parts drag the window. */}
      <SidebarHeader {...dragsWindow()}
        className={cn('h-[calc(env(safe-area-inset-top)+var(--title-bar-height))] shrink-0 flex-row items-center gap-1 pt-[env(safe-area-inset-top)] pr-1.5 pb-0 pl-2',
          platform().titleBar === 'overlay' && 'pl-(--traffic-lights-width)')}>
        <h1 className='sr-only'>Sessions</h1>
        {leading}
        {model.hosts.length > 0 && (
          <Button ref={filterButton} size='icon' variant='ghost' aria-label='Filter Sessions' title='Filter Sessions' aria-expanded={filtering} aria-controls={filterId}
            data-sidebar='header-action' className='ml-auto shrink-0 aria-expanded:bg-sidebar-accent' onClick={() => showFilter(!filtering)}>
            <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
          </Button>
        )}
        <Button size='icon' variant='ghost' aria-label='New Session' title='New Session' data-sidebar='header-action' className={cn('shrink-0', model.hosts.length === 0 && 'ml-auto')}
          disabled={!model.hosts.some(({ status }) => status === 'connected')} onClick={() => onNewSession()}>
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
        </Button>
      </SidebarHeader>
      {filtering && model.hosts.length > 0 && (
        <div className='relative mx-2 mb-1.5 shrink-0'>
          <HugeiconsIcon icon={Search01Icon} strokeWidth={2}
            className='pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-icon-muted' />
          <SidebarInput ref={filterInput} id={filterId} type='search' aria-label='Filter Sessions' placeholder='Filter Sessions' className='pl-7'
            value={query} onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              showFilter(false);
              filterButton.current?.focus();
            }} />
        </div>
      )}

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
        {model.bots && (
          <BotList bots={model.bots} unread={model.unread} canAdd={Boolean(model.canAddBots && onNewBot)} canStart={canStart} query={query}
            selected={selectedBot} onOpen={(id) => onOpenBot?.(id)} onNewBot={() => onNewBot?.()} />
        )}
        {view.projects.map(({ project, sessions: under }) => {
          const location = startIn(project);
          return (
            <SidebarGroup key={project.id} role='group' aria-label={project.name} className='py-1.5'>
              <ProjectHeading project={project} onNewSession={location ? () => onNewSession({ hostId: location.hostId, cwd: location.path }) : undefined} />
              <SidebarMenu className='gap-0.5'>{under.map((listedSession) => row(listedSession, true))}</SidebarMenu>
              {under.length === 0 && <p className='px-2 pb-1 text-[0.6875rem] text-muted-foreground'>No Sessions yet</p>}
            </SidebarGroup>
          );
        })}
        {view.hosts.map(({ host, sessions: under }) => (
          <SidebarGroup key={host.id} role='group' aria-label={host.name} data-away={hostAway(host) || undefined}
            className={cn('py-1.5', hostAway(host) && 'opacity-60')}>
            <HostHeading host={host} onNewSession={() => onNewSession({ hostId: host.id })} />
            {!hostAway(host) && host.status !== 'connected' && host.error && (
              <p className='px-2 pb-1 text-[0.6875rem] text-muted-foreground'>{host.error}</p>
            )}
            <SidebarMenu className='gap-0.5'>{under.map((session) => row({ session, host }, false))}</SidebarMenu>
          </SidebarGroup>
        ))}
        {model.hosts.length > 0 && !listed && (
          <Empty className='p-6'>
            <EmptyHeader>
              <EmptyTitle>{query ? 'No matching Sessions' : 'No Sessions'}</EmptyTitle>
              <EmptyDescription>
                {query ? 'Try another filter.' : 'A Session is a directory you work in. Start one with New Session.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </SidebarContent>

      <SidebarFooter className='shrink-0 flex-row items-center gap-1 px-2 pt-1.5 pb-[calc(env(safe-area-inset-bottom)+0.375rem)]'>
        <Button variant='ghost' size='lg' className='ml-auto' onClick={onOpenHosts}>
          <HugeiconsIcon icon={ComputerIcon} strokeWidth={2} />
          Hosts
          {unreachable > 0 && <Badge variant='destructive' aria-label={`${unreachable} unreachable`}>{unreachable}</Badge>}
        </Button>
      </SidebarFooter>
    </div>
  );
}
