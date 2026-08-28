import type { KeyboardEvent, ReactNode } from 'react';
import { Add01Icon, Cancel01Icon, TerminalIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { AlphaTerminalsModel } from '@/app/use-alpha-terminals';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { XtermTerminalView } from './xterm-terminal-view';

export function TerminalPane({
  model,
  disabled,
  className,
  footerActions,
  onCreate,
  onSelect,
  onClose,
  onRetryControl,
  onInput,
  onResize,
}: {
  model: AlphaTerminalsModel;
  disabled: boolean;
  className?: string;
  footerActions?: ReactNode;
  onCreate?(): Promise<void> | void;
  onSelect?(terminalId: string): Promise<void> | void;
  onClose?(terminalId: string): Promise<void> | void;
  onRetryControl?(): Promise<void> | void;
  onInput?(data: string): Promise<void> | void;
  onResize?(cols: number, rows: number): Promise<void> | void;
}) {
  const readOnly = model.attachmentMode !== 'control';
  const activateOnKeyboard = (
    event: KeyboardEvent<HTMLDivElement>,
    terminalId: string,
  ) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    void onSelect?.(terminalId);
  };

  return (
    <section
      aria-label='Terminal Pane'
      data-slot='terminal-pane'
      className={cn('flex min-h-0 min-w-0 flex-1 flex-col bg-[#1e1e2e]', className)}
    >
      <header className='flex h-9 shrink-0 items-stretch border-b border-border bg-title-bar'>
        <div role='tablist' aria-label='Terminals' className='flex min-w-0 flex-1 overflow-x-auto'>
          {model.tabs.map((terminal) => {
            const active = terminal.terminalId === model.activeTerminalId;
            return (
              <div
                key={terminal.terminalId}
                role='tab'
                tabIndex={active ? 0 : -1}
                aria-selected={active}
                aria-label={terminal.title}
                className={cn(
                  'group flex min-w-32 max-w-56 cursor-default items-center gap-2 border-r border-border px-2 text-xs text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
                  active && 'bg-[#1e1e2e] text-foreground',
                )}
                onClick={() => void onSelect?.(terminal.terminalId)}
                onKeyDown={(event) => activateOnKeyboard(event, terminal.terminalId)}
              >
                <HugeiconsIcon icon={TerminalIcon} strokeWidth={1.75} className='size-3.5 shrink-0' />
                <span className='min-w-0 flex-1 truncate'>{terminal.title}</span>
                <Button
                  type='button'
                  size='icon-xs'
                  variant='ghost'
                  aria-label={`Close ${terminal.title}`}
                  className='size-5 shrink-0 opacity-60 hover:opacity-100'
                  disabled={disabled || !active || model.attachmentMode !== 'control'}
                  onClick={(event) => {
                    event.stopPropagation();
                    void onClose?.(terminal.terminalId);
                  }}
                >
                  <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                </Button>
              </div>
            );
          })}
        </div>
        <Button
          type='button'
          size='icon'
          variant='ghost'
          aria-label='New Terminal'
          className='h-full w-9 shrink-0 rounded-none border-l border-border'
          disabled={disabled || !model.supported}
          onClick={() => void onCreate?.()}
        >
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
        </Button>
      </header>

      <div className='relative flex min-h-0 flex-1 flex-col'>
        {model.loading && (
          <div className='absolute inset-0 z-10 flex items-center justify-center bg-[#1e1e2e]/80'>
            <Spinner className='text-primary' />
          </div>
        )}
        {(model.readOnlyReason || readOnly && model.attachmentId) && (
          <div
            role='status'
            className='flex min-h-8 shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-3 text-xs text-muted-foreground'
          >
            <span className='min-w-0 flex-1 truncate'>
              {model.readOnlyReason ?? 'Read-only Terminal attachment.'}
            </span>
            <Button
              type='button'
              size='xs'
              variant='outline'
              disabled={disabled}
              onClick={() => void onRetryControl?.()}
            >
              Request Control
            </Button>
          </div>
        )}
        {model.error && !model.attachmentId
          ? (
            <div
              role='alert'
              className='flex flex-1 items-center justify-center p-4 text-center text-sm text-muted-foreground'
            >
              {model.error}
            </div>
          )
          : (
            <XtermTerminalView
              data={model.data}
              dataEpoch={model.dataEpoch}
              dataOffset={model.dataOffset}
              readOnly={readOnly}
              onInput={(data) => void onInput?.(data)}
              onResize={(cols, rows) => void onResize?.(cols, rows)}
            />
          )}
      </div>

      <footer
        data-slot='terminal-bottom-rail'
        className='flex h-[var(--bottom-rail-height)] shrink-0 items-center border-t border-border bg-status-bar'
      >
        {model.error && model.attachmentId && (
          <span role='alert' className='min-w-0 flex-1 truncate px-2 text-xs text-destructive'>
            {model.error}
          </span>
        )}
        {footerActions && <div className='ml-auto'>{footerActions}</div>}
      </footer>
    </section>
  );
}
