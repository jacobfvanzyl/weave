import { useCallback, useEffect, useRef, useState, type ReactNode, type TouchEvent } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeft01Icon, Delete02Icon, Edit02Icon, MoreHorizontalIcon, SparklesIcon, StopIcon, UserMultiple02Icon } from '@hugeicons/core-free-icons';
import type { AgentUpdateNotice, AppController, OpenSession, PairedHost, SessionSummary } from '@/app/app-controller';
import { allSubagents, findSubagent, sessionLabel, waitsForAnswer } from '@/chat/acp-transcript';
import { ChatPane } from '@/chat/chat-pane';
import { ActivityIndicator } from '@/components/activity-indicator';
import { DeleteSessionDialog } from '@/components/delete-session-dialog';
import { PathLabel } from '@/components/path-label';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';

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
          <DialogTitle>Rename session</DialogTitle>
          <DialogDescription>Every device and the TUI show the new title. The agent keeps its own.</DialogDescription>
        </DialogHeader>
        <form aria-label='Rename session' className='grid gap-3' onSubmit={async (event) => {
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
        <DropdownMenuTrigger render={<Button size='icon' variant='ghost' aria-label='Session actions' />}>
          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end'>
          <DropdownMenuGroup>
            {canRename && (
              <DropdownMenuItem disabled={session.state !== 'open'} onClick={() => setRenaming(true)}>
                <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} />
                Rename session…
              </DropdownMenuItem>
            )}
            <DropdownMenuItem disabled={session.state === 'closed'} onClick={() => void actions.closeSession(session.key)}>
              <HugeiconsIcon icon={StopIcon} strokeWidth={2} />
              Close session
            </DropdownMenuItem>
            <DropdownMenuItem variant='destructive' onClick={() => setConfirmDelete(true)}>
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
              Delete session
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
 * A newer version of the session's agent is out. Remote clients can't update agents, so until the
 * Host has, the notice says where that's done; once its new sessions launch another version, it
 * offers to move this session there (`session/reopen`).
 */
function UpdateNotice({ update, reopening, onMove }: { update: AgentUpdateNotice; reopening?: boolean; onMove(): void }) {
  return (
    <Alert className='m-2 w-auto'>
      <HugeiconsIcon icon={SparklesIcon} strokeWidth={2} />
      <AlertTitle>{shortName(update.name)} {update.latest} is out; this session runs {update.running}.</AlertTitle>
      {update.available
        ? (
          <AlertDescription>
            The Host has {update.available} for new sessions. Moving this one ends its background commands and running subagents,
            and waits for a running turn.
          </AlertDescription>
        )
        : (
          <AlertDescription>
            Update it on the Host's computer with <code>weave update {update.agentId}</code>; this session can move to it then.
          </AlertDescription>
        )}
      {update.available && (
        <AlertAction>
          <Button size='sm' variant='outline' disabled={reopening} onClick={onMove}>
            {reopening ? 'Moving…' : `Move to ${update.available}`}
          </Button>
        </AlertAction>
      )}
    </Alert>
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
  // A subagent whose own transcript shows instead of the session's.
  const [watching, setWatching] = useState<string>();
  useEffect(() => setWatching(undefined), [session.key]);
  const subagent = watching ? findSubagent(session.transcript, watching) : undefined;
  const openSubagent = useCallback((sessionId: string) => setWatching(sessionId), []);
  const swipe = useEdgeSwipe(subagent ? () => setWatching(undefined) : onSwipeBack);
  // Requests waiting in a transcript not on screen: Main's while a subagent's shows, or a subagent's.
  const asking = [
    ...(subagent && waitsForAnswer(session.transcript) ? [undefined] : []),
    ...allSubagents(session.transcript)
      .filter(({ sessionId, transcript }) => sessionId !== subagent?.sessionId && waitsForAnswer(transcript))
      .map(({ sessionId }) => sessionId),
  ];
  return (
    <section aria-label={summary?.title || 'New session'} data-slot='session-view' className='flex min-h-0 min-w-0 flex-1 flex-col' {...swipe}>
      <SessionHeader leading={leading}>
        <div className='min-w-0 flex-1 py-1.5'>
          <h2 className='truncate text-sm font-semibold'>{summary?.title || 'New session'}</h2>
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
        {summary && <SessionMenu session={summary} actions={actions} canRename={host?.canRename} />}
      </SessionHeader>
      {host && host.status !== 'connected' && <ConnectionNotice host={host} />}
      {model.error && (
        <Alert variant='destructive' className='m-2 w-auto'>
          <AlertDescription>{model.error}</AlertDescription>
        </Alert>
      )}
      {session.update && <UpdateNotice update={session.update} reopening={session.reopening} onMove={() => void actions.reopenSession()} />}
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
            onOpenSubagent={openSubagent}
          />
        )}
    </section>
  );
}
