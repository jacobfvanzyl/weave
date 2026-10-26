import { useEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Cancel01Icon, Delete02Icon, Edit02Icon, Maximize01Icon, Minimize01Icon, MoreHorizontalIcon, PlusSignIcon } from '@hugeicons/core-free-icons';
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

export type TerminalPanelProps = {
  tabs: TerminalSummary[];
  /** The worktree's terminals without a tab here. */
  others: TerminalSummary[];
  active?: TerminalSummary;
  fontSize: number;
  /** iPad: whether it takes the thread's whole width; none on the iPhone, where it does always. */
  wide?: boolean;
  onSelect(id: string): void;
  onOpen(id: string): void;
  /** Closes a terminal's tab here, leaving the terminal running. */
  onCloseTab(id: string): void;
  onNew(): Promise<void>;
  /** Ends a terminal, for every device. */
  onEnd(id: string): Promise<void>;
  onRename(id: string, label?: string): Promise<void>;
  onWide?(wide: boolean): void;
  onFontSize(size: number): void;
  /** Hides the panel, or closes the iPhone's sheet. */
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
 * iPad it sits beside the thread, or takes its width; on the iPhone it's a sheet over it.
 */
export function TerminalPanel(props: TerminalPanelProps) {
  const { tabs, others, active, fontSize, wide, onSelect, onOpen, onCloseTab, onNew, onEnd, onRename, onWide, onFontSize, onDone, attach } = props;
  const [renaming, setRenaming] = useState(false);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [focusNext, setFocusNext] = useState<string>();
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
  const create = () => report(async () => {
    setCreating(true);
    try {
      await onNew();
      setFocusNext('new');
    } finally {
      setCreating(false);
    }
  });

  return (
    <section aria-label='Terminals' data-slot='terminal-panel' className='flex min-h-0 min-w-0 flex-1 flex-col'>
      <div className='flex h-9 shrink-0 items-center gap-1 border-b border-border bg-title-bar px-1.5'>
        {wide === undefined && <Button size='sm' variant='ghost' onClick={onDone}>Done</Button>}
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
                  <Button size='icon-xs' variant='ghost' aria-label={`Close the tab of ${name}`} className='-mr-1'
                    onClick={(event) => { event.stopPropagation(); onCloseTab(terminal.id); }}>
                    <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                  </Button>
                )}
              </div>
            );
          })}
        </div>
        <Button size='icon' variant='ghost' aria-label='New terminal' disabled={creating} onClick={() => void create()}>
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
                <DropdownMenuItem onClick={() => onCloseTab(active.id)}>
                  <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                  Close tab
                </DropdownMenuItem>
                <DropdownMenuItem variant='destructive' onClick={() => setEnding(true)}>
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                  End terminal…
                </DropdownMenuItem>
              </DropdownMenuGroup>
            )}
            {others.length > 0 && (
              <>
                {active && <DropdownMenuSeparator />}
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Also in this worktree</DropdownMenuLabel>
                  {others.map((terminal) => (
                    <DropdownMenuItem key={terminal.id} onClick={() => onOpen(terminal.id)}>
                      <StateMark terminal={terminal} />
                      Open {terminalName(terminal)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </>
            )}
            {(active || others.length > 0) && <DropdownMenuSeparator />}
            <DropdownMenuGroup>
              <DropdownMenuItem disabled={fontSize >= FONT_SIZE.max} onClick={() => onFontSize(fontSize + FONT_SIZE.step)}>Larger text</DropdownMenuItem>
              <DropdownMenuItem disabled={fontSize <= FONT_SIZE.min} onClick={() => onFontSize(fontSize - FONT_SIZE.step)}>Smaller text</DropdownMenuItem>
              {onWide && wide !== undefined && (
                <DropdownMenuItem onClick={() => onWide(!wide)}>
                  <HugeiconsIcon icon={wide ? Minimize01Icon : Maximize01Icon} strokeWidth={2} />
                  {wide ? 'Beside the thread' : 'Full width'}
                </DropdownMenuItem>
              )}
              {wide !== undefined && <DropdownMenuItem onClick={onDone}>Hide terminals</DropdownMenuItem>}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {error && (
        <Alert variant='destructive' className='m-2 w-auto'>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <p role='status' data-slot='terminal-notice' className='shrink-0 border-b border-border bg-muted/40 px-3 py-1 text-[0.6875rem]'>{notice}</p>
      )}
      {active
        ? (
          <TerminalSurface key='surface' terminal={active} fontSize={fontSize} attach={attach}
            focusOnAttach={focusNext !== undefined} onFocused={() => setFocusNext(undefined)}
            onNotice={(next) => setNotice(next.kind === 'clipboard'
              ? `${terminalName(active)} copied text to the clipboard.`
              : [next.title, next.body].filter(Boolean).join(': ') || `${terminalName(active)} sent a notification.`)} />
        )
        : (
          <div className='flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground'>
            <p>No terminal is open beside this thread.</p>
            <Button size='sm' variant='outline' disabled={creating} onClick={() => void create()}>New terminal</Button>
            {others.length > 0 && <p>Or open one of this worktree's from the menu.</p>}
          </div>
        )}
      <RenameTerminalDialog terminal={active} open={renaming} onOpenChange={setRenaming} onRename={onRename} />
      <AlertDialog open={ending} onOpenChange={setEnding}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End {active ? terminalName(active) : 'the terminal'}?</AlertDialogTitle>
            <AlertDialogDescription>Its shell and whatever runs in it stop, on every device.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant='destructive' onClick={() => { if (active) void report(() => onEnd(active.id)); }}>End</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
