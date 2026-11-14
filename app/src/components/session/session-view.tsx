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
import { Add01Icon, Cancel01Icon, Tick02Icon, UnfoldMoreIcon } from '@hugeicons/core-free-icons';
import { type AppController, type BotSummary, type CreatedThread, type LayoutChange, type OpenSession, revealedTerminal, threadKey } from '@/app/app-controller';
import { saveLastChoices } from '@/app/last-choices';
import { useCommand } from '@/app/commands';
import { BotHeading } from '@/components/bots/bot-heading';
import { type NewThreadTarget, NewThreadDialog } from '@/components/new-thread-dialog';
import { type BlockContext, blockType } from '@/components/session/blocks';
import { NewBlockDialog } from '@/components/session/new-block-dialog';
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { SessionBlock, SessionTab } from '@/host/protocol';
import { cn } from '@/lib/utils';
import { blockOfTerminal, blockOfThread, place, terminalBlock, terminalOf, threadBlock, threadOf } from '@/session/blocks';
import { botAllows, botLayout, lockedBlock } from '@/session/bots';
import {
  FLOATING_FRAME,
  type Side,
  type Target,
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
import { terminalBusy, terminalsInOrder } from '@/terminal/terminals';

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

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
  onBack?(): void;
  /** The Bot whose Session this is (WVE-178): one tab, its Thread Block locked to the top left. */
  bot?: BotSummary;
  /** Shows the Bot's page, from its name atop the Session. */
  onOpenBot?(): void;
  /** The Session ended, with its last Block (WVE-228). */
  onEnded?(): void;
};

