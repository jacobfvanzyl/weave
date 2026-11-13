import { useEffect, useMemo, useReducer, useRef } from 'react';
import { createAcpShowcaseTranscript, createFinishedTurnsTranscript, createMarkdownShowcaseTranscript } from '@/chat/acp-showcase';
import { type AcpTranscript, type AcpTranscriptEvent, createTranscript, reduceAcpEvent } from '@/chat/acp-transcript';
import type { ContentBlock, McpServerStatus, SessionLayout } from '@/host/protocol';
import { terminalBlock, threadBlock } from '@/session/blocks';
import { LAYOUT_VERSION, layoutWith, tidy } from '@/session/layout';
import { sessionOfThread } from '@/session/sessions';
import {
  type AgentChoice,
  type AppController,
  type AppModel,
  type BotSummary,
  type DispatcherSummary,
  type HostSummary,
  type KnownSession,
  type OpenThread,
  type ProjectSummary,
  type PromptImage,
  type QueuedPrompt,
  type RepositoryListing,
  type ScheduleSummary,
  type TerminalSummary,
  type ThreadActions,
  type ThreadGit,
  type ThreadSummary,
  sessionKey,
  sessionOfKey,
  threadKey,
} from './app-controller';
import { ThreadReadState } from './thread-read-state';

/**
 * Fixture states for UI work and tests. `unpaired` is the pairing screen, before the app pairs
 * with the Dispatcher; `empty`, a Dispatcher no Host has joined; `unreachable`, a Host the
 * Dispatcher can't reach; `offline`, the Dispatcher itself out of reach, with the Hosts it last
 * listed; `session`, a Session someone arranged: two tabs, threads and terminals split, stacked
 * and floating, and a Block of a type the app doesn't have.
 */
export const MOCK_SCENARIOS = ['list', 'thread', 'running', 'unreachable', 'offline', 'banner', 'empty', 'unpaired', 'markdown', 'terminals', 'session'] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

/** A message the mock fails to send, so a thread's Block has an error to show (WVE-219). */
export const MOCK_FAILS = '/fail';

export const mockScenarioFromLocation = (search = location.search): MockScenario => {
  const value = new URLSearchParams(search).get('mock');
  return MOCK_SCENARIOS.find((scenario) => scenario === value) ?? 'list';
};

const MAC = 'host-mac';
const SERVER = 'host-server';
const WEAVE = '/Users/jaco/Documents/VeeZee/weave';
const MINUTE = 60_000;

const AGENTS: AgentChoice[] = [
  { id: 'claude', name: 'Claude' },
  { id: 'codex', name: 'Codex' },
  { id: 'gemini', name: 'Gemini' },
];

/** Gemini stands in for an agent that can't take steers, so its messages queue. */
const steers = (agentId: string) => agentId !== 'gemini';

const DISPATCHER: DispatcherSummary = { id: 'dispatcher-homelab', name: 'homelab', url: 'wss://homelab.tail1234.ts.net:7342', status: 'connected' };

const dispatcher = (offline: boolean, now: number): DispatcherSummary => offline
  ? { ...DISPATCHER, status: 'reconnecting', error: `Couldn't reach the Dispatcher since ${new Date(now - 2 * MINUTE).toLocaleTimeString()}.` }
  : DISPATCHER;

const hosts = (now: number, scenario: MockScenario): HostSummary[] => {
  const offline = scenario === 'offline';
  const unreachable = scenario === 'unreachable';
  return [
    {
      id: MAC,
      name: 'mac',
      status: offline ? 'reconnecting' : 'connected',
      canBrowse: true,
      canRename: true,
      canWorktree: true,
      canTerminals: true,
      canEndSessions: true,
    },
    {
      id: SERVER,
      name: 'build',
      status: offline ? 'reconnecting' : unreachable ? 'unreachable' : 'connected',
      canBrowse: true,
      canRename: true,
      canWorktree: true,
      canEndSessions: true,
      ...(unreachable ? { error: `It hasn't connected to the Dispatcher since ${new Date(now - 4 * MINUTE).toLocaleTimeString()}.` } : {}),
    },
  ];
};

/** Each Host's directories, for browsing: a path and the directories in it. */
const DIRECTORIES: Record<string, Record<string, string[]>> = {
  [MAC]: {
    '/': ['Applications', 'Users', 'Volumes'],
    '/Users': ['jaco', 'Shared'],
    '/Users/jaco': ['.config', 'Desktop', 'Documents', 'Downloads'],
    '/Users/jaco/Documents': ['Notes', 'VeeZee'],
    '/Users/jaco/Documents/VeeZee': ['rex', 'weave'],
    [WEAVE]: ['.git', 'app', 'docs', 'host', 'protocol', 'tui'],
  },
  [SERVER]: {
    '/': ['home', 'srv'],
    '/home': ['jaco'],
    '/home/jaco': ['.cache', 'weave'],
    '/home/jaco/weave': ['.git', 'app', 'docs'],
    '/srv': ['odin'],
    '/srv/odin': ['uploads'],
  },
};
const HOMES: Record<string, string> = { [MAC]: '/Users/jaco', [SERVER]: '/home/jaco' };

/** A worktree of a fixture repository. */
type MockWorktree = { path: string; branch?: string; changes: boolean };

/** Each Host's repositories, by primary worktree: their default branch and worktrees, primary first. */
type MockRepositories = Record<string, Record<string, { defaultBranch: string; remote?: string; worktrees: MockWorktree[] }>>;

const WEAVE_REMOTE = 'github.com/veezee/weave';
/** A clone of the weave repository on the build Host, which no Project has yet. */
const WEAVE_CLONE = '/home/jaco/weave';

const RECONNECT = `${WEAVE}.fix-reconnect`;

const repositories = (): MockRepositories => ({
  [MAC]: {
    [WEAVE]: {
      defaultBranch: 'main',
      remote: WEAVE_REMOTE,
      worktrees: [
        { path: WEAVE, branch: 'main', changes: false },
        { path: RECONNECT, branch: 'fix-reconnect', changes: true },
      ],
    },
  },
  [SERVER]: {
    [WEAVE_CLONE]: { defaultBranch: 'main', remote: WEAVE_REMOTE, worktrees: [{ path: WEAVE_CLONE, branch: 'main', changes: false }] },
  },
});

const onMain: ThreadGit = { repo: WEAVE, worktree: WEAVE, branch: 'main' };

const parentOf = (path: string) => path === '/' ? undefined : path.slice(0, path.lastIndexOf('/')) || '/';

const summary = (
  hostId: string,
  threadId: string,
  cwd: string,
  title: string,
  agentId: string,
  ago: number,
  now: number,
  extra: Partial<ThreadSummary> = {},
): ThreadSummary => ({
  key: threadKey(hostId, threadId),
  hostId,
  threadId,
  title,
  agentId,
  agentName: AGENTS.find(({ id }) => id === agentId)?.name ?? agentId,
  cwd,
  state: 'open',
  activity: 'idle',
  clients: 0,
  headless: false,
  lastActivityAt: now - ago * MINUTE,
  ...extra,
});

