import { useState, type ComponentProps, type HTMLAttributes, type KeyboardEventHandler } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export type PromptInputProps = ComponentProps<'form'>;

export function PromptInput({ className, ...props }: PromptInputProps) {
  return (
    <form
      className={cn('w-full', className)}
      data-slot="prompt-input"
      {...props}
    />
  );
}

export type PromptInputBodyProps = HTMLAttributes<HTMLDivElement>;

export function PromptInputBody({ className, ...props }: PromptInputBodyProps) {
  return <div className={cn('contents', className)} data-slot="prompt-input-body" {...props} />;
}

export type PromptInputTextareaProps = ComponentProps<typeof Textarea>;

export function PromptInputTextarea({
  onCompositionEnd,
  onCompositionStart,
  onKeyDown,
  ...props
}: PromptInputTextareaProps) {
  const [isComposing, setIsComposing] = useState(false);
  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (event) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key !== 'Enter' || event.shiftKey || isComposing || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    const submit = event.currentTarget.form?.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    if (!submit?.disabled) event.currentTarget.form?.requestSubmit();
  };

  return (
    <Textarea
      data-slot="prompt-input-textarea"
      onCompositionStart={(event) => {
        setIsComposing(true);
        onCompositionStart?.(event);
      }}
      onCompositionEnd={(event) => {
        setIsComposing(false);
        onCompositionEnd?.(event);
      }}
      onKeyDown={handleKeyDown}
      {...props}
    />
  );
}

export type PromptInputFooterProps = HTMLAttributes<HTMLDivElement>;

export function PromptInputFooter({ className, ...props }: PromptInputFooterProps) {
  return (
    <div
      className={cn('flex items-end justify-between gap-2', className)}
      data-slot="prompt-input-footer"
      {...props}
    />
  );
}

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>;

export function PromptInputTools({ className, ...props }: PromptInputToolsProps) {
  return (
    <div
      className={cn('flex min-w-0 items-center gap-1', className)}
      data-slot="prompt-input-tools"
      {...props}
    />
  );
}
