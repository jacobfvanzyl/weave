import { useEffect, useMemo, useReducer, useRef } from 'react';
import { createAcpShowcaseTranscript } from '@/chat/acp-showcase';
import { type AcpTranscript, type AcpTranscriptEvent, createTranscript, reduceAcpEvent } from '@/chat/acp-transcript';
import type { ContentBlock } from '@/host/protocol';
import {
  type AgentChoice,
  type AppController,
  type AppModel,
  type PairedHost,
  type PromptImage,
  type QueuedPrompt,
  type SessionSummary,
  sessionKey,
} from './app-controller';
import { SessionReadState } from './session-read-state';

/** Fixture states for UI work and tests until the app talks to a Host (WVE-100). */
export const MOCK_SCENARIOS = ['list', 'session', 'running', 'unreachable', 'banner', 'empty'] as const;
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

const hosts = (now: number, unreachable: boolean): PairedHost[] => [
  { id: MAC, name: 'mac.tail1234.ts.net', url: 'https://mac.tail1234.ts.net:7341', status: 'connected' },
  {
    id: SERVER,
    name: 'build.tail1234.ts.net',
    url: 'https://build.tail1234.ts.net:7341',
    status: unreachable ? 'reconnecting' : 'connected',
    ...(unreachable ? { error: `Unreachable since ${new Date(now - 4 * MINUTE).toLocaleTimeString()}` } : {}),
  },
];

