// Bots in the app (WVE-178), with no I/O. A Bot opens as a Session of a kind: the one at its home
// on its Host, listed under Bots and never under a Project or its Host, with one tab and its
// Thread Block locked to the top left, showing its current thread. The app keeps the document that
// way (`botLayout`), refuses what would move another Block before it (`botAllows`), and says what
// a Bot's row in the list shows (`botRowState`).
import { type BotSummary, type HostSummary, type ProjectSummary, type ThreadSummary, threadKey } from '@/app/app-controller';
import type { BotColor, SessionBlock, SessionLayout } from '@/host/protocol';
import { THREAD_BLOCK, threadBlock, threadOf } from './blocks';
import { type Target, docked, layoutBlocks, newId, placeBlock, removeBlock, replaceBlock, tidy } from './layout';
import { containing, threadDirectory } from './sessions';

/** What a Bot's row says, most pressing first: its Host away, needs you, working, unread, idle. */
export type BotRowState = 'away' | 'needsYou' | 'working' | 'unread' | 'idle';

/**
 * What a Bot's row shows. A Bot whose Host the Dispatcher can't reach is away. Otherwise its state
 * as the Dispatcher says it, needing the person before working, then unread, which is this
 * device's own (its current thread ended a turn the person hasn't seen here), then idle.
 */
export function botRowState(bot: Pick<BotSummary, 'connected' | 'state' | 'hostId' | 'thread'>, unread: ReadonlySet<string>): BotRowState {
  if (!bot.connected) return 'away';
  if (bot.state === 'needsYou') return 'needsYou';
  if (bot.state === 'working') return 'working';
  if (bot.thread && unread.has(threadKey(bot.hostId, bot.thread))) return 'unread';
  return 'idle';
}

/** How a row's state reads. */
export const botStateLabel: Record<BotRowState, string> = {
  away: 'away',
  needsYou: 'needs you',
  working: 'working',
  unread: 'unread',
  idle: 'idle',
};

/** The colours a Bot's avatar is drawn on (WVE-223), in the order they're offered. */
export const BOT_COLORS: readonly BotColor[] = ['white', 'brown', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'gray'];

/** The emoji offered for a Bot's avatar; any other can be typed. */
export const BOT_EMOJI: readonly string[] = [
  '🤖', '🦉', '🐙', '🦊', '🐝', '🐢', '🦄', '🐳',
  '🦜', '🐺', '🧠', '👾', '🛰️', '🔭', '🧪', '📚',
  '📝', '🗂️', '📬', '🧭', '🔧', '🌱', '⚡', '✨',
];

/**
 * The emoji in what was typed for a Bot's avatar: the first one, whatever it's made of, or none
 * when what's first is a letter, a digit or nothing, as the Dispatcher would refuse it.
 */
export function typedEmoji(text: string): string | undefined {
  const [first] = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text.trim());
  const emoji = first?.segment;
  if (!emoji || /[A-Za-z0-9\s\p{Cc}]/u.test(emoji)) return undefined;
  return emoji;
}

/** How many Bots other than `except` need the person. */
export const waitingBots = (bots: readonly BotSummary[] = [], except?: string) =>
  bots.filter(({ id, state }) => state === 'needsYou' && id !== except).length;

/** The Bot whose thread `key` is, current or earlier. */
export const botOfThread = (bots: readonly BotSummary[] = [], key: string) =>
  bots.find((bot) => [...(bot.thread ? [bot.thread] : []), ...bot.threads.map(({ threadId }) => threadId)]
    .some((threadId) => threadKey(bot.hostId, threadId) === key));

/** A Bot picked in the list, as the shell keeps what's on screen: Sessions by their key, Bots so. */
const BOT = 'bot:';
export const botSelection = (id: string) => `${BOT}${id}`;
/** The Bot a selection names, if it names one. A Session's key is a Host id, a colon and an absolute path. */
export const selectedBot = (selection: string | undefined) => selection?.startsWith(BOT) && !selection.startsWith(`${BOT}/`) ? selection.slice(BOT.length) : undefined;

/** The Bot's Thread Block: the first docked Block of the first tab, as the tab reads. */
export function lockedBlock(layout: SessionLayout): SessionBlock | undefined {
  const tab = layout.tabs[0];
  return tab ? docked(tab)[0]?.block : undefined;
}

/**
 * The layout with the Bot's current thread `threadId` in its Thread Block, top left of its first
 * tab: unchanged when it is already. A Block showing the thread elsewhere moves there. A thread's
 * Block there, as one showing the thread before, gives its place to it and leaves the layout, its
 * thread running on: only a deliberate close closes a thread (ADR 0031). Anything else there has
 * the thread's Block docked to its left, along the whole tab. Other tabs stay as they are.
 */
