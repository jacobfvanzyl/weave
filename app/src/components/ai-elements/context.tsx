import { createContext, useContext, useMemo, type ComponentProps, type ReactNode } from 'react';
import { CircularProgress } from '@/components/ui/progress';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type ContextValue = {
  cost?: { amount: number; currency: string } | null;
  maxTokens: number;
  percentage: number;
  usedTokens: number;
};

const UsageContext = createContext<ContextValue | null>(null);

const useUsageContext = () => {
  const value = useContext(UsageContext);
  if (!value) throw new Error('Context components must be used within Context.');
  return value;
};

export type ContextProps = {
  children: ReactNode;
  cost?: ContextValue['cost'];
  maxTokens: number;
  usedTokens: number;
};

export function Context({ children, cost, maxTokens, usedTokens }: ContextProps) {
  const value = useMemo<ContextValue>(() => ({
    cost,
    maxTokens,
    percentage: maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : 0,
    usedTokens,
  }), [cost, maxTokens, usedTokens]);

  return (
    <UsageContext.Provider value={value}>
      <TooltipProvider>
        <Tooltip>{children}</Tooltip>
      </TooltipProvider>
    </UsageContext.Provider>
  );
}

export type ContextTriggerProps = ComponentProps<typeof TooltipTrigger>;

export function ContextTrigger({ className, children, ...props }: ContextTriggerProps) {
  const { percentage, usedTokens, maxTokens } = useUsageContext();
  const description = `${usedTokens.toLocaleString()} of ${maxTokens.toLocaleString()} context tokens used`;
  return (
    <TooltipTrigger
      aria-label="Context usage"
      className={cn('rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40', className)}
      type="button"
      {...props}
    >
      {children ?? (
        <CircularProgress
          aria-label="Context usage"
          aria-valuetext={description}
          value={percentage}
        />
      )}
    </TooltipTrigger>
  );
}

const formatCost = ({ amount, currency }: NonNullable<ContextValue['cost']>) => {
  try {
    return new Intl.NumberFormat(undefined, { currency, style: 'currency' }).format(amount);
  } catch {
    return `${amount.toLocaleString()} ${currency}`;
  }
};

export type ContextContentProps = ComponentProps<typeof TooltipContent>;

export function ContextContent({ children, className, ...props }: ContextContentProps) {
  const { cost, maxTokens, usedTokens } = useUsageContext();
  return (
    <TooltipContent
      className={cn('flex flex-col items-start gap-0.5', className)}
      data-slot="context-content"
      {...props}
    >
      {children ?? (
        <>
          <span>{usedTokens.toLocaleString()} of {maxTokens.toLocaleString()} tokens</span>
          {cost && <span>{formatCost(cost)}</span>}
        </>
      )}
    </TooltipContent>
  );
}
