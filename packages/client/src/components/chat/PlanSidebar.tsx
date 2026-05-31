import { Check, Circle, Loader2 } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { PlanStepStatus, ThreadPlan } from '../../stores/chat-store';
import { Badge } from '../ui/badge';

const PlanStatusGlyph = ({ status }: { status: PlanStepStatus }) => {
  if (status === 'completed') {
    return (
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
        <Check size={10} strokeWidth={3} />
      </span>
    );
  }

  if (status === 'in_progress') {
    return <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin text-primary" />;
  }

  return <Circle size={16} className="mt-0.5 shrink-0 text-muted-foreground/60" />;
};

export const PlanSidebar = ({ plan }: { plan?: ThreadPlan }) => {
  if (!plan) return null;

  const isComplete = plan.total > 0 && plan.completed >= plan.total;

  return (
    <aside
      className="pointer-events-auto absolute right-4 top-4 z-20 hidden max-h-[min(70dvh,calc(100%_-_2rem))] w-80 min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card/95 shadow-lg backdrop-blur md:flex"
      data-weave-plan-card
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">Plan</h2>
        {plan.isBusy ? <Loader2 size={14} className="shrink-0 animate-spin text-primary" /> : null}
        <Badge size="sm" variant={plan.isBusy ? 'info' : isComplete ? 'success' : 'info'}>
          {plan.completed}/{plan.total}
        </Badge>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <ol className="space-y-3">
          {plan.plan.map((item, index) => (
            <li key={`${item.status}-${item.step}-${index}`} className="flex min-w-0 gap-2 text-sm leading-5">
              <PlanStatusGlyph status={item.status} />
              <span className={cn(
                'min-w-0 break-words',
                item.status === 'completed' && 'text-muted-foreground line-through',
                item.status === 'in_progress' && 'font-medium text-foreground',
                item.status === 'pending' && 'text-muted-foreground',
              )}>
                {item.step}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </aside>
  );
};
