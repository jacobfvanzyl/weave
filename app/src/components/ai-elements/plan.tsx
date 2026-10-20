import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowUpDownIcon } from '@hugeicons/core-free-icons';
import type { ComponentProps } from 'react';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

export type PlanProps = ComponentProps<typeof Collapsible>;

export function Plan({ className, ...props }: PlanProps) {
  return (
    <Collapsible
      className={cn('rounded-md border bg-card/50', className)}
      data-slot="plan"
      {...props}
    />
  );
}

export type PlanHeaderProps = ComponentProps<'header'>;

export function PlanHeader({ className, ...props }: PlanHeaderProps) {
  return (
    <header
      className={cn('flex items-center gap-2', className)}
      data-slot="plan-header"
      {...props}
    />
  );
}

export type PlanTriggerProps = Omit<
  ComponentProps<typeof CollapsibleTrigger>,
  'className' | 'render'
> & { className?: string };

export function PlanTrigger({ className, ...props }: PlanTriggerProps) {
  return (
    <CollapsibleTrigger
      data-slot="plan-trigger"
      render={(
        <Button
          aria-label="Toggle plan"
          className={className}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <HugeiconsIcon data-icon="inline-start" icon={ArrowUpDownIcon} strokeWidth={1.75} />
        </Button>
      )}
      {...props}
    />
  );
}

export type PlanContentProps = ComponentProps<typeof CollapsibleContent>;

export function PlanContent({ className, ...props }: PlanContentProps) {
  return (
    <CollapsibleContent
      className={cn('outline-none', className)}
      data-slot="plan-content"
      {...props}
    />
  );
}
