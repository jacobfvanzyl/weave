import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode, type TouchEvent } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeft01Icon, Cancel01Icon, ComputerTerminal01Icon, Delete02Icon, Edit02Icon, MoreHorizontalIcon, SparklesIcon, StopIcon, UserMultiple02Icon } from '@hugeicons/core-free-icons';
import type { AgentUpdateNotice, AppController, OpenSession, PairedHost, SessionSummary } from '@/app/app-controller';
import { usePhoneLayout } from '@/app/use-phone-layout';
import { useUpdateNotice } from '@/app/use-update-notice';
import { allSubagents, findSubagent, sessionLabel, waitsForAnswer } from '@/chat/acp-transcript';
import { ChatPane } from '@/chat/chat-pane';
import { ActivityIndicator } from '@/components/activity-indicator';
import { DeleteSessionDialog } from '@/components/delete-session-dialog';
import { PathLabel } from '@/components/path-label';
import { ResizeHandle } from '@/components/resize-handle';
import { TerminalPanel } from '@/components/terminal-panel';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { clampPaneWidth, PANE_WIDTH, selectTab } from '@/terminal/terminal-layout';
import { useThreadTerminals } from '@/terminal/use-thread-terminals';

/** The bar above a session, and above the empty state when none is open. */
export function SessionHeader({ leading, children }: { leading?: ReactNode; children?: ReactNode }) {
  return (
    <header data-slot='session-header'
      className='flex h-[calc(env(safe-area-inset-top)+var(--title-bar-height))] shrink-0 items-center gap-2 border-b border-border bg-title-bar pt-[env(safe-area-inset-top)] pr-2 pl-[max(env(safe-area-inset-left),0.5rem)]'>
      {leading}
      {children}
    </header>
  );
}

