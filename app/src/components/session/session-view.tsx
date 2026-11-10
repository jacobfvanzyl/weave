// A Session on screen (ADR 0031, WVE-203): its tabs, and in the tab in front its panes of Blocks.
// The Mac and the iPad lay a tab out as the document has it; the iPhone shows one Block at a
// time, a tab's Blocks as chips to move between. What changes the layout goes to the Host for
// every device; which tab and Block are in front, focus and zoom are this device's own.
import { useEffect, useMemo, useRef, useState, type ReactNode, type TouchEvent } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon, Cancel01Icon, ComputerTerminal01Icon, BubbleChatIcon } from '@hugeicons/core-free-icons';
import { type AppController, type CreatedThread, type LayoutChange, type OpenSession, type TerminalSummary, type ThreadSummary, threadKey } from '@/app/app-controller';
import { useCommand } from '@/app/commands';
import { type NewThreadTarget, NewThreadDialog } from '@/components/new-thread-dialog';
import { type BlockContext, TerminalMark, blockType } from '@/components/session/blocks';
import { type PaneActions, BlockRail, TabPanes } from '@/components/session/panes';
import { ThreadHeader } from '@/components/thread-view';
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { SessionBlock, SessionTab } from '@/host/protocol';
import { cn } from '@/lib/utils';
import { blockOfTerminal, blockOfThread, place, terminalBlock, terminalOf, threadBlock, threadOf } from '@/session/blocks';
import {
  FLOATING_FRAME,
  type Side,
  type Target,
  addTab,
  findBlock,
  frameBlock,
  layoutBlocks,
  newTab,
  paneBeside,
  panes,
  placeBlock,
  prune,
  removeBlock,
  removeTab,
  renameTab,
  resizeSplit,
  tabBlocks,
} from '@/session/layout';
import { directoryName } from '@/session/sessions';
import { blockInFront, focusBlock, focusedBlock, showTab, tabInFront, toggleZoom, trimView, useSessionView, zoomedIn, blocksShown } from '@/session/view';
import type { DeviceSurface } from '@/surface/use-surface';
import { terminalBusy, terminalName, terminalsInOrder } from '@/terminal/terminals';

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

