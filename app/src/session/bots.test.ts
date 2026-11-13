import { describe, expect, it } from 'vitest';
import type { BotSummary, HostSummary, KnownSession, ProjectSummary, ThreadSummary } from '@/app/app-controller';
import type { SessionLayout, SessionNode, SessionTab } from '@/host/protocol';
import { terminalBlock, threadBlock, threadOf } from './blocks';
import {
  botAllows,
  botLayout,
  botOfThread,
  botRowState,
  botSelection,
  durationLabel,
  earlierThreads,
  groupStarted,
  lockedBlock,
  selectedBot,
  startedByBot,
  typedEmoji,
  waitingBots,
} from './bots';
import { LAYOUT_VERSION, docked, findBlock, layoutBlocks, tidy } from './layout';
import { botDirectory, botSessionKey, ownThreads, sessionSummaries } from './sessions';

const MAC = 'h-mac';
const LAB = 'h-lab';
const HOME = '/Users/jaco/bots/scout';

const bot = (change: Partial<BotSummary> = {}): BotSummary => ({
  id: 'b-scout',
  name: 'Scout',
  agentId: 'claude',
  hostId: MAC,
  hostName: 'mac',
  connected: true,
  home: HOME,
  policy: { otherwise: 'ask' },
  zone: 'Africa/Johannesburg',
  pauseAfter: 12 * 3_600_000,
  thread: 't-now',
  threads: [{ threadId: 't-old', startedAt: 1, endedAt: 5 }, { threadId: 't-now', startedAt: 5 }],
  state: 'idle',
  createdAt: 1,
  updatedAt: 1,
  ...change,
});

const thread = (hostId: string, id: string, cwd: string, change: Partial<ThreadSummary> = {}): ThreadSummary => ({
  key: `${hostId}/${id}`,
  hostId,
  threadId: id,
  agentId: 'claude',
  agentName: 'Claude',
  cwd,
  state: 'open',
  clients: 0,
  headless: false,
  ...change,
});

const leaf = (block: { id: string; type: string; props?: Record<string, unknown> }): SessionNode => ({ kind: 'block', ...block });
const layout = (...tabs: SessionTab[]): SessionLayout => tidy({ version: LAYOUT_VERSION, tabs });
/** The first tab's docked Blocks as they read: a thread's by its thread, another by its id. */
const reading = (shown: SessionLayout, tab = 0) => docked(shown.tabs[tab]).map(({ block }) => threadOf(block) ?? block.id);

describe("a Bot's row", () => {
  it('shows needs you, working, unread and idle in that order, and away over all of them', () => {
    const unread = new Set([`${MAC}/t-now`]);
    expect(botRowState(bot({ state: 'needsYou' }), unread)).toBe('needsYou');
    expect(botRowState(bot({ state: 'working' }), unread)).toBe('working');
    expect(botRowState(bot(), unread)).toBe('unread');
    expect(botRowState(bot(), new Set())).toBe('idle');
    // Unread is its current thread's, on this device.
    expect(botRowState(bot(), new Set([`${MAC}/t-old`]))).toBe('idle');
    expect(botRowState(bot({ connected: false, state: 'needsYou' }), unread)).toBe('away');
  });

  it('counts the Bots that need the person, but the one on screen', () => {
    const bots = [bot({ state: 'needsYou' }), bot({ id: 'b-two', state: 'needsYou' }), bot({ id: 'b-three' })];
    expect(waitingBots(bots)).toBe(2);
    expect(waitingBots(bots, 'b-two')).toBe(1);
  });

  it('is picked apart from a Session by its selection', () => {
    expect(selectedBot(botSelection('b-scout'))).toBe('b-scout');
    expect(selectedBot(`${MAC}:/srv/odin`)).toBeUndefined();
    // A Host whose id happened to be "bot" names a Session still.
    expect(selectedBot('bot:/srv/odin')).toBeUndefined();
  });

  it('finds the Bot a thread is of, its current or an earlier one', () => {
    expect(botOfThread([bot()], `${MAC}/t-old`)?.id).toBe('b-scout');
    expect(botOfThread([bot()], `${MAC}/t-now`)?.id).toBe('b-scout');
    expect(botOfThread([bot()], `${LAB}/t-now`)).toBeUndefined();
  });
});

describe("a Bot's avatar", () => {
  it('takes the first emoji of what was typed, whatever it is made of, and no word', () => {
    expect(typedEmoji(' 🦉 ')).toBe('🦉');
    expect(typedEmoji('🐙🦊')).toBe('🐙');
    expect(typedEmoji('👩‍👩‍👧‍👦 family')).toBe('👩‍👩‍👧‍👦');
    expect(typedEmoji('🛰️')).toBe('🛰️');
    for (const none of ['', '   ', 'owl', '7', 'a🦉']) expect(typedEmoji(none), none).toBeUndefined();
  });
});

