import { useEffect, useMemo, useReducer, useRef } from 'react';
import { createAcpShowcaseTranscript, createMarkdownShowcaseTranscript } from '@/chat/acp-showcase';
import { type AcpTranscript, type AcpTranscriptEvent, createTranscript, reduceAcpEvent } from '@/chat/acp-transcript';
import type { ContentBlock, McpServerStatus } from '@/host/protocol';
import {
  type AgentChoice,
  type AppController,
  type AppModel,
  type DispatcherSummary,
  type HostSummary,
  type PromptImage,
  type QueuedPrompt,
  type RepositoryListing,
  type TerminalSummary,
  type ThreadGit,
  type ThreadSummary,
  threadKey,
} from './app-controller';
import { ThreadReadState } from './thread-read-state';

/**
 * Fixture states for UI work and tests. `unpaired` is the pairing screen, before the app pairs
 * with the Dispatcher; `empty`, a Dispatcher no Host has joined; `unreachable`, a Host the
 * Dispatcher can't reach; `offline`, the Dispatcher itself out of reach, with the Hosts it last
 * listed.
 */
export const MOCK_SCENARIOS = ['list', 'thread', 'running', 'unreachable', 'offline', 'banner', 'empty', 'unpaired', 'markdown', 'terminals'] as const;
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
    },
    {
      id: SERVER,
      name: 'build',
      status: offline ? 'reconnecting' : unreachable ? 'unreachable' : 'connected',
      canBrowse: true,
      canRename: true,
      canWorktree: true,
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
  summary(SERVER, 'upload-failures', '/srv/odin', 'Diagnose upload failures', 'codex', 45, now),
];

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
};

/** The `markdown` scenario's thread, which shows the fake agent's rich Markdown reply. */
const MARKDOWN = 'rich-markdown';

const transcriptFor = (thread: ThreadSummary): AcpTranscript => {
  const showcase = thread.threadId === MARKDOWN ? createMarkdownShowcaseTranscript() : createAcpShowcaseTranscript();
  const transcript = { ...showcase, threadId: thread.threadId, title: thread.title };
  return thread.activity === 'running' ? reduceAcpEvent(transcript, { type: 'turn/started' }) : transcript;
};

