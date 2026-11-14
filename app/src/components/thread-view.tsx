import { useCallback, useEffect, useRef, useState, type ReactNode, type TouchEvent } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeft01Icon, Cancel01Icon, Delete02Icon, Edit02Icon, InformationCircleIcon, MoreHorizontalIcon, SparklesIcon, StopIcon, UserMultiple02Icon } from '@hugeicons/core-free-icons';
import type { AgentUpdateNotice, AppController, DispatcherSummary, HostSummary, OpenThread, ThreadSummary } from '@/app/app-controller';
import { dragsWindow } from '@/app/platform';
import { usePhoneLayout } from '@/app/use-phone-layout';
import { useUpdateNotice } from '@/app/use-update-notice';
import { allSubagents, findSubagent, threadLabel, waitsForAnswer } from '@/chat/acp-transcript';
import { ChatPane } from '@/chat/chat-pane';
import { ActivityIndicator } from '@/components/activity-indicator';
import { DeleteThreadDialog } from '@/components/delete-thread-dialog';
import { PathLabel } from '@/components/path-label';
import { ThreadStatusSheet } from '@/components/thread-status-sheet';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** The bar above a thread, and above the empty state when none is open. */
export function ThreadHeader({ leading, divided = true, children }: {
  leading?: ReactNode;
  /** A line under it; none above Blocks, which have edges of their own. */
  divided?: boolean;
  children?: ReactNode;
}) {
  // On the Mac it's the window's title row: its empty parts drag the window.
  return (
    <header data-slot='thread-header' {...dragsWindow()}
      className={cn('flex h-[calc(env(safe-area-inset-top)+var(--title-bar-height))] shrink-0 items-center gap-2 bg-title-bar pt-[env(safe-area-inset-top)] pr-2 pl-[max(env(safe-area-inset-left),0.5rem)]',
        divided && 'border-b border-border')}>
      {leading}
      {children}
    </header>
  );
}

/** Renames an open thread through the Host, for every client. */
function RenameDialog({ thread, actions, open, onOpenChange }: {
  thread: ThreadSummary;
  actions: AppController['actions'];
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setTitle(thread.title ?? '');
    setError(undefined);
    // Starts from the title it has when it opens.
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='w-[min(28rem,calc(100%-2rem))] max-w-none sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>Rename thread</DialogTitle>
          <DialogDescription>Every device and the TUI show the new title. The agent keeps its own.</DialogDescription>
        </DialogHeader>
        <form aria-label='Rename thread' className='grid gap-3' onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          setError(undefined);
          try {
            await actions.renameThread(thread.key, title);
            onOpenChange(false);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setSaving(false);
          }
        }}>
          <Input aria-label='Title' autoFocus maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
          {error && <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert>}
          <DialogFooter>
            <Button type='submit' disabled={saving || !title.trim()}>{saving ? 'Renaming…' : 'Rename'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** What a thread's Block asks of its thread from the Block's own menu: the thread's view answers. */
export type ThreadAsk = 'status' | 'delete';

const asks = new Map<string, Set<(what: ThreadAsk) => void>>();

/** Asks the view of the thread `key`, wherever it's on screen, to show its status, or to delete it. */
export function askThread(key: string, what: ThreadAsk) {
  for (const answer of [...(asks.get(key) ?? [])]) answer(what);
}

/** Answers `askThread` for the thread `key` while the component is mounted. */
function useThreadAsks(key: string, answer: (what: ThreadAsk) => void) {
  const latest = useRef(answer);
  latest.current = answer;
  useEffect(() => {
    const own = (what: ThreadAsk) => latest.current(what);
    const answering = asks.get(key) ?? new Set();
    answering.add(own);
    asks.set(key, answering);
    return () => {
      answering.delete(own);
      if (answering.size === 0) asks.delete(key);
    };
  }, [key]);
}

function ThreadMenu({ thread, actions, canRename, onStatus }: {
  thread: ThreadSummary;
  actions: AppController['actions'];
  canRename?: boolean;
  /** Show the thread's status sheet. */
  onStatus(): void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size='icon' variant='ghost' aria-label='Thread actions' />}>
          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end'>
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={onStatus}>
              <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} />
              Thread status
            </DropdownMenuItem>
            {canRename && (
              <DropdownMenuItem disabled={thread.state !== 'open'} onClick={() => setRenaming(true)}>
                <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} />
                Rename thread…
              </DropdownMenuItem>
            )}
            <DropdownMenuItem disabled={thread.state === 'closed'} onClick={() => void actions.closeThread(thread.key)}>
              <HugeiconsIcon icon={StopIcon} strokeWidth={2} />
              Close thread
            </DropdownMenuItem>
            <DropdownMenuItem variant='destructive' onClick={() => setConfirmDelete(true)}>
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
              Delete thread
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameDialog thread={thread} actions={actions} open={renaming} onOpenChange={setRenaming} />
      <DeleteThreadDialog thread={thread} actions={actions} open={confirmDelete} onOpenChange={setConfirmDelete} />
    </>
  );
}

