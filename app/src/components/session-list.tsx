import { useEffect, useId, useRef, useState, type ReactNode, type TouchEvent } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon, Cancel01Icon, FolderAddIcon, GitBranchIcon, LaptopIcon, Search01Icon, ServerStack01Icon } from '@hugeicons/core-free-icons';
import type { AppController, DispatcherSummary, HostStatus, HostSummary, ProjectSummary, SessionSummary, ThreadActivity } from '@/app/app-controller';
import { dragsWindow, platform } from '@/app/platform';
import { type SidebarViewName, hostGroup, projectGroup, toggleGroup, useSidebarView } from '@/app/sidebar-view';
import { type GroupFold, GroupHeading } from '@/components/group-heading';
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
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import type { AddProjectTarget } from '@/components/add-project-dialog';
import type { NewSessionTarget } from '@/components/new-session-dialog';
import { ProjectHeading } from '@/components/project-heading';
import { type ListedSession, type ThreadTab, sessionLabel, sessionListView, sessionsActivity, threadTabs } from '@/session/sessions';

export const sinceLabel = (at: number | undefined, now = Date.now()) => {
  if (at === undefined) return '';
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
};

/** What's waiting or running, in words, after a tile's label. */
const stateOf = ({ waiting, running }: { waiting: number; running: number }) =>
  waiting > 0 ? `${waiting} waiting on you` : running > 0 ? `${running} running` : undefined;

/**
 * A tile in the list, a Session's or a tab's: its name, a dot for what its threads are doing, how
 * long since something happened in it, and under them where it is, when it says.
 */
function Tile({ name, label, title, activity, unread, state, at, selected, onOpen }: {
  name: string;
  /** Under its name; none for a tile of one line. */
  label?: string;
  title?: string;
  activity?: ThreadActivity;
  unread: boolean;
  state?: string;
  at?: number;
  selected: boolean;
  onOpen(): void;
}) {
  return (
    <SidebarMenuButton
      size='lg'
      isActive={selected}
      aria-current={selected ? 'page' : undefined}
      className={cn('h-auto rounded-xl border border-transparent py-1.5 pl-3.5 data-active:border-sidebar-border', label === undefined ? 'min-h-9' : 'min-h-12')}
      onClick={onOpen}
    >
      {/* No icon of its own (WVE-223): a small indent under its heading, and what its threads
          are doing as a dot after its name. */}
      <span className='flex min-w-0 flex-1 flex-col gap-0.5'>
        <span className='flex min-w-0 items-center gap-2'>
          <span className='truncate font-medium text-sidebar-foreground'>{name}</span>
          <ActivityIndicator activity={activity} unread={unread} className='size-2 shrink-0' />
          <span className='ml-auto shrink-0 text-[0.6875rem] text-muted-foreground'>{sinceLabel(at)}</span>
        </span>
        {label !== undefined && (
          <span className='flex min-w-0 items-center gap-1.5 text-[0.6875rem] text-muted-foreground'>
            <span className='truncate' title={title}>{label}</span>
            {state && <span className='shrink-0'>· {state}</span>}
          </span>
        )}
      </span>
    </SidebarMenuButton>
  );
}

/**
 * One Session in the list: a tile with its name, where it is, and a mark when a thread in it
 * waits on the person, runs, or ended a turn they haven't seen. What else a tile shows of what's
 * inside is still to come (WVE-192). A long press, or a right-click, offers End Session, which
 * closes what's in it for good, and Remove worktree for a worktree other than its repository's first.
 */
