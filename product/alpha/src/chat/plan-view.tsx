import { HugeiconsIcon } from '@hugeicons/react';
import {
  CheckmarkCircle02Icon,
  CircleIcon,
  Loading03Icon,
  Task01Icon,
} from '@hugeicons/core-free-icons';
import type { TranscriptPlan } from './acp-transcript';
import { Plan, PlanContent, PlanHeader, PlanTrigger } from '@/components/ai-elements/plan';
import { Badge } from '@/components/ui/badge';

const statusIcon = {
  pending: CircleIcon,
  in_progress: Loading03Icon,
  completed: CheckmarkCircle02Icon,
} as const;

export function PlanView({ plan }: { plan: TranscriptPlan }) {
  return (
    <Plan aria-label="Agent plan" defaultOpen>
      <PlanHeader className="px-3 pb-2 pt-3 text-xs font-medium">
        <HugeiconsIcon icon={Task01Icon} strokeWidth={1.75} className="size-3.5" />
        Plan
        <Badge className="ml-auto" variant="outline">{plan.format}</Badge>
        <PlanTrigger />
      </PlanHeader>
      <PlanContent className="px-3 pb-3">
        {plan.entries && (
          <ol className="grid gap-1.5">
            {plan.entries.map((entry, index) => (
              <li key={`${entry.content}-${index}`} className="flex items-start gap-2 text-xs/relaxed">
                <HugeiconsIcon icon={statusIcon[entry.status]} strokeWidth={1.75} className="mt-0.5 size-3.5 text-muted-foreground" />
                <span className="min-w-0 flex-1">{entry.content}</span>
                <span className="text-[0.625rem] text-muted-foreground">{entry.priority}</span>
              </li>
            ))}
          </ol>
        )}
        {plan.content && <pre className="text-xs/relaxed whitespace-pre-wrap">{plan.content}</pre>}
        {plan.uri && <p className="truncate text-xs text-muted-foreground">{plan.uri}</p>}
      </PlanContent>
    </Plan>
  );
}