/** What a new Block shows: a thread or terminal to start, or one the Session has that no Block shows. */
function NewBlockDialog({ open, onOpenChange, threads, closed, terminals, canTerminals, onNewThread, onNewTerminal, onThread, onTerminal }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The Session's open threads no Block shows, and its closed ones. */
  threads: ThreadSummary[];
  closed: ThreadSummary[];
  terminals: TerminalSummary[];
  canTerminals: boolean;
  onNewThread(): void;
  onNewTerminal(): void;
  onThread(thread: ThreadSummary): void;
  onTerminal(terminal: TerminalSummary): void;
}) {
  const row = 'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted focus-visible:bg-muted outline-none';
  const none = threads.length === 0 && terminals.length === 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='w-[min(26rem,calc(100%-2rem))] max-w-none sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>New Block</DialogTitle>
          <DialogDescription>What it shows: something new, or a thread or terminal of this Session that no Block shows. It's placed here on every device.</DialogDescription>
        </DialogHeader>
        <div className='grid max-h-[60dvh] gap-3 overflow-y-auto'>
          <div role='group' aria-label='New' className='grid gap-0.5'>
            <button type='button' className={row} onClick={onNewThread}>
              <HugeiconsIcon icon={BubbleChatIcon} strokeWidth={2} className='size-3.5 text-icon-muted' />
              New thread…
            </button>
            {canTerminals && (
              <button type='button' className={row} onClick={onNewTerminal}>
                <HugeiconsIcon icon={ComputerTerminal01Icon} strokeWidth={2} className='size-3.5 text-icon-muted' />
                New terminal
              </button>
            )}
          </div>
          <div role='group' aria-label='Not shown' className='grid gap-0.5'>
            <p className='px-2 text-[0.6875rem] font-medium text-muted-foreground'>Not shown</p>
            {none && <p className='px-2 py-1 text-[0.6875rem] text-muted-foreground'>Every open thread and terminal here has a Block.</p>}
            {threads.map((thread) => (
              <button key={thread.key} type='button' className={row} onClick={() => onThread(thread)}>
                <HugeiconsIcon icon={BubbleChatIcon} strokeWidth={2} className='size-3.5 shrink-0 text-icon-muted' />
                <span className='min-w-0 flex-1 truncate'>{thread.title || 'New thread'}</span>
                <span className='shrink-0 text-[0.6875rem] text-muted-foreground'>{thread.activity === 'waiting' ? 'waiting on you' : thread.activity === 'running' ? 'running' : thread.agentName}</span>
              </button>
            ))}
            {terminals.map((terminal) => (
              <button key={terminal.id} type='button' className={row} onClick={() => onTerminal(terminal)}>
                <HugeiconsIcon icon={ComputerTerminal01Icon} strokeWidth={2} className='size-3.5 shrink-0 text-icon-muted' />
                <span className='min-w-0 flex-1 truncate'>{terminalName(terminal)}</span>
                <TerminalMark terminal={terminal} />
              </button>
            ))}
          </div>
          {closed.length > 0 && (
            <div role='group' aria-label='Closed threads' className='grid gap-0.5'>
              <p className='px-2 text-[0.6875rem] font-medium text-muted-foreground'>Closed threads, which open again here</p>
              {closed.map((thread) => (
                <button key={thread.key} type='button' className={row} onClick={() => onThread(thread)}>
                  <HugeiconsIcon icon={BubbleChatIcon} strokeWidth={2} className='size-3.5 shrink-0 text-icon-muted' />
                  <span className='min-w-0 flex-1 truncate'>{thread.title || 'New thread'}</span>
                  <span className='shrink-0 text-[0.6875rem] text-muted-foreground'>{thread.agentName}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A tab's name, typed in the tab itself: Return keeps it, Escape leaves it as it was. */
function TabNameInput({ tab, placeholder, onDone }: { tab: SessionTab; placeholder: string; onDone(title?: string): void }) {
  const [value, setValue] = useState(tab.title ?? '');
  const done = useRef(false);
  const finish = (title?: string) => {
    if (done.current) return;
    done.current = true;
    onDone(title);
  };
  return (
    <input aria-label='Tab name' autoFocus maxLength={80} value={value} placeholder={placeholder}
      className='h-6 w-36 min-w-0 rounded-sm border border-border bg-background px-1.5 text-xs text-foreground outline-none focus-visible:border-primary'
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onFocus={(event) => event.target.select()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') finish(value);
        else if (event.key === 'Escape') finish(undefined);
      }}
      onBlur={() => finish(value)} />
  );
}

/** A swipe sideways, for the iPhone's row of Blocks. */
function useSwipe(onSwipe: (by: number) => void) {
  const start = useRef<{ x: number; y: number }>(undefined);
  return {
    onTouchStart(event: TouchEvent) {
      const touch = event.touches[0];
      start.current = touch ? { x: touch.clientX, y: touch.clientY } : undefined;
    },
    onTouchEnd(event: TouchEvent) {
      const from = start.current;
      const touch = event.changedTouches[0];
      start.current = undefined;
      if (!from || !touch || Math.abs(touch.clientY - from.y) > 40) return;
      if (touch.clientX - from.x > 60) onSwipe(-1);
      else if (from.x - touch.clientX > 60) onSwipe(1);
    },
  };
}

export type SessionViewProps = {
  controller: AppController;
  session: OpenSession;
  /** The Session's threads, by key, as the list of Sessions places them. */
  members: readonly string[];
  /** Before the tabs: what shows the sidebar, or the iPhone's way back to the list. */
  leading?: ReactNode;
  /** The iPhone: one Block at a time. */
  phone?: boolean;
  /** A thread to show, by key, as one just started or one a link named; `onRevealed` once it is. */
  reveal?: string;
  onRevealed?(): void;
  /** Shows a thread that may be in another Session. */
  onOpenThread(key: string): void;
  /** The iPhone's Surface (WVE-183), for the thread in front. */
  surface?: DeviceSurface;
  onBack?(): void;
};

export function SessionView({ controller, session, members, leading, phone = false, reveal, onRevealed, onOpenThread, surface, onBack }: SessionViewProps) {
  const { model, actions } = controller;
  const { layout } = session;
  const [view, changeView] = useSessionView(session.key);
  const host = model.hosts.find(({ id }) => id === session.hostId);
  const canTerminals = Boolean(host?.canTerminals);
  const tab = tabInFront(layout, view);
  const zoomed = phone ? undefined : zoomedIn(tab, view);
  const focused = focusedBlock(tab, phone ? { ...view, zoom: undefined } : view);
  const update = (change: LayoutChange) => actions.updateLayout?.(session.key, change);
  const focus = (id: string) => changeView((current) => focusBlock(current, layout, id));

  // A Block placed here takes the keyboard once the layout has it.
  const [pending, setPending] = useState<{ block?: string; thread?: string }>();
  useEffect(() => {
    if (!pending) return;
    const id = pending.block && findBlock(layout, pending.block) ? pending.block : pending.thread ? blockOfThread(layout, pending.thread)?.id : undefined;
    if (!id) return;
    focus(id);
    setPending(undefined);
  }, [pending, layout]);

  // The threads on screen are the ones followed: the Block in front of each pane, or on the
  // iPhone the one Block.
  const shown = phone ? (focused ? [focused] : []) : blocksShown(tab, view);
  const keyOf = (block: SessionBlock | undefined) => {
    const threadId = block ? threadOf(block) : undefined;
    return threadId ? threadKey(session.hostId, threadId) : undefined;
  };
  const shownKeys = shown.flatMap((block) => keyOf(block) ?? []);
  const frontKey = keyOf(focused);
  useEffect(() => {
    actions.showThreads?.(shownKeys, frontKey);
  }, [shownKeys.join('\n'), frontKey]);
  useEffect(() => () => actions.showThreads?.([], undefined), []);

  // What the layout no longer has leaves this device's view of it.
  useEffect(() => {
    changeView((current) => {
      const trimmed = trimView(current, layout);
      return JSON.stringify(trimmed) === JSON.stringify(current) ? current : trimmed;
    });
  }, [layout]);

  // A terminal is one to one with its Block: one that ended anywhere takes its Block with it.
  const liveTerminals = session.terminals?.map(({ id }) => id).join('\n');
  useEffect(() => {
    if (session.terminals === undefined) return;
    const live = new Set(session.terminals.map(({ id }) => id));
    const gone = (block: SessionBlock) => {
      const id = terminalOf(block);
      return id !== undefined && !live.has(id);
    };
    if (layoutBlocks(layout).some(gone)) update((current) => prune(current, (block) => !gone(block)));
  }, [liveTerminals, layout]);

  const threads = useMemo(() => model.threads.filter(({ key }) => members.includes(key)), [model.threads, members]);
  const hidden = threads.filter(({ threadId }) => !blockOfThread(layout, threadId));
  const hiddenTerminals = terminalsInOrder(session.terminals ?? []).filter(({ id }) => !blockOfTerminal(layout, id));
  const notShown = hidden.filter(({ state }) => state !== 'closed').length + hiddenTerminals.length;

  const context = (block: SessionBlock): BlockContext => ({
    // A thread's Block shows its own errors' place once, above the panes.
    controller: { ...controller, model: { ...model, error: undefined } },
    session,
    focused: block.id === focused?.id,
    onOpenThread,
    onRemove: () => update((current) => removeBlock(current, block.id)),
    ...(phone ? { surface, onSwipeBack: onBack } : {}),
  });
  const title = (block: SessionBlock) => blockType(block.type).title(block, { controller, session });
  const mark = (block: SessionBlock) => blockType(block.type).mark?.(block, { controller, session }) ?? null;
  const menu = (block: SessionBlock) => blockType(block.type).actions?.(block, context(block)) ?? [];
  const body = (block: SessionBlock) => {
    const { Body } = blockType(block.type);
    return <Body block={block} context={context(block)} />;
  };

  /** Where something new goes without saying: the pane with the keyboard, else the tab. */
  const here = (): Target => focused && findBlock(layout, focused.id)?.pane ? { into: focused.id } : { tab: tab.id };

  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState<{ target: Target }>();
  const [newThread, setNewThread] = useState<{ target: Target; dialog: NewThreadTarget }>();
  // The tab being renamed in place, by id.
  const [renaming, setRenaming] = useState<string>();
  const [confirm, setConfirm] = useState<{ title: string; description: string; action: string; run(): void }>();

  const showThread = (threadId: string, target: Target = here()) => {
    const existing = blockOfThread(layout, threadId);
    if (existing) {
      focus(existing.id);
      return;
    }
    const block = threadBlock(threadId);
    update((current) => blockOfThread(current, threadId) ? current : place(current, block, target));
    setPending({ block: block.id, thread: threadId });
  };
  const showTerminal = (terminalId: string, target: Target = here()) => {
    const existing = blockOfTerminal(layout, terminalId);
    if (existing) {
      focus(existing.id);
      return;
    }
    const block = terminalBlock(terminalId);
    update((current) => blockOfTerminal(current, terminalId) ? current : place(current, block, target));
    setPending({ block: block.id });
  };
  const startTerminal = async (target: Target = here()) => {
    setError(undefined);
    try {
      showTerminal(await actions.newTerminal(), target);
    } catch (cause) {
      setError(describe(cause));
    }
  };
  const startThread = (target: Target = here()) => setNewThread({ target, dialog: { hostId: session.hostId, cwd: session.directory } });
  const created = (thread: CreatedThread) => {
    const target = newThread?.target;
    if (thread.sessionKey !== session.key) {
      onOpenThread(thread.key);
      return;
    }
    showThread(thread.key.slice(thread.key.indexOf('/') + 1), target);
  };

  // A thread to show, as one a link named or one just started from the sidebar.
  useEffect(() => {
    if (!reveal) return;
    if (reveal.startsWith(`${session.hostId}/`)) showThread(reveal.slice(reveal.indexOf('/') + 1));
    onRevealed?.();
  }, [reveal]);

  /** What closing a Block ends, and whether that cuts something off. */
  const ending = (block: SessionBlock) => {
    const threadId = threadOf(block);
    const terminalId = terminalOf(block);
    const thread = threadId ? model.threads.find(({ key }) => key === threadKey(session.hostId, threadId)) : undefined;
    const terminal = terminalId ? session.terminals?.find(({ id }) => id === terminalId) : undefined;
    return {
      thread: thread && thread.state !== 'closed' ? thread : undefined,
      terminal,
      busy: (thread && thread.state !== 'closed' && (thread.activity === 'running' || thread.activity === 'waiting')) || (terminal ? terminalBusy(terminal) : false),
    };
  };
  /** Closes what the Blocks show: a thread closes and can be opened again, a terminal ends. */
  const end = (blocks: SessionBlock[]) => {
    setError(undefined);
    for (const block of blocks) {
      const { thread, terminal } = ending(block);
      if (thread) void Promise.resolve(actions.closeThread(thread.key)).catch((cause: unknown) => setError(describe(cause)));
      if (terminal) void actions.closeTerminal(terminal.id).catch((cause: unknown) => setError(describe(cause)));
    }
  };
  const closeBlock = (block: SessionBlock) => {
    const run = () => {
      end([block]);
      update((current) => removeBlock(current, block.id));
    };
    const { thread, terminal, busy } = ending(block);
    if (!busy) {
      run();
      return;
    }
    setConfirm(thread
      ? {
          title: `Close ${title(block)}?`,
          description: thread.activity === 'running'
            ? 'Its turn is still running, and closing the thread ends it. The thread stays in the list of closed threads, and opens again from there.'
            : 'It is waiting on you, and closing the thread ends its turn. The thread stays in the list of closed threads, and opens again from there.',
          action: 'Close thread',
          run,
        }
      : {
          title: `End ${title(block)}?`,
          description: `${terminal?.command?.command || 'A command'} is still running in it, and ending the terminal stops it. A terminal that ends is gone.`,
          action: 'End terminal',
          run,
        });
  };
  const closeTab = (closing: SessionTab) => {
    const blocks = tabBlocks(closing);
    const run = () => {
      end(blocks);
      update((current) => removeTab(current, closing.id));
    };
    // An empty tab has nothing to lose.
    if (blocks.length === 0) {
      run();
      return;
    }
    const ended = blocks.map(ending);
    const count = { threads: ended.filter(({ thread }) => thread).length, terminals: ended.filter(({ terminal }) => terminal).length };
    const parts = [
      ...(count.threads ? [`closes ${count.threads === 1 ? 'its thread' : `its ${count.threads} threads`}`] : []),
      ...(count.terminals ? [`ends ${count.terminals === 1 ? 'its terminal' : `its ${count.terminals} terminals`}`] : []),
    ];
    setConfirm({
      title: `Close ${tabName(closing)}?`,
      description: parts.length > 0
        ? `Closing the tab ${parts.join(' and ')}${ended.some(({ busy }) => busy) ? ', and something in it is still running' : ''}. Threads open again from the list of closed threads; terminals that end are gone.`
        : `Closing the tab takes its ${blocks.length === 1 ? 'Block' : `${blocks.length} Blocks`} out of the layout, on every device.`,
      action: 'Close tab',
      run,
    });
  };

  const tabName = (named: SessionTab) => {
    if (named.title) return named.title;
    const blocks = tabBlocks(named);
    const first = (named.id === tab.id ? focused : undefined) ?? blocks[0];
    return first ? title(first) : 'Empty tab';
  };
  const stepTab = (by: number) => {
    const at = layout.tabs.findIndex(({ id }) => id === tab.id);
    const next = layout.tabs[(at + by + layout.tabs.length) % layout.tabs.length];
    if (next) changeView((current) => showTab(current, next.id));
  };
  const openTab = () => {
    const made = newTab();
    update((current) => addTab(current, made, tab.id));
    changeView((current) => showTab(current, made.id));
  };
  const toggleFloat = (block: SessionBlock) => {
    const found = findBlock(layout, block.id);
    if (!found) return;
    update((current) => found.pane
      ? placeBlock(current, block, { floating: found.tab.id, frame: FLOATING_FRAME })
      : place(current, block, { tab: found.tab.id }));
    setPending({ block: block.id });
  };
  const toNewTab = (block: SessionBlock) => {
    const made = newTab();
    update((current) => placeBlock(current, block, { newTab: made, after: findBlock(current, block.id)?.tab.id }));
    setPending({ block: block.id });
  };
  const focusBeside = (side: Side) => {
    const pane = focused ? paneBeside(tab, focused.id, side) : undefined;
    if (pane) focus(blockInFront(pane, view).id);
  };
  /** The next Block of the focused one's pane, or on the iPhone of the tab. */
  const stepBlock = (by: number) => {
    if (!focused) return;
    const among = phone ? tabBlocks(tab) : findBlock(layout, focused.id)?.pane?.children ?? [];
    const at = among.findIndex(({ id }) => id === focused.id);
    const next = among[(at + by + among.length) % among.length];
    if (next && next.id !== focused.id) focus(next.id);
  };

  const paneActions: PaneActions = {
    focus,
    close: closeBlock,
    zoom: (id) => changeView((current) => toggleZoom(current, layout, id)),
    split: (id, side) => setAdding({ target: { beside: id, side } }),
    toNewTab,
    float: toggleFloat,
    move: (block, target) => {
      update((current) => placeBlock(current, block, target));
      setPending({ block: block.id });
    },
    resize: (path, sizes) => update((current) => resizeSplit(current, tab.id, path, sizes)),
    frame: (id, frame) => update((current) => frameBlock(current, id, frame)),
  };

  const docked = Boolean(focused && findBlock(layout, focused.id)?.pane);
  useCommand('thread.new', () => startThread());
  useCommand('terminal.new', () => void startTerminal(), canTerminals);
  useCommand('block.add', () => setAdding({ target: here() }));
  useCommand('tab.new', openTab);
  useCommand('tab.rename', () => setRenaming(tab.id));
  useCommand('tab.close', () => closeTab(tab));
  useCommand('tab.next', () => stepTab(1), layout.tabs.length > 1);
  useCommand('tab.previous', () => stepTab(-1), layout.tabs.length > 1);
  useCommand('block.splitRight', () => { if (focused) setAdding({ target: { beside: focused.id, side: 'right' } }); }, docked && !phone);
  useCommand('block.splitDown', () => { if (focused) setAdding({ target: { beside: focused.id, side: 'down' } }); }, docked && !phone);
  useCommand('block.zoom', () => { if (focused) paneActions.zoom(focused.id); }, Boolean(focused) && !phone);
  useCommand('block.float', () => { if (focused) toggleFloat(focused); }, Boolean(focused) && !phone);
  useCommand('block.toNewTab', () => { if (focused) toNewTab(focused); }, Boolean(focused));
  useCommand('block.close', () => { if (focused) closeBlock(focused); }, Boolean(focused));
  useCommand('block.focusLeft', () => focusBeside('left'), docked && !phone);
  useCommand('block.focusRight', () => focusBeside('right'), docked && !phone);
  useCommand('block.focusUp', () => focusBeside('up'), docked && !phone);
  useCommand('block.focusDown', () => focusBeside('down'), docked && !phone);
  useCommand('block.next', () => stepBlock(1), Boolean(focused));
  useCommand('block.previous', () => stepBlock(-1), Boolean(focused));
  useCommand('composer.focus', () => {
    if (focused) document.querySelector<HTMLTextAreaElement>(`[data-block-id="${focused.id}"] textarea`)?.focus();
  }, Boolean(focused && threadOf(focused)));

  const empty = (
    <div data-slot='empty-tab' className='flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center'>
      <p className='text-sm font-medium'>Nothing in this tab</p>
      <p className='max-w-xs text-xs text-muted-foreground'>
        A Block shows a thread or a terminal: a new one, or one of this Session's that isn't shown{notShown > 0 ? `, of which there ${notShown === 1 ? 'is 1' : `are ${notShown}`}` : ''}.
      </p>
      <Button onClick={() => setAdding({ target: here() })}>New Block</Button>
    </div>
  );

  const newBlock = (
    <Button size={phone ? (notShown > 0 ? 'sm' : 'icon') : 'sm'} variant='ghost' className='shrink-0'
      aria-label={notShown > 0 ? `New Block, ${notShown} not shown` : 'New Block'}
      title={notShown > 0 ? `New Block: ${notShown} of this Session's threads and terminals aren't shown` : 'New Block'}
      onClick={() => setAdding({ target: here() })}>
      <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
      {!phone && 'New Block'}
      {notShown > 0 && <span className='text-muted-foreground'>{notShown}</span>}
    </Button>
  );
  // The tabs: each with its name, which is typed in place to rename it, and its own close; then
  // a + for a new one, which a Block dragged onto it moves into.
  const tabRail = (
    <div role='tablist' aria-label='Tabs' className='flex h-full min-w-0 flex-1 items-stretch gap-px overflow-x-auto'>
      {layout.tabs.map((listed) => {
        const selected = listed.id === tab.id;
        const name = tabName(listed);
        const show = () => changeView((current) => showTab(current, listed.id));
        return (
          <div key={listed.id} role='tab' tabIndex={0} aria-selected={selected} aria-label={name} data-tab-drop={listed.id} title={name}
            className={cn(
              'flex max-w-56 min-w-0 shrink-0 cursor-default items-center gap-1 border-b-2 border-transparent pr-1 pl-3 text-xs text-muted-foreground outline-none focus-visible:bg-accent',
              selected && 'border-primary text-foreground',
            )}
            onClick={show}
            onDoubleClick={() => setRenaming(listed.id)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
              event.preventDefault();
              show();
            }}>
            {renaming === listed.id
              ? (
                <TabNameInput tab={listed} placeholder={tabName({ ...listed, title: undefined })} onDone={(next) => {
                  if (next !== undefined) update((current) => renameTab(current, listed.id, next));
                  setRenaming(undefined);
                }} />
              )
              : <span className='truncate'>{name}</span>}
            <Button size='icon-xs' variant='ghost' aria-label={`Close tab ${name}`} title='Close tab' className='shrink-0 opacity-60 hover:opacity-100'
              onClick={(event) => {
                event.stopPropagation();
                closeTab(listed);
              }}>
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
            </Button>
          </div>
        );
      })}
      <Button size='icon' variant='ghost' aria-label='New tab' title='New tab' data-tab-drop='new' className='shrink-0 self-center' onClick={openTab}>
        <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
      </Button>
    </div>
  );
  const swipe = useSwipe(stepBlock);
  const sessionName = directoryName(session.directory);
  const inTab = tabBlocks(tab).length;

  return (
    <section aria-label={`Session ${sessionName}`} data-slot='session-view' data-session={session.key} className='flex min-h-0 min-w-0 flex-1 flex-col'>
      <ThreadHeader leading={leading}>
        {tabRail}
        {newBlock}
      </ThreadHeader>
      {(error ?? model.error) && (
        <Alert variant='destructive' className='m-2 w-auto has-data-[slot=alert-action]:pr-8'>
          <AlertDescription>{error ?? model.error}</AlertDescription>
          {error && (
            <Button size='icon-xs' variant='ghost' aria-label='Dismiss' className='absolute top-1.5 right-1.5' onClick={() => setError(undefined)}>
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
            </Button>
          )}
        </Alert>
      )}
      {phone
        ? (
          <>
            {focused && (
              // One Block at a time: the tab's Blocks by name, and the one in front's menu and close.
              <div {...swipe}>
                <BlockRail blocks={tabBlocks(tab)} front={focused} focused arrange={false} view={view} focusedId={focused.id}
                  actions={paneActions} title={title} mark={mark} body={body} menu={menu} inTab={inTab} />
              </div>
            )}
            {focused
              ? <div key={focused.id} data-block-id={focused.id} role='tabpanel' className='flex min-h-0 min-w-0 flex-1 flex-col'>{body(focused)}</div>
              : empty}
          </>
        )
        : <TabPanes tab={tab} view={view} focusedId={focused?.id} zoomedId={zoomed?.id} actions={paneActions} title={title} mark={mark} body={body} menu={menu} inTab={inTab} empty={empty} />}

      <NewBlockDialog
        open={adding !== undefined}
        onOpenChange={(open) => { if (!open) setAdding(undefined); }}
        threads={hidden.filter(({ state }) => state !== 'closed')}
        closed={hidden.filter(({ state }) => state === 'closed')}
        terminals={hiddenTerminals}
        canTerminals={canTerminals}
        onNewThread={() => {
          const target = adding?.target;
          setAdding(undefined);
          startThread(target);
        }}
        onNewTerminal={() => {
          const target = adding?.target;
          setAdding(undefined);
          void startTerminal(target);
        }}
        onThread={(thread) => {
          showThread(thread.threadId, adding?.target);
          setAdding(undefined);
        }}
        onTerminal={(terminal) => {
          showTerminal(terminal.id, adding?.target);
          setAdding(undefined);
        }}
      />
      <NewThreadDialog controller={controller} target={newThread?.dialog} onCreated={created} onClose={() => setNewThread(undefined)} />
      <AlertDialog open={confirm !== undefined} onOpenChange={(open) => { if (!open) setConfirm(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it open</AlertDialogCancel>
            <AlertDialogAction variant='destructive' onClick={() => {
              confirm?.run();
              setConfirm(undefined);
            }}>{confirm?.action}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
