import { useEffect, useRef, useState, type ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowDown01Icon, Cancel01Icon, Delete02Icon, Edit02Icon, Maximize01Icon, Minimize01Icon, MoreHorizontalIcon, PlusSignIcon } from '@hugeicons/core-free-icons';
import type { TerminalSummary, TerminalTicket } from '@/app/app-controller';
import { FONT_SIZE, terminalName, terminalState } from '@/terminal/terminal-layout';
import { type TerminalNotice, useNativeTerminal } from '@/terminal/use-native-terminal';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

export type TerminalPanelProps = {
  /** The worktree's terminals, a tab each. */
  tabs: TerminalSummary[];
  active?: TerminalSummary;
  fontSize: number;
  /**
   * `beside` the thread or `wide` over its width, on the iPad, where the tabs share the thread's
   * top rail; or a `pane` the iPhone swaps the thread's chat for, under its header.
   */
  placement: 'beside' | 'wide' | 'pane';
  /** What the rail shows before the tabs and after them, at full width, where the thread's header doesn't show. */
  leading?: ReactNode;
  trailing?: ReactNode;
  onSelect(id: string): void;
  /** Starts a terminal, which is a tab on every device. */
  onNew(): void;
  /** A terminal is starting. */
  starting?: boolean;
  /** Why the last one didn't start. */
  startError?: string;
  /** A terminal just started here, which takes the keyboard once attached. */
  focus?: string;
  onFocused?(): void;
  /** Ends a terminal, which closes its tab on every device. */
  onClose(id: string): Promise<void>;
  onRename(id: string, label?: string): Promise<void>;
  onWide?(wide: boolean): void;
  onFontSize(size: number): void;
  /** Hides the panel. */
  onDone(): void;
  attach(id: string): Promise<TerminalTicket>;
};

/** A dot and words for what a tab's terminal is doing. */
function StateMark({ terminal }: { terminal: TerminalSummary }) {
  const state = terminalState(terminal);
  if (state.kind === 'idle') return null;
  const color = state.kind === 'running'
    ? 'bg-primary'
    : state.kind === 'exited'
      ? state.code === 0 ? 'bg-success' : 'bg-destructive'
      : { working: 'bg-primary', blocked: 'bg-warning', error: 'bg-destructive', done: 'bg-success' }[state.state];
  return (
    <span className='inline-flex shrink-0 items-center' title={state.text}>
      <span aria-hidden='true' className={cn('size-1.5 rounded-full', color, (state.kind === 'running' || (state.kind === 'status' && state.state === 'working')) && 'animate-pulse')} />
      <span className='sr-only'>{state.text}</span>
    </span>
  );
}