/** A swipe from the left edge, as iOS goes back. */
function useEdgeSwipe(onSwipe?: () => void) {
  const start = useRef<{ x: number; y: number }>(undefined);
  if (!onSwipe) return {};
  return {
    onTouchStart(event: TouchEvent) {
      const touch = event.touches[0];
      start.current = touch && touch.clientX <= 24 ? { x: touch.clientX, y: touch.clientY } : undefined;
    },
    onTouchEnd(event: TouchEvent) {
      const from = start.current;
      const touch = event.changedTouches[0];
      start.current = undefined;
      if (from && touch && touch.clientX - from.x > 80 && Math.abs(touch.clientY - from.y) < 60) onSwipe();
    },
  };
}

/** A package as people say it: `@zed-industries/claude-code-acp` is `claude-code-acp`. */
const shortName = (name: string) => name.startsWith('@') && name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;

/**
 * A newer version of the thread's agent is out. Update has the Host update the agent and moves
 * this thread over, as the TUI's `/update` does; once the Host's new threads launch another
 * version already, Move only moves it (`thread/reopen`). Dismissed, it stays hidden in this
 * thread on this device until a newer release, or a version to move to.
 */
function UpdateNotice({ update, updating, reopening, onUpdate, onMove, onDismiss }: {
  update: AgentUpdateNotice;
  updating?: boolean;
  reopening?: boolean;
  onUpdate(): void;
  onMove(): void;
  onDismiss(): void;
}) {
  return (
    <Alert className='m-2 w-auto has-data-[slot=alert-action]:pr-8'>
      <HugeiconsIcon icon={SparklesIcon} strokeWidth={2} />
      <AlertTitle>{shortName(update.name)} {update.latest} is out; this thread runs {update.running}.</AlertTitle>
      <AlertDescription>
        {update.available && (update.blank
          ? (
            <>
              The Host has {update.available} for new threads. Nothing has been sent in this one, so it stays on{' '}
              {update.running}: start a new thread to use {update.available}.
            </>
          )
          : (
            <>
              The Host has {update.available} for new threads. Moving this one ends its background commands and running
              subagents, and waits for a running turn.
            </>
          ))}
        <div className='mt-1.5 empty:hidden'>
          {update.available && update.blank
            ? null
            : update.available
            ? (
              <Button size='sm' variant='outline' disabled={reopening} onClick={onMove}>
                {reopening ? 'Moving…' : `Move to ${update.available}`}
              </Button>
            )
            : (
              <Button size='sm' variant='outline' disabled={updating || reopening} onClick={onUpdate}>
                {updating ? 'Updating…' : reopening ? 'Moving…' : `Update to ${update.latest}`}
              </Button>
            )}
        </div>
      </AlertDescription>
      <AlertAction>
        <Button size='icon-xs' variant='ghost' aria-label='Dismiss update notice' onClick={onDismiss}>
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        </Button>
      </AlertAction>
    </Alert>
  );
}

/**
 * The thread's Host isn't connected, or the Dispatcher every Host is reached through can't be
 * reached: the transcript catches up once it is.
 */
function ConnectionNotice({ host, dispatcher }: { host: HostSummary; dispatcher?: DispatcherSummary }) {
  const text = dispatcher && dispatcher.status !== 'connected'
    ? `Can't reach the Dispatcher on ${dispatcher.name}, which ${host.name} is reached through.`
    : host.status === 'connecting'
      ? `Connecting to ${host.name}…`
      : host.status === 'reconnecting'
        ? `Reconnecting to ${host.name}…`
        : `${host.name} isn't connected.${host.error ? ` ${host.error}` : ''}`;
  return (
    <p role='status' data-slot='connection-notice' className='shrink-0 border-b border-border bg-muted/40 px-3 py-1.5 text-[0.6875rem] text-muted-foreground'>
      {text}
    </p>
  );
}