const threads = (now: number): ThreadSummary[] => [
  summary(MAC, 'fix-reconnect', RECONNECT, 'Fix the flaky reconnect test', 'claude', 1, now, {
    git: { repo: WEAVE, worktree: RECONNECT, branch: 'fix-reconnect' },
    activity: 'waiting',
    waitingOn: 'Permission to run cargo test',
    clients: 1,
  }),
  summary(MAC, 'protocol-spec', `${WEAVE}/tui`, 'Update the Host protocol spec', 'gemini', 3, now, { git: onMain, activity: 'running' }),
  summary(MAC, 'steer-tui', `${WEAVE}/tui`, 'Steer handling in the TUI', 'claude', 80, now, { git: onMain }),
  summary(MAC, 'nightly', WEAVE, 'Nightly dependency check', 'claude', 300, now, { git: onMain, headless: true }),
  summary(MAC, 'alpha-back', `${WEAVE}/app`, 'Bring Alpha back', 'claude', 2, now, { git: onMain, activity: 'running', clients: 2 }),
  summary(MAC, 'usb-latency', `${WEAVE}/trackpad`, 'USB transport latency', 'codex', 60 * 26, now, { git: onMain }),
  summary(MAC, 'pencil-hover', `${WEAVE}/trackpad`, 'Pencil hover', 'claude', 60 * 50, now, {
    git: onMain,
    state: 'closed',
    activity: undefined,
  }),
  // A worktree whose only thread closed before its Host kept Sessions: it has none.
  summary(MAC, 'old-spike', `${WEAVE}.old-spike`, 'Spike a transcript cache', 'claude', 60 * 90, now, {
    git: { repo: WEAVE, worktree: `${WEAVE}.old-spike`, branch: 'old-spike' },
    state: 'closed',
    activity: undefined,
  }),
  summary(SERVER, 'upload-failures', '/srv/odin', 'Diagnose upload failures', 'codex', 45, now),
];

const HOUR = 60 * MINUTE;
/** A Bot's home on the Mac, a repository of its own. */
const botHome = (name: string, hostId = MAC) => `${HOMES[hostId]}/bots/${name}`;
const inHome = (home: string): Partial<ThreadSummary> => ({ git: { repo: home, worktree: home, branch: 'main' } });

/**
 * The Bots (WVE-178), one for each way a row shows: needing you, working, unread, idle, its Host
 * away, no thread yet, made by another Bot, its schedules paused, and starting a new thread.
 */
const bots = (now: number): BotSummary[] => {
  const bot = (id: string, name: string, change: Partial<BotSummary> = {}): BotSummary => ({
    id,
    name,
    agentId: 'claude',
    hostId: MAC,
    hostName: 'mac',
    connected: true,
    home: botHome(name.toLowerCase()),
    policy: { otherwise: 'ask' },
    zone: 'Africa/Johannesburg',
    pauseAfter: 12 * HOUR,
    thread: `${id}-now`,
    threads: [{ threadId: `${id}-now`, startedAt: now - 30 * HOUR }],
    state: 'idle',
    createdAt: now - 20 * 24 * HOUR,
    updatedAt: now - 2 * 24 * HOUR,
    ...change,
  });
  return [
    bot('b-scout', 'Scout', { state: 'needsYou', waitingSince: now - 4 * MINUTE }),
    bot('b-builder', 'Builder', { state: 'working', agentId: 'codex' }),
    bot('b-reader', 'Reader'),
    bot('b-gardener', 'Gardener', {
      newThreadAt: '07:00',
      createdBy: 'b-scout',
      createdByName: 'Scout',
      threads: [
        { threadId: 'b-gardener-1', startedAt: now - 72 * HOUR, endedAt: now - 48 * HOUR },
        { threadId: 'b-gardener-2', startedAt: now - 48 * HOUR, endedAt: now - 24 * HOUR },
        { threadId: 'b-gardener-now', startedAt: now - 24 * HOUR },
      ],
    }),
    bot('b-archivist', 'Archivist', { hostId: SERVER, hostName: 'build', home: botHome('archivist', SERVER), connected: false }),
    bot('b-newcomer', 'Newcomer', { thread: undefined, threads: [], createdAt: now - 5 * MINUTE }),
    bot('b-sentinel', 'Sentinel', {
      state: 'needsYou',
      waitingSince: now - 14 * HOUR,
      pauseAfter: 12 * HOUR,
      paused: `a request in its thread has waited for you since ${new Date(now - 14 * HOUR).toLocaleTimeString()}, longer than 12 hours`,
    }),
    bot('b-courier', 'Courier', { state: 'working', startingThread: true }),
  ];
};

/** The Bots' threads, in their homes, and those Scout started elsewhere. */
const botThreads = (now: number): ThreadSummary[] => [
  summary(MAC, 'b-scout-now', botHome('scout'), 'Morning sweep of the issue tracker', 'claude', 4, now, {
    ...inHome(botHome('scout')),
    activity: 'waiting',
    waitingOn: 'Permission to run gh issue list',
    headless: true,
  }),
  summary(MAC, 'b-builder-now', botHome('builder'), 'Watching the nightly builds', 'codex', 1, now, { ...inHome(botHome('builder')), activity: 'running', headless: true }),
  summary(MAC, 'b-reader-now', botHome('reader'), 'Papers to read this week', 'claude', 12, now, { ...inHome(botHome('reader')), headless: true }),
  summary(MAC, 'b-gardener-1', botHome('gardener'), 'Pruning stale branches', 'claude', 48 * 60, now, { ...inHome(botHome('gardener')), state: 'closed', activity: undefined }),
  summary(MAC, 'b-gardener-2', botHome('gardener'), 'Dependency updates', 'claude', 24 * 60, now, { ...inHome(botHome('gardener')), state: 'closed', activity: undefined }),
  summary(MAC, 'b-gardener-now', botHome('gardener'), 'Tidying the docs', 'claude', 90, now, { ...inHome(botHome('gardener')), headless: true }),
  summary(MAC, 'b-sentinel-now', botHome('sentinel'), 'Disk space watch', 'claude', 14 * 60, now, {
    ...inHome(botHome('sentinel')),
    activity: 'waiting',
    waitingOn: 'Permission to delete old logs',
    headless: true,
  }),
  summary(MAC, 'b-courier-now', botHome('courier'), 'Shipping notes', 'claude', 6, now, { ...inHome(botHome('courier')), activity: 'running', headless: true }),
  // What Scout's threads started elsewhere: one in a worktree of weave, one in a directory on build.
  summary(MAC, 'scout-docs-link', `${WEAVE}.docs-link`, 'Fix the broken docs link', 'claude', 25, now, {
    git: { repo: WEAVE, worktree: `${WEAVE}.docs-link`, branch: 'docs-link' },
    startedBy: { key: threadKey(MAC, 'b-scout-now'), label: '' },
    headless: true,
  }),
  summary(SERVER, 'scout-uploads', '/srv/odin/uploads', 'Check the upload quota', 'codex', 50, now, {
    startedBy: { key: threadKey(MAC, 'b-scout-now'), label: '' },
    headless: true,
  }),
];

