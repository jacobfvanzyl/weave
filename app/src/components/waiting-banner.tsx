import { useEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Cancel01Icon } from '@hugeicons/core-free-icons';
import type { AppController, ThreadSummary } from '@/app/app-controller';
import { Button } from '@/components/ui/button';

const SHOWN_MS = 8_000;

/**
 * The thread that most recently started waiting on the person while it wasn't on screen. Threads
 * already waiting when the app first sees them are in "Needs you" and get no banner.
 */
export function useWaitingBanner(threads: readonly ThreadSummary[], shown: readonly string[] = []) {
  const seen = useRef<Set<string>>(undefined);
  const [banner, setBanner] = useState<ThreadSummary>();
  const onScreen = shown.join('\n');

  useEffect(() => {
    const waiting = new Set(threads.filter(({ activity }) => activity === 'waiting').map(({ key }) => key));
    const previous = seen.current;
    seen.current = waiting;
    if (!previous) return;
    const started = threads.find(({ key }) => waiting.has(key) && !previous.has(key) && !shown.includes(key));
    if (started) setBanner(started);
  }, [threads, onScreen]);

  useEffect(() => {
    if (!banner) return;
    const stillWaiting = threads.some(({ key, activity }) => key === banner.key && activity === 'waiting');
    if (!stillWaiting || shown.includes(banner.key)) setBanner(undefined);
  }, [banner, threads, onScreen]);

  useEffect(() => {
    if (!banner) return;
    const timer = setTimeout(() => setBanner(undefined), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [banner]);

  return [banner, () => setBanner(undefined)] as const;
}

/** Names a thread that started waiting off screen; tapping it shows that thread, in its Session. */
export function WaitingBanner({ controller, onOpen }: { controller: AppController; onOpen?(key: string): void }) {
  const { model, actions } = controller;
  const [banner, dismiss] = useWaitingBanner(model.threads, [...Object.keys(model.open ?? {}), ...(model.selectedKey ? [model.selectedKey] : [])]);
  if (!banner) return null;
  return (
    <div role='status' aria-live='polite' data-slot='waiting-banner'
      className='fixed inset-x-0 top-[calc(env(safe-area-inset-top)+0.5rem)] z-50 flex justify-center px-3'>
      <div className='flex w-full max-w-md items-center gap-1 rounded-xl border border-warning/40 bg-popover p-1 shadow-lg'>
        <button type='button' className='min-w-0 flex-1 rounded-lg px-2.5 py-1.5 text-left hover:bg-muted'
          onClick={() => {
            if (onOpen) onOpen(banner.key);
            else actions.selectThread(banner.key);
            dismiss();
          }}>
          <span className='block truncate text-xs font-medium'>{banner.title || 'New thread'} needs you</span>
          <span className='block truncate text-[0.6875rem] text-muted-foreground'>{banner.waitingOn ?? `${banner.agentName} is waiting`}</span>
        </button>
        <Button size='icon' variant='ghost' aria-label='Dismiss' onClick={dismiss}>
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        </Button>
      </div>
    </div>
  );
}
