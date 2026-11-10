// The Block types this app draws (ADR 0031, WVE-203): a name and a mark for a pane's strip, and
// what fills the pane. A Block of a type that isn't here shows its type and props as text, the
// floor every device has (ADR 0018).
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { type AppController, type OpenSession, type TerminalSummary, type ThreadSummary, threadController, threadKey } from '@/app/app-controller';
import { platform } from '@/app/platform';
import { ActivityIndicator } from '@/components/activity-indicator';
import { PathLabel } from '@/components/path-label';
import { ThreadView, askThread } from '@/components/thread-view';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import type { BlockAction } from '@/components/session/panes';
import type { SessionBlock } from '@/host/protocol';
import { cn } from '@/lib/utils';
import { TERMINAL_BLOCK, THREAD_BLOCK, terminalOf, threadOf } from '@/session/blocks';
import type { DeviceSurface } from '@/surface/use-surface';
import { FONT_SIZE, loadFontSize, onFontSize, setFontSize, terminalName, terminalState } from '@/terminal/terminals';
import { type TerminalNotice, useNativeTerminal } from '@/terminal/use-native-terminal';

/** What a Block is drawn with: the app, its Session, and how it stands in the layout. */
export type BlockContext = {
  controller: AppController;
  session: OpenSession;
  /** It has the keyboard. */
  focused: boolean;
  /** Shows another thread of the Session, as the one a thread continues in. */
  onOpenThread(key: string): void;
  /** Takes the Block out of the layout, as for one whose thread or terminal is gone. */
  onRemove(): void;
  /** The iPhone's Surface, for the thread in front (WVE-183). */
  surface?: DeviceSurface;
  onSwipeBack?(): void;
};

export type BlockType = {
  /** What the pane's strip calls the Block. */
  title(block: SessionBlock, context: Pick<BlockContext, 'controller' | 'session'>): string;
  /** A mark of what it's doing, beside its name. */
  mark?(block: SessionBlock, context: Pick<BlockContext, 'controller' | 'session'>): ReactNode;
  /** What its rail's menu offers: what's the type's own, every Block having the rest as icons. */
  actions?(block: SessionBlock, context: BlockContext): BlockAction[];
  Body(props: { block: SessionBlock; context: BlockContext }): ReactNode;
};

const Notice = ({ children, action }: { children: ReactNode; action?: ReactNode }) => (
  <div className='flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground'>
    <p>{children}</p>
    {action}
  </div>
);

const summaryOf = (block: SessionBlock, { controller, session }: Pick<BlockContext, 'controller' | 'session'>): ThreadSummary | undefined => {
  const threadId = threadOf(block);
  return threadId ? controller.model.threads.find(({ key }) => key === threadKey(session.hostId, threadId)) : undefined;
};

const thread: BlockType = {
  title: (block, context) => summaryOf(block, context)?.title || 'New thread',
  mark: (block, context) => {
    const summary = summaryOf(block, context);
    return <ActivityIndicator activity={summary?.activity} unread={summary ? context.controller.model.unread.has(summary.key) : false} />;
  },
  // Closing the thread is the rail's close; what else is a thread's own is here.
  actions: (block, context) => {
    const summary = summaryOf(block, context);
    if (!summary) return [];
    const host = context.controller.model.hosts.find(({ id }) => id === summary.hostId);
    const { surface } = context;
    return [
      { title: 'Thread status', run: () => askThread(summary.key, 'status') },
      ...(surface?.status.available
        ? [{ title: surface.status.enabled ? 'Turn the Surface off' : 'Show on the Surface', run: () => surface.setEnabled(!surface.status.enabled) }]
        : []),
      ...(host?.canRename && summary.state === 'open' ? [{ title: 'Rename thread…', run: () => askThread(summary.key, 'rename') }] : []),
      { title: 'Delete thread…', destructive: true, run: () => askThread(summary.key, 'delete') },
    ];
  },
  Body({ block, context }) {
    const { controller, session } = context;
    const threadId = threadOf(block);
    const key = threadId ? threadKey(session.hostId, threadId) : undefined;
    const open = key ? controller.model.open?.[key] : undefined;
    const host = controller.model.hosts.find(({ id }) => id === session.hostId);
    if (!key) return <Notice>This Block names no thread.</Notice>;
    if (open) {
      return (
        <ThreadView controller={threadController(controller, key)} thread={open} chrome='block'
          onOpenThread={context.onOpenThread} surface={context.surface} onSwipeBack={context.onSwipeBack} onDeleted={context.onRemove} />
      );
    }
    if (controller.model.error) {
      return <Notice action={<Button size='sm' variant='outline' onClick={context.onRemove}>Remove from the layout</Button>}>{controller.model.error}</Notice>;
    }
    if (host && host.status !== 'connected') return <Notice>{host.name} isn't connected.</Notice>;
    return <Notice><Spinner className='mr-1.5 inline size-3' />Opening the thread…</Notice>;
  },
};

