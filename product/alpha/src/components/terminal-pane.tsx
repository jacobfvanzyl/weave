import { compactTerminalTitle } from '@/lib/display-path';
import { TerminalTitle } from './path-label';
import type { KeyboardEvent, ReactNode } from 'react';
import {
  Add01Icon,
  ArrowExpand01Icon,
  ArrowShrink01Icon,
  Cancel01Icon,
  TerminalIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { AlphaTerminalsModel } from '@/app/use-alpha-terminals';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { isElectronDesktop } from '@/lib/platform';
import { TerminalView } from './terminal-view';

export function TerminalPane({
  model,
  disabled,
  className,
  footerActions,
  showFooter = true,
  maximized = false,
  onCreate,
  onSelect,
  onClose,
  onToggleMaximized,
  onRetryControl,
  onInput,
  onResize,
}: {
  model: AlphaTerminalsModel;
  disabled: boolean;
  className?: string;
  footerActions?: ReactNode;
  showFooter?: boolean;
  maximized?: boolean;
  onCreate?(): Promise<void> | void;
  onSelect?(terminalId: string): Promise<void> | void;
  onClose?(terminalId: string): Promise<void> | void;
  onToggleMaximized?(): void;
  onRetryControl?(): Promise<void> | void;
  onInput?(data: string | Uint8Array): Promise<void> | void;
  onResize?(cols: number, rows: number): Promise<void> | void;
}) {
  const readOnly = model.attachmentMode !== 'shared';
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
      <header
        data-slot='terminal-top-rail'
        data-hover-actions={isElectronDesktop() || undefined}
        className='flex h-[var(--rail-height)] shrink-0 items-stretch bg-title-bar'
      >
        <div className='scrollbar-none min-w-0 flex-1 overflow-x-auto overflow-y-hidden'>
          <div
            role='tablist'
            aria-label='Terminals'
            className='flex h-full w-max min-w-full items-stretch'
          >
            {model.tabs.map((terminal) => {
              const active = terminal.terminalId === model.activeTerminalId;
              return (
                <div
                  key={terminal.terminalId}
                  role='tab'
                  tabIndex={active ? 0 : -1}
                  aria-selected={active}
                  aria-label={compactTerminalTitle(terminal.title)}
                  data-slot='terminal-tab'
                  data-active={active ? '' : undefined}
                  className={cn(
                    'group flex min-w-32 max-w-56 cursor-default items-center gap-2 border-r border-border px-2 text-xs text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
                    active
                      ? 'bg-[#1e1e2e] text-foreground'
                      : 'border-b border-border',
                  )}
                  onClick={() => void onSelect?.(terminal.terminalId)}
                  onKeyDown={(event) => activateOnKeyboard(event, terminal.terminalId)}
                >
                  <HugeiconsIcon icon={TerminalIcon} strokeWidth={1.75} className='size-[16px] shrink-0' />
                  <TerminalTitle title={terminal.title} className='flex-1' />
                  <Button
                    type='button'
                    size='rail'
                    variant='ghost'
                    aria-label={`Close ${compactTerminalTitle(terminal.title)}`}
                    className='shrink-0 opacity-60 hover:opacity-100'
                    disabled={disabled || !active || model.attachmentMode !== 'shared'}
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
            <span
              data-slot='terminal-tab-rail-fill'
              aria-hidden='true'
              className='h-full min-w-0 flex-1 border-b border-border'
            />
          </div>
        </div>
        <div
          data-slot='terminal-actions'
          className='flex h-full shrink-0 border-b border-l border-border'
        >
          <Button
            type='button'
            size='rail'
            variant='ghost'
            aria-label='New Terminal'
            className='h-full w-11 shrink-0 rounded-none border-0'
            disabled={disabled || !model.supported}
            onClick={() => void onCreate?.()}
          >
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
          </Button>
          <Button
            type='button'
            size='rail'
            variant='ghost'
            aria-label={maximized ? 'Restore Terminal' : 'Maximize Terminal'}
            aria-pressed={maximized}
            title={maximized ? 'Restore Terminal' : 'Maximize Terminal'}
            className='h-full w-11 shrink-0 rounded-none border-0'
            onClick={onToggleMaximized}
          >
            <HugeiconsIcon
              data-symbol={maximized ? 'collapse-terminal' : 'expand-terminal'}
              icon={maximized ? ArrowShrink01Icon : ArrowExpand01Icon}
              strokeWidth={2}
            />
          </Button>
        </div>
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
        {!showFooter && model.error && model.attachmentId && (
          <div role='alert' className='shrink-0 border-b border-border px-3 py-1 text-xs text-destructive'>
            {model.error}
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
            <TerminalView
              output={model.output}
              readOnly={readOnly}
              onInput={(data) => void onInput?.(data)}
              onResize={(cols, rows) => void onResize?.(cols, rows)}
            />
          )}
      </div>

      {showFooter && (
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
      )}
    </section>
  );
}