const summary = (
  hostId: string,
  sessionId: string,
  cwd: string,
  title: string,
  agentId: string,
  ago: number,
  now: number,
  extra: Partial<SessionSummary> = {},
): SessionSummary => ({
  key: sessionKey(hostId, sessionId),
  hostId,
  sessionId,
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

const sessions = (now: number): SessionSummary[] => [
  summary(MAC, 'fix-reconnect', `${WEAVE}/tui`, 'Fix the flaky reconnect test', 'claude', 1, now, {
    activity: 'waiting',
    waitingOn: 'Permission to run cargo test',
    clients: 1,
  }),
  summary(MAC, 'protocol-spec', `${WEAVE}/tui`, 'Update the Host protocol spec', 'gemini', 3, now, { activity: 'running' }),
  summary(MAC, 'steer-tui', `${WEAVE}/tui`, 'Steer handling in the TUI', 'claude', 80, now),
  summary(MAC, 'nightly', `${WEAVE}/tui`, 'Nightly dependency check', 'claude', 300, now, { headless: true }),
  summary(MAC, 'alpha-back', `${WEAVE}/app`, 'Bring Alpha back', 'claude', 2, now, { activity: 'running', clients: 2 }),
  summary(MAC, 'usb-latency', `${WEAVE}/trackpad`, 'USB transport latency', 'codex', 60 * 26, now),
  summary(MAC, 'pencil-hover', `${WEAVE}/trackpad`, 'Pencil hover', 'claude', 60 * 50, now, { state: 'closed', activity: undefined }),
  summary(SERVER, 'upload-failures', '/srv/odin', 'Diagnose upload failures', 'codex', 45, now),
];

type MockState = {
  model: AppModel;
  transcripts: Record<string, AcpTranscript>;
  queued: Record<string, QueuedPrompt[]>;
};

const transcriptFor = (session: SessionSummary): AcpTranscript => {
  const transcript = { ...createAcpShowcaseTranscript(), sessionId: session.sessionId, title: session.title };
  return session.activity === 'running' ? reduceAcpEvent(transcript, { type: 'turn/started' }) : transcript;
};

const initialState = (scenario: MockScenario, now: number): MockState => {
  if (scenario === 'empty') {
    return { model: { hosts: [], sessions: [], agents: {}, unread: new Set() }, transcripts: {}, queued: {} };
  }
  const list = sessions(now);
  const selectedKey = scenario === 'session'
    ? sessionKey(MAC, 'fix-reconnect')
    : scenario === 'running'
      ? sessionKey(MAC, 'protocol-spec')
      : undefined;
  return {
    model: {
      hosts: hosts(now, scenario === 'unreachable'),
      sessions: list,
      agents: { [MAC]: AGENTS, [SERVER]: AGENTS },
      selectedKey,
      unread: new Set(),
    },
    transcripts: {},
    queued: scenario === 'running' ? { [sessionKey(MAC, 'protocol-spec')]: [{ id: 'q1', text: 'Then regenerate the fixtures.' }] } : {},
  };
};

let nextId = 0;
const localId = (prefix: string) => `${prefix}-${++nextId}`;

/** A controller over fixtures: turns end on their own after a moment, as a fake agent's would. */
export function useMockController(scenario: MockScenario, options: { turnMs?: number; bannerMs?: number } = {}): AppController {
  const { turnMs = 1500, bannerMs = 2500 } = options;
  const state = useRef<MockState>(undefined as unknown as MockState);
  state.current ??= initialState(scenario, Date.now());
  const readState = useRef(new SessionReadState());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const [, render] = useReducer((value: number) => value + 1, 0);

  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => { timers.current.delete(timer); run(); }, ms);
    timers.current.add(timer);
  };

  const update = (change: (current: MockState) => MockState) => {
    const next = change(state.current);
    for (const session of next.model.sessions) readState.current.observe(session.key, session.activity);
    state.current = { ...next, model: { ...next.model, unread: readState.current.unread() } };
    render();
  };

  const setSession = (key: string, change: Partial<SessionSummary>) => update((current) => ({
    ...current,
    model: {
      ...current.model,
      sessions: current.model.sessions.map((session) => session.key === key ? { ...session, ...change } : session),
    },
  }));

  const transcript = (key: string) => {
    const known = state.current.transcripts[key];
    if (known) return known;
    const session = state.current.model.sessions.find((item) => item.key === key);
    return session ? transcriptFor(session) : createTranscript(key);
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
    setSession(key, { activity: 'running', lastActivityAt: Date.now() });
    later(turnMs, () => finishTurn(key));
  };

  const finishTurn = (key: string) => {
    if (transcript(key).turn.status !== 'running') return;
    reduce(
      key,
      { type: 'session/update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done. This reply is from the mock controller.' } } },
      { type: 'turn/stopped', stopReason: 'end_turn' },
    );
    setSession(key, { activity: 'idle', waitingOn: undefined, lastActivityAt: Date.now() });
    const [next, ...rest] = state.current.queued[key] ?? [];
    if (!next) return;
    update((current) => ({ ...current, queued: { ...current.queued, [key]: rest } }));
    startTurn(key, next.text, next.images);
  };

  useEffect(() => {
    if (scenario !== 'banner') return;
    later(bannerMs, () => {
      const key = sessionKey(MAC, 'alpha-back');
      if (state.current.model.selectedKey === key) return;
      setSession(key, { activity: 'waiting', waitingOn: 'Permission to edit app/src/App.tsx' });
    });
  }, [scenario, bannerMs]);

  useEffect(() => () => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current.clear();
  }, []);

  const { model } = state.current;
  const selected = model.sessions.find(({ key }) => key === model.selectedKey);
  const session = selected
    ? {
        key: selected.key,
        transcript: transcript(selected.key),
        canSteer: steers(selected.agentId),
        queued: state.current.queued[selected.key] ?? [],
        canAttachImages: true,
      }
    : undefined;

  const actions = useMemo<AppController['actions']>(() => {
    const selectedKey = () => state.current.model.selectedKey;
    const selectSession = (key?: string) => {
      readState.current.focus(key);
      update((current) => ({ ...current, model: { ...current.model, selectedKey: key } }));
    };
    return {
      selectSession,
      createSession({ hostId, cwd, agentId }) {
        const sessionId = localId('session');
        const created = summary(hostId, sessionId, cwd, '', agentId, 0, Date.now());
        update((current) => ({
          ...current,
          transcripts: { ...current.transcripts, [created.key]: createTranscript(sessionId) },
          model: { ...current.model, sessions: [created, ...current.model.sessions], selectedKey: created.key },
        }));
      },
      closeSession(key) {
        setSession(key, { state: 'closed', activity: undefined, waitingOn: undefined });
        if (selectedKey() === key) selectSession(undefined);
      },
      deleteSession(key) {
        readState.current.forget(key);
        update((current) => ({
          ...current,
          model: {
            ...current.model,
            sessions: current.model.sessions.filter((item) => item.key !== key),
            selectedKey: current.model.selectedKey === key ? undefined : current.model.selectedKey,
          },
        }));
      },
      pairHost({ url, code }) {
        const parsed = new URL(url);
        if (!code.trim()) throw new Error('The pairing code is missing.');
        const id = localId('host');
        update((current) => ({
          ...current,
          model: {
            ...current.model,
            hosts: [...current.model.hosts, { id, name: parsed.hostname, url, status: 'connected' }],
            agents: { ...current.model.agents, [id]: AGENTS },
          },
        }));
      },
      forgetHost(hostId) {
        update((current) => ({
          ...current,
          model: {
            ...current.model,
            hosts: current.model.hosts.filter(({ id }) => id !== hostId),
            sessions: current.model.sessions.filter((item) => item.hostId !== hostId),
            selectedKey: current.model.sessions.some((item) => item.hostId === hostId && item.key === current.model.selectedKey)
              ? undefined
              : current.model.selectedKey,
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
        const current = state.current.model.sessions.find((item) => item.key === key);
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
      reopenSession() {
        const key = selectedKey();
        if (!key) return;
        reduce(key, { type: 'agent/reopened', text: 'Reopened this session in a new agent process', failed: false });
      },
      removeQueued(id) {
        const key = selectedKey();
        if (!key) return;
        update((current) => ({
          ...current,
          queued: { ...current.queued, [key]: (current.queued[key] ?? []).filter((item) => item.id !== id) },
        }));
      },
      cancelTurn() {
        const key = selectedKey();
        if (!key) return;
        reduce(key, { type: 'turn/stopped', stopReason: 'cancelled' });
        setSession(key, { activity: 'idle', waitingOn: undefined });
      },
      respondToPermission(requestId, optionId) {
        const key = selectedKey();
        if (!key) return;
        reduce(key, { type: 'permission/resolved', requestId, optionId });
        setSession(key, { activity: transcript(key).turn.status === 'running' ? 'running' : 'idle', waitingOn: undefined });
      },
      respondToElicitation(requestId, response) {
        const key = selectedKey();
        if (!key) return;
        reduce(key, { type: 'elicitation/resolved', requestId, response });
        setSession(key, { activity: transcript(key).turn.status === 'running' ? 'running' : 'idle', waitingOn: undefined });
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
    };
    // The actions read the latest state through refs, so they never change.
  }, []);

  return { model: { ...model, session }, actions };
}
