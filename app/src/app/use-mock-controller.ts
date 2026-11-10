import { useEffect, useMemo, useReducer, useRef } from 'react';
import { createAcpShowcaseTranscript, createMarkdownShowcaseTranscript } from '@/chat/acp-showcase';
import { type AcpTranscript, type AcpTranscriptEvent, createTranscript, reduceAcpEvent } from '@/chat/acp-transcript';
import type { ContentBlock, McpServerStatus, SessionLayout } from '@/host/protocol';
import { terminalBlock, threadBlock } from '@/session/blocks';
import { LAYOUT_VERSION, firstLayout, tidy } from '@/session/layout';
import { sessionOfThread } from '@/session/sessions';
import {
  type AgentChoice,
  type AppController,
  type AppModel,
  type DispatcherSummary,
  type HostSummary,
  type KnownSession,
  type OpenThread,
  type ProjectSummary,
  type PromptImage,
  type QueuedPrompt,
  type RepositoryListing,
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
    '/home/jaco': ['.cache'],
    '/srv': ['odin'],
    '/srv/odin': ['uploads'],
  },
};
const HOMES: Record<string, string> = { [MAC]: '/Users/jaco', [SERVER]: '/home/jaco' };

/** A worktree of a fixture repository. */
type MockWorktree = { path: string; branch?: string; changes: boolean };

/** Each Host's repositories, by primary worktree: their default branch and worktrees, primary first. */
type MockRepositories = Record<string, Record<string, { defaultBranch: string; worktrees: MockWorktree[] }>>;

const RECONNECT = `${WEAVE}.fix-reconnect`;

const repositories = (): MockRepositories => ({
  [MAC]: {
    [WEAVE]: {
      defaultBranch: 'main',
      worktrees: [
        { path: WEAVE, branch: 'main', changes: false },
        { path: RECONNECT, branch: 'fix-reconnect', changes: true },
      ],
    },
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
};

/** The person's Projects: weave, on the Mac. */
const PROJECTS: ProjectSummary[] = [{ id: 'p-weave', name: 'weave', locations: [{ hostId: MAC, path: WEAVE }] }];

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
          { kind: 'stack', children: [threadBlock('protocol-spec', 'b-spec'), threadBlock('steer-tui', 'b-steer')] },
          {
            kind: 'column',
            children: [
              { kind: 'stack', children: [terminalBlock('t-tests', 'b-tests')] },
              { kind: 'stack', children: [threadBlock('alpha-back', 'b-alpha')] },
            ],
          },
        ],
      },
      floating: [{ block: terminalBlock('t-block', 'b-block'), frame: { x: 0.3, y: 0.2, width: 0.4, height: 0.4 } }],
    },
    {
      id: 'tab-notes',
      title: 'Notes',
      root: { kind: 'stack', children: [{ id: 'b-browser', type: 'weave.browser', props: { url: 'https://example.com/docs' } }] },
    },
  ],
});

/** The `markdown` scenario's thread, which shows the fake agent's rich Markdown reply. */
const MARKDOWN = 'rich-markdown';

const transcriptFor = (thread: ThreadSummary): AcpTranscript => {
  const showcase = thread.threadId === MARKDOWN ? createMarkdownShowcaseTranscript() : createAcpShowcaseTranscript();
  const transcript = { ...showcase, threadId: thread.threadId, title: thread.title };
  return thread.activity === 'running' ? reduceAcpEvent(transcript, { type: 'turn/started' }) : transcript;
};

const initialState = (scenario: MockScenario, now: number): MockState => {
  if (scenario === 'unpaired') {
    return { model: { hosts: [], threads: [], agents: {}, unread: new Set() }, transcripts: {}, queued: {}, repositories: {}, terminals: {}, layouts: {}, saved: [], shown: [] };
  }
  if (scenario === 'empty') {
    return { model: { dispatcher: DISPATCHER, hosts: [], threads: [], agents: {}, unread: new Set() }, transcripts: {}, queued: {}, repositories: {}, terminals: {}, layouts: {}, saved: [], shown: [] };
  }
  const list = scenario === 'markdown'
    ? [summary(MAC, MARKDOWN, WEAVE, 'Render rich Markdown', 'claude', 0, now, { git: onMain }), ...threads(now)]
    : threads(now);
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
    },
    ...(selected ? { sessionKey: sessionOfThread(selected) } : {}),
    layouts: scenario === 'session' ? { [main]: arranged() } : {},
    saved: scenario === 'session' ? [main] : [],
    shown: selectedKey ? [selectedKey] : [],
    transcripts: {},
    queued: scenario === 'running' ? { [threadKey(MAC, 'protocol-spec')]: [{ id: 'q1', text: 'Then regenerate the fixtures.' }] } : {},
    repositories: repositories(),
    terminals: { [MAC]: terminals(now) },
  };
};

/** The fixture repository `path` is in on a Host, by its primary worktree. */
/**
 * What a Session shows: as someone arranged it, or its open threads in one pane, the one in front
 * first and then the most recently active.
 */
const layoutOf = (state: MockState, key: string): SessionLayout => {
  const known = state.layouts[key];
  if (known) return known;
  const members = state.model.threads
    .filter((thread) => thread.state !== 'closed' && sessionOfThread(thread) === key)
    .sort((left, right) => Number(right.key === state.model.selectedKey) - Number(left.key === state.model.selectedKey)
      || (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0));
  return firstLayout(members.map(({ threadId }) => threadBlock(threadId, `b-${threadId}`)), { id: 'tab-1' });
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
  const readState = useRef(new ThreadReadState());
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
  for (const key of new Set([...state.current.shown, ...(model.selectedKey ? [model.selectedKey] : [])])) {
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
    /** What's done in one thread: in the one `pick` gives when it's done. */
    const threadActions = (pick: () => string | undefined): ThreadActions => ({
    send(text, images) {
      const key = pick();
      if (!key) return;
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
    cancelTurn() {
      const key = pick();
      if (!key) return;
      reduce(key, { type: 'turn/stopped', stopReason: 'cancelled' });
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
            threads: threads(now),
            agents: { [MAC]: AGENTS, [SERVER]: AGENTS },
            projects: PROJECTS,
            known: kept(),
          },
          repositories: repositories(),
          terminals: { [MAC]: terminals(now) },
        }));
      },
      forgetDispatcher() {
        update((current) => ({
          ...current,
          sessionKey: undefined,
          shown: [],
          model: { ...current.model, dispatcher: undefined, hosts: [], threads: [], agents: {}, known: [], selectedKey: undefined },
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

  return { model: { ...model, thread, open, ...(session ? { session } : {}) }, actions };
}
