import type { SessionActivity } from '@/app/app-controller';
import { cn } from '@/lib/utils';

const indicators = {
  waiting: { label: 'Waiting for you', color: 'bg-warning' },
  running: { label: 'Running', color: 'bg-info motion-safe:animate-pulse' },
  unread: { label: 'Finished since you last looked', color: 'bg-success' },
};

/** A session's activity as a dot: waiting, running, or a turn that ended while you weren't looking. */
export function ActivityIndicator({ activity, unread, className }: {
  activity?: SessionActivity;
  unread?: boolean;
  className?: string;
}) {
  const state = activity === 'waiting' || activity === 'running' ? activity : unread ? 'unread' : undefined;
  if (!state) return null;
  const indicator = indicators[state];
  return (
    <span role='img' aria-label={indicator.label} title={indicator.label} data-slot='session-activity' data-state={state}
      className={cn('size-2 shrink-0 rounded-full', className)}>
      <span aria-hidden='true' className={cn('block size-full rounded-full', indicator.color)} />
    </span>
  );
}
