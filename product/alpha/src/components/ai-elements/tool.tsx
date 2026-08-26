import type { ComponentProps } from 'react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

export type ToolProps = ComponentProps<typeof Collapsible>;

export function Tool({ className, ...props }: ToolProps) {
  return (
    <Collapsible
      className={cn('group w-full overflow-hidden rounded-md border bg-card/50', className)}
      data-slot="tool"
      {...props}
    />
  );
}

export type ToolHeaderProps = ComponentProps<typeof CollapsibleTrigger>;

export function ToolHeader({ className, ...props }: ToolHeaderProps) {
  return (
    <CollapsibleTrigger
      className={cn('flex w-full items-center text-left', className)}
      data-slot="tool-header"
      {...props}
    />
  );
}

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export function ToolContent({ className, ...props }: ToolContentProps) {
  return (
    <CollapsibleContent
      className={cn('outline-none', className)}
      data-slot="tool-content"
      {...props}
    />
  );
}
