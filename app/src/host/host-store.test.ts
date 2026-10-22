// The Host store against a scripted Host, for what a dev Host can't produce on demand, such as a
// newer version of an agent being out.
import { describe, expect, it } from 'vitest';
import { sessionKey } from '@/app/app-controller';
import type { Connector, TransportEvents } from './connection';
import { HOST_PROTOCOL } from './protocol';
import { HostStore } from './host-store';
import type { AgentSummary, PendingRequest, SessionListing, SessionState } from './protocol';
import { memoryStorage } from './storage';

const HOST = 'host-1';
const SESSION = 's-1';

type Answer = { result: unknown } | { error: { code: number; message: string } };

/**
 * A Host that answers what the store asks, with the agents `agents` gives at the time; `answers`
 * overrides what it answers a method.
 */
function scriptedHost(agents: () => AgentSummary[], answers: Record<string, (params: unknown) => Answer> = {}) {
  let events: TransportEvents | undefined;
  const asked: string[] = [];
  const state = {
    sessionId: SESSION,
    agent: { id: 'claude', name: 'Claude', initialize: { protocolVersion: 1 }, release: { name: 'claude-agent-acp', version: '0.86.0' } },
    cwd: '/work',
    state: 'open',
    activity: 'idle',
    clients: 1,
    blank: false,
    policy: {},
    journal: { id: 'j-1', head: 0 },
    update: { agentId: 'claude', name: '@agentclientprotocol/claude-agent-acp', running: '0.86.0', latest: '0.94.0' },
  } satisfies Partial<SessionState> as unknown as SessionState;
  const results: Record<string, () => unknown> = {
    'host/challenge': () => ({ hostId: HOST, nonce: 'n' }),
    'host/hello': () => ({ protocol: 2, clientId: 'c1', host: { id: HOST, version: '0', pid: 1, startedAt: 0 }, features: [], acp: { protocolVersion: 1 }, device: { id: 'd-1', name: 'iPad' } }),
    'agents/list': () => ({ agents: agents() }),
    'sessions/list': () => ({ sessions: [{ info: { sessionId: SESSION, cwd: '/work' }, agentId: 'claude', state: 'open', activity: 'idle', clients: 1, headless: false }] }),
    'session/attach': () => ({ ...state, replay: { from: 1, reset: true } }),
  };
  const connector: Connector = async (transport) => {
    events = transport;
    return {
      send(text) {
        const { id, method, params } = JSON.parse(text) as { id: number; method: string; params: unknown };
        asked.push(method);
        const answer = answers[method]?.(params) ?? { result: results[method]?.() ?? {} };
        queueMicrotask(() => events?.message(JSON.stringify({ jsonrpc: '2.0', id, ...answer })));
      },
      close() {},
    };
  };
  const notify = (method: string, params: unknown) => events?.message(JSON.stringify({ jsonrpc: '2.0', method, params }));
  return { connector, asked, notify, state };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

const storeFor = (connector: Connector) => new HostStore({
  storage: memoryStorage([{ hostId: HOST, name: 'mac', url: 'wss://mac', deviceId: 'd-1', keyId: 'k' }]),
  keyFor: () => ({ publicKey: async () => ({ kty: 'EC', crv: 'P-256', x: '', y: '' }), sign: async () => 'signature', forget: async () => {} }),
  newKey: () => Promise.reject(new Error('no pairing here')),
  connectorFor: () => connector,
  client: { name: 'test', version: '0' },
  deviceName: 'iPad',
  schedule: (notify) => queueMicrotask(notify),
});

const write: PendingRequest = {
  id: 'p-1',
  sessionId: SESSION,
  createdAt: 0,
  kind: 'permission',
  request: {
    sessionId: SESSION,
    toolCall: { toolCallId: 't-1', title: 'Write a.txt' },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  },
};

const tools = (store: HostStore) => store.snapshot().session!.transcript.entries.filter((entry) => entry.kind === 'tool');

describe('HostStore', () => {
  it('offers to move a session to a newer agent only once the Host launches it', async () => {
    let launches = '0.86.0';
    const host = scriptedHost(() => [{ id: 'claude', name: 'Claude', source: 'preset', version: launches, installed: true }]);
    const store = new HostStore({
      storage: memoryStorage([{ hostId: HOST, name: 'mac', url: 'wss://mac', deviceId: 'd-1', keyId: 'k' }]),
      keyFor: () => ({ publicKey: async () => ({ kty: 'EC', crv: 'P-256', x: '', y: '' }), sign: async () => 'signature', forget: async () => {} }),
      newKey: () => Promise.reject(new Error('no pairing here')),
      connectorFor: () => host.connector,
      client: { name: 'test', version: '0' },
      deviceName: 'iPad',
      schedule: (notify) => queueMicrotask(notify),
    });
    await store.start();
    store.actions.selectSession(sessionKey(HOST, SESSION));
    await settle();
    // Out, but not on the Host yet: its new sessions launch what this one runs.
    expect(store.snapshot().session?.update).toEqual({ agentId: 'claude', name: '@agentclientprotocol/claude-agent-acp', running: '0.86.0', latest: '0.94.0' });

    // `weave update claude` on the Host: it tells open sessions again, and the store looks again.
    launches = '0.94.0';
    const listed = host.asked.filter((method) => method === 'agents/list').length;
    host.notify('agents/updateAvailable', { sessionId: SESSION, agentId: 'claude', name: '@agentclientprotocol/claude-agent-acp', running: '0.86.0', latest: '0.94.0' });
    await settle();
    expect(host.asked.filter((method) => method === 'agents/list')).toHaveLength(listed + 1);
    expect(store.snapshot().session?.update).toMatchObject({ available: '0.94.0' });

    // Moved: the session runs the newest, and the notice goes.
    host.notify('session/event', {
      sessionId: SESSION, seq: 1, at: 0,
      event: { kind: 'agentReopened', agent: { id: 'claude', name: 'Claude', initialize: { protocolVersion: 1 }, release: { name: 'claude-agent-acp', version: '0.94.0' } }, configOptions: [] },
    });
    await settle();
    expect(store.snapshot().session?.update).toBeUndefined();
    store.stop();
  });

  it('shows what waits once the history before it is in, and ends what stopped waiting meanwhile', async () => {
    let attach: () => Answer = () => ({ result: {} });
    const host = scriptedHost(() => [], { 'session/attach': () => attach() });
    attach = () => ({ result: { ...host.state, journal: { id: 'j-1', head: 2 }, pending: [write], replay: { from: 1, reset: true } } });
    const store = storeFor(host.connector);
    await store.start();
    store.actions.selectSession(sessionKey(HOST, SESSION));
    await settle();
    // Not before the replay: the request belongs after it.
    expect(tools(store)).toEqual([]);
    host.notify('session/event', {
      sessionId: SESSION, seq: 1, at: 0,
      event: { kind: 'turnStarted', sessionId: SESSION, prompt: [{ type: 'text', text: 'write a.txt' }], origin: { client: { name: 'weave-tui', id: 'c9' } } },
    });
    host.notify('session/event', {
      sessionId: SESSION, seq: 2, at: 0,
      event: { kind: 'update', notification: { sessionId: SESSION, update: { sessionUpdate: 'tool_call', toolCallId: 't-1', title: 'Write a.txt', status: 'pending' } } },
    });
    await settle();
    expect(store.snapshot().session!.transcript.entries.map(({ kind }) => kind)).toEqual(['message', 'tool']);
    expect(tools(store)[0]).toMatchObject({ permission: { requestId: 'p-1', status: 'pending' } });

    // Away, and back once the TUI answered it.
    store.actions.selectSession(undefined);
    attach = () => ({ result: { ...host.state, journal: { id: 'j-1', head: 2 }, pending: [], replay: { from: 3, reset: false } } });
    store.actions.selectSession(sessionKey(HOST, SESSION));
    await settle();
    expect(tools(store)[0]).toMatchObject({ permission: { status: 'ended' } });
    store.stop();
  });

  it('shows a request again when answering it fails, and says why', async () => {
    let answer: Answer = { error: { code: -32602, message: 'Invalid params' } };
    const host = scriptedHost(() => [], {
      'session/attach': () => ({ result: { ...host.state, journal: { id: 'j-1', head: 0 }, pending: [write], replay: { from: 1, reset: true } } }),
      'pending/answer': () => answer,
    });
    const store = storeFor(host.connector);
    await store.start();
    store.actions.selectSession(sessionKey(HOST, SESSION));
    await settle();
    await store.actions.respondToPermission('p-1', 'allow');
    expect(tools(store)[0]).toMatchObject({ permission: { status: 'pending' } });
    expect(store.snapshot().error).toBe("Couldn't answer: Invalid params");

    // Resolved without this device hearing how: it no longer waits, and isn't tried again.
    answer = { error: { code: HOST_PROTOCOL.errors.alreadyResolved, message: 'already resolved' } };
    await store.actions.respondToPermission('p-1', 'allow');
    expect(tools(store)[0]).toMatchObject({ permission: { status: 'ended' } });
    expect(store.snapshot().error).toBeUndefined();
    const answers = host.asked.filter((method) => method === 'pending/answer').length;
    await store.actions.respondToPermission('p-1', 'allow');
    expect(host.asked.filter((method) => method === 'pending/answer')).toHaveLength(answers);
    store.stop();
  });

  it('keeps the list live from a Host that offers sessions/watch, and lists once from one that doesn\'t', async () => {
    const listing = (sessionId: string, more: Partial<SessionListing> = {}): SessionListing => ({
      info: { sessionId, cwd: '/work', title: 'Fix it' }, agentId: 'claude', state: 'open', activity: 'idle', clients: 0, headless: false, ...more,
    });
    const host = scriptedHost(() => [], {
      'host/hello': () => ({
        result: { protocol: 2, clientId: 'c1', host: { id: HOST, version: '0', pid: 1, startedAt: 0 }, features: [HOST_PROTOCOL.features.watch], acp: { protocolVersion: 1 }, device: { id: 'd-1', name: 'iPad' } },
      }),
      'sessions/watch': () => ({ result: { sessions: [listing(SESSION)] } }),
    });
    const store = storeFor(host.connector);
    await store.start();
    await settle();
    expect(host.asked).toContain('sessions/watch');
    expect(host.asked).not.toContain('sessions/list');

    host.notify('sessions/updated', { session: listing('s-2', { activity: 'waiting', info: { sessionId: 's-2', cwd: '/elsewhere' } }) });
    // Closed, the Host lists it without the title it had.
    host.notify('sessions/updated', { session: listing(SESSION, { state: 'closed', activity: null, info: { sessionId: SESSION, cwd: '/work' } }) });
    await settle();
    expect(store.snapshot().sessions.map(({ sessionId, state, activity, title }) => ({ sessionId, state, activity, title }))).toEqual([
      { sessionId: SESSION, state: 'closed', activity: undefined, title: 'Fix it' },
      { sessionId: 's-2', state: 'open', activity: 'waiting', title: undefined },
    ]);
    host.notify('sessions/removed', { sessionId: 's-2' });
    await settle();
    expect(store.snapshot().sessions.map(({ sessionId }) => sessionId)).toEqual([SESSION]);
    store.stop();

    const older = scriptedHost(() => []);
    const listed = storeFor(older.connector);
    await listed.start();
    await settle();
    expect(older.asked).toContain('sessions/list');
    expect(older.asked).not.toContain('sessions/watch');
    listed.stop();
  });
});
