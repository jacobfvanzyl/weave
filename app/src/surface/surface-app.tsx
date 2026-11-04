import { useEffect, useRef, useState } from 'react';
import { useMessageScroller, useMessageScrollerScrollable } from '@/components/ui/message-scroller';
import { createTranscript, type AcpTranscript } from '@/chat/acp-transcript';
import { ChatPane, type ChatPaneActions } from '@/chat/chat-pane';
import { ActivityIndicator } from '@/components/activity-indicator';
import { PathLabel } from '@/components/path-label';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { surfaceEnd, type SurfaceEnd } from './surface-link';
import { applyTranscript, type SurfacePosition, type ToSurface } from './surface-messages';

/** The Surface takes no input: everything is answered on the device. */
const inert: ChatPaneActions = {
  send: () => {},
  cancelTurn: () => {},
  respondToPermission: () => {},
  respondToElicitation: () => {},
  setMode: () => {},
  setConfigOption: () => {},
};

type ScrollCommand = { seq: number; command: Extract<ToSurface, { kind: 'scroll' }> };

const viewportOf = (from: Element | null) =>
  from?.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]') ?? null;

/** Inside the transcript's scroller: scrolls it as the device asks, and tells the device where it is. */
function ScrollBridge({ root, command, onPosition }: {
  root: React.RefObject<HTMLElement | null>;
  command?: ScrollCommand;
  onPosition(position: SurfacePosition): void;
}) {
  const { scrollToEnd } = useMessageScroller();
  const scrollable = useMessageScrollerScrollable();
  const report = useRef(onPosition);
  report.current = onPosition;
  useEffect(() => {
    if (!command) return;
    const viewport = viewportOf(root.current);
    if ('to' in command.command) {
      scrollToEnd({ behavior: 'smooth' });
      return;
    }
    if (!viewport) return;
    const max = viewport.scrollHeight - viewport.clientHeight;
    viewport.scrollTo({ top: Math.max(0, Math.min(1, command.command.fraction)) * max, behavior: 'instant' });
  }, [command]);
  useEffect(() => {
    const viewport = viewportOf(root.current);
    if (!viewport) return;
    let frame: number | undefined;
    const send = () => {
      frame = undefined;
      const max = viewport.scrollHeight - viewport.clientHeight;
      report.current({
        fraction: max > 0 ? viewport.scrollTop / max : 1,
        following: !scrollable.end,
        scrollable: max > 0,
      });
    };
    const schedule = () => { frame ??= requestAnimationFrame(send); };
    schedule();
    viewport.addEventListener('scroll', schedule, { passive: true });
    return () => {
      viewport.removeEventListener('scroll', schedule);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [scrollable.end]);
  return null;
}

/**
 * A Surface (WVE-183): the thread open on the device, large and read only, or the one last open,
 * dimmed, while the device shows its list. It talks to no Host; the device sends what it shows.
 */
export function SurfaceApp({ end: given }: { end?: SurfaceEnd }) {
  const [end] = useState(() => given ?? surfaceEnd());
  const [show, setShow] = useState<Extract<ToSurface, { kind: 'show' }>>();
  const [shown, setShown] = useState<{ key: string; transcript: AcpTranscript }>();
  const [command, setCommand] = useState<ScrollCommand>();
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    const html = document.documentElement;
    html.dataset.surface = 'true';
    return () => { delete html.dataset.surface; };
  }, []);

  useEffect(() => {
    const off = end.onMessage((message) => {
      switch (message.kind) {
        case 'show':
          setShow(message);
          return;
        case 'transcript':
          setShown((current) => {
            const next = applyTranscript(current, message);
            // Out of step with the device: ask for all of it again.
            if (!next) queueMicrotask(() => end.send({ kind: 'ready' }));
            return next ?? current;
          });
          return;
        case 'scroll':
          setCommand((current) => ({ seq: (current?.seq ?? 0) + 1, command: message }));
      }
    });
    end.send({ kind: 'ready' });
    return off;
  }, [end]);

  const thread = show?.thread;
  const transcript = thread && shown?.key === thread.key ? shown.transcript : undefined;
  const waiting = show?.waiting ?? 0;
  return (
    <main ref={root} aria-label='Surface' data-slot='surface' data-dimmed={show?.dimmed || undefined}
      className='flex h-dvh min-h-0 flex-col bg-chat-background px-[4vw] py-[3vh] text-foreground'>
      {thread
        ? (
          <>
            <header className='flex shrink-0 items-center gap-3 pb-3'>
              <div className={cn('min-w-0 flex-1', show?.dimmed && 'opacity-50')}>
                <h1 className='truncate text-2xl font-semibold'>{thread.title || 'New thread'}</h1>
                <p className='flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground'>
                  {thread.agentName && <span className='shrink-0'>{thread.agentName}</span>}
                  {thread.branch && <><span aria-hidden='true'>·</span><span className='shrink-0'>{thread.branch}</span></>}
                  {thread.cwd && <><span aria-hidden='true'>·</span><PathLabel path={thread.cwd} /></>}
                  {thread.host && <span className='shrink-0'>· {thread.host}</span>}
                </p>
              </div>
              <ActivityIndicator activity={thread.activity} className='size-3' />
              <WaitingCount count={waiting} />
            </header>
            <div inert className={cn('flex min-h-0 flex-1 flex-col transition-opacity', show?.dimmed && 'opacity-40')}>
              {transcript
                ? (
                  <ChatPane
                    key={thread.key}
                    model={transcript}
                    actions={inert}
                    readOnly
                    loading={thread.loading}
                    inScroller={<ScrollBridge root={root} command={command} onPosition={(position) => end.send({ kind: 'position', ...position })} />}
                  />
                )
                : <ChatPane key={thread.key} model={createTranscript(thread.key)} actions={inert} readOnly loading />}
            </div>
          </>
        )
        : (
          <div className='flex flex-1 flex-col items-center justify-center gap-3 text-center'>
            <p className='text-4xl font-semibold tracking-tight'>weave</p>
            <p className='text-muted-foreground'>Open a thread on your iPhone to show it here.</p>
            <WaitingCount count={waiting} />
          </div>
        )}
    </main>
  );
}

function WaitingCount({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <Badge className='bg-warning px-3 py-1 text-base text-background'>
      {count === 1 ? '1 thread needs you' : `${count} threads need you`}
    </Badge>
  );
}