/** Renames an open session through the Host, for every client. */
function RenameDialog({ session, actions, open, onOpenChange }: {
  session: SessionSummary;
  actions: AppController['actions'];
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setTitle(session.title ?? '');
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
            await actions.renameSession(session.key, title);
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

function SessionMenu({ session, actions, canRename }: { session: SessionSummary; actions: AppController['actions']; canRename?: boolean }) {
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
            {canRename && (
              <DropdownMenuItem disabled={session.state !== 'open'} onClick={() => setRenaming(true)}>
                <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} />
                Rename thread…
              </DropdownMenuItem>
            )}
            <DropdownMenuItem disabled={session.state === 'closed'} onClick={() => void actions.closeSession(session.key)}>
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
      <RenameDialog session={session} actions={actions} open={renaming} onOpenChange={setRenaming} />
      <DeleteSessionDialog session={session} actions={actions} open={confirmDelete} onOpenChange={setConfirmDelete} />
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
 * A newer version of the session's agent is out. Update has the Host update the agent and moves
 * this session over, as the TUI's `/update` does; once the Host's new sessions launch another
 * version already, Move only moves it (`session/reopen`). Dismissed, it stays hidden in this
 * session on this device until a newer release, or a version to move to.
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
        {update.available && (
          <>
            The Host has {update.available} for new threads. Moving this one ends its background commands and running
            subagents, and waits for a running turn.
          </>
        )}
        <div className='mt-1.5'>
          {update.available
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

/** Shows and hides the thread's terminals, with how many tabs it has while they're hidden. */
function TerminalsButton({ shown, count, onToggle }: { shown: boolean; count: number; onToggle(): void }) {
  const counted = !shown && count > 0;
  return (
    <Button size={counted ? 'sm' : 'icon'} variant='ghost' aria-pressed={shown} onClick={onToggle}
      aria-label={shown ? 'Hide terminals' : counted ? `Show terminals, ${count} open` : 'Show terminals'}>
      <HugeiconsIcon icon={ComputerTerminal01Icon} strokeWidth={2} />
      {counted && count}
    </Button>
  );
}

/** The session's Host isn't connected: the transcript catches up once it is. */
function ConnectionNotice({ host }: { host: PairedHost }) {
  const text = host.status === 'connecting'
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

/** The session on screen: its header, transcript and composer. */
export function SessionView({ controller, session, leading, onSwipeBack }: {
  controller: AppController;
  session: OpenSession;
  leading?: ReactNode;
  onSwipeBack?: () => void;
}) {
  const { model, actions } = controller;
  const summary = model.sessions.find(({ key }) => key === session.key);
  const host = model.hosts.find(({ id }) => id === summary?.hostId);
  const others = Math.max(0, (summary?.clients ?? 0) - 1);
  const phone = usePhoneLayout();
  const sessionId = summary?.sessionId ?? session.key.slice(session.key.indexOf('/') + 1);
  const terminals = useThreadTerminals(session.key, sessionId, session.terminals);
  const canTerminals = Boolean(host?.canTerminals && session.terminals);
  const terminalsShown = canTerminals && terminals.thread.shown;
  // On the iPad the terminals sit beside the thread, or over its width, their tabs in its top
  // rail; on the iPhone they take the chat's place under its header.
  const wide = !phone && terminalsShown && terminals.thread.wide;
  const paned = phone && terminalsShown;
  // A subagent whose own transcript shows instead of the session's.
  const [watching, setWatching] = useState<string>();
  useEffect(() => setWatching(undefined), [session.key]);
  const subagent = watching ? findSubagent(session.transcript, watching) : undefined;
  const openSubagent = useCallback((sessionId: string) => setWatching(sessionId), []);
  // A terminal starting here, until the list has it; why the last one didn't start; and the one
  // just started, which takes the keyboard.
  const [starting, setStarting] = useState<{ id?: string }>();
  const [startError, setStartError] = useState<string>();
  const [started, setStarted] = useState<string>();
  const shownKey = useRef(session.key);
  shownKey.current = session.key;
  useEffect(() => {
    setStarting(undefined);
    setStartError(undefined);
    setStarted(undefined);
  }, [session.key]);
  const startTerminal = async () => {
    const key = session.key;
    setStarting({});
    setStartError(undefined);
    try {
      const id = await actions.newTerminal();
      terminals.change((thread) => selectTab(thread, id));
      // The terminal is the worktree's either way; the thread on screen may be another by now.
      if (shownKey.current !== key) return;
      setStarted(id);
      setStarting({ id });
    } catch (cause) {
      if (shownKey.current !== key) return;
      setStartError(cause instanceof Error ? cause.message : String(cause));
      setStarting(undefined);
    }
  };
  const listed = Boolean(starting?.id && terminals.tabs.some(({ id }) => id === starting.id));
  useEffect(() => {
    if (!starting?.id) return;
    if (listed) {
      setStarting(undefined);
      return;
    }
    // One that ended before it was listed.
    const timer = setTimeout(() => setStarting(undefined), 5000);
    return () => clearTimeout(timer);
  }, [starting, listed]);
  // The pane's edge, as the sidebar's: the pane keeps its width, and the thread fits the rest.
  const view = useRef<HTMLElement>(null);
  const [resizing, setResizing] = useState(false);
  const available = () => view.current?.getBoundingClientRect().width ?? window.innerWidth;
  const resizePane = (width: number, keep = true) => terminals.setWidth(clampPaneWidth(width, available()), keep);
  const hideTerminals = () => {
    setStartError(undefined);
    terminals.change((thread) => ({ ...thread, shown: false }));
  };
  // The pane shows only with a terminal: opening it on none starts one, and it closes with the
  // last, wherever that ended, unless one is starting or didn't.
  const toggleTerminals = () => {
    if (terminalsShown) {
      hideTerminals();
      return;
    }
    terminals.change((thread) => ({ ...thread, shown: true }));
    if (terminals.tabs.length === 0) void startTerminal();
  };
  const empty = terminalsShown && terminals.tabs.length === 0 && starting === undefined && !startError;
  useEffect(() => {
    if (empty) terminals.change((thread) => ({ ...thread, shown: false }));
  }, [empty]);
  const swipe = useEdgeSwipe(paned ? hideTerminals : subagent ? () => setWatching(undefined) : onSwipeBack);
  const terminalsButton = canTerminals && (
    <TerminalsButton shown={terminalsShown} count={terminals.tabs.length} onToggle={toggleTerminals} />
  );
  const [update, dismissUpdate] = useUpdateNotice(session.key, session.update);
  // Requests waiting in a transcript not on screen: Main's while a subagent's shows, or a subagent's.
  const asking = [
    ...(subagent && waitsForAnswer(session.transcript) ? [undefined] : []),
    ...allSubagents(session.transcript)
      .filter(({ sessionId, transcript }) => sessionId !== subagent?.sessionId && waitsForAnswer(transcript))
      .map(({ sessionId }) => sessionId),
  ];
  return (
    <section ref={view} aria-label={summary?.title || 'New thread'} data-slot='session-view' className='flex min-h-0 min-w-0 flex-1' {...swipe}>
      <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', wide && 'hidden')}>
        {!wide && (
          <SessionHeader leading={leading}>
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
            <ActivityIndicator activity={summary?.activity} />
            {others > 0 && (
              <Badge variant='outline' aria-label={`${others} other ${others === 1 ? 'client' : 'clients'} attached`} title='Other clients attached'>
                <HugeiconsIcon icon={UserMultiple02Icon} strokeWidth={2} />
                {others}
              </Badge>
            )}
            {terminalsButton}
            {summary && <SessionMenu session={summary} actions={actions} canRename={host?.canRename} />}
          </SessionHeader>
        )}
        {host && host.status !== 'connected' && <ConnectionNotice host={host} />}
        {model.error && (
          <Alert variant='destructive' className='m-2 w-auto'>
            <AlertDescription>{model.error}</AlertDescription>
          </Alert>
        )}
        {update && (
          <UpdateNotice
            update={update}
            updating={session.updating}
            reopening={session.reopening}
            onUpdate={() => void actions.updateAgent()}
            onMove={() => void actions.reopenSession()}
            onDismiss={dismissUpdate}
          />
        )}
        {asking.map((sessionId) => {
          const label = sessionId ? sessionLabel(session.transcript, sessionId) : 'Main';
          return (
            <Alert key={sessionId ?? 'main'} className='m-2 mb-0 w-auto border-warning/40' data-slot='asking-notice'>
              <AlertTitle>{label} is waiting for you</AlertTitle>
              <AlertAction>
                <Button size='sm' variant='outline' aria-label={`Show ${label}`} onClick={() => setWatching(sessionId)}>Show</Button>
              </AlertAction>
            </Alert>
          );
        })}
        <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', paned && 'hidden')}>
          {subagent
            ? (
              <>
                <div data-slot='subagent-bar' className='flex min-h-9 shrink-0 items-center gap-2 border-b bg-muted/40 px-2 text-xs'>
                  <Button size='sm' variant='ghost' onClick={() => setWatching(undefined)}>
                    <HugeiconsIcon data-icon='inline-start' icon={ArrowLeft01Icon} strokeWidth={2} />
                    Main
                  </Button>
                  <span className='min-w-0 truncate font-semibold'>{sessionLabel(session.transcript, subagent.sessionId)}</span>
                  {subagent.description && <span className='min-w-0 truncate text-muted-foreground'>{subagent.description}</span>}
                  {subagent.state && <Badge variant='outline' className='ml-auto shrink-0'>{subagent.state.replace('_', ' ')}</Badge>}
                </div>
                <ChatPane
                  key={`${session.key}/${subagent.sessionId}`}
                  model={subagent.transcript}
                  root={session.transcript}
                  actions={actions}
                  readOnly
                  onOpenSubagent={openSubagent}
                />
              </>
            )
            : (
              <ChatPane
                key={session.key}
                draftKey={session.key}
                model={session.transcript}
                actions={actions}
                queued={session.queued}
                queuePaused={session.queuePaused}
                canSteer={session.canSteer}
                canAttachImages={session.canAttachImages}
                loading={session.loading}
                onOpenSubagent={openSubagent}
              />
            )}
        </div>
        {paned && terminalPanel('pane')}
      </div>
      {terminalsShown && !phone && (
        <div data-slot='terminal-side' className={cn('relative flex min-h-0 min-w-0 flex-col', wide ? 'flex-1' : 'shrink-0 border-l border-border')}
          // A window narrowed since keeps the thread its least, as `clampPaneWidth` does.
          style={wide ? undefined : {
            '--terminal-pane-width': `${terminals.width}px`,
            width: `max(${PANE_WIDTH.min}px, min(var(--terminal-pane-width), calc(100% - ${PANE_WIDTH.thread}px)))`,
          } as CSSProperties}>
          {!wide && (
            <ResizeHandle label='Resize terminals' edge='left' width={terminals.width} min={PANE_WIDTH.min}
              max={Math.max(PANE_WIDTH.min, Math.round(available() - PANE_WIDTH.thread))} initial={PANE_WIDTH.initial}
              resizing={resizing}
              onResizing={(next) => {
                setResizing(next);
                if (!next) terminals.setWidth(terminals.width);
              }}
              // The pane ends at the thread's right edge, so its width is from the pointer to there.
              onPointer={(x) => resizePane((view.current?.getBoundingClientRect().right ?? window.innerWidth) - x, false)}
              onResize={resizePane} />
          )}
          {terminalPanel(wide ? 'wide' : 'beside')}
        </div>
      )}
    </section>
  );

  function terminalPanel(placement: 'beside' | 'wide' | 'pane') {
    return (
      <TerminalPanel
        tabs={terminals.tabs}
        active={terminals.active}
        fontSize={terminals.fontSize}
        placement={placement}
        // Over the thread's width, the rail is the thread's too.
        {...(placement === 'wide' ? { leading, trailing: terminalsButton } : {})}
        onSelect={(id) => terminals.change((thread) => selectTab(thread, id))}
        onNew={() => void startTerminal()}
        starting={starting !== undefined}
        startError={startError}
        focus={started}
        onFocused={() => setStarted(undefined)}
        onClose={(id) => actions.closeTerminal(id)}
        onRename={(id, label) => actions.renameTerminal(id, label)}
        onWide={(next) => terminals.change((thread) => ({ ...thread, wide: next }))}
        onFontSize={terminals.setFontSize}
        onDone={hideTerminals}
        attach={actions.attachTerminal}
      />
    );
  }
}
