import { useRef, useState, type TouchEvent } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon, ComputerIcon, Delete02Icon, Folder01Icon, Search01Icon, StopIcon, ViewIcon, ViewOffIcon } from '@hugeicons/core-free-icons';
import type { AppController, PairedHost, SessionSummary } from '@/app/app-controller';
import { type DirectoryGroup, sessionListView } from '@/app/session-list';
import { ActivityIndicator } from '@/components/activity-indicator';
import { DeleteSessionDialog } from '@/components/delete-session-dialog';
import { type NewSessionTarget, NewSessionDialog } from '@/components/new-session-dialog';
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

/**
 * One session in the list. A long press, or a right-click, offers Close for an open session and
 * Delete for any, so an old one goes without being opened again.
 */
function SessionRow({ session, host, selected, unread, showDirectory, onOpen, actions }: {
  session: SessionSummary;
  host?: PairedHost;
  selected: boolean;
  unread: boolean;
  showDirectory: boolean;
  onOpen(): void;
  actions: AppController['actions'];
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const closed = session.state === 'closed';
  const unreachable = host !== undefined && host.status !== 'connected';
  return (
    <SidebarMenuItem>
      <ContextMenu>
        <ContextMenuTrigger className='[-webkit-touch-callout:none]'>
          <SidebarMenuButton
            size='lg'
            isActive={selected}
            aria-current={selected ? 'page' : undefined}
            className={cn('h-auto min-h-12 items-start py-2', closed && 'opacity-60')}
            data-state-session={session.state}
            onClick={onOpen}
          >
            <span className='flex min-w-0 flex-1 flex-col gap-0.5'>
              <span className='flex min-w-0 items-center gap-2'>
                <span className='truncate font-medium text-sidebar-foreground'>{session.title || 'New session'}</span>
                <span className='ml-auto shrink-0 text-[0.6875rem] text-muted-foreground'>{sinceLabel(session.lastActivityAt)}</span>
              </span>
              <span className='flex min-w-0 items-center gap-1.5 text-[0.6875rem] text-muted-foreground'>
                <ActivityIndicator activity={session.activity} unread={unread} />
                <span className='shrink-0'>{session.agentName}</span>
                {showDirectory && <span className='truncate'>· {directoryName(session.cwd)}</span>}
                {session.headless && <Badge variant='outline'>headless</Badge>}
                {closed && <span>closed</span>}
                {unreachable && <span>· Host unreachable</span>}
              </span>
            </span>
          </SidebarMenuButton>
        </ContextMenuTrigger>
        <ContextMenuContent aria-label={`${session.title || 'New session'} actions`}>
          {session.state === 'open' && (
            <ContextMenuItem disabled={unreachable} onClick={() => void actions.closeSession(session.key)}>
              <HugeiconsIcon icon={StopIcon} strokeWidth={2} />
              Close session
            </ContextMenuItem>
          )}
          <ContextMenuItem variant='destructive' disabled={unreachable} onClick={() => setConfirmDelete(true)}>
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            Delete session…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <DeleteSessionDialog session={session} actions={actions} open={confirmDelete} onOpenChange={setConfirmDelete} />
    </SidebarMenuItem>
  );
}

function GroupHeading({ group, onNewSession }: { group: DirectoryGroup; onNewSession?: () => void }) {
  return (
    <>
      <SidebarGroupLabel title={group.cwd} className='gap-1.5 pr-9'>
        <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} className='shrink-0' />
        <span className='max-w-[70%] shrink-0 truncate'>{group.name}</span>
        {group.hostName && <span className='min-w-0 truncate font-normal text-muted-foreground'>{group.hostName}</span>}
      </SidebarGroupLabel>
      {onNewSession && (
        <SidebarGroupAction aria-label={`New session in ${group.name}`} title={`New session in ${group.cwd}`} className='top-2 right-2.5' onClick={onNewSession}>
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
        </SidebarGroupAction>
      )}
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

/** Every paired Host's sessions: "Needs you" on top, then one group per Host and directory. */
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
  const unreachable = model.hosts.filter(({ status }) => status !== 'connected').length;
  const open = (key: string) => {
    actions.selectSession(key);
    onOpen?.();
  };
  const row = (session: SessionSummary, showDirectory: boolean) => (
    <SessionRow
      key={session.key}
      session={session}
      host={host(session.hostId)}
      selected={session.key === model.selectedKey}
      unread={model.unread.has(session.key)}
      showDirectory={showDirectory}
      onOpen={() => open(session.key)}
      actions={actions}
    />
  );

  return (
    <div data-slot='session-list' className='flex h-full min-h-0 w-full flex-col bg-sidebar text-sidebar-foreground'>
      {/* As tall as the session's header beside it, so their edges line up; its + sits over the directories' +. */}
      <SidebarHeader className='h-[calc(env(safe-area-inset-top)+var(--title-bar-height))] shrink-0 flex-row items-center gap-1 border-b border-sidebar-border pt-[env(safe-area-inset-top)] pr-1.5 pb-0 pl-3'>
        <h1 className='sr-only'>Sessions</h1>
        {model.hosts.length > 0 && (
          <div className='relative min-w-0 flex-1'>
            <HugeiconsIcon icon={Search01Icon} strokeWidth={2}
              className='pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-icon-muted' />
            <SidebarInput type='search' aria-label='Filter sessions' placeholder='Filter sessions' className='pl-7'
              value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
        )}
        <Button size='icon' variant='ghost' aria-label='New session' data-sidebar='header-action' className='ml-auto shrink-0'
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
              <EmptyDescription>Pair this device with a weave Host to see its sessions.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={onOpenHosts}>Pair a Host</Button>
            </EmptyContent>
          </Empty>
        )}
        {view.needsYou.length > 0 && (
          <SidebarGroup role='group' aria-label='Needs you' className='py-1'>
            <SidebarGroupLabel className='text-warning'>Needs you</SidebarGroupLabel>
            <SidebarMenu>{view.needsYou.map((session) => row(session, true))}</SidebarMenu>
          </SidebarGroup>
        )}
        {view.groups.map((group) => (
          <SidebarGroup key={group.key} role='group' aria-label={group.hostName ? `${group.name} on ${group.hostName}` : group.name} className='py-1'>
            <GroupHeading group={group} onNewSession={() => setNewSession({ hostId: group.hostId, cwd: group.cwd })} />
            <SidebarMenu>{group.sessions.map((session) => row(session, false))}</SidebarMenu>
          </SidebarGroup>
        ))}
        {model.hosts.length > 0 && view.groups.length === 0 && (
          <Empty className='p-6'>
            <EmptyHeader>
              <EmptyTitle>{query ? 'No matching sessions' : 'No sessions'}</EmptyTitle>
              <EmptyDescription>
                {query ? 'Try another filter.' : 'Start one with New session.'}
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
