import { AlertTriangle, Check, Circle, FileText, Loader2 } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { PlanStepStatus, ThreadPlan } from '../../stores/chat-store';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';

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

  if (status === 'blocked') {
    return <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />;
  }

  return <Circle size={16} className="mt-0.5 shrink-0 text-muted-foreground/60" />;
};

const statusBadgeVariant = (status: PlanStepStatus | undefined, isBusy: boolean, isComplete: boolean) => {
  if (status === 'blocked') return 'warning';
  if (status === 'completed' || isComplete) return 'success';
  if (status === 'in_progress' || isBusy) return 'info';
  return 'outline';
};

export const PlanSidebar = ({ plan, onOpenPlan }: { plan?: ThreadPlan; onOpenPlan?: (path: string) => void }) => {
  if (!plan) return null;

  const isComplete = plan.total > 0 && plan.completed >= plan.total;
  const blockedCount = plan.plan.filter(item => item.status === 'blocked').length;
  const status = plan.status ?? (isComplete ? 'completed' : plan.isBusy ? 'in_progress' : 'pending');

  return (
    <aside
      className="pointer-events-auto absolute right-4 top-4 z-20 hidden max-h-[min(70dvh,calc(100%_-_2rem))] w-80 min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card/95 shadow-lg backdrop-blur md:flex"
      data-weave-plan-card
      data-weave-surface="plan"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-foreground">{plan.title ?? 'Plan'}</h2>
          <div className="mt-1 flex min-w-0 items-center gap-1.5">
            {plan.isBusy ? <Loader2 size={13} className="shrink-0 animate-spin text-primary" /> : null}
            <Badge size="sm" variant={statusBadgeVariant(status, Boolean(plan.isBusy), isComplete)}>
              {status.replace('_', ' ')}
            </Badge>
            <Badge size="sm" variant={isComplete ? 'success' : 'info'}>
              {plan.completed}/{plan.total}
            </Badge>
            {blockedCount > 0 ? (
              <Badge size="sm" variant="warning">
                {blockedCount} blocked
              </Badge>
            ) : null}
          </div>
        </div>
        {plan.path && onOpenPlan ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Open plan artifact"
            title={plan.path}
            onClick={() => onOpenPlan(plan.path!)}
          >
            <FileText size={14} />
          </Button>
        ) : null}
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
                item.status === 'blocked' && 'font-medium text-warning-foreground',
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