const initialState = (scenario: MockScenario, now: number): MockState => {
  if (scenario === 'unpaired') {
    return { model: { hosts: [], threads: [], agents: {}, unread: new Set() }, transcripts: {}, queued: {}, repositories: {}, terminals: {} };
  }
  if (scenario === 'empty') {
    return { model: { dispatcher: DISPATCHER, hosts: [], threads: [], agents: {}, unread: new Set() }, transcripts: {}, queued: {}, repositories: {}, terminals: {} };
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
          : undefined;
  return {
    model: {
      dispatcher: dispatcher(scenario === 'offline', now),
      hosts: hosts(now, scenario),
      threads: list,
      agents: { [MAC]: AGENTS, [SERVER]: AGENTS },
      selectedKey,
      unread: new Set(),
    },
    transcripts: {},
    queued: scenario === 'running' ? { [threadKey(MAC, 'protocol-spec')]: [{ id: 'q1', text: 'Then regenerate the fixtures.' }] } : {},
    repositories: repositories(),
    terminals: { [MAC]: terminals(now) },
  };
};

/** The fixture repository `path` is in on a Host, by its primary worktree. */
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
  const selected = model.threads.find(({ key }) => key === model.selectedKey);
  const thread = selected
    ? {
        key: selected.key,
        transcript: transcript(selected.key),
        canSteer: steers(selected.agentId),
        queued: state.current.queued[selected.key] ?? [],
        canAttachImages: true,
        mcpServers: MCP_SERVERS,
        ...(model.hosts.find(({ id }) => id === selected.hostId)?.canTerminals
          ? { terminals: (state.current.terminals[selected.hostId] ?? []).filter(({ scope }) => scope === (selected.git?.worktree ?? selected.cwd)) }
          : {}),
      }
    : undefined;

  const actions = useMemo<AppController['actions']>(() => {
    const selectedKey = () => state.current.model.selectedKey;
    const selectedThread = () => state.current.model.threads.find(({ key }) => key === selectedKey());
    const setTerminals = (hostId: string, change: (terminals: TerminalSummary[]) => TerminalSummary[]) => update((current) => ({
      ...current,
      terminals: { ...current.terminals, [hostId]: change(current.terminals[hostId] ?? []) },
    }));
    const selectThread = (key?: string) => {
      readState.current.focus(key);
      update((current) => ({ ...current, model: { ...current.model, selectedKey: key } }));
    };
    return {
      selectThread,
      createThread({ hostId, cwd, agentId }) {
        const threadId = localId('thread');
        const git = gitOf(state.current.repositories, hostId, cwd);
        const created = summary(hostId, threadId, cwd, '', agentId, 0, Date.now(), git ? { git } : {});
        update((current) => ({
          ...current,
          transcripts: { ...current.transcripts, [created.key]: createTranscript(threadId) },
          model: { ...current.model, threads: [created, ...current.model.threads], selectedKey: created.key },
        }));
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
          },
          repositories: repositories(),
          terminals: { [MAC]: terminals(now) },
        }));
      },
      forgetDispatcher() {
        update((current) => ({
          ...current,
          model: { ...current.model, dispatcher: undefined, hosts: [], threads: [], agents: {}, selectedKey: undefined },
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
      send(text, images) {
        const key = selectedKey();
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
        const key = selectedKey();
        if (!key) return;
        reduce(key, { type: 'agent/reopened', text: 'Reopened this thread in a new agent process', failed: false });
      },
      updateAgent() {
        const key = selectedKey();
        if (!key) return;
        reduce(key, { type: 'agent/reopened', text: 'Reopened this thread in a new agent process', failed: false });
      },
      removeQueued(id) {
        const key = selectedKey();
        if (!key) return;
        update((current) => ({
          ...current,
          queued: { ...current.queued, [key]: (current.queued[key] ?? []).filter((item) => item.id !== id) },
        }));
      },
      // The mock's queue never pauses.
      resumeQueue() {},
      cancelTurn() {
        const key = selectedKey();
        if (!key) return;
        reduce(key, { type: 'turn/stopped', stopReason: 'cancelled' });
        setThread(key, { activity: 'idle', waitingOn: undefined });
      },
      respondToPermission(requestId, optionId) {
        const key = selectedKey();
        if (!key) return;
        reduce(key, { type: 'permission/resolved', requestId, optionId });
        setThread(key, { activity: transcript(key).turn.status === 'running' ? 'running' : 'idle', waitingOn: undefined });
      },
      respondToElicitation(requestId, response) {
        const key = selectedKey();
        if (!key) return;
        reduce(key, { type: 'elicitation/resolved', requestId, response });
        setThread(key, { activity: transcript(key).turn.status === 'running' ? 'running' : 'idle', waitingOn: undefined });
      },
      setMode(modeId) {
        const key = selectedKey();
        if (!key) return;
        reduce(key, { type: 'session/update', update: { sessionUpdate: 'current_mode_update', currentModeId: modeId } });
      },
      setConfigOption(optionId, value) {
        const key = selectedKey();
        if (!key) return;
        const configOptions = transcript(key).configOptions.map((option) =>
          option.id !== optionId
            ? option
            : option.type === 'boolean'
              ? { ...option, currentValue: Boolean(value) }
              : { ...option, currentValue: String(value) });
        reduce(key, { type: 'session/update', update: { sessionUpdate: 'config_option_update', configOptions } });
      },
      async newTerminal() {
        const thread = selectedThread();
        if (!thread) throw new Error('No thread is open.');
        const id = localId('terminal');
        setTerminals(thread.hostId, (list) => [...list, {
          id,
          scope: thread.git?.worktree ?? thread.cwd,
          pwd: thread.cwd,
          openedFrom: thread.threadId,
          process: 'zsh',
          size: { cols: 80, rows: 24 },
          command: { running: false },
          startedAt: Date.now(),
        }]);
        return id;
      },
      async closeTerminal(id) {
        const thread = selectedThread();
        if (thread) setTerminals(thread.hostId, (list) => list.filter((terminal) => terminal.id !== id));
      },
      async renameTerminal(id, label) {
        const thread = selectedThread();
        if (!thread) return;
        setTerminals(thread.hostId, (list) => list.map((terminal) => {
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

  return { model: { ...model, thread }, actions };
}