/** The Bots' schedules and wake-ups, by Bot. */
const botSchedules = (now: number): Record<string, ScheduleSummary[]> => ({
  'b-scout': [
    { id: 's-morning', name: 'morning-sweep', wakeUp: false, cron: '0 8 * * 1-5', zone: 'Africa/Johannesburg', prompt: 'Go through the new issues and tell me which need me.', next: 'Thu 12 Nov 08:00 SAST', nextAt: now + 11 * HOUR },
    { id: 's-wake', name: 'wake-up-1a2b3c4d5e6f', wakeUp: true, cron: '', at: now + 3 * HOUR, zone: 'Africa/Johannesburg', prompt: 'Check whether the flaky reconnect test passed on main.' },
  ],
  'b-sentinel': [
    { id: 's-disk', name: 'disk-watch', wakeUp: false, cron: '0 * * * *', zone: 'Africa/Johannesburg', prompt: 'Check free disk space on every Host.', paused: 'paused by you' },
  ],
  'b-gardener': [
    { id: 's-weekly', name: 'weekly-prune', wakeUp: false, cron: '0 9 * * 1', zone: 'Africa/Johannesburg', prompt: 'Prune merged branches.', next: 'Mon 16 Nov 09:00 SAST', nextAt: now + 4 * 24 * HOUR },
  ],
});

/** The Sessions the Hosts keep: where something was prompted or started since they kept any. */
const kept = (): KnownSession[] => [
  { hostId: MAC, directory: WEAVE, git: { repo: WEAVE, branch: 'main' }, threads: [] },
  { hostId: MAC, directory: RECONNECT, git: { repo: WEAVE, branch: 'fix-reconnect' }, threads: [] },
  { hostId: SERVER, directory: '/srv/odin', threads: [] },
];

/** `current` with a Session at `key`, as its Host makes one when a thread there is first prompted, or its layout is kept. */
const withSession = (current: MockState, key: string): MockState => {
  const { hostId, directory } = sessionOfKey(key);
  if (current.model.known?.some((known) => known.hostId === hostId && known.directory === directory)) return current;
  const git = current.model.threads.find((thread) => sessionOfThread(thread) === key)?.git;
  const made: KnownSession = { hostId, directory, ...(git ? { git: { repo: git.repo, ...(git.branch ? { branch: git.branch } : {}) } } : {}), threads: [] };
  return { ...current, model: { ...current.model, known: [...(current.model.known ?? []), made] } };
};

/** Every thread's MCP servers: weave's own, connected, one from the config, and one it skipped. */
const MCP_SERVERS: McpServerStatus[] = [
  { name: 'weave', source: 'host', transport: 'acp', state: 'connected' },
  { name: 'github', source: 'config', transport: 'stdio', state: 'passed' },
  { name: 'docs', source: 'config', state: 'skipped', reason: 'the agent does not support the sse transport' },
];

/**
 * The Mac's terminals: in the main worktree, one the `steer-tui` thread opened running its tests,
 * one another thread opened, and one nobody did, without the fields only a holder reports, as a
 * Rex block's would be; and one in the reconnect worktree whose last command failed.
 */
const terminals = (now: number): TerminalSummary[] => [
  {
    id: 't-tests',
    scope: WEAVE,
    label: 'tests',
    pwd: `${WEAVE}/tui`,
    openedFrom: 'steer-tui',
    process: 'cargo',
    size: { cols: 100, rows: 30 },
    command: { running: true, command: 'cargo test -p weave-tui' },
    programStatus: [{ state: 'working', app: 'cargo', title: 'Testing', progress: 60 }],
    startedAt: now - 20 * MINUTE,
  },
  {
    id: 't-editor',
    scope: WEAVE,
    title: 'nvim protocol/src/terminals.rs',
    pwd: `${WEAVE}/protocol`,
    openedFrom: 'protocol-spec',
    process: 'nvim',
    size: { cols: 120, rows: 40 },
    command: { running: true, command: 'nvim src/terminals.rs' },
    startedAt: now - 10 * MINUTE,
  },
  { id: 't-block', scope: WEAVE, pwd: `${WEAVE}/app`, size: { cols: 80, rows: 24 }, startedAt: now - 5 * MINUTE },
  {
    id: 't-reconnect',
    scope: RECONNECT,
    pwd: RECONNECT,
    openedFrom: 'fix-reconnect',
    process: 'zsh',
    size: { cols: 80, rows: 24 },
    command: { running: false, exitCode: 101 },
    startedAt: now - 3 * MINUTE,
  },
];

type MockState = {
  model: AppModel;
  transcripts: Record<string, AcpTranscript>;
  queued: Record<string, QueuedPrompt[]>;
  repositories: MockRepositories;
  /** By Host. */
  terminals: Record<string, TerminalSummary[]>;
  /** The Session on screen, by key. */
  sessionKey?: string;
  /** Sessions' layouts, by key: arranged, or as each first showed. */
  layouts: Record<string, SessionLayout>;
  /** The layouts someone arranged, which a Host would keep. */
  saved: string[];
  /** The threads on screen, by key. */
  shown: string[];
  /** A thread shown to read only, beside them. */
  peeked?: string;
  /** The Bots' schedules, by Bot. */
  schedules: Record<string, ScheduleSummary[]>;
};

/** The person's Projects: weave, on the Mac. */
const PROJECTS: ProjectSummary[] = [{ id: 'p-weave', name: 'weave', kind: 'git', remote: WEAVE_REMOTE, locations: [{ hostId: MAC, path: WEAVE }] }];

/** The `session` scenario's layout of the weave repository's main worktree. */
const arranged = (): SessionLayout => tidy({
  version: LAYOUT_VERSION,
  tabs: [
    {
      id: 'tab-work',
      root: {
        kind: 'row',
        sizes: [0.55, 0.45],
        children: [
          { kind: 'block', ...threadBlock('protocol-spec', 'b-spec') },
          {
            kind: 'column',
            children: [
              { kind: 'block', ...terminalBlock('t-tests', 'b-tests') },
              { kind: 'block', ...threadBlock('alpha-back', 'b-alpha') },
            ],
          },
        ],
      },
      floating: [
        { block: terminalBlock('t-block', 'b-block'), frame: { x: 0.3, y: 0.2, width: 0.4, height: 0.4 } },
        { block: threadBlock('steer-tui', 'b-steer'), frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.6 }, minimized: true },
      ],
    },
    {
      id: 'tab-notes',
      title: 'Notes',
      root: { kind: 'block', id: 'b-browser', type: 'weave.browser', props: { url: 'https://example.com/docs' } },
    },
  ],
});

/** The `markdown` scenario's thread, which shows the fake agent's rich Markdown reply. */
const MARKDOWN = 'rich-markdown';

