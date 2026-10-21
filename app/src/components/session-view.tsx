import { useCallback, useEffect, useRef, useState, type ReactNode, type TouchEvent } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeft01Icon, Delete02Icon, MoreHorizontalIcon, SparklesIcon, StopIcon, UserMultiple02Icon } from '@hugeicons/core-free-icons';
import type { AgentUpdateNotice, AppController, OpenSession, SessionSummary } from '@/app/app-controller';
import { findSubagent, sessionLabel } from '@/chat/acp-transcript';
import { ChatPane } from '@/chat/chat-pane';
import { ActivityIndicator } from '@/components/activity-indicator';
import { PathLabel } from '@/components/path-label';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

/** The bar above a session, and above the empty state when none is open. */
export function SessionHeader({ leading, children }: { leading?: ReactNode; children?: ReactNode }) {
  return (
    <header data-slot='session-header'
      className='flex min-h-11 shrink-0 items-center gap-2 border-b border-border bg-title-bar pt-[env(safe-area-inset-top)] pr-2 pl-[max(env(safe-area-inset-left),0.5rem)]'>
      {leading}
      {children}
    </header>
  );
}

function SessionMenu({ session, actions }: { session: SessionSummary; actions: AppController['actions'] }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const name = session.title || 'this session';
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size='icon' variant='ghost' aria-label='Session actions' />}>
          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end'>
          <DropdownMenuGroup>
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
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The agent and the Host forget it, on every device. Its turn stops if one is running.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant='destructive' onClick={() => void actions.deleteSession(session.key)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
        {summary && <SessionMenu session={summary} actions={actions} />}
      </SessionHeader>
      {model.error && (
        <Alert variant='destructive' className='m-2 w-auto'>
          <AlertDescription>{model.error}</AlertDescription>
        </Alert>
      )}
      {session.update && <UpdateNotice update={session.update} reopening={session.reopening} onMove={() => void actions.reopenSession()} />}
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
            canSteer={session.canSteer}
            canAttachImages={session.canAttachImages}
            onOpenSubagent={openSubagent}
          />
        )}
    </section>
  );
}
