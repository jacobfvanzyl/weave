import { useEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Cancel01Icon } from '@hugeicons/core-free-icons';
import type { AppController, SessionSummary } from '@/app/app-controller';
import { Button } from '@/components/ui/button';

const SHOWN_MS = 8_000;

/**
 * The session that most recently started waiting on the person while it wasn't on screen. Sessions
 * already waiting when the app first sees them are in "Needs you" and get no banner.
 */
export function useWaitingBanner(sessions: readonly SessionSummary[], selectedKey?: string) {
  const seen = useRef<Set<string>>(undefined);
  const [banner, setBanner] = useState<SessionSummary>();

  useEffect(() => {
    const waiting = new Set(sessions.filter(({ activity }) => activity === 'waiting').map(({ key }) => key));
    const previous = seen.current;
    seen.current = waiting;
    if (!previous) return;
    const started = sessions.find(({ key }) => waiting.has(key) && !previous.has(key) && key !== selectedKey);
    if (started) setBanner(started);
  }, [sessions, selectedKey]);

  useEffect(() => {
    if (!banner) return;
    const stillWaiting = sessions.some(({ key, activity }) => key === banner.key && activity === 'waiting');
    if (!stillWaiting || banner.key === selectedKey) setBanner(undefined);
  }, [banner, sessions, selectedKey]);

  useEffect(() => {
    if (!banner) return;
    const timer = setTimeout(() => setBanner(undefined), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [banner]);

  return [banner, () => setBanner(undefined)] as const;
}

/** Names a session that started waiting off screen; tapping it opens that session. */
export function WaitingBanner({ controller, onOpen }: { controller: AppController; onOpen?(): void }) {
  const { model, actions } = controller;
  const [banner, dismiss] = useWaitingBanner(model.sessions, model.selectedKey);
  if (!banner) return null;
  return (
    <div role='status' aria-live='polite' data-slot='waiting-banner'
      className='fixed inset-x-0 top-[calc(env(safe-area-inset-top)+0.5rem)] z-50 flex justify-center px-3'>
      <div className='flex w-full max-w-md items-center gap-1 rounded-xl border border-warning/40 bg-popover p-1 shadow-lg'>
        <button type='button' className='min-w-0 flex-1 rounded-lg px-2.5 py-1.5 text-left hover:bg-muted'
          onClick={() => { actions.selectSession(banner.key); onOpen?.(); dismiss(); }}>
          <span className='block truncate text-xs font-medium'>{banner.title || 'New session'} needs you</span>
          <span className='block truncate text-[0.6875rem] text-muted-foreground'>{banner.waitingOn ?? `${banner.agentName} is waiting`}</span>
        </button>
        <Button size='icon' variant='ghost' aria-label='Dismiss' onClick={dismiss}>
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        </Button>
      </div>
    </div>
  );
}
