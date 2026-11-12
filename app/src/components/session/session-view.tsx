// A Session on screen (ADR 0031, WVE-203): its tabs, and in the tab in front its Blocks, docked
// or floating. The Mac and the iPad lay a tab out as the document has it; the iPhone shows one
// Block at a time, a tab's Blocks by name to move between. What changes the layout goes to the
// Host for every device; which tab is in front, focus and zoom are this device's own. What a
// Block shows is the Session's from then on (`sessions/add`): nothing else in its directory is.
//
// A Bot's Session (WVE-178) is skinned apart: no tabs, the Bot's name in their place, and its
// Thread Block locked to the top left of the one tab, showing the Bot's current thread. Terminals
// and other Blocks go beside it, never before it, and no second thread is offered.
import { useEffect, useMemo, useRef, useState, type ReactNode, type TouchEvent } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon, Cancel01Icon, ComputerTerminal01Icon, BubbleChatIcon } from '@hugeicons/core-free-icons';
import { type AppController, type BotSummary, type CreatedThread, type LayoutChange, type OpenSession, type TerminalSummary, type ThreadSummary, threadKey } from '@/app/app-controller';
import { useCommand } from '@/app/commands';
import { BotHeading } from '@/components/bots/bot-heading';
import { type NewThreadTarget, NewThreadDialog } from '@/components/new-thread-dialog';
import { type BlockContext, TerminalMark, blockType } from '@/components/session/blocks';
import { NameInput } from '@/components/session/name-input';
import { type BlockActions, BlockRail, TabBlocks } from '@/components/session/tab-blocks';
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
import { botAllows, botLayout, lockedBlock } from '@/session/bots';
import {
  FLOATING_FRAME,
  type Side,
  type Target,
  addTab,
  blockBeside,
  findBlock,
  frameBlock,
  layoutBlocks,
  minimizeBlock,
  newTab,
  placeBlock,
  prune,
  removeBlock,
  removeTab,
  renameTab,
  resizeSplit,
  roomierSide,
  tabBlocks,
} from '@/session/layout';
import { directoryName, threadDirectories } from '@/session/sessions';
import { blockOnPhone, blocksShown, focusBlock, focusedBlock, showTab, tabInFront, toggleZoom, trimView, useSessionView, zoomedIn } from '@/session/view';
import type { DeviceSurface } from '@/surface/use-surface';
import { terminalBusy, terminalName, terminalsInOrder } from '@/terminal/terminals';

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * What a new Block shows: a thread or terminal to start, one the Session has that no Block shows,
 * or one elsewhere in its directory, which a Block brings into the Session.
 */