describe("a Bot's Session", () => {
  const threads = [thread(MAC, 't-now', HOME, { git: { repo: HOME, worktree: HOME, branch: 'main' } })];

  it('is the one at its home on its Host, or where its threads run when its home is under ~', () => {
    expect(botSessionKey(bot(), [])).toBe(`${MAC}:${HOME}`);
    expect(botDirectory(bot({ home: '~/bots/scout' }), threads)).toBe(HOME);
    expect(botDirectory(bot({ home: '~/bots/scout' }), [])).toBeUndefined();
    expect(botDirectory(bot({ home: '~/bots/scout', thread: undefined, threads: [{ threadId: 't-now', startedAt: 1, endedAt: 2 }] }), threads)).toBe(HOME);
  });

  it('is listed only as its Bot, never with the Sessions, and its thread is told of all the same', () => {
    const known: KnownSession[] = [
      { hostId: MAC, directory: HOME, threads: ['t-now'], keepsOwn: true },
      { hostId: MAC, directory: '/code/weave', threads: [], keepsOwn: true },
    ];
    const waiting = [thread(MAC, 't-now', HOME, { activity: 'waiting' })];
    const model = { threads: waiting, known, unread: new Set<string>(), bots: [bot()] };
    expect(sessionSummaries(model).map(({ directory }) => directory)).toEqual(['/code/weave']);
    // Once the Bot is removed, it's an ordinary Session.
    expect(sessionSummaries({ ...model, bots: [] }).map(({ directory }) => directory).sort()).toEqual([HOME, '/code/weave']);
    // Its current thread is the person's, though its Session isn't listed, and before one is made.
    expect(ownThreads({ threads: waiting, known: [], bots: [bot()] }).map(({ key }) => key)).toEqual([`${MAC}/t-now`]);
    expect(ownThreads({ threads: waiting, known: [] })).toEqual([]);
  });
});

describe("a Bot's Thread Block", () => {
  it('is the first docked Block of the first tab', () => {
    const shown = layout({ id: 'one', root: { kind: 'row', children: [leaf(terminalBlock('t1', 'b-term')), leaf(threadBlock('t-now', 'b-bot'))] } });
    expect(lockedBlock(shown)?.id).toBe('b-term');
    expect(lockedBlock(layout({ id: 'one' }))).toBeUndefined();
  });

  it('is made in an empty tab, and the layout is left alone once it shows the current thread', () => {
    const made = botLayout(layout({ id: 'one' }), 't-now', 'b-bot');
    expect(reading(made)).toEqual(['t-now']);
    expect(botLayout(made, 't-now', 'b-other')).toBe(made);
  });

  it("follows a new thread in place, the old thread's Block leaving the layout", () => {
    const shown = layout({
      id: 'one',
      root: { kind: 'row', sizes: [0.7, 0.3], children: [leaf(threadBlock('t-old', 'b-old')), leaf(terminalBlock('t1', 'b-term'))] },
    });
    const next = botLayout(shown, 't-now', 'b-now');
    expect(reading(next)).toEqual(['t-now', 'b-term']);
    // It takes the old one's place, sizes and all.
    expect(next.tabs[0].root).toMatchObject({ kind: 'row', sizes: [0.7, 0.3] });
    expect(findBlock(next, 'b-old')).toBeUndefined();
  });

  it('moves a Block showing the thread elsewhere, floating or in another tab, to the top left', () => {
    const floating = layout({
      id: 'one',
      root: leaf(terminalBlock('t1', 'b-term')),
      floating: [{ block: threadBlock('t-now', 'b-float'), frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } }],
    });
    const fixed = botLayout(floating, 't-now');
    expect(reading(fixed)).toEqual(['t-now', 'b-term']);
    expect(lockedBlock(fixed)?.id).toBe('b-float');
    expect(fixed.tabs[0].floating ?? []).toEqual([]);

    // Alone in the second tab, it leaves that tab; the first stays first.
    const tabs = layout({ id: 'one', root: leaf(terminalBlock('t1', 'b-term')) }, { id: 'two', root: leaf(threadBlock('t-now', 'b-two')) });
    const moved = botLayout(tabs, 't-now');
    expect(moved.tabs.map(({ id }) => id)).toEqual(['one']);
    expect(reading(moved)).toEqual(['t-now', 'b-term']);

    // Alone in the first tab beside another, after a stranger's Block: it comes first.
    const behind = layout({ id: 'one', root: { kind: 'column', children: [leaf(terminalBlock('t1', 'b-term')), leaf(threadBlock('t-now', 'b-mine'))] } });
    expect(reading(botLayout(behind, 't-now'))).toEqual(['t-now', 'b-term']);
  });

  it('leaves the other tabs as they are, and makes none', () => {
    const tabs = layout({ id: 'one' }, { id: 'two', root: leaf(terminalBlock('t1', 'b-term')) });
    const made = botLayout(tabs, 't-now', 'b-bot');
    expect(made.tabs.map(({ id }) => id)).toEqual(['one', 'two']);
    expect(reading(made)).toEqual(['t-now']);
    expect(reading(made, 1)).toEqual(['b-term']);
  });
});