/**
 * A thread: its header, transcript and composer. On its own it has the whole header, with its
 * title; in a Block (`chrome='block'`, WVE-203) it has none: the Block's rail names it, marks
 * what it's doing, renames it in place, and has its menu, which asks here (`askThread`) for its
 * status, or to delete it.
 */
export function ThreadView({ controller, thread, leading, onSwipeBack, chrome = 'full', onOpenThread, onDeleted }: {
  controller: AppController;
  thread: OpenThread;
  leading?: ReactNode;
  onSwipeBack?: () => void;
  chrome?: 'full' | 'block';
  /** Shows another thread, as the one this one continues in; `selectThread` without it. */
  onOpenThread?(key: string): void;
  /** The person deleted the thread from its Block's menu. */
  onDeleted?(): void;
}) {
  const { model, actions } = controller;
  const summary = model.threads.find(({ key }) => key === thread.key);
  const host = model.hosts.find(({ id }) => id === summary?.hostId);
  const others = Math.max(0, (summary?.clients ?? 0) - 1);
  const phone = usePhoneLayout();
  // A subagent whose own transcript shows instead of the thread's.
  const [watching, setWatching] = useState<string>();
  useEffect(() => setWatching(undefined), [thread.key]);
  const subagent = watching ? findSubagent(thread.transcript, watching) : undefined;
  const openSubagent = useCallback((threadId: string) => setWatching(threadId), []);
  const swipe = useEdgeSwipe(subagent ? () => setWatching(undefined) : onSwipeBack);
  const [update, dismissUpdate] = useUpdateNotice(thread.key, thread.update);
  // What failed in this thread, and nothing else's: another Block's failure is its own to show.
  const failure = model.threadErrors?.[thread.key];
  const notices = model.threadNotices?.[thread.key] ?? [];
  const [statusShown, setStatusShown] = useState(false);
  useEffect(() => setStatusShown(false), [thread.key]);
  // In a Block, its rail has the thread's menu, which asks here for what needs the thread's view.
  const [confirmDelete, setConfirmDelete] = useState(false);
  useThreadAsks(thread.key, (what) => {
    if (what === 'status') setStatusShown(true);
    else setConfirmDelete(true);
  });
  const details = (
    <>
      <ActivityIndicator activity={summary?.activity} />
      {others > 0 && (
        <Badge variant='outline' aria-label={`${others} other ${others === 1 ? 'client' : 'clients'} attached`} title='Other clients attached'>
          <HugeiconsIcon icon={UserMultiple02Icon} strokeWidth={2} />
          {others}
        </Badge>
      )}
      {summary && (
        <ThreadMenu thread={summary} actions={actions} canRename={host?.canRename} onStatus={() => setStatusShown(true)} />
      )}
    </>
  );
  // Requests waiting in a transcript not on screen: Main's while a subagent's shows, or a subagent's.
  const asking = [
    ...(subagent && waitsForAnswer(thread.transcript) ? [undefined] : []),
    ...allSubagents(thread.transcript)
      .filter(({ threadId, transcript }) => threadId !== subagent?.threadId && waitsForAnswer(transcript))
      .map(({ threadId }) => threadId),
  ];
  return (
    <section aria-label={summary?.title || 'New thread'} data-slot='thread-view' className='flex min-h-0 min-w-0 flex-1' {...swipe}>
      <div className='flex min-h-0 min-w-0 flex-1 flex-col'>
        {chrome === 'full'
          ? (
            <ThreadHeader leading={leading}>
              <div className='min-w-0 flex-1 py-1.5'>
                <h2 className='truncate text-sm font-semibold'>{summary?.title || 'New thread'}</h2>
                {summary && (
                  <p className='flex min-w-0 items-center gap-1 text-[0.6875rem] text-muted-foreground'>
                    <span className='shrink-0'>{summary.agentName}</span>
                    <span aria-hidden='true'>·</span>
                    <PathLabel path={summary.cwd} />
                    {model.hosts.length > 1 && host && <span className='shrink-0'>· {host.name}</span>}
                  </p>
                )}
              </div>
              {details}
            </ThreadHeader>
          )
          : summary && <DeleteThreadDialog thread={summary} actions={actions} open={confirmDelete} onOpenChange={setConfirmDelete} onDeleted={onDeleted} />}
        <ThreadStatusSheet
          open={statusShown}
          onOpenChange={setStatusShown}
          servers={thread.mcpServers}
          agentListsServers={thread.transcript.availableCommands.some(({ name }) => name === 'mcp')}
          side={phone ? 'bottom' : 'right'}
        />
        {host && host.status !== 'connected' && <ConnectionNotice host={host} dispatcher={model.dispatcher} />}
        {failure && (
          <Alert variant='destructive' className='m-2 w-auto has-data-[slot=alert-action]:pr-8'>
            <AlertDescription>{failure}</AlertDescription>
            {actions.dismissError && (
              <AlertAction>
                <Button size='icon-xs' variant='ghost' aria-label='Dismiss error' onClick={() => actions.dismissError?.()}>
                  <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                </Button>
              </AlertAction>
            )}
          </Alert>
        )}
        {notices.map((notice) => (
          <Alert
            key={notice.id}
            variant={notice.severity === 'error' ? 'destructive' : 'default'}
            className={cn('m-2 w-auto has-data-[slot=alert-action]:pr-8', notice.severity === 'warning' && 'text-warning')}
            data-slot='agent-notice'
          >
            <AlertTitle>{notice.title}</AlertTitle>
            {notice.detail && <AlertDescription>{notice.detail}</AlertDescription>}
            {actions.dismissNotice && (
              <AlertAction>
                <Button size='icon-xs' variant='ghost' aria-label='Dismiss notice' onClick={() => actions.dismissNotice?.(notice.id)}>
                  <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                </Button>
              </AlertAction>
            )}
          </Alert>
        ))}
        {summary?.continuedIn && (
          <Alert className='m-2 w-auto' data-slot='successor-notice'>
            <AlertTitle>This thread continues in {summary.continuedIn.label}</AlertTitle>
            <AlertAction>
              <Button size='sm' variant='outline' onClick={() => {
                const key = summary.continuedIn?.key;
                if (key) (onOpenThread ?? actions.selectThread)(key);
              }}>Open</Button>
            </AlertAction>
          </Alert>
        )}
        {update && (
          <UpdateNotice
            update={update}
            updating={thread.updating}
            reopening={thread.reopening}
            onUpdate={() => void actions.updateAgent()}
            onMove={() => void actions.reopenThread()}
            onDismiss={dismissUpdate}
          />
        )}
        {asking.map((threadId) => {
          const label = threadId ? threadLabel(thread.transcript, threadId) : 'Main';
          return (
            <Alert key={threadId ?? 'main'} className='m-2 mb-0 w-auto border-warning/40' data-slot='asking-notice'>
              <AlertTitle>{label} is waiting for you</AlertTitle>
              <AlertAction>
                <Button size='sm' variant='outline' aria-label={`Show ${label}`} onClick={() => setWatching(threadId)}>Show</Button>
              </AlertAction>
            </Alert>
          );
        })}
        <div className='flex min-h-0 min-w-0 flex-1 flex-col'>
          {subagent
            ? (
              <>
                <div data-slot='subagent-bar' className='flex min-h-9 shrink-0 items-center gap-2 border-b bg-muted/40 px-2 text-xs'>
                  <Button size='sm' variant='ghost' onClick={() => setWatching(undefined)}>
                    <HugeiconsIcon data-icon='inline-start' icon={ArrowLeft01Icon} strokeWidth={2} />
                    Main
                  </Button>
                  <span className='min-w-0 truncate font-semibold'>{threadLabel(thread.transcript, subagent.threadId)}</span>
                  {subagent.description && <span className='min-w-0 truncate text-muted-foreground'>{subagent.description}</span>}
                  {subagent.state && <Badge variant='outline' className='ml-auto shrink-0'>{subagent.state.replace('_', ' ')}</Badge>}
                </div>
                <ChatPane
                  key={`${thread.key}/${subagent.threadId}`}
                  model={subagent.transcript}
                  root={thread.transcript}
                  actions={actions}
                  readOnly
                  onOpenSubagent={openSubagent}
                />
              </>
            )
            : (
              <ChatPane
                key={thread.key}
                draftKey={thread.key}
                model={thread.transcript}
                actions={actions}
                queued={thread.queued}
                queuePaused={thread.queuePaused}
                canSteer={thread.canSteer}
                canAttachImages={thread.canAttachImages}
                loading={thread.loading}
                onOpenSubagent={openSubagent}
              />
            )}
        </div>
      </div>
    </section>
  );
}