function NewBlockDialog({ open, onOpenChange, threads, closed, terminals, elsewhere, canTerminals, canThreads = true, onNewThread, onNewTerminal, onThread, onTerminal }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Whether a thread may be given a Block: not in a Bot's Session, whose one thread is its own. */
  canThreads?: boolean;
  /** The Session's open threads no Block shows, and its closed ones. */
  threads: ThreadSummary[];
  closed: ThreadSummary[];
  terminals: TerminalSummary[];
  /** What's in its directory and not the Session's: started from a terminal, a schedule or another client. */
  elsewhere: { threads: ThreadSummary[]; terminals: TerminalSummary[] };
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
          <DialogDescription>
            {canThreads
              ? 'What it shows: something new, or a thread or terminal of this Session that no Block shows. It docks beside the Block with the keyboard, on every device.'
              : "What it shows: a new terminal, or one of this directory's that no Block shows. It docks beside the Block with the keyboard, on every device."}
          </DialogDescription>
        </DialogHeader>
        <div className='grid max-h-[60dvh] gap-3 overflow-y-auto'>
          <div role='group' aria-label='New' className='grid gap-0.5'>
            {canThreads && (
              <button type='button' className={row} onClick={onNewThread}>
                <HugeiconsIcon icon={BubbleChatIcon} strokeWidth={2} className='size-3.5 text-icon-muted' />
                New thread…
              </button>
            )}
            {canTerminals && (
              <button type='button' className={row} onClick={onNewTerminal}>
                <HugeiconsIcon icon={ComputerTerminal01Icon} strokeWidth={2} className='size-3.5 text-icon-muted' />
                New terminal
              </button>
            )}
          </div>
          <div role='group' aria-label='Not shown' className='grid gap-0.5'>
            <p className='px-2 text-[0.6875rem] font-medium text-muted-foreground'>Not shown</p>
            {none && <p className='px-2 py-1 text-[0.6875rem] text-muted-foreground'>{canThreads ? 'Every open thread and terminal here has a Block.' : 'Every terminal here has a Block.'}</p>}
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
          {(elsewhere.threads.length > 0 || elsewhere.terminals.length > 0) && (
            <div role='group' aria-label='Elsewhere in this directory' className='grid gap-0.5'>
              <p className='px-2 text-[0.6875rem] font-medium text-muted-foreground'>Elsewhere in this directory, which a Block brings into the Session</p>
              {elsewhere.threads.map((thread) => (
                <button key={thread.key} type='button' className={row} onClick={() => onThread(thread)}>
                  <HugeiconsIcon icon={BubbleChatIcon} strokeWidth={2} className='size-3.5 shrink-0 text-icon-muted' />
                  <span className='min-w-0 flex-1 truncate'>{thread.title || 'New thread'}</span>
                  <span className='shrink-0 text-[0.6875rem] text-muted-foreground'>{thread.activity === 'waiting' ? 'waiting on you' : thread.activity === 'running' ? 'running' : thread.agentName}</span>
                </button>
              ))}
              {elsewhere.terminals.map((terminal) => (
                <button key={terminal.id} type='button' className={row} onClick={() => onTerminal(terminal)}>
                  <HugeiconsIcon icon={ComputerTerminal01Icon} strokeWidth={2} className='size-3.5 shrink-0 text-icon-muted' />
                  <span className='min-w-0 flex-1 truncate'>{terminalName(terminal)}</span>
                  <TerminalMark terminal={terminal} />
                </button>
              ))}
            </div>
          )}
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
  /** The Session's threads, by key: those started or shown in a Block of it, and those they started. */
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
  /** A thread was started from here in another directory: its own Session's, which it starts. */
  onCreated?(thread: CreatedThread): void;
  /** The iPhone's Surface (WVE-183), for the thread in front. */
  surface?: DeviceSurface;
  onBack?(): void;
  /** The Bot whose Session this is (WVE-178): one tab, its Thread Block locked to the top left. */
  bot?: BotSummary;
  /** Shows the Bot's page, from its name atop the Session. */
  onOpenBot?(): void;
};