function SessionRow({ session, host, label, selected, onOpen, onEnd, actions }: {
  session: SessionSummary;
  host?: HostSummary;
  /** Under its name: its Host's name and its branch, under a Project. None under its Host, which shows its name alone (WVE-231). */
  label?: string;
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
  const tile = (
    <Tile name={session.name} label={label} title={session.directory} activity={activity} unread={session.unread} state={stateOf(session)}
      at={session.lastActivityAt} selected={selected} onOpen={onOpen} />
  );
  return (
    <SidebarMenuItem>
      {removable || onEnd
        ? (
          <ContextMenu>
            <ContextMenuTrigger className='[-webkit-touch-callout:none]'>{tile}</ContextMenuTrigger>
            <ContextMenuContent aria-label={`${[session.name, label].filter(Boolean).join(' ')} actions`}>
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

/**
 * A Host's heading, over its Sessions no Project has: its name, and how it's connected when it
 * isn't. A click collapses it, when it has any.
 */
function HostHeading({ host, fold, onNewSession }: { host: HostSummary; fold?: GroupFold; onNewSession(): void }) {
  const status = hostStatus[host.status];
  return (
    <>
      <GroupHeading name={host.name} icon={LaptopIcon} iconClassName='text-peach' fold={fold} title={host.error}>
        {status && <span className='shrink-0 text-[0.6875rem] font-normal text-muted-foreground'>· {status}</span>}
      </GroupHeading>
      <SidebarGroupAction aria-label={`New Session on ${host.name}`} title={`New Session on ${host.name}`}
        className='top-3.5 right-2.5' disabled={host.status !== 'connected'} onClick={onNewSession}>
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

const VIEWS: { name: SidebarViewName; label: string }[] = [{ name: 'sessions', label: 'Sessions' }, { name: 'threads', label: 'Threads' }];

/** The sidebar's two views, as a pill of two in the style of a Session's tab rail (WVE-231). */
function ViewToggle({ view, onChange }: { view: SidebarViewName; onChange(view: SidebarViewName): void }) {
  return (
    <div role='tablist' aria-label='View' className='flex h-9 min-w-0 flex-1 items-stretch gap-1 rounded-full bg-muted/50 p-1'>
      {VIEWS.map(({ name, label }) => (
        <button key={name} type='button' role='tab' aria-selected={view === name}
          className={cn(
            'min-w-0 flex-1 cursor-default truncate rounded-full border border-transparent px-3 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
            view === name && 'border-foreground/10 bg-muted text-foreground',
          )}
          onClick={() => onChange(name)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * The sidebar. Above everything, the Bots, from a Dispatcher that keeps them (WVE-178). Below
 * them, one of two views, which the pill at the bottom switches between and the device remembers
 * (WVE-231). Sessions (ADR 0031, WVE-203): under "Projects", each Project's, saying which Host
 * each is on, and under "Hosts" every Host, with each Session of its own no Project has, by name
 * alone; a heading collapses, unless it's a Host with none. Threads: a tile for each tab that has
 * a Thread Block, under no heading. While the Dispatcher can't be reached, a banner says so, and
 * the Sessions of the Hosts it last listed stay, greyed out unless their Host is still connected.
 */
export function SessionList({ controller, sessions, selected, selectedBot, frontTab, leading, onOpen, onOpenTab, onOpenBot, onNewBot, onOpenHosts, onNewSession, onAddProject, onEndSession }: {
  controller: AppController;
  /** First in its top rail: the toggle that hides it, beside a Session. */
  leading?: ReactNode;
  sessions: SessionSummary[];
  /** The Session on screen, by key. */
  selected?: string;
  /** The Bot on screen, by id. */
  selectedBot?: string;
  /** The tab in front in the Session on screen, by id. */
  frontTab?: string;
  onOpen(key: string): void;
  /** Opens a tab's Session with that tab in front. */
  onOpenTab(tab: ThreadTab): void;
  onOpenBot?(id: string): void;
  onNewBot?(): void;
  onOpenHosts(): void;
  /** Starts a Session: in a Project, or in a directory on a Host, when one is named. */
  onNewSession(target?: NewSessionTarget): void;
  /** Adds a Project, or a location on another Host to one there is (WVE-220). */
  onAddProject?(target?: AddProjectTarget): void;
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
  const [sidebar, changeSidebar] = useSidebarView();
  const threadsView = sidebar.view === 'threads';
  const view = sessionListView(sessions, model.hosts, model.projects, { query });
  const tabs = threadsView ? threadTabs(sessions, model, { query }) : [];
  const listed = threadsView ? tabs.length > 0 : view.projects.length > 0 || view.hosts.length > 0;
  /**
   * How a heading folds: open unless the device collapsed it, and while the list is filtered,
   * which looks inside and leaves what's remembered alone.
   */
  const fold = (group: string, under: readonly SessionSummary[]): GroupFold => ({
    open: Boolean(query) || !sidebar.collapsed.includes(group),
    onToggle: () => changeSidebar((current) => toggleGroup(current, group)),
    ...sessionsActivity(under),
  });
  const canStart = model.hosts.some(({ status }) => status === 'connected');
  const canAddProject = Boolean(model.canManageProjects && onAddProject && model.hosts.length > 0);
  const projectsHeading = view.projects.length > 0 || (canAddProject && !query);
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
    const label = named ? [on, sessionLabel(session)].filter(Boolean).join(' · ') : undefined;
    return (
      <div key={session.key} data-away={(named && hostAway(host)) || undefined} className={cn(named && hostAway(host) && 'opacity-60')}
        title={named && host && host.status !== 'connected' ? host.error : undefined}>
        <SessionRow session={session} host={host} label={label}
          selected={session.key === selected} onOpen={() => onOpen(session.key)} actions={actions}
          // Only a Session its Host keeps, on a Host that closes what's in it.
          onEnd={kept(session) && host?.status === 'connected' && host.canEndSessions ? () => onEndSession(session) : undefined} />
      </div>
    );
  };
  /** Whether a Session can start in a Project now: one of its Hosts is connected. */
  const startable = (project: ProjectSummary) => project.locations.some(({ hostId }) => model.hosts.some(({ id, status }) => id === hostId && status === 'connected'));

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
              <Button onClick={onOpenHosts}>Connections</Button>
            </EmptyContent>
          </Empty>
        )}
        {model.bots && (
          <BotList bots={model.bots} unread={model.unread} canAdd={Boolean(model.canAddBots && onNewBot)} canStart={canStart} query={query}
            selected={selectedBot} onOpen={(id) => onOpenBot?.(id)} onNewBot={() => onNewBot?.()} />
        )}
        {/* What's the person's own to arrange, apart from their Bots: the Projects, under a heading
            that adds one, where the first is added too. */}
        {model.bots && !query && model.hosts.length > 0 && <SidebarSeparator className='my-1' />}
        {!threadsView && projectsHeading && (
          <div data-slot='projects-heading' className='relative flex h-8 items-center px-4 pt-1'>
            <h2 className='text-[0.6875rem] font-medium tracking-wide text-muted-foreground'>Projects</h2>
            {canAddProject && (
              <Button size='icon' variant='ghost' aria-label='Add Project' title='Add Project' className='absolute top-1 right-2.5 size-7 text-muted-foreground'
                disabled={!canStart} onClick={() => onAddProject?.()}>
                <HugeiconsIcon icon={FolderAddIcon} strokeWidth={1.75} />
              </Button>
            )}
          </div>
        )}
        {!threadsView && view.projects.map(({ project, sessions: under }) => {
          const folded = fold(projectGroup(project.id), under.map(({ session }) => session));
          return (
            <SidebarGroup key={project.id} role='group' aria-label={project.name} className='py-1.5'>
              <ProjectHeading controller={controller} project={project} fold={folded}
                onNewSession={startable(project) ? () => onNewSession({ projectId: project.id }) : undefined}
                onAddLocation={onAddProject ? () => onAddProject({ to: project }) : undefined} />
              {folded.open && <SidebarMenu className='gap-0.5'>{under.map((listedSession) => row(listedSession, true))}</SidebarMenu>}
              {folded.open && under.length === 0 && <p className='px-2 pb-1 text-[0.6875rem] text-muted-foreground'>No Sessions yet</p>}
            </SidebarGroup>
          );
        })}
        {!threadsView && view.hosts.length > 0 && (
          <div data-slot='hosts-heading' className='flex h-8 items-center px-4 pt-1'>
            <h2 className='text-[0.6875rem] font-medium tracking-wide text-muted-foreground'>Hosts</h2>
          </div>
        )}
        {!threadsView && view.hosts.map(({ host, sessions: under }) => {
          // A Host with no Session of its own to show has nothing to fold, and no chevron.
          const folded = under.length > 0 ? fold(hostGroup(host.id), under) : undefined;
          return (
            <SidebarGroup key={host.id} role='group' aria-label={host.name} data-away={hostAway(host) || undefined}
              className={cn('py-1.5', hostAway(host) && 'opacity-60')}>
              <HostHeading host={host} fold={folded} onNewSession={() => onNewSession({ hostId: host.id })} />
              {!hostAway(host) && host.status !== 'connected' && host.error && (
                <p className='px-2 pb-1 text-[0.6875rem] text-muted-foreground'>{host.error}</p>
              )}
              {folded?.open && <SidebarMenu className='gap-0.5'>{under.map((session) => row({ session, host }, false))}</SidebarMenu>}
            </SidebarGroup>
          );
        })}
        {threadsView && listed && (
          <SidebarGroup role='group' aria-label='Threads' className='py-1.5'>
            <div data-slot='threads-heading' className='flex h-8 items-center px-2 pt-1'>
              <h2 className='text-[0.6875rem] font-medium tracking-wide text-muted-foreground'>Threads</h2>
            </div>
            <SidebarMenu className='gap-0.5'>
              {tabs.map((tab) => {
                const { session, host } = tab;
                const front = session.key === selected && tab.tabId === frontTab;
                return (
                  <SidebarMenuItem key={tab.key} data-away={hostAway(host) || undefined} className={cn(hostAway(host) && 'opacity-60')}>
                    <Tile name={tab.name} title={session.directory}
                      label={[session.name, host?.name, session.git ? sessionLabel(session) : undefined].filter(Boolean).join(' · ')}
                      activity={tab.waiting > 0 ? 'waiting' : tab.running > 0 ? 'running' : undefined} unread={tab.unread} state={stateOf(tab)}
                      at={tab.lastActivityAt} selected={front} onOpen={() => onOpenTab(tab)} />
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        )}
        {model.hosts.length > 0 && !listed && (
          <Empty className='p-6'>
            <EmptyHeader>
              <EmptyTitle>{threadsView ? (query ? 'No matching threads' : 'No threads') : query ? 'No matching Sessions' : 'No Sessions'}</EmptyTitle>
              <EmptyDescription>
                {query
                  ? 'Try another filter.'
                  : threadsView
                    ? 'A tab with a thread in it shows here.'
                    : 'A Session is a directory you work in. Start one with New Session.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </SidebarContent>

      <SidebarFooter className='shrink-0 flex-row items-center gap-1.5 px-2 pt-1.5 pb-[calc(env(safe-area-inset-bottom)+0.375rem)]'>
        <Button variant='ghost' size='icon-lg' className='relative shrink-0' aria-label='Connections' title='Connections' onClick={onOpenHosts}>
          <HugeiconsIcon icon={ServerStack01Icon} strokeWidth={2} />
          {unreachable > 0 && (
            <Badge variant='destructive' className='absolute -top-1 -right-1' aria-label={`${unreachable} unreachable`}>{unreachable}</Badge>
          )}
        </Button>
        {model.hosts.length > 0 && <ViewToggle view={sidebar.view} onChange={(next) => changeSidebar((current) => ({ ...current, view: next }))} />}
      </SidebarFooter>
    </div>
  );
}