const transcriptFor = (thread: ThreadSummary): AcpTranscript => {
  // Turns that finished before the showcase's, folded as the app shows them (WVE-218).
  const showcase = thread.threadId === MARKDOWN
    ? createMarkdownShowcaseTranscript()
    : createAcpShowcaseTranscript(createFinishedTurnsTranscript('showcase', Date.now() - 20 * 60_000));
  const transcript = { ...showcase, threadId: thread.threadId, title: thread.title };
  return thread.activity === 'running' ? reduceAcpEvent(transcript, { type: 'turn/started' }) : transcript;
};

const initialState = (scenario: MockScenario, now: number): MockState => {
  if (scenario === 'unpaired') {
    return { model: { hosts: [], threads: [], agents: {}, unread: new Set() }, transcripts: {}, queued: {}, repositories: {}, terminals: {}, layouts: {}, saved: [], shown: [], schedules: {} };
  }
  if (scenario === 'empty') {
    return { model: { dispatcher: DISPATCHER, hosts: [], threads: [], agents: {}, unread: new Set() }, transcripts: {}, queued: {}, repositories: {}, terminals: {}, layouts: {}, saved: [], shown: [], schedules: {} };
  }
  const list = [
    ...(scenario === 'markdown' ? [summary(MAC, MARKDOWN, WEAVE, 'Render rich Markdown', 'claude', 0, now, { git: onMain })] : []),
    ...threads(now),
    ...botThreads(now),
  ];
  const selectedKey = scenario === 'thread'
    ? threadKey(MAC, 'fix-reconnect')
    : scenario === 'running'
      ? threadKey(MAC, 'protocol-spec')
      : scenario === 'markdown'
        ? threadKey(MAC, MARKDOWN)
        : scenario === 'terminals'
          ? threadKey(MAC, 'steer-tui')
          : scenario === 'session'
            ? threadKey(MAC, 'protocol-spec')
            : undefined;
  const selected = list.find(({ key }) => key === selectedKey);
  const main = sessionKey(MAC, WEAVE);
  return {
    model: {
      dispatcher: dispatcher(scenario === 'offline', now),
      hosts: hosts(now, scenario),
      threads: list,
      agents: { [MAC]: AGENTS, [SERVER]: AGENTS },
      projects: PROJECTS,
      known: kept(),
      selectedKey,
      unread: new Set(),
      bots: bots(now),
      canAddBots: true,
      canManageProjects: true,
    },
    ...(selected ? { sessionKey: sessionOfThread(selected) } : {}),
    layouts: scenario === 'session' ? { [main]: arranged() } : {},
    saved: scenario === 'session' ? [main] : [],
    shown: selectedKey ? [selectedKey] : [],
    transcripts: {},
    queued: scenario === 'running' ? { [threadKey(MAC, 'protocol-spec')]: [{ id: 'q1', text: 'Then regenerate the fixtures.' }] } : {},
    repositories: repositories(),
    terminals: { [MAC]: terminals(now) },
    schedules: botSchedules(now),
  };
};

/** A Bot's state as its Dispatcher says it, from its current thread's activity as listed. */
const withBotStates = (model: AppModel): BotSummary[] | undefined => model.bots?.map((bot) => {
  const thread = bot.thread ? model.threads.find(({ key }) => key === threadKey(bot.hostId, bot.thread ?? '')) : undefined;
  if (!thread || !bot.connected) return bot;
  const state = thread.activity === 'waiting' ? 'needsYou' : thread.activity === 'running' ? 'working' : 'idle';
  return state === bot.state ? bot : { ...bot, state };
});

/** The fixture repository `path` is in on a Host, by its primary worktree. */
/**
 * What a Session shows: as someone arranged it, or else the one thread it was started with, which
 * here is the one in front or the most recently active. Its other threads have no Block yet.
 */
const layoutOf = (state: MockState, key: string): SessionLayout => {
  const known = state.layouts[key];
  if (known) return known;
  const members = state.model.threads
    .filter((thread) => thread.state !== 'closed' && sessionOfThread(thread) === key)
    .sort((left, right) => Number(right.key === state.model.selectedKey) - Number(left.key === state.model.selectedKey)
      || (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0));
  return layoutWith(members.slice(0, 1).map(({ threadId }) => threadBlock(threadId, `b-${threadId}`)), { id: 'tab-1' });
};

const repositoryOf = (repositories: MockRepositories, hostId: string, path: string) =>
  Object.entries(repositories[hostId] ?? {}).find(([, { worktrees }]) =>
    worktrees.some((worktree) => path === worktree.path || path.startsWith(`${worktree.path}/`)));

/** Where a thread in `cwd` is in the fixture repositories. */
const gitOf = (repositories: MockRepositories, hostId: string, cwd: string): ThreadGit | undefined => {
  const [repo, found] = repositoryOf(repositories, hostId, cwd) ?? [];
  const worktree = found?.worktrees
    .filter(({ path }) => cwd === path || cwd.startsWith(`${path}/`))
    .sort((left, right) => right.path.length - left.path.length)[0];
  return repo && worktree ? { repo, worktree: worktree.path, ...(worktree.branch ? { branch: worktree.branch } : {}) } : undefined;
};

let nextId = 0;
const localId = (prefix: string) => `${prefix}-${++nextId}`;

