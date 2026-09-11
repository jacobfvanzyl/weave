import { useEffect, useReducer } from 'react';
import type { ThreadAttention } from '@weave/product-protocol';
import { cn } from '@/lib/utils';

const freshnessMs = 15_000;
const indicators = {
  working: { label: 'Working', color: 'bg-info motion-safe:animate-pulse' },
  waiting: { label: 'Waiting for your input', color: 'bg-warning' },
  completed: { label: 'Turn finished', color: 'bg-success' },
  uncertain: { label: 'Interrupted — outcome unknown', color: 'bg-destructive' },
};

export function AgentActivityIndicator({ attention, available, selected, id }: {
  id?: string;
  attention?: ThreadAttention;
  available: boolean;
  selected: boolean;
}) {
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const observedAt = Date.parse(attention?.observedAt ?? '');
  useEffect(() => {
    const remaining = observedAt + freshnessMs - Date.now();
    if (!available || !Number.isFinite(remaining) || remaining <= 0) return;
    // Expire even when a failed Host refresh produces no new React render.
    const timer = window.setTimeout(refresh, remaining + 1);
    return () => window.clearTimeout(timer);
  }, [available, observedAt]);

  if (!available || !attention || !Number.isFinite(observedAt) || Date.now() - observedAt >= freshnessMs) return null;
  if (attention.state === 'idle' || attention.state === 'unavailable') return null;
  // Older Hosts cannot distinguish dormant conversations from interrupted work.
  if (attention.state === 'uncertain' && attention.uncertaintyReason !== 'prompt_outcome_unknown') return null;
  const indicator = indicators[attention.state];
  return <span id={id} role='img' aria-label={indicator.label} title={indicator.label}
    data-slot='agent-activity' data-state={attention.state}
    className={cn('size-1.5 shrink-0 rounded-full', selected && 'ring-1 ring-primary-foreground')}>
    <span aria-hidden='true' className={cn('block size-full rounded-full', indicator.color)} />
  </span>;
}
