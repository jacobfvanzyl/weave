import type { ComponentProps } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type ConfirmationProps = ComponentProps<typeof Alert>;

export function Confirmation({ className, ...props }: ConfirmationProps) {
  return (
    <Alert
      className={cn(
        'flex flex-row flex-wrap items-center gap-1.5 rounded-none border-0 border-t bg-warning-background px-3 py-2',
        className,
      )}
      data-slot="confirmation"
      {...props}
    />
  );
}

export type ConfirmationTitleProps = ComponentProps<typeof AlertTitle>;

export function ConfirmationTitle({ className, ...props }: ConfirmationTitleProps) {
  return (
    <AlertTitle
      className={cn('mr-auto text-[0.6875rem] font-normal text-warning', className)}
      data-slot="confirmation-title"
      {...props}
    />
  );
}

export type ConfirmationActionsProps = ComponentProps<'div'>;

export function ConfirmationActions({ className, ...props }: ConfirmationActionsProps) {
  return (
    <div
      className={cn('flex flex-wrap items-center gap-1.5', className)}
      data-slot="confirmation-actions"
      {...props}
    />
  );
}

export type ConfirmationActionProps = ComponentProps<typeof Button>;

export function ConfirmationAction({ size = 'sm', type = 'button', ...props }: ConfirmationActionProps) {
  return <Button data-slot="confirmation-action" size={size} type={type} {...props} />;
}