/** A controller over fixtures: turns end on their own after a moment, as a fake agent's would. */
export function useMockController(scenario: MockScenario, options: { turnMs?: number; bannerMs?: number } = {}): AppController {
  const { turnMs = 1500, bannerMs = 2500 } = options;
  const state = useRef<MockState>(undefined as unknown as MockState);
  state.current ??= initialState(scenario, Date.now());
  const readState = useRef<ThreadReadState>(undefined as unknown as ThreadReadState);
  if (!readState.current) {
    readState.current = new ThreadReadState();
    // Reader's thread ended a turn the person hasn't seen on this device.
    const reader = threadKey(MAC, 'b-reader-now');
    if (state.current.model.threads.some(({ key }) => key === reader)) {
      readState.current.observe(reader, 'running');
      readState.current.observe(reader, 'idle');
      state.current = { ...state.current, model: { ...state.current.model, unread: readState.current.unread() } };
    }
  }
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const [, render] = useReducer((value: number) => value + 1, 0);

  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => { timers.current.delete(timer); run(); }, ms);
    timers.current.add(timer);
  };

  const update = (change: (current: MockState) => MockState) => {
    const next = change(state.current);
    for (const thread of next.model.threads) readState.current.observe(thread.key, thread.activity);
    state.current = { ...next, model: { ...next.model, unread: readState.current.unread() } };
    render();
  };

  const setThread = (key: string, change: Partial<ThreadSummary>) => update((current) => ({
    ...current,
    model: {
      ...current.model,
      threads: current.model.threads.map((thread) => thread.key === key ? { ...thread, ...change } : thread),
    },
  }));

  const transcript = (key: string) => {
    const known = state.current.transcripts[key];
    if (known) return known;
    const thread = state.current.model.threads.find((item) => item.key === key);
    return thread ? transcriptFor(thread) : createTranscript(key);
  };

  const reduce = (key: string, ...events: AcpTranscriptEvent[]) => update((current) => ({
    ...current,
    transcripts: { ...current.transcripts, [key]: events.reduce(reduceAcpEvent, transcript(key)) },
  }));

  const userMessage = (text: string, images: PromptImage[] = [], steer = false): AcpTranscriptEvent => ({
    type: 'prompt',
    own: true,
    ...(steer ? { steer } : {}),
    prompt: [
      ...(text ? [{ type: 'text', text } as ContentBlock] : []),
      ...images.map(({ mimeType, data }): ContentBlock => ({ type: 'image', mimeType, data })),
    ],
  });

  const startTurn = (key: string, text: string, images?: PromptImage[]) => {
    // A thread's first prompt makes its directory's Session, on a Host.
    const prompted = state.current.model.threads.find((thread) => thread.key === key);
    if (prompted) update((current) => withSession(current, sessionOfThread(prompted)));
    reduce(key, userMessage(text, images), { type: 'turn/started' });
    setThread(key, { activity: 'running', lastActivityAt: Date.now() });
    later(turnMs, () => finishTurn(key));
  };

  const finishTurn = (key: string) => {
    if (transcript(key).turn.status !== 'running') return;
    reduce(
      key,
      { type: 'session/update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done. This reply is from the mock controller.' } } },
      // As the Host journals a turn's end, and then says so live.
      { type: 'turn/ended', stopReason: 'end_turn' },
      { type: 'turn/stopped', stopReason: 'end_turn' },
    );
    setThread(key, { activity: 'idle', waitingOn: undefined, lastActivityAt: Date.now() });
    const [next, ...rest] = state.current.queued[key] ?? [];
    if (!next) return;
    update((current) => ({ ...current, queued: { ...current.queued, [key]: rest } }));
    startTurn(key, next.text, next.images);
  };

  useEffect(() => {
    if (scenario !== 'banner') return;
    later(bannerMs, () => {
      const key = threadKey(MAC, 'alpha-back');
      if (state.current.model.selectedKey === key) return;
      setThread(key, { activity: 'waiting', waitingOn: 'Permission to edit app/src/App.tsx' });
    });
  }, [scenario, bannerMs]);

  useEffect(() => () => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current.clear();
  }, []);

  const { model } = state.current;
  const openThread = (key: string): OpenThread | undefined => {
    const summary = model.threads.find((item) => item.key === key);
    return summary && {
      key,
      transcript: transcript(key),
      canSteer: steers(summary.agentId),
      queued: state.current.queued[key] ?? [],
      canAttachImages: true,
      mcpServers: MCP_SERVERS,
    };
  };
  const open: Record<string, OpenThread> = {};
  for (const key of new Set([...state.current.shown, ...(model.selectedKey ? [model.selectedKey] : []), ...(state.current.peeked ? [state.current.peeked] : [])])) {
    const thread = openThread(key);
    if (thread) open[key] = thread;
  }
  const thread = model.selectedKey ? open[model.selectedKey] : undefined;
  const shownSession = state.current.sessionKey ? sessionOfKey(state.current.sessionKey) : undefined;
  const session = state.current.sessionKey && shownSession
    ? {
        key: state.current.sessionKey,
        ...shownSession,
        layout: layoutOf(state.current, state.current.sessionKey),
        saved: state.current.saved.includes(state.current.sessionKey),
        terminals: (state.current.terminals[shownSession.hostId] ?? []).filter(({ scope }) => scope === shownSession.directory),
      }
    : undefined;

  const actions = useMemo<AppController['actions']>(() => {
    const selectedKey = () => state.current.model.selectedKey;
    const shownHost = () => state.current.sessionKey ? sessionOfKey(state.current.sessionKey) : undefined;
    const setTerminals = (hostId: string, change: (terminals: TerminalSummary[]) => TerminalSummary[]) => update((current) => ({
      ...current,
      terminals: { ...current.terminals, [hostId]: change(current.terminals[hostId] ?? []) },
    }));
    const selectThread = (key?: string) => {
      readState.current.focus(key);
      update((current) => ({ ...current, shown: key ? [key] : [], model: { ...current.model, selectedKey: key } }));
    };
    /** What failed in a thread shows in its own Block (`threadErrors`), until dismissed or tried again. */
    const setThreadError = (key: string, message: string | undefined) => update((current) => {
      const { [key]: _, ...rest } = current.model.threadErrors ?? {};
      return { ...current, model: { ...current.model, threadErrors: message ? { ...rest, [key]: message } : rest } };
    });
    /** What's done in one thread: in the one `pick` gives when it's done. */
    const threadActions = (pick: () => string | undefined): ThreadActions => ({
    send(text, images) {
      const key = pick();
      if (!key) return;
      setThreadError(key, text.trim() === MOCK_FAILS ? "Couldn't start the turn: the mock was asked to fail." : undefined);
      if (text.trim() === MOCK_FAILS) return;
      const current = state.current.model.threads.find((item) => item.key === key);
      if (transcript(key).turn.status !== 'running') {
        startTurn(key, text, images);
      } else if (current && steers(current.agentId)) {
        reduce(key, userMessage(text, images, true));
      } else {
        update((latest) => ({
          ...latest,
          queued: { ...latest.queued, [key]: [...(latest.queued[key] ?? []), { id: localId('queued'), text, ...(images?.length ? { images } : {}) }] },
        }));
      }
    },
    reopenThread() {
      const key = pick();
      if (!key) return;
      reduce(key, { type: 'agent/reopened', text: 'Reopened this thread in a new agent process', failed: false });
    },
    updateAgent() {
      const key = pick();
      if (!key) return;
      reduce(key, { type: 'agent/reopened', text: 'Reopened this thread in a new agent process', failed: false });
    },
    removeQueued(id) {
      const key = pick();
      if (!key) return;
      update((current) => ({
        ...current,
        queued: { ...current.queued, [key]: (current.queued[key] ?? []).filter((item) => item.id !== id) },
      }));
    },
    // The mock's queue never pauses.
    resumeQueue() {},
    dismissError() {
      const key = pick();
      if (key) setThreadError(key, undefined);
    },
    cancelTurn() {
      const key = pick();
      if (!key) return;
      reduce(key, { type: 'turn/ended', stopReason: 'cancelled' }, { type: 'turn/stopped', stopReason: 'cancelled' });
      setThread(key, { activity: 'idle', waitingOn: undefined });
    },
    respondToPermission(requestId, optionId) {
      const key = pick();
      if (!key) return;
      reduce(key, { type: 'permission/resolved', requestId, optionId });
      setThread(key, { activity: transcript(key).turn.status === 'running' ? 'running' : 'idle', waitingOn: undefined });
    },
    respondToElicitation(requestId, response) {
      const key = pick();
      if (!key) return;
      reduce(key, { type: 'elicitation/resolved', requestId, response });
      setThread(key, { activity: transcript(key).turn.status === 'running' ? 'running' : 'idle', waitingOn: undefined });
    },
    setMode(modeId) {
      const key = pick();
      if (!key) return;
      reduce(key, { type: 'session/update', update: { sessionUpdate: 'current_mode_update', currentModeId: modeId } });
    },
    setConfigOption(optionId, value) {
      const key = pick();
      if (!key) return;
      const configOptions = transcript(key).configOptions.map((option) =>
        option.id !== optionId
          ? option
          : option.type === 'boolean'
            ? { ...option, currentValue: Boolean(value) }
            : { ...option, currentValue: String(value) });
      reduce(key, { type: 'session/update', update: { sessionUpdate: 'config_option_update', configOptions } });
    },
    });
    /** A Session's layout stays as it first showed from then on, as a Host's would once kept. */
    const keep = (current: MockState, key: string): MockState =>
      current.layouts[key] ? current : { ...current, layouts: { ...current.layouts, [key]: layoutOf(current, key) } };
    const perThread = new Map<string, ThreadActions>();
    const setBots = (change: (list: BotSummary[]) => BotSummary[]) => update((current) => ({
      ...current,
      model: { ...current.model, bots: change(current.model.bots ?? []) },
    }));
    const setBot = (id: string, change: (bot: BotSummary) => BotSummary) => setBots((list) => list.map((bot) => bot.id === id ? change(bot) : bot));
    return {
      selectThread,
      selectSession(key) {
        update((current) => key ? { ...keep(current, key), sessionKey: key } : { ...current, sessionKey: undefined });
      },
      showThreads(keys, front) {
        const shown = [...new Set([...keys, ...(front ? [front] : [])])];
        const current = state.current;
        if (current.model.selectedKey === front && shown.length === current.shown.length && shown.every((key) => current.shown.includes(key))) return;
        readState.current.focus(front);
        update((latest) => ({ ...latest, shown, model: { ...latest.model, selectedKey: front } }));
      },
      forThread(key) {
        let actions = perThread.get(key);
        if (!actions) {
          actions = threadActions(() => key);
          perThread.set(key, actions);
        }
        return actions;
      },
      updateLayout(key, change) {
        update((current) => {
          const shown = keep(withSession(current, key), key);
          return { ...shown, layouts: { ...shown.layouts, [key]: tidy(change(shown.layouts[key])) }, saved: [...new Set([...shown.saved, key])] };
        });
      },
      async endSession(key) {
        const members = state.current.model.threads.filter((thread) => sessionOfThread(thread) === key && thread.state !== 'closed');
        if (members.some(({ activity }) => activity === 'running' || activity === 'waiting')) {
          throw new Error('A thread in it is running a turn or waiting on you. Let it finish, or stop it, first.');
        }
        const { hostId, directory } = sessionOfKey(key);
        update((current) => {
          const { [key]: _layout, ...layouts } = current.layouts;
          return {
            ...current,
            layouts,
            saved: current.saved.filter((saved) => saved !== key),
            ...(current.sessionKey === key ? { sessionKey: undefined } : {}),
            shown: current.shown.filter((shown) => !members.some((member) => member.key === shown)),
            terminals: { ...current.terminals, [hostId]: (current.terminals[hostId] ?? []).filter(({ scope }) => scope !== directory) },
            model: {
              ...current.model,
              known: (current.model.known ?? []).filter((known) => !(known.hostId === hostId && known.directory === directory)),
              threads: current.model.threads.map((thread) => members.some((member) => member.key === thread.key) ? { ...thread, state: 'closed' as const, activity: undefined } : thread),
              selectedKey: members.some((member) => member.key === current.model.selectedKey) ? undefined : current.model.selectedKey,
            },
          };
        });
      },
      createThread({ hostId, cwd, agentId }) {
        const threadId = localId('thread');
        const git = gitOf(state.current.repositories, hostId, cwd);
        const created = summary(hostId, threadId, cwd, '', agentId, 0, Date.now(), git ? { git } : {});
        update((current) => ({
          ...current,
          transcripts: { ...current.transcripts, [created.key]: createTranscript(threadId) },
          shown: [...current.shown, created.key],
          model: { ...current.model, threads: [created, ...current.model.threads], selectedKey: created.key },
        }));
        return { key: created.key, sessionKey: sessionOfThread(created) };
      },
      async listDirectory({ hostId, path, hidden }) {
        const home = HOMES[hostId] ?? '/';
        const listed = path ?? home;
        const directories = DIRECTORIES[hostId]?.[listed] ?? (listed.startsWith('/') ? [] : undefined);
        if (!directories) throw new Error(`${listed} isn't an absolute path`);
        const parent = parentOf(listed);
        return {
          path: listed,
          ...(parent ? { parent } : {}),
          home,
          directories: directories.filter((name) => hidden || !name.startsWith('.')),
          truncated: false,
        };
      },
      async listWorktrees({ hostId, path }): Promise<RepositoryListing | undefined> {
        const [repo, found] = repositoryOf(state.current.repositories, hostId, path) ?? [];
        if (!repo || !found) return undefined;
        return {
          repo,
          ...(found.remote ? { remote: found.remote } : {}),
          defaultBranch: found.defaultBranch,
          worktrees: found.worktrees.map((worktree, index) => ({
            ...worktree,
            primary: index === 0,
            threads: state.current.model.threads
              .filter((thread) => thread.hostId === hostId && thread.git?.worktree === worktree.path)
              .map(({ threadId }) => threadId),
          })),
        };
      },
      async createWorktree({ hostId, repo: dir, branch }) {
        const [repo, found] = repositoryOf(state.current.repositories, hostId, dir) ?? [];
        if (!repo || !found) throw new Error(`Couldn't make the worktree: ${dir} isn't in a git repository`);
        if (!branch.trim() || /\s|\.\./.test(branch)) throw new Error(`Couldn't make the worktree: "${branch}" isn't a branch name`);
        const taken = found.worktrees.find((worktree) => worktree.branch === branch);
        if (taken) throw new Error(`Couldn't make the worktree: ${branch} is checked out in ${taken.path} already`);
        const path = `${repo}.${branch.replaceAll('/', '-')}`;
        update((current) => ({
          ...current,
          repositories: {
            ...current.repositories,
            [hostId]: {
              ...current.repositories[hostId],
              [repo]: { ...found, worktrees: [...found.worktrees, { path, branch, changes: false }] },
            },
          },
        }));
        return path;
      },
      async removeWorktree({ hostId, path, force }) {
        const [repo, found] = repositoryOf(state.current.repositories, hostId, path) ?? [];
        const worktree = found?.worktrees.find((item) => item.path === path);
        if (!repo || !found || !worktree || worktree.path === repo) throw new Error(`Couldn't remove the worktree: ${path} isn't one that can be removed`);
        const inside = state.current.model.threads.filter((thread) => thread.hostId === hostId && thread.git?.worktree === path);
        if (inside.some(({ activity }) => activity === 'running' || activity === 'waiting')) {
          throw new Error('A thread in it is running a turn or waiting on you. Let it finish, or stop it, first.');
        }
        if (worktree.changes && !force) return { outcome: 'hasChanges' };
        update((current) => ({
          ...current,
          repositories: {
            ...current.repositories,
            [hostId]: { ...current.repositories[hostId], [repo]: { ...found, worktrees: found.worktrees.filter((item) => item !== worktree) } },
          },
          model: {
            ...current.model,
            threads: current.model.threads.map((thread) => inside.includes(thread)
              ? { ...thread, state: 'closed', activity: undefined, waitingOn: undefined }
              : thread),
            selectedKey: inside.some(({ key }) => key === current.model.selectedKey) ? undefined : current.model.selectedKey,
          },
        }));
        return { outcome: 'removed', ...(worktree.branch ? { branch: worktree.branch } : {}), branchDeleted: false };
      },
      renameThread(key, title) {
        setThread(key, { title });
        reduce(key, { type: 'thread/renamed', title, by: 'You' });
      },
      closeThread(key) {
        setThread(key, { state: 'closed', activity: undefined, waitingOn: undefined });
        if (selectedKey() === key) selectThread(undefined);
      },
      deleteThread(key) {
        readState.current.forget(key);
        update((current) => ({
          ...current,
          model: {
            ...current.model,
            threads: current.model.threads.filter((item) => item.key !== key),
            selectedKey: current.model.selectedKey === key ? undefined : current.model.selectedKey,
          },
        }));
      },
      pairDispatcher({ url, code }) {
        const parsed = new URL(url);
        if (!code.trim()) throw new Error('The pairing code is missing.');
        const now = Date.now();
        update((current) => ({
          ...current,
          model: {
            ...current.model,
            dispatcher: { ...DISPATCHER, name: parsed.hostname.split('.')[0], url },
            hosts: hosts(now, 'list'),
            threads: [...threads(now), ...botThreads(now)],
            agents: { [MAC]: AGENTS, [SERVER]: AGENTS },
            projects: PROJECTS,
            known: kept(),
            bots: bots(now),
            canAddBots: true,
            canManageProjects: true,
          },
          repositories: repositories(),
          terminals: { [MAC]: terminals(now) },
          schedules: botSchedules(now),
        }));
      },
      forgetDispatcher() {
        update((current) => ({
          ...current,
          sessionKey: undefined,
          shown: [],
          model: { ...current.model, dispatcher: undefined, hosts: [], threads: [], agents: {}, known: [], selectedKey: undefined, bots: undefined, canAddBots: undefined, projects: undefined, canManageProjects: undefined },
        }));
      },
      reconnectDispatcher() {
        update((current) => ({
          ...current,
          model: {
            ...current.model,
            ...(current.model.dispatcher ? { dispatcher: { ...current.model.dispatcher, status: 'connected', error: undefined } } : {}),
            hosts: current.model.hosts.map((host) => host.status === 'reconnecting' ? { ...host, status: 'connected' } : host),
          },
        }));
      },
      reconnectHost(hostId) {
        update((current) => ({
          ...current,
          model: {
            ...current.model,
            hosts: current.model.hosts.map((host) => host.id === hostId ? { ...host, status: 'connected', error: undefined } : host),
          },
        }));
      },
      ...threadActions(selectedKey),
      peekThread(key) {
        update((current) => ({ ...current, peeked: key }));
      },
      async addBot({ name, hostId, agentId }) {
        const named = name.trim();
        if (!named) throw new Error('A Bot needs a name.');
        if (state.current.model.bots?.some((bot) => bot.name.toLowerCase() === named.toLowerCase())) throw new Error(`There's a Bot called ${named} already.`);
        const host = state.current.model.hosts.find(({ id }) => id === hostId);
        if (!host || host.status !== 'connected') {
          throw new Error(`${host?.name ?? 'That Host'} isn't connected to the Dispatcher now, so it can't make ${named}'s home; add the Bot once it's back`);
        }
        const now = Date.now();
        const made: BotSummary = {
          id: localId('b'),
          name: named,
          agentId,
          hostId,
          hostName: host.name,
          connected: true,
          home: `${HOMES[hostId] ?? '/home'}/bots/${named.toLowerCase().replaceAll(/[\s/]+/g, '-')}`,
          policy: { otherwise: 'ask' },
          zone: 'Africa/Johannesburg',
          pauseAfter: 12 * HOUR,
          threads: [],
          state: 'idle',
          createdAt: now,
          updatedAt: now,
        };
        setBots((list) => [...list, made].sort((left, right) => left.name.localeCompare(right.name)));
        return made;
      },
      async updateBot(id, change) {
        if (change.name !== undefined && state.current.model.bots?.some((bot) => bot.id !== id && bot.name.toLowerCase() === change.name?.toLowerCase())) {
          throw new Error(`There's a Bot called ${change.name} already.`);
        }
        if (change.newThreadAt && !/^\d{2}:\d{2}$/.test(change.newThreadAt)) throw new Error(`"${change.newThreadAt}" isn't a time of day, HH:MM.`);
        setBot(id, (bot) => {
          const { mode: _mode, newThreadAt: _at, ...rest } = bot;
          const mode = change.mode === undefined ? bot.mode : change.mode ?? undefined;
          const newThreadAt = change.newThreadAt === undefined ? bot.newThreadAt : change.newThreadAt ?? undefined;
          return {
            ...rest,
            ...(change.name ? { name: change.name } : {}),
            ...(change.zone ? { zone: change.zone } : {}),
            ...(change.pauseAfter ? { pauseAfter: change.pauseAfter } : {}),
            ...(change.policy ? { policy: change.policy } : {}),
            ...(mode ? { mode } : {}),
            ...(newThreadAt ? { newThreadAt } : {}),
            updatedAt: Date.now(),
          };
        });
      },
      async removeBot(id) {
        setBots((list) => list.filter((bot) => bot.id !== id));
      },
      async newBotThread(id) {
        const bot = state.current.model.bots?.find((listed) => listed.id === id);
        if (!bot?.thread) throw new Error(`${bot?.name ?? 'The Bot'} has no thread yet.`);
        if (bot.startingThread) throw new Error(`${bot.name} is starting a new thread already.`);
        setBot(id, (current) => ({ ...current, startingThread: true }));
        later(turnMs, () => {
          const current = state.current.model.bots?.find((listed) => listed.id === id);
          if (!current?.thread) return;
          const threadId = localId(`${id}-thread`);
          const old = threadKey(current.hostId, current.thread);
          const made = summary(current.hostId, threadId, current.home, `${current.name}, carrying on`, current.agentId, 0, Date.now(), { ...inHome(current.home), headless: true });
          const now = Date.now();
          update((latest) => ({
            ...latest,
            transcripts: { ...latest.transcripts, [made.key]: createTranscript(threadId) },
            model: {
              ...latest.model,
              threads: [made, ...latest.model.threads.map((thread) => thread.key === old ? { ...thread, continuedIn: { key: made.key, label: `“${made.title}”` } } : thread)],
            },
          }));
          setBot(id, ({ startingThread: _starting, ...rest }) => ({
            ...rest,
            thread: threadId,
            threads: [...rest.threads.map((thread) => thread.threadId === current.thread ? { ...thread, endedAt: now } : thread), { threadId, startedAt: now }],
          }));
        });
      },
      async sendToBot(id, text, images) {
        const bot = state.current.model.bots?.find((listed) => listed.id === id);
        if (!bot) throw new Error('That Bot is gone.');
        if (bot.thread) {
          startTurn(threadKey(bot.hostId, bot.thread), text, images);
          return;
        }
        // Its first prompt starts its first thread, in its home, a moment later.
        const threadId = localId(`${id}-thread`);
        later(600, () => {
          const made = summary(bot.hostId, threadId, bot.home, text.slice(0, 60) || 'First thread', bot.agentId, 0, Date.now(), { ...inHome(bot.home), headless: true });
          update((latest) => ({
            ...latest,
            transcripts: { ...latest.transcripts, [made.key]: createTranscript(threadId) },
            model: { ...latest.model, threads: [made, ...latest.model.threads] },
          }));
          setBot(id, (current) => ({ ...current, thread: threadId, threads: [{ threadId, startedAt: Date.now() }] }));
          startTurn(made.key, text, images);
        });
      },
      async botSchedules(id) {
        return state.current.schedules[id] ?? [];
      },
      async changeSchedule(id, action) {
        update((current) => ({
          ...current,
          schedules: Object.fromEntries(Object.entries(current.schedules).map(([botId, list]) => [botId, list.flatMap((schedule): ScheduleSummary[] => {
            if (schedule.id !== id) return [schedule];
            switch (action) {
              case 'remove': return [];
              case 'pause': return [{ ...schedule, paused: 'paused by you' }];
              case 'resume': {
                const { paused: _paused, ...rest } = schedule;
                return [rest];
              }
              case 'run': return [{ ...schedule, last: { state: 'started', at: Date.now() } }];
            }
          })])),
        }));
      },
      async startTerminal({ hostId, directory }) {
        const host = state.current.model.hosts.find(({ id }) => id === hostId);
        if (!host || host.status !== 'connected') throw new Error(`${host?.name ?? 'The Host'} isn't connected.`);
        if (!host.canTerminals) throw new Error(`${host.name} has no terminals.`);
        const id = localId('terminal');
        const scope = gitOf(state.current.repositories, hostId, directory)?.worktree ?? directory;
        setTerminals(hostId, (list) => [...list, { id, scope, pwd: directory, process: 'zsh', size: { cols: 80, rows: 24 }, command: { running: false }, startedAt: Date.now() }]);
        return { id, sessionKey: sessionKey(hostId, scope) };
      },
      async addProject({ name, location }) {
        const named = name.trim();
        const listed = state.current.model.projects ?? [];
        if (!named) throw new Error('a Project needs a name');
        if (listed.some((project) => project.name.toLowerCase() === named.toLowerCase())) throw new Error(`there's a Project called ${named} already`);
        const taken = listed.find((project) => project.locations.some(({ hostId, path }) => hostId === location.hostId && path === location.path));
        if (taken) throw new Error(`${location.path} is ${taken.name}'s already`);
        const made: ProjectSummary = {
          id: localId('p'),
          name: named,
          kind: location.kind,
          ...(location.remote ? { remote: location.remote } : {}),
          locations: [{ hostId: location.hostId, path: location.path }],
        };
        update((current) => ({ ...current, model: { ...current.model, projects: [...(current.model.projects ?? []), made].sort((left, right) => left.name.localeCompare(right.name)) } }));
        return made;
      },
      async updateProject(id, { name, removeHost, add }) {
        const listed = state.current.model.projects ?? [];
        const project = listed.find((candidate) => candidate.id === id);
        if (!project) throw new Error(`there's no Project ${id}`);
        const named = name?.trim();
        if (name !== undefined && !named) throw new Error('a Project needs a name');
        if (named && listed.some((other) => other.id !== id && other.name.toLowerCase() === named.toLowerCase())) throw new Error(`there's a Project called ${named} already`);
        let locations = removeHost ? project.locations.filter(({ hostId }) => hostId !== removeHost) : project.locations;
        if (add) {
          if (project.kind && add.kind !== project.kind) throw new Error(`${project.name} is a ${project.kind} Project, and ${add.path} is ${add.kind === 'git' ? 'a repository' : 'a directory outside one'}`);
          if (project.remote && add.remote !== project.remote) throw new Error(`${add.path} isn't a clone of ${project.name}'s repository`);
          if (locations.some(({ hostId, path }) => hostId === add.hostId && path !== add.path)) throw new Error(`${project.name} has a location on that Host already`);
          locations = [...locations.filter(({ hostId }) => hostId !== add.hostId), { hostId: add.hostId, path: add.path }];
        }
        const changed: ProjectSummary = { ...project, ...(named ? { name: named } : {}), ...(!project.remote && add?.remote ? { remote: add.remote } : {}), locations };
        update((current) => ({
          ...current,
          model: { ...current.model, projects: (current.model.projects ?? []).map((candidate) => candidate.id === id ? changed : candidate).sort((left, right) => left.name.localeCompare(right.name)) },
        }));
        return changed;
      },
      async removeProject(id) {
        update((current) => ({ ...current, model: { ...current.model, projects: (current.model.projects ?? []).filter((project) => project.id !== id) } }));
      },
      async newTerminal() {
        const shown = shownHost();
        if (!shown) throw new Error('No Session is open.');
        const id = localId('terminal');
        setTerminals(shown.hostId, (list) => [...list, {
          id,
          scope: shown.directory,
          pwd: shown.directory,
          process: 'zsh',
          size: { cols: 80, rows: 24 },
          command: { running: false },
          startedAt: Date.now(),
        }]);
        return id;
      },
      async closeTerminal(id) {
        const shown = shownHost();
        if (shown) setTerminals(shown.hostId, (list) => list.filter((terminal) => terminal.id !== id));
      },
      async renameTerminal(id, label) {
        const shown = shownHost();
        if (!shown) return;
        setTerminals(shown.hostId, (list) => list.map((terminal) => {
          if (terminal.id !== id) return terminal;
          const { label: _previous, ...rest } = terminal;
          return label?.trim() ? { ...rest, label: label.trim() } : rest;
        }));
      },
      async attachTerminal() {
        throw new Error('The mock has no Host to stream terminals from.');
      },
    };
    // The actions read the latest state through refs, so they never change.
  }, []);

  const botList = withBotStates(model);
  return { model: { ...model, thread, open, ...(session ? { session } : {}), ...(botList ? { bots: botList } : {}) }, actions };
}