export function botLayout(layout: SessionLayout, threadId: string, blockId = newId()): SessionLayout {
  const first = layout.tabs[0];
  if (!first) return layout;
  const top = lockedBlock(layout);
  if (top && threadOf(top) === threadId) return layout;
  const existing = layoutBlocks(layout).find((block) => threadOf(block) === threadId);
  const block = existing ?? threadBlock(threadId, blockId);
  let next = existing ? removeBlock(layout, existing.id) : layout;
  // Taking the Block out of a tab it was alone in takes the tab: the first stays first.
  if (next.tabs[0]?.id !== first.id) next = { ...next, tabs: [{ id: first.id, ...(first.title ? { title: first.title } : {}) }, ...next.tabs] };
  const tab = next.tabs[0];
  const stale = lockedBlock(next);
  if (stale?.type === THREAD_BLOCK) {
    next = replaceBlock(next, stale.id, block);
  } else if (tab.root) {
    next = placeBlock(next, block, { edge: tab.id, side: 'left' });
  } else {
    next = placeBlock(next, block, { tab: tab.id });
  }
  return tidy(next);
}

/**
 * Whether a Block may go to `target` in a Bot's Session: never the Bot's Thread Block `locked`
 * itself, never into its place, and nowhere that puts another Block before it, as on its left or
 * top edge. Its right and bottom edges, and anywhere else in the tab, are as in any Session; no
 * new tab is made.
 */
export function botAllows(layout: SessionLayout, locked: string, block: SessionBlock, target: Target): boolean {
  if (block.id === locked) return false;
  if ('swap' in target && target.swap === locked) return false;
  if ('newTab' in target) return false;
  return lockedBlock(placeBlock(layout, block, target))?.id === locked;
}

/** A Bot's earlier threads, the newest first: those a new thread took over from. */
export const earlierThreads = (bot: Pick<BotSummary, 'threads'>) =>
  bot.threads.flatMap((thread) => thread.endedAt !== undefined ? [{ ...thread, endedAt: thread.endedAt }] : [])
    .sort((left, right) => right.endedAt - left.endedAt || right.startedAt - left.startedAt);

/**
 * The listed threads a Bot's threads started, on any of the person's Hosts: those whose
 * `startedBy` leads back to one of its threads, through threads they started in turn. Its own
 * threads aren't among them.
 */
export function startedByBot(bot: Pick<BotSummary, 'hostId' | 'thread' | 'threads'>, threads: readonly ThreadSummary[]): ThreadSummary[] {
  const own = new Set([...(bot.thread ? [bot.thread] : []), ...bot.threads.map(({ threadId }) => threadId)].map((id) => threadKey(bot.hostId, id)));
  const byKey = new Map(threads.map((thread) => [thread.key, thread]));
  const leadsBack = (thread: ThreadSummary) => {
    const seen = new Set([thread.key]);
    for (let at = thread.startedBy?.key; at && !seen.has(at); at = byKey.get(at)?.startedBy?.key) {
      if (own.has(at)) return true;
      seen.add(at);
    }
    return false;
  };
  return threads.filter((thread) => !own.has(thread.key) && leadsBack(thread))
    .sort((left, right) => (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0));
}

export type StartedElsewhere = {
  /** Those in a Project's directories, by Project, as the Dispatcher places them. */
  projects: { project: ProjectSummary; threads: ThreadSummary[] }[];
  /** Those in no Project, under their Host, in the Dispatcher's order. */
  hosts: { hostId: string; host?: HostSummary; threads: ThreadSummary[] }[];
};

/** Threads grouped as the list of Sessions groups them: by Project, those in none under their Host. */
export function groupStarted(threads: readonly ThreadSummary[], projects: readonly ProjectSummary[] = [], hosts: readonly HostSummary[] = []): StartedElsewhere {
  const byProject = new Map<string, ThreadSummary[]>();
  const byHost = new Map<string, ThreadSummary[]>();
  for (const thread of threads) {
    const project = containing(projects, thread.hostId, threadDirectory(thread), thread.git?.repo);
    if (project) byProject.set(project.id, [...(byProject.get(project.id) ?? []), thread]);
    else byHost.set(thread.hostId, [...(byHost.get(thread.hostId) ?? []), thread]);
  }
  const order = (hostId: string) => {
    const at = hosts.findIndex(({ id }) => id === hostId);
    return at < 0 ? hosts.length : at;
  };
  return {
    projects: [...projects].sort((left, right) => left.name.localeCompare(right.name))
      .flatMap((project) => byProject.has(project.id) ? [{ project, threads: byProject.get(project.id) ?? [] }] : []),
    hosts: [...byHost.entries()].sort(([left], [right]) => order(left) - order(right))
      .map(([hostId, listed]) => ({ hostId, host: hosts.find(({ id }) => id === hostId), threads: listed })),
  };
}

/** A duration as the person sets one: whole hours, else minutes. */
export function durationLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}