export function SessionView({ controller, session, members, leading, phone = false, reveal, onRevealed, onOpenThread, onCreated, onBack, bot, onOpenBot, onEnded }: SessionViewProps) {
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
    const went = layoutBlocks(layout).filter(gone);
    if (went.length === 0) return;
    // The last of them takes the Session too, as `exit` in a terminal's last pane does.
    const ends = last(went);
    update((current) => prune(current, (block) => !gone(block)));
    if (ends) void endSession();
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

  // A Session ends with its last Block (WVE-228), where its Host ends Sessions and it holds
  // nothing a Block doesn't show: what's not shown keeps it, to be shown or ended by hand. Not a
  // Bot's, and not one with no Block yet, as one being started. Only the device that took the
  // last Block out ends it.
  const canEnd = !bot && Boolean(actions.endSession) && host?.status === 'connected' && Boolean(host.canEndSessions)
    && Boolean(model.known?.some((known) => known.hostId === session.hostId && known.directory === session.directory));
  /** Whether the layout without `blocks` leaves the Session nothing, so that it ends. */
  const last = (blocks: SessionBlock[]) => {
    const all = layoutBlocks(layout);
    return canEnd && notShown === 0 && all.length > 0 && all.every(({ id }) => blocks.some((block) => block.id === id));
  };
  /** Ends the Session, once what its last Blocks showed has closed: its Host refuses while any of it is busy. */
  const endSession = async (closing: Promise<unknown>[] = []) => {
    await Promise.allSettled(closing);
    try {
      await actions.endSession?.(session.key);
      onEnded?.();
    } catch (cause) {
      setError(describe(cause));
    }
  };
  const remove = (block: SessionBlock) => {
    const ends = last([block]);
    update((current) => removeBlock(current, block.id));
    if (ends) void endSession();
  };

  const context = (block: SessionBlock): BlockContext => ({
    controller,
    session,
    focused: block.id === focused?.id,
    onOpenThread,
    onRemove: () => remove(block),
    ...(phone ? { onSwipeBack: onBack } : {}),
  });
  const title = (block: SessionBlock) => blockType(block.type).title(block, { controller, session });
  const icon = (block: SessionBlock) => blockType(block.type).icon;
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

  const sessionName = directoryName(session.directory);
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
  const created = (thread: CreatedThread, target: Target | undefined = newThread?.target) => {
    if (thread.sessionKey !== session.key) {
      onCreated?.(thread);
      return;
    }
    showThread(thread.key.slice(thread.key.indexOf('/') + 1), target);
  };

  /** A thread of `agentId` here, in the Session's directory, shown in a Block at `target`: New Block's one step. */
  const startThreadWith = async (agentId: string, target: Target) => {
    setError(undefined);
    try {
      const thread = await actions.createThread({ hostId: session.hostId, cwd: session.directory, agentId });
      saveLastChoices({ agentId });
      if (thread) created(thread, target);
    } catch (cause) {
      setError(describe(cause));
    }
  };

  // What to show: a thread, as one a link named or one just started from the sidebar, or the
  // terminal the Session was started with.
  useEffect(() => {
    if (!reveal) return;
    const terminalId = revealedTerminal(reveal);
    if (terminalId) {
      showTerminal(terminalId);
      onRevealed?.();
      return;
    }
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
  const end = (blocks: SessionBlock[]): Promise<unknown>[] => {
    setError(undefined);
    const closing: Promise<unknown>[] = [];
    for (const block of blocks) {
      const { thread, terminal } = ending(block);
      if (thread) closing.push(Promise.resolve(actions.closeThread(thread.key)).catch((cause: unknown) => setError(describe(cause))));
      if (terminal) closing.push(actions.closeTerminal(terminal.id).catch((cause: unknown) => setError(describe(cause))));
    }
    return closing;
  };
  const closeBlock = (block: SessionBlock) => {
    if (isLocked(block)) return;
    const ends = last([block]);
    const run = () => {
      const closing = end([block]);
      update((current) => removeBlock(current, block.id));
      if (ends) void endSession(closing);
    };
    const { thread, terminal, busy } = ending(block);
    // The last Block takes the Session with it without asking, unless that cuts something off.
    if (!busy) {
      run();
      return;
    }
    const too = ends ? ` It's the last Block in ${sessionName}, so the Session ends too.` : '';
    setConfirm(thread
      ? {
          title: `Close ${title(block)}?`,
          description: `${thread.activity === 'running'
            ? 'Its turn is still running, and closing the thread ends it. The thread stays in the list of closed threads, and opens again from there.'
            : 'It is waiting on you, and closing the thread ends its turn. The thread stays in the list of closed threads, and opens again from there.'}${too}`,
          action: 'Close thread',
          run,
        }
      : {
          title: `End ${title(block)}?`,
          description: `${terminal?.command?.command || 'A command'} is still running in it, and ending the terminal stops it. A terminal that ends is gone.${too}`,
          action: 'End terminal',
          run,
        });
  };
  const closeTab = (closing: SessionTab) => {
    const blocks = tabBlocks(closing);
    // The Session's last Blocks, or its only tab with none and nothing else in the Session: it ends too.
    const ends = blocks.length > 0 ? last(blocks) : canEnd && notShown === 0 && layout.tabs.length === 1;
    const run = () => {
      const closed = end(blocks);
      update((current) => removeTab(current, closing.id));
      if (ends) void endSession(closed);
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
        ? `Closing the tab ${parts.join(' and ')}${ended.some(({ busy }) => busy) ? ', and something in it is still running' : ''}. Threads open again from the list of closed threads; terminals that end are gone.${ends ? ` It's the last tab in ${sessionName}, so the Session ends too.` : ''}`
        : `Closing the tab takes its ${blocks.length === 1 ? 'Block' : `${blocks.length} Blocks`} out of the layout, on every device${ends ? `, and ends the Session ${sessionName}` : ''}.`,
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
  // A new tab is made by its first Block (WVE-228): New Block, aimed at one, and nothing if it's
  // put away. From a tab with nothing in it, that tab is the one to fill.
  const openTab = () => setAdding({ target: tabBlocks(tab).length === 0 ? { tab: tab.id } : { newTab: newTab(), after: tab.id } });
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
  useCommand('block.toNewTab', () => { if (focused) toNewTab(focused); }, Boolean(focused) && !bot && tabBlocks(tab).length > 1);
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

  // New Block shows as a button only here, in an empty tab: elsewhere a Block's split icons,
  // the keys, the menu bar and the palette open it.
  const empty = (
    <div data-slot='empty-tab' className='flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center'>
      <p className='text-sm font-medium'>Nothing in this tab</p>
      <p className='max-w-xs text-xs text-muted-foreground'>
        A Block shows a thread or a terminal: a new one, or one of this Session's that isn't shown{notShown > 0 ? `, of which there ${notShown === 1 ? 'is 1' : `are ${notShown}`}` : ''}.
      </p>
      <Button aria-label='New Block' onClick={() => setAdding({ target: here() })}>
        <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
        New Block
      </Button>
    </div>
  );

  // The tabs, as pills in a pill: each with the mark of what it shows first and its name, which is
  // typed in place to rename it, and its own close. A + after them opens a new tab, and takes a
  // Block dragged onto it into one. The pill is only as wide as its tabs, scrolling when they
  // don't fit, so the rest of the rail stays empty, where on the Mac it drags the window.
  /** The mark of what a tab shows first: the Block in front, in the tab on screen. */
  const tabIcon = (listed: SessionTab) => {
    const first = (listed.id === tab.id ? focused : undefined) ?? tabBlocks(listed)[0];
    return first ? blockType(first.type).icon : undefined;
  };
  const tabMark = (listed: SessionTab) => {
    const icon = tabIcon(listed);
    return icon && (
      <span aria-hidden='true' className='grid size-5 shrink-0 place-items-center rounded-md border border-foreground/10 bg-background text-foreground/80'>
        <HugeiconsIcon icon={icon} strokeWidth={2} className='size-3' />
      </span>
    );
  };
  // On the iPhone the pill holds the tab in front alone, as wide as the rail. Tapping it lists the
  // tabs to pick from, where there's more than one, and renames it, which a double click does elsewhere.
  const phoneTabRail = (
    <>
      <div data-slot='tab-picker' className='flex h-9 min-w-0 flex-1 items-stretch rounded-full bg-muted/50 p-1'>
        <div className={cn('flex min-w-0 flex-1 items-center gap-1.5 rounded-full border border-foreground/10 bg-muted pr-0.5 pl-1 text-xs text-foreground', !tabIcon(tab) && 'pl-3')}>
          {renaming === tab.id
            ? (
              <>
                {tabMark(tab)}
                <NameInput label='Tab name' name={tab.title ?? ''} placeholder={tabName({ ...tab, title: undefined })}
                  onKeep={(next) => update((current) => renameTab(current, tab.id, next))} onDone={() => setRenaming(undefined)} />
              </>
            )
            : (
              <DropdownMenu>
                <DropdownMenuTrigger render={<button type='button' aria-label={`Tab ${tabName(tab)}, ${layout.tabs.indexOf(tab) + 1} of ${layout.tabs.length}`}
                  className='flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-full text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50' />}>
                  {tabMark(tab)}
                  <span className='min-w-0 flex-1 truncate'>{tabName(tab)}</span>
                  {layout.tabs.length > 1 && <HugeiconsIcon icon={UnfoldMoreIcon} strokeWidth={2} className='size-3.5 shrink-0 text-muted-foreground' />}
                </DropdownMenuTrigger>
                <DropdownMenuContent align='start' className='w-(--anchor-width) min-w-56'>
                  {layout.tabs.map((listed) => (
                    <DropdownMenuItem key={listed.id} aria-current={listed.id === tab.id ? 'true' : undefined}
                      onClick={() => changeView((current) => showTab(current, listed.id))}>
                      <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className={cn('size-3.5', listed.id !== tab.id && 'invisible')} />
                      {tabMark(listed)}
                      <span className='min-w-0 flex-1 truncate'>{tabName(listed)}</span>
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setRenaming(tab.id)}>Rename tab</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          <Button size='icon-xs' variant='ghost' aria-label={`Close tab ${tabName(tab)}`} title='Close tab' className='shrink-0 rounded-full opacity-60 hover:opacity-100'
            onClick={() => closeTab(tab)}>
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
          </Button>
        </div>
      </div>
      <Button size='icon' variant='ghost' aria-label='New tab' title='New tab' className='shrink-0' onClick={openTab}>
        <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
      </Button>
    </>
  );
  const tabRail = (
    <>
      <div role='tablist' aria-label='Tabs'
        className='flex h-9 min-w-0 items-stretch gap-1 overflow-x-auto rounded-full bg-muted/50 p-1 [scrollbar-width:none]'>
        {layout.tabs.map((listed) => {
          const selected = listed.id === tab.id;
          const name = tabName(listed);
          const show = () => changeView((current) => showTab(current, listed.id));
          const first = (listed.id === tab.id ? focused : undefined) ?? tabBlocks(listed)[0];
          const icon = first ? blockType(first.type).icon : undefined;
          return (
            <div key={listed.id} role='tab' tabIndex={0} aria-selected={selected} aria-label={name} data-tab-drop={listed.id} title={name}
              className={cn(
                'flex max-w-56 min-w-0 shrink-0 cursor-default items-center gap-1.5 rounded-full border border-transparent pr-0.5 pl-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
                !icon && 'pl-3',
                selected && 'border-foreground/10 bg-muted text-foreground',
              )}
              onClick={show}
              onDoubleClick={() => setRenaming(listed.id)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
                event.preventDefault();
                show();
              }}>
              {icon && (
                <span aria-hidden='true' className='grid size-5 shrink-0 place-items-center rounded-md border border-foreground/10 bg-background text-foreground/80'>
                  <HugeiconsIcon icon={icon} strokeWidth={2} className='size-3' />
                </span>
              )}
              {renaming === listed.id
                ? (
                  <NameInput label='Tab name' name={listed.title ?? ''} placeholder={tabName({ ...listed, title: undefined })}
                    onKeep={(next) => update((current) => renameTab(current, listed.id, next))} onDone={() => setRenaming(undefined)} />
                )
                : <span className='truncate'>{name}</span>}
              <Button size='icon-xs' variant='ghost' aria-label={`Close tab ${name}`} title='Close tab' className='shrink-0 rounded-full opacity-60 hover:opacity-100'
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(listed);
                }}>
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              </Button>
            </div>
          );
        })}
      </div>
      <Button size='icon' variant='ghost' aria-label='New tab' title='New tab' data-tab-drop='new' className='shrink-0' onClick={openTab}>
        <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
      </Button>
    </>
  );
  const swipe = useSwipe(stepBlock);
  const inTab = tabBlocks(tab).length;

  return (
    <section aria-label={bot ? `Bot ${bot.name}` : `Session ${sessionName}`} data-slot='session-view' data-session={session.key} data-bot={bot?.id}
      className='flex min-h-0 min-w-0 flex-1 flex-col'>
      {/* No line under it but on the iPhone: Blocks have edges of their own. */}
      <ThreadHeader leading={leading} divided={phone}>
        {bot ? <BotHeading bot={bot} unread={model.unread} onOpen={onOpenBot} /> : phone ? phoneTabRail : tabRail}
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
                  actions={blockActions} title={title} mark={mark} icon={icon} body={body} menu={menu} rename={rename} inTab={inTab} marksFocus={false} />
              </div>
            )}
            {focused
              ? <div key={focused.id} data-block-id={focused.id} role='tabpanel' className='flex min-h-0 min-w-0 flex-1 flex-col'>{body(focused)}</div>
              : empty}
          </>
        )
        : <TabBlocks tab={tab} focusedId={focused?.id} zoomedId={zoomed?.id} actions={blockActions} title={title} mark={mark} icon={icon} body={body} menu={menu} rename={rename} inTab={inTab} marksFocus={shown.length > 1} empty={empty}
            locked={locked?.id} allows={locked ? (block, target) => botAllows(layout, locked.id, block, target) : undefined} />}

      <NewBlockDialog
        open={adding !== undefined}
        onOpenChange={(open) => { if (!open) setAdding(undefined); }}
        threads={bot ? [] : hidden.filter(({ state }) => state !== 'closed')}
        closed={bot ? [] : hidden.filter(({ state }) => state === 'closed')}
        terminals={hiddenTerminals}
        elsewhere={bot ? { threads: [], terminals: elsewhere.terminals } : elsewhere}
        canTerminals={canTerminals}
        agents={bot ? [] : model.agents[session.hostId] ?? []}
        onNewThread={(agentId) => {
          const target = adding?.target ?? here();
          setAdding(undefined);
          void startThreadWith(agentId, target);
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