/** A dot and words for what a terminal is doing. */
export function TerminalMark({ terminal }: { terminal: TerminalSummary }) {
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

/** A terminal drawn natively beneath the page, at this element's frame (ADR 0022): the iPad and iPhone. */
function NativeTerminal({ terminal, attach, focused }: {
  terminal: TerminalSummary;
  attach: AppController['actions']['attachTerminal'];
  focused: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const fontSize = useSyncExternalStore(onFontSize, loadFontSize);
  const [notice, setNotice] = useState<TerminalNotice>();
  const { state, focus, retry } = useNativeTerminal(host, { terminalId: terminal.id, fontSize, attach, onNotice: setNotice });
  useEffect(() => {
    if (state.kind === 'attached' && focused) focus();
  }, [state.kind, focused]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  const status = state.kind === 'connecting'
    ? <><Spinner className='size-3' /> Connecting to the terminal…</>
    : state.kind === 'attached' && state.restore === 'vt'
      ? "This Host's terminals use another Ghostty, so the history from before attaching isn't here."
      : state.kind === 'exited'
        ? `The terminal ended${state.exitCode !== undefined ? ` with exit code ${state.exitCode}` : ''}.`
        : state.kind === 'failed'
          ? state.message
          : notice?.kind === 'notification'
            ? [notice.title, notice.body].filter(Boolean).join(': ')
            : notice?.kind === 'clipboard'
              ? 'Copied to the clipboard.'
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
      {/* The native terminal shows through this element, which stays transparent, as do its ancestors (`styles.css`). */}
      <div ref={host} data-slot='native-terminal' data-native-layered='true' aria-label={`Terminal ${terminalName(terminal)}`}
        className='min-h-0 min-w-0 flex-1 overflow-hidden' />
    </>
  );
}

/** A terminal as text, where the device doesn't draw them: what it is and what it's running. */
function TerminalText({ terminal }: { terminal: TerminalSummary }) {
  const state = terminalState(terminal);
  return (
    <div data-slot='terminal-text' className='flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 p-4 text-center text-xs text-muted-foreground'>
      <p className='font-mono text-sm text-foreground'>{terminalName(terminal)}</p>
      {terminal.pwd && <PathLabel path={terminal.pwd} />}
      <p>{state.kind === 'idle' ? (terminal.process ? `Running ${terminal.process}.` : 'Nothing is running in it.') : `${state.text}.`}</p>
      <p className='max-w-xs'>This device doesn't draw terminals yet, so it shows what this one is doing. It runs on, and draws on the iPad and iPhone.</p>
    </div>
  );
}

const terminalIn = (block: SessionBlock, session: OpenSession) => session.terminals?.find(({ id }) => id === terminalOf(block));

// The terminal being renamed, by id: its Block's menu asks, and its Block shows the dialog.
let renaming: string | undefined;
const renameListeners = new Set<() => void>();
const rename = (id?: string) => {
  renaming = id;
  for (const listener of renameListeners) listener();
};
const onRename = (listener: () => void) => {
  renameListeners.add(listener);
  return () => { renameListeners.delete(listener); };
};

/** Names a terminal on every device, or without a name clears it. */
function RenameTerminalDialog({ terminal, onRename: save }: { terminal: TerminalSummary; onRename(id: string, label?: string): Promise<void> }) {
  const open = useSyncExternalStore(onRename, () => renaming === terminal.id);
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    setLabel(terminal.label ?? '');
    setError(undefined);
    // Starts from the name it has when it opens.
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) rename(undefined); }}>
      <DialogContent className='w-[min(24rem,calc(100%-2rem))] max-w-none sm:max-w-sm'>
        <DialogHeader>
          <DialogTitle>Rename terminal</DialogTitle>
          <DialogDescription>Every device shows the name. Without one, it's named after its title or its directory.</DialogDescription>
        </DialogHeader>
        <form aria-label='Rename terminal' className='grid gap-3' onSubmit={async (event) => {
          event.preventDefault();
          setError(undefined);
          try {
            await save(terminal.id, label);
            rename(undefined);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        }}>
          <Input aria-label='Name' autoFocus maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} />
          {error && <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert>}
          <DialogFooter>
            <Button type='submit'>Rename</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const terminal: BlockType = {
  title: (block, { session }) => {
    const found = terminalIn(block, session);
    return found ? terminalName(found) : 'Terminal';
  },
  mark: (block, { session }) => {
    const found = terminalIn(block, session);
    return found ? <TerminalMark terminal={found} /> : null;
  },
  actions: (block, { session }) => {
    const found = terminalIn(block, session);
    if (!found) return [];
    const size = loadFontSize();
    return [
      { title: 'Rename terminal…', run: () => rename(found.id) },
      // Every terminal on this device, where the device draws them.
      ...(platform().drawsTerminals
        ? [
            ...(size < FONT_SIZE.max ? [{ title: 'Larger text', run: () => setFontSize(size + FONT_SIZE.step) }] : []),
            ...(size > FONT_SIZE.min ? [{ title: 'Smaller text', run: () => setFontSize(size - FONT_SIZE.step) }] : []),
          ]
        : []),
    ];
  },
  Body({ block, context }) {
    const { session, controller } = context;
    const found = terminalIn(block, session);
    if (!session.terminals) return <Notice><Spinner className='mr-1.5 inline size-3' />Listing the terminals…</Notice>;
    if (!found) return <Notice action={<Button size='sm' variant='outline' onClick={context.onRemove}>Remove from the layout</Button>}>This terminal has ended.</Notice>;
    return (
      <>
        {platform().drawsTerminals
          ? <NativeTerminal terminal={found} attach={controller.actions.attachTerminal} focused={context.focused} />
          : <TerminalText terminal={found} />}
        <RenameTerminalDialog terminal={found} onRename={controller.actions.renameTerminal} />
      </>
    );
  },
};

/** The text floor: a Block of a type this app doesn't have, as its type and props. */
const unknown: BlockType = {
  title: (block) => block.type,
  Body({ block }) {
    return (
      <div data-slot='unknown-block' className='min-h-0 flex-1 overflow-auto p-3 text-xs'>
        <p className='text-muted-foreground'>This app has no Block of this type, so here is what it holds.</p>
        <p className='mt-2 font-mono text-foreground'>{block.type}</p>
        <pre className='mt-1 whitespace-pre-wrap break-words font-mono text-[0.6875rem] text-muted-foreground'>{JSON.stringify(block.props ?? {}, null, 2)}</pre>
      </div>
    );
  },
};

const types = new Map<string, BlockType>([[THREAD_BLOCK, thread], [TERMINAL_BLOCK, terminal]]);

/** Adds a Block type, or replaces one: its reverse-DNS name, and how it's drawn. */
export const registerBlockType = (type: string, definition: BlockType) => { types.set(type, definition); };

/** How a Block's type is drawn; the text floor for one the app doesn't have. */
export const blockType = (type: string): BlockType => types.get(type) ?? unknown;