/** The iPhone's tabs, which a portrait screen has no room for: a picker in the pane's own rail. */
function TerminalPicker({ tabs, active, onSelect }: {
  tabs: TerminalSummary[];
  active?: TerminalSummary;
  onSelect(id: string): void;
}) {
  const name = active ? terminalName(active) : undefined;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={
        <Button size='sm' variant='ghost' className='min-w-0 flex-1 justify-start'
          aria-label={name ? `Terminals, showing ${name}` : 'Terminals'} disabled={tabs.length === 0} />
      }>
        {active && <StateMark terminal={active} />}
        <span className='min-w-0 truncate'>{name ?? 'No terminals'}</span>
        <HugeiconsIcon data-icon='inline-end' icon={ArrowDown01Icon} strokeWidth={2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='start'>
        <DropdownMenuRadioGroup value={active?.id} onValueChange={(id) => onSelect(String(id))}>
          {tabs.map((terminal) => (
            <DropdownMenuRadioItem key={terminal.id} value={terminal.id} closeOnClick>
              <StateMark terminal={terminal} />
              {terminalName(terminal)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RenameTerminalDialog({ terminal, open, onOpenChange, onRename }: {
  terminal?: TerminalSummary;
  open: boolean;
  onOpenChange(open: boolean): void;
  onRename(id: string, label?: string): Promise<void>;
}) {
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setLabel(terminal?.label ?? '');
    setError(undefined);
    // Starts from the name it has when it opens.
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='w-[min(28rem,calc(100%-2rem))] max-w-none sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>Rename terminal</DialogTitle>
          <DialogDescription>Every device shows the new name. Leave it empty to show the terminal's own title.</DialogDescription>
        </DialogHeader>
        <form aria-label='Rename terminal' className='grid gap-3' onSubmit={async (event) => {
          event.preventDefault();
          if (!terminal) return;
          setSaving(true);
          setError(undefined);
          try {
            await onRename(terminal.id, label.trim() || undefined);
            onOpenChange(false);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setSaving(false);
          }
        }}>
          <Input aria-label='Name' autoFocus maxLength={100} value={label} onChange={(event) => setLabel(event.target.value)} />
          {error && <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert>}
          <DialogFooter>
            <Button type='submit' disabled={saving}>{saving ? 'Renaming…' : 'Rename'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** What the native terminal says about its stream, and the surface it draws under. */
function TerminalSurface({ terminal, fontSize, attach, focusOnAttach, onFocused, onNotice }: {
  terminal: TerminalSummary;
  fontSize: number;
  attach(id: string): Promise<TerminalTicket>;
  /** Takes the keyboard once attached, as a terminal just made does. */
  focusOnAttach: boolean;
  onFocused(): void;
  onNotice(notice: TerminalNotice): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const { state, focus, retry } = useNativeTerminal(host, { terminalId: terminal.id, fontSize, attach, onNotice });
  useEffect(() => {
    if (state.kind !== 'attached' || !focusOnAttach) return;
    focus();
    onFocused();
  }, [state.kind, focusOnAttach]);
  const status = state.kind === 'connecting'
    ? <><Spinner className='size-3' /> Connecting to the terminal…</>
    : state.kind === 'attached' && state.restore === 'vt'
      ? "This Host's terminals use another Ghostty, so the history from before attaching isn't here."
      : state.kind === 'exited'
        ? `The terminal ended${state.exitCode !== undefined ? ` with exit code ${state.exitCode}` : ''}.`
        : state.kind === 'failed'
          ? state.message
          : undefined;
  return (
    <>
      {status && (
        <p role='status' data-slot='terminal-status'
          className='flex shrink-0 items-center gap-1.5 border-b border-border bg-muted/40 px-3 py-1 text-[0.6875rem] text-muted-foreground'>
          {status}
          {state.kind === 'failed' && <Button size='xs' variant='outline' className='ml-auto' onClick={retry}>Try again</Button>}
        </p>
      )}
      {state.kind === 'unavailable'
        ? (
          <div className='flex min-h-0 flex-1 items-center justify-center p-4 text-center text-xs text-muted-foreground'>
            Terminals draw in the iOS app.
          </div>
        )
        : (
          // The native terminal shows through this element, which stays transparent, as do its
          // ancestors (`styles.css`).
          <div ref={host} data-slot='native-terminal' data-native-layered='true' aria-label={`Terminal ${terminalName(terminal)}`}
            className='min-h-0 min-w-0 flex-1 overflow-hidden' />
        )}
    </>
  );
}

/**
 * A thread's terminals: a tab for each, the one in front drawn natively beneath the page. On the
 * iPad it sits beside the thread, or takes its width, its tabs in the thread's top rail; on the
 * iPhone it takes the chat's place under the thread's header.
 */
export function TerminalPanel(props: TerminalPanelProps) {
  const { tabs, active, fontSize, placement, leading, trailing, onSelect, onNew, starting, startError, focus, onFocused, onClose, onRename, onWide, onFontSize, onDone, attach } = props;
  const rail = placement !== 'pane';
  const [renaming, setRenaming] = useState(false);
  // The terminal whose tab is closing, which ends it, once confirmed.
  const [closing, setClosing] = useState<TerminalSummary>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  const report = async (action: () => Promise<void>) => {
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <section aria-label='Terminals' data-slot='terminal-panel' className='flex min-h-0 min-w-0 flex-1 flex-col'>
      <div data-slot={rail ? 'terminal-rail' : 'terminal-bar'}
        className={cn('flex shrink-0 items-center gap-1 border-b border-border bg-title-bar px-1.5',
          rail
            // The thread's top rail goes on over the terminals, at its height (`SessionHeader`).
            ? 'h-[calc(env(safe-area-inset-top)+var(--title-bar-height))] pt-[env(safe-area-inset-top)]'
            : 'h-9',
          leading && 'pl-[max(env(safe-area-inset-left),0.5rem)]')}>
        {leading}
        {rail
          ? (
            <div role='tablist' aria-label='Terminals' className='flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto'>
              {tabs.map((terminal) => {
                const selected = terminal.id === active?.id;
                const name = terminalName(terminal);
                return (
                  <div key={terminal.id} role='tab' aria-selected={selected} tabIndex={selected ? 0 : -1}
                    className={cn('flex h-7 max-w-48 shrink-0 cursor-default items-center gap-1.5 rounded-md px-2 text-xs',
                      selected ? 'bg-background font-medium text-foreground' : 'text-muted-foreground')}
                    onClick={() => onSelect(terminal.id)}
                    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect(terminal.id); }}>
                    <StateMark terminal={terminal} />
                    <span className='min-w-0 truncate'>{name}</span>
                    {selected && (
                      <Button size='icon-xs' variant='ghost' aria-label={`Close ${name}`} className='-mr-1'
                        onClick={(event) => { event.stopPropagation(); setClosing(terminal); }}>
                        <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )
          : <TerminalPicker tabs={tabs} active={active} onSelect={onSelect} />}
        <Button size='icon' variant='ghost' aria-label='New terminal' disabled={starting} onClick={onNew}>
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size='icon' variant='ghost' aria-label='Terminal actions' />}>
            <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end'>
            {active && (
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => setRenaming(true)}>
                  <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} />
                  Rename terminal…
                </DropdownMenuItem>
                <DropdownMenuItem variant='destructive' onClick={() => setClosing(active)}>
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                  Close terminal…
                </DropdownMenuItem>
              </DropdownMenuGroup>
            )}
            {active && <DropdownMenuSeparator />}
            <DropdownMenuGroup>
              <DropdownMenuItem disabled={fontSize >= FONT_SIZE.max} onClick={() => onFontSize(fontSize + FONT_SIZE.step)}>Larger text</DropdownMenuItem>
              <DropdownMenuItem disabled={fontSize <= FONT_SIZE.min} onClick={() => onFontSize(fontSize - FONT_SIZE.step)}>Smaller text</DropdownMenuItem>
              {onWide && rail && (
                <DropdownMenuItem onClick={() => onWide(placement !== 'wide')}>
                  <HugeiconsIcon icon={placement === 'wide' ? Minimize01Icon : Maximize01Icon} strokeWidth={2} />
                  {placement === 'wide' ? 'Beside the thread' : 'Full width'}
                </DropdownMenuItem>
              )}
              {rail && <DropdownMenuItem onClick={onDone}>Hide terminals</DropdownMenuItem>}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {trailing}
      </div>
      {(error || startError) && (
        <Alert variant='destructive' className='m-2 w-auto'>
          <AlertDescription>{error ?? startError}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <p role='status' data-slot='terminal-notice' className='shrink-0 border-b border-border bg-muted/40 px-3 py-1 text-[0.6875rem]'>{notice}</p>
      )}
      {active
        ? (
          <TerminalSurface key='surface' terminal={active} fontSize={fontSize} attach={attach}
            focusOnAttach={focus === active.id} onFocused={() => onFocused?.()}
            onNotice={(next) => setNotice(next.kind === 'clipboard'
              ? `${terminalName(active)} copied text to the clipboard.`
              : [next.title, next.body].filter(Boolean).join(': ') || `${terminalName(active)} sent a notification.`)} />
        )
        : (
          // The pane shows only with a terminal, or while one starts.
          <div className='flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground'>
            {startError
              ? <Button size='sm' variant='outline' onClick={onNew}>Try again</Button>
              : <><Spinner className='size-4' /> Starting a terminal…</>}
          </div>
        )}
      <RenameTerminalDialog terminal={active} open={renaming} onOpenChange={setRenaming} onRename={onRename} />
      <AlertDialog open={closing !== undefined} onOpenChange={(open) => { if (!open) setClosing(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close {closing ? terminalName(closing) : 'the terminal'}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its shell and whatever runs in it stop, and its tab closes on every device.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant='destructive' onClick={() => {
              setClosing(undefined);
              if (closing) void report(() => onClose(closing.id));
            }}>
              Close terminal
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
