import { createContext, useContext, useMemo, useState, type ComponentProps } from 'react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

type ReasoningState = {
  isStreaming: boolean;
};

const ReasoningContext = createContext<ReasoningState | null>(null);

export type ReasoningProps = Omit<ComponentProps<typeof Collapsible>, 'open'> & {
  isStreaming?: boolean;
  open?: boolean;
};

export function Reasoning({
  children,
  className,
  defaultOpen = true,
  isStreaming = false,
  onOpenChange,
  open,
  ...props
}: ReasoningProps) {
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const isOpen = open ?? localOpen;
  const context = useMemo(() => ({ isStreaming }), [isStreaming]);

  return (
    <ReasoningContext.Provider value={context}>
      <Collapsible
        className={cn('min-w-0', className)}
        data-slot="reasoning"
        open={isOpen}
        onOpenChange={(nextOpen, eventDetails) => {
          if (open === undefined) setLocalOpen(nextOpen);
          onOpenChange?.(nextOpen, eventDetails);
        }}
        {...props}
      >
        {children}
      </Collapsible>
    </ReasoningContext.Provider>
  );
}

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger>;

export function ReasoningTrigger({ className, ...props }: ReasoningTriggerProps) {
  const state = useContext(ReasoningContext);
  if (!state) throw new Error('ReasoningTrigger must be used within Reasoning.');

  return (
    <CollapsibleTrigger
      className={cn(
        'flex items-center gap-2 text-[0.6875rem] text-muted-foreground transition-colors hover:text-foreground motion-reduce:transition-none [&_svg]:size-3.5',
        className,
      )}
      data-streaming={state.isStreaming || undefined}
      data-slot="reasoning-trigger"
      {...props}
    />
  );
}

export type ReasoningContentProps = ComponentProps<typeof CollapsibleContent>;

export function ReasoningContent({ className, ...props }: ReasoningContentProps) {
  return (
    <CollapsibleContent
      className={cn(
        'mt-1 border-l pl-3 text-muted-foreground transition-[height,opacity] motion-reduce:transition-none',
        className,
      )}
      data-slot="reasoning-content"
      {...props}
    />
  );
}