describe('what may be dropped in a Bot\'s Session', () => {
  const shown = layout({ id: 'one', root: { kind: 'row', children: [leaf(threadBlock('t-now', 'b-bot')), leaf(terminalBlock('t1', 'b-term'))] } });
  const term = terminalBlock('t1', 'b-term');
  const bot_ = threadBlock('t-now', 'b-bot');

  it('never moves the Thread Block itself', () => {
    expect(botAllows(shown, 'b-bot', bot_, { beside: 'b-term', side: 'right' })).toBe(false);
    expect(botAllows(shown, 'b-bot', bot_, { floating: 'one', frame: { x: 0, y: 0, width: 0.5, height: 0.5 } })).toBe(false);
  });

  it('refuses its middle, its left and its top, and takes its right and bottom', () => {
    expect(botAllows(shown, 'b-bot', term, { swap: 'b-bot' })).toBe(false);
    expect(botAllows(shown, 'b-bot', term, { beside: 'b-bot', side: 'left' })).toBe(false);
    expect(botAllows(shown, 'b-bot', term, { beside: 'b-bot', side: 'up' })).toBe(false);
    expect(botAllows(shown, 'b-bot', term, { beside: 'b-bot', side: 'right' })).toBe(true);
    expect(botAllows(shown, 'b-bot', term, { beside: 'b-bot', side: 'down' })).toBe(true);
  });

  it('takes anywhere else that keeps it first, and no new tab', () => {
    const three = layout({
      id: 'one',
      root: { kind: 'row', children: [leaf(threadBlock('t-now', 'b-bot')), leaf(terminalBlock('t1', 'b-term')), leaf(terminalBlock('t2', 'b-two'))] },
    });
    const two = terminalBlock('t2', 'b-two');
    expect(botAllows(three, 'b-bot', two, { swap: 'b-term' })).toBe(true);
    expect(botAllows(three, 'b-bot', two, { beside: 'b-term', side: 'left' })).toBe(true);
    expect(botAllows(three, 'b-bot', two, { floating: 'one', frame: { x: 0, y: 0, width: 0.5, height: 0.5 } })).toBe(true);
    expect(botAllows(three, 'b-bot', two, { edge: 'one', side: 'left' })).toBe(false);
    expect(botAllows(three, 'b-bot', two, { newTab: { id: 'new' } })).toBe(false);
    expect(layoutBlocks(three)).toHaveLength(3);
  });
});

describe("a Bot's threads", () => {
  it('lists its earlier ones, newest first', () => {
    const listed = bot({ threads: [
      { threadId: 'a', startedAt: 1, endedAt: 2 },
      { threadId: 'b', startedAt: 2, endedAt: 3 },
      { threadId: 'c', startedAt: 3 },
    ] });
    expect(earlierThreads(listed).map(({ threadId }) => threadId)).toEqual(['b', 'a']);
  });

  it('finds what its threads started elsewhere, and what those started, grouped by Project and else by Host', () => {
    const projects: ProjectSummary[] = [{ id: 'p-weave', name: 'weave', locations: [{ hostId: MAC, path: '/code/weave' }] }];
    const hosts: HostSummary[] = [{ id: MAC, name: 'mac', status: 'connected' }, { id: LAB, name: 'lab', status: 'connected' }];
    const threads = [
      thread(MAC, 't-now', HOME),
      thread(MAC, 'fix', '/code/weave/app', { startedBy: { key: `${MAC}/t-now`, label: '' }, lastActivityAt: 3 }),
      thread(MAC, 'old-fix', '/code/weave', { startedBy: { key: `${MAC}/t-old`, label: '' }, lastActivityAt: 1 }),
      thread(LAB, 'deploy', '/srv/odin', { startedBy: { key: `${MAC}/t-now`, label: '' } }),
      thread(LAB, 'deeper', '/srv/odin', { startedBy: { key: `${LAB}/deploy`, label: '' } }),
      thread(MAC, 'mine', '/code/weave'),
      thread(MAC, 'other', '/code/weave', { startedBy: { key: `${MAC}/mine`, label: '' } }),
    ];
    const started = startedByBot(bot(), threads);
    expect(started.map(({ threadId }) => threadId).sort()).toEqual(['deeper', 'deploy', 'fix', 'old-fix']);
    const grouped = groupStarted(started, projects, hosts);
    expect(grouped.projects.map(({ project, threads: under }) => [project.name, under.map(({ threadId }) => threadId)])).toEqual([['weave', ['fix', 'old-fix']]]);
    expect(grouped.hosts.map(({ host, threads: under }) => [host?.name, under.map(({ threadId }) => threadId).sort()])).toEqual([['lab', ['deeper', 'deploy']]]);
  });

  it('says how long a request may wait in hours or minutes', () => {
    expect(durationLabel(12 * 3_600_000)).toBe('12 hours');
    expect(durationLabel(3_600_000)).toBe('1 hour');
    expect(durationLabel(90 * 60_000)).toBe('90 minutes');
  });
});