export function SessionView({ controller, session, members, leading, phone = false, reveal, onRevealed, onOpenThread, onCreated, surface, onBack, bot, onOpenBot }: SessionViewProps) {
  const { model, actions } = controller;
  const { layout } = session;
  const [view, changeView] = useSessionView(session.key);
  const host = model.hosts.find(({ id }) => id === session.hostId);
  const canTerminals = Boolean(host?.canTerminals);
  // A Bot's Session shows its first tab, and never writes another.
  const tab = bot ? layout.tabs[0] : tabInFront(layout, view);
  // Its Thread Block, which stays at the top left.
  const locked = bot ? lockedBlock(layout) : undefined;
  const isLocked = (block: SessionBlock) => block.id === locked?.id;
  const zoomed = phone ? undefined : zoomedIn(tab, view);
  const focused = phone ? blockOnPhone(tab, view) : focusedBlock(tab, view);
  const update = (change: LayoutChange) => actions.updateLayout?.(session.key, change);
  const focus = (id: string) => changeView((current) => focusBlock(current, layout, id));

  // A Bot's Thread Block shows its current thread: when the Bot starts a new one, or another
  // device's write left something else at the top left, the layout is made so again, with the
  // thread the Session's first. A Block that leaves this way leaves its thread running.
  const botThread = bot?.thread;
  const lockedShows = locked ? threadOf(locked) : undefined;
  useEffect(() => {
    if (!botThread || lockedShows === botThread) return;
    actions.addToSession?.(session.key, { threads: [botThread], terminals: [] });
    update((current) => botLayout(current, botThread));
  }, [botThread, lockedShows, layout]);
  // Opening the Bot is opening its thread: its Block has the keyboard, and the thread is read.
  useEffect(() => {
    if (locked && lockedShows === botThread) focus(locked.id);
  }, [locked?.id, lockedShows === botThread]);

  // A Block placed here takes the keyboard once the layout has it.
  const [pending, setPending] = useState<{ block?: string; thread?: string }>();
  useEffect(() => {
    if (!pending) return;
    const id = pending.block && findBlock(layout, pending.block) ? pending.block : pending.thread ? blockOfThread(layout, pending.thread)?.id : undefined;
    if (!id) return;
    focus(id);
    setPending(undefined);
  }, [pending, layout]);

  // The threads on screen are the ones followed: each Block that shows, or on the iPhone the one
  // Block.
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

  // The Session's own are those its Host lists; a Host from before it kept them counts everything
  // in the directory. What else is in the directory is elsewhere, until a Block brings it in.
  const own = session.own;
  const threads = useMemo(() => model.threads.filter(({ key }) => members.includes(key)), [model.threads, members]);
  const hidden = threads.filter(({ threadId }) => !blockOfThread(layout, threadId));
  const unplaced = terminalsInOrder(session.terminals ?? []).filter(({ id }) => !blockOfTerminal(layout, id));
  const hiddenTerminals = unplaced.filter(({ id }) => !own || own.terminals.includes(id));
  const notShown = (bot ? 0 : hidden.filter(({ state }) => state !== 'closed').length) + hiddenTerminals.length;
  const elsewhere = useMemo(() => {
    if (!own) return { threads: [], terminals: [] };
    const directories = threadDirectories(model.threads, model.known ?? []);
    return {
      threads: model.threads.filter((thread) => thread.hostId === session.hostId && thread.state !== 'closed' && !members.includes(thread.key)
        && directories.get(thread.key) === session.directory && !blockOfThread(layout, thread.threadId)),
      terminals: unplaced.filter(({ id }) => !own.terminals.includes(id)),
    };
  }, [model.threads, model.known, members, own, layout, session.terminals]);

  // What a Block shows is the Session's: its Host is told of any it doesn't list yet, as one
  // just started here, or one brought in from elsewhere in the directory.
  const strangers = useMemo(() => {
    if (!own) return { threads: [], terminals: [] };
    const blocks = layoutBlocks(layout);
    return {
      threads: blocks.flatMap((block) => threadOf(block) ?? []).filter((id) => !own.threads.includes(id)),
      terminals: blocks.flatMap((block) => terminalOf(block) ?? []).filter((id) => !own.terminals.includes(id) && session.terminals?.some((terminal) => terminal.id === id)),
    };
  }, [layout, own, session.terminals]);
  useEffect(() => {
    if (strangers.threads.length + strangers.terminals.length > 0) actions.addToSession?.(session.key, strangers);
  }, [session.key, strangers.threads.join('\n'), strangers.terminals.join('\n')]);

  const context = (block: SessionBlock): BlockContext => ({
    // A thread's Block shows its own errors' place once, above the Blocks.
    controller: { ...controller, model: { ...model, error: undefined } },
    session,
    focused: block.id === focused?.id,
    onOpenThread,
    onRemove: () => update((current) => removeBlock(current, block.id)),
    ...(phone ? { surface, onSwipeBack: onBack } : {}),
  });
  const title = (block: SessionBlock) => blockType(block.type).title(block, { controller, session });
  const mark = (block: SessionBlock) => blockType(block.type).mark?.(block, { controller, session }) ?? null;
  // The Bot's thread isn't deleted from its Block: it's the Bot's.
  const menu = (block: SessionBlock) => (blockType(block.type).actions?.(block, context(block)) ?? []).filter((item) => !(isLocked(block) && item.destructive));
  const rename = (block: SessionBlock) => blockType(block.type).rename?.(block, { controller, session });
  const body = (block: SessionBlock) => {
    const { Body } = blockType(block.type);
    return <Body block={block} context={context(block)} />;
  };

  /**
   * Where something new goes without saying: docked beside the Block with the keyboard, to its
   * right while that's wider than tall, else below it; beside the tab's largest when the one with
   * the keyboard floats.
   */
  const here = (): Target => {
    if (!focused || !findBlock(layout, focused.id)?.path) return { tab: tab.id };
    const rect = document.querySelector(`[data-session="${CSS.escape(session.key)}"] [data-slot="session-tab"]`)?.getBoundingClientRect();
    return { beside: focused.id, side: roomierSide(tab, focused.id, rect && rect.height > 0 && rect.width > 0 ? rect.width / rect.height : undefined) };
  };

  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState<{ target: Target }>();
  const [newThread, setNewThread] = useState<{ target: Target; dialog: NewThreadTarget }>();
  // The tab being renamed in place, by id.
  const [renaming, setRenaming] = useState<string>();
  const [confirm, setConfirm] = useState<{ title: string; description: string; action: string; run(): void }>();

  /** Gives a Block the layout has the keyboard, bringing it back first if it was put away. */
  const bring = (block: SessionBlock) => {
    if (!phone && findBlock(layout, block.id)?.minimized) {
      update((current) => minimizeBlock(current, block.id, false));
      setPending({ block: block.id });
    } else {
      focus(block.id);
    }
  };
  const showThread = (threadId: string, target: Target = here()) => {
    const existing = blockOfThread(layout, threadId);
    if (existing) {
      bring(existing);
      return;
    }
    const block = threadBlock(threadId);
    update((current) => blockOfThread(current, threadId) ? current : place(current, block, target));
    setPending({ block: block.id, thread: threadId });
  };
  const showTerminal = (terminalId: string, target: Target = here()) => {
    const existing = blockOfTerminal(layout, terminalId);
    if (existing) {
      bring(existing);
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
      onCreated?.(thread);
      return;
    }
    showThread(thread.key.slice(thread.key.indexOf('/') + 1), target);
  };

  // A thread to show, as one a link named or one just started from the sidebar.
  useEffect(() => {
    if (!reveal) return;
    const threadId = reveal.startsWith(`${session.hostId}/`) ? reveal.slice(reveal.indexOf('/') + 1) : undefined;
    // A Bot's Session gives no second thread a Block.
    if (threadId && bot) {
      const existing = blockOfThread(layout, threadId);
      if (existing) bring(existing);
    } else if (threadId) {
      showThread(threadId);
    }
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
    if (isLocked(block)) return;
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
    if (!found || isLocked(block)) return;
    update((current) => found.path
      ? placeBlock(current, block, { floating: found.tab.id, frame: FLOATING_FRAME })
      : place(current, block, { tab: found.tab.id }));
    setPending({ block: block.id });
  };
  const toNewTab = (block: SessionBlock) => {
    if (bot) return;
    const made = newTab();
    update((current) => placeBlock(current, block, { newTab: made, after: findBlock(current, block.id)?.tab.id }));
    setPending({ block: block.id });
  };
  const minimize = (block: SessionBlock, minimized: boolean) => {
    update((current) => minimizeBlock(current, block.id, minimized));
    if (!minimized) setPending({ block: block.id });
  };
  const focusBeside = (side: Side) => {
    const beside = focused ? blockBeside(tab, focused.id, side) : undefined;
    if (beside) focus(beside.id);
  };
  /** The next of the Blocks the tab shows, or on the iPhone of all it has. */
  const stepBlock = (by: number) => {
    if (!focused) return;
    const among = phone ? tabBlocks(tab) : shown;
    const at = among.findIndex(({ id }) => id === focused.id);
    const next = among[(at + by + among.length) % among.length];
    if (next && next.id !== focused.id) focus(next.id);
  };

  const blockActions: BlockActions = {
    focus,
    close: closeBlock,
    zoom: (id) => changeView((current) => toggleZoom(current, layout, id)),
    split: (id, side) => setAdding({ target: { beside: id, side } }),
    float: toggleFloat,
    minimize,
    move: (block, target) => {
      if (locked && !botAllows(layout, locked.id, block, target)) return;
      update((current) => locked && !botAllows(current, locked.id, block, target) ? current : placeBlock(current, block, target));
      setPending({ block: block.id });
    },
    resize: (path, sizes) => update((current) => resizeSplit(current, tab.id, path, sizes)),
    frame: (id, frame) => update((current) => frameBlock(current, id, frame)),
  };

  const found = focused ? findBlock(layout, focused.id) : undefined;
  const docked = Boolean(found?.path);
  const pinned = Boolean(focused && isLocked(focused));
  useCommand('thread.new', () => startThread(), !bot);
  useCommand('terminal.new', () => void startTerminal(), canTerminals);
  useCommand('block.add', () => setAdding({ target: here() }));
  useCommand('tab.new', openTab, !bot);
  useCommand('tab.rename', () => setRenaming(tab.id), !bot);
  useCommand('tab.close', () => closeTab(tab), !bot);
  useCommand('tab.next', () => stepTab(1), !bot && layout.tabs.length > 1);
  useCommand('tab.previous', () => stepTab(-1), !bot && layout.tabs.length > 1);
  useCommand('block.splitRight', () => { if (focused) setAdding({ target: { beside: focused.id, side: 'right' } }); }, docked && !phone);
  useCommand('block.splitDown', () => { if (focused) setAdding({ target: { beside: focused.id, side: 'down' } }); }, docked && !phone);
  useCommand('block.zoom', () => { if (focused) blockActions.zoom(focused.id); }, Boolean(focused) && !phone);
  useCommand('block.float', () => { if (focused) toggleFloat(focused); }, Boolean(focused) && !phone && !pinned);
  useCommand('block.minimize', () => { if (focused) minimize(focused, true); }, Boolean(found?.frame) && !phone && !pinned);
  useCommand('block.toNewTab', () => { if (focused) toNewTab(focused); }, Boolean(focused) && !bot);
  useCommand('block.close', () => { if (focused) closeBlock(focused); }, Boolean(focused) && !pinned);
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
                <NameInput label='Tab name' name={listed.title ?? ''} placeholder={tabName({ ...listed, title: undefined })}
                  onKeep={(next) => update((current) => renameTab(current, listed.id, next))} onDone={() => setRenaming(undefined)} />
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
    <section aria-label={bot ? `Bot ${bot.name}` : `Session ${sessionName}`} data-slot='session-view' data-session={session.key} data-bot={bot?.id}
      className='flex min-h-0 min-w-0 flex-1 flex-col'>
      <ThreadHeader leading={leading}>
        {bot ? <BotHeading bot={bot} unread={model.unread} onOpen={onOpenBot} /> : tabRail}
        {newBlock}
      </ThreadHeader>
      {bot?.startingThread && (
        <p role='status' data-slot='bot-starting' className='shrink-0 border-b border-border bg-muted/40 px-3 py-1.5 text-[0.6875rem] text-muted-foreground'>
          Starting a new thread: the current one saves its notes first, then the new one takes over here.
        </p>
      )}
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
                <BlockRail block={focused} among={tabBlocks(tab)} focusedId={focused.id} locked={locked?.id}
                  actions={blockActions} title={title} mark={mark} body={body} menu={menu} rename={rename} inTab={inTab} marksFocus={false} />
              </div>
            )}
            {focused
              ? <div key={focused.id} data-block-id={focused.id} role='tabpanel' className='flex min-h-0 min-w-0 flex-1 flex-col'>{body(focused)}</div>
              : empty}
          </>
        )
        : <TabBlocks tab={tab} focusedId={focused?.id} zoomedId={zoomed?.id} actions={blockActions} title={title} mark={mark} body={body} menu={menu} rename={rename} inTab={inTab} marksFocus={shown.length > 1} empty={empty}
            locked={locked?.id} allows={locked ? (block, target) => botAllows(layout, locked.id, block, target) : undefined} />}

      <NewBlockDialog
        open={adding !== undefined}
        onOpenChange={(open) => { if (!open) setAdding(undefined); }}
        threads={bot ? [] : hidden.filter(({ state }) => state !== 'closed')}
        closed={bot ? [] : hidden.filter(({ state }) => state === 'closed')}
        terminals={hiddenTerminals}
        elsewhere={bot ? { threads: [], terminals: elsewhere.terminals } : elsewhere}
        canTerminals={canTerminals}
        canThreads={!bot}
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
