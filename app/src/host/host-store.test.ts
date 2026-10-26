// The Host store against a scripted Host, for what a dev Host can't produce on demand, such as a
// newer version of an agent being out.
import { describe, expect, it } from 'vitest';
import { sessionKey } from '@/app/app-controller';
import { blocksText } from '@/chat/acp-transcript';
import type { Connector, TransportEvents } from './connection';
import { APP_PROTOCOL } from './connection';
import { HOST_PROTOCOL } from './protocol';
import { HostStore, type HostStoreOptions } from './host-store';
import type { AgentSummary, PendingRequest, SessionListing, SessionState } from './protocol';
import { memoryStorage } from './storage';

const HOST = 'host-1';
const SESSION = 's-1';

type Answer = { result: unknown } | { error: { code: number; message: string; data?: unknown } };

/**
 * A Host that answers what the store asks, with the agents `agents` gives at the time; `answers`
 * overrides what it answers a method, and one answering `'silent'` answers nothing.
 */
function scriptedHost(agents: () => AgentSummary[], answers: Record<string, (params: unknown) => Answer | 'silent' | undefined> = {}) {
  let events: TransportEvents | undefined;
  const asked: string[] = [];
  const params: Record<string, unknown[]> = {};
  /** Connections opened, and how many tries to leave opening until they're abandoned. */
  const connects = { opened: 0, hang: 0 };
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
  const connector: Connector = async (transport, signal) => {
    if (connects.hang > 0) {
      connects.hang -= 1;
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
    }
    connects.opened += 1;
    events = transport;
    let open = true;
    return {
      send(text) {
        const { id, method, params: given } = JSON.parse(text) as { id: number; method: string; params: unknown };
        asked.push(method);
        (params[method] ??= []).push(given);
        const answer = answers[method]?.(given) ?? { result: results[method]?.() ?? {} };
        if (answer === 'silent') return;
        queueMicrotask(() => { if (open) transport.message(JSON.stringify({ jsonrpc: '2.0', id, ...answer })); });
      },
      close() { open = false; },
    };
  };
  const notify = (method: string, params: unknown) => events?.message(JSON.stringify({ jsonrpc: '2.0', method, params }));
  /** The Host closes the latest connection, with a WebSocket close code. */
  const close = (code: number, reason = '') => events?.closed({ code, reason });
  return { connector, asked, params, connects, notify, close, state };
}

const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

const PAIRED = { hostId: HOST, name: 'mac', url: 'wss://mac', deviceId: 'd-1', keyId: 'k' };

const storeFor = (connector: Connector, options: Partial<HostStoreOptions> = {}) => new HostStore({
  storage: memoryStorage([PAIRED]),
  keyFor: () => ({ publicKey: async () => ({ kty: 'EC', crv: 'P-256', x: '', y: '' }), sign: async () => 'signature', forget: async () => {} }),
  newKey: () => Promise.reject(new Error('no pairing here')),
  connectorFor: () => connector,
  client: { name: 'test', version: '0' },
  deviceName: 'iPad',
  schedule: (notify) => queueMicrotask(notify),
  ...options,
});

const chunk = (seq: number, text: string) => ({
  sessionId: SESSION, seq, at: 0,
  event: { kind: 'update', notification: { sessionId: SESSION, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } },
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

/** What the agent said in the session on screen. */
const said = (store: HostStore) => store.snapshot().session!.transcript.entries
  .flatMap((entry) => entry.kind === 'message' && entry.role === 'assistant'
    ? [blocksText(entry.chunks.filter(({ kind }) => kind === 'message').flatMap(({ content }) => content))]
    : [])
  .join('');

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

  it('updates the agent on the Host, then moves the session there', async () => {
    const host = scriptedHost(() => [{ id: 'claude', name: 'Claude', source: 'preset', version: '0.86.0', installed: true }], {
      'agents/update': () => ({ result: { version: '0.94.0' } }),
    });
    const store = storeFor(host.connector);
    await store.start();
    store.actions.selectSession(sessionKey(HOST, SESSION));
    await settle();
    const updated = store.actions.updateAgent();
    expect(store.snapshot().session?.updating).toBe(true);
    await updated;
    expect(host.asked.filter((method) => method === 'agents/update' || method === 'session/reopen')).toEqual(['agents/update', 'session/reopen']);
    expect(host.params['agents/update']).toEqual([{ agentId: 'claude' }]);
    expect(host.params['session/reopen']).toEqual([{ sessionId: SESSION }]);
    expect(store.snapshot().session).not.toHaveProperty('updating');
    expect(store.snapshot().error).toBeUndefined();
    store.stop();
  });

  it('says where to update an agent when the Host won\'t let a device, and moves nothing', async () => {
    const host = scriptedHost(() => [{ id: 'claude', name: 'Claude', source: 'preset', version: '0.86.0', installed: true }], {
      'agents/update': () => ({ error: { code: HOST_PROTOCOL.errors.forbidden, message: 'Remote clients can\'t administer the Host' } }),
    });
    const store = storeFor(host.connector);
    await store.start();
    store.actions.selectSession(sessionKey(HOST, SESSION));
    await settle();
    await store.actions.updateAgent();
    expect(store.snapshot().error).toBe('Remote clients can\'t administer the Host. That\'s done on the Host\'s computer.');
    expect(host.asked).not.toContain('session/reopen');
    expect(store.snapshot().session).not.toHaveProperty('updating');
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

describe('HostStore closing and deleting', () => {
  it('says what failed and why when the Host can\'t delete a session', async () => {
    const host = scriptedHost(() => [], {
      'session/delete': () => ({ error: { code: -32603, message: 'Internal error', data: 'the agent couldn\'t start' } }),
    });
    const store = storeFor(host.connector);
    await store.start();
    await settle();
    await store.actions.deleteSession(sessionKey(HOST, SESSION));
    expect(store.snapshot().error).toBe("Couldn't delete the thread: the agent couldn't start");
    expect(store.snapshot().sessions.map(({ sessionId }) => sessionId)).toEqual([SESSION]);
    store.stop();
  });
});

describe('HostStore journal times', () => {
  it('dates the transcript\'s entries by when the journal says their events happened', async () => {
    const host = scriptedHost(() => []);
    const store = storeFor(host.connector);
    await store.start();
    store.actions.selectSession(sessionKey(HOST, SESSION));
    await settle();
    host.notify('session/event', { ...chunk(1, 'Chunk 1. '), at: 1_000 });
    host.notify('session/event', { ...chunk(2, 'Chunk 2. '), at: 2_500 });
    await settle();
    expect(store.snapshot().session!.transcript.entries).toMatchObject([{ kind: 'message', startedAt: 1_000, updatedAt: 2_500 }]);
    store.stop();
  });
});

describe('HostStore reconnecting', () => {
  it('renames a Host on this device only, and keeps the name', async () => {
    const host = scriptedHost(() => []);
    const storage = memoryStorage([PAIRED]);
    const store = storeFor(host.connector, { storage });
    await store.start();
    await settle();
    const asked = host.asked.length;
    await store.actions.renameHost(HOST, '  Studio Mac ');
    expect(store.snapshot().hosts).toMatchObject([{ id: HOST, name: 'Studio Mac', url: 'wss://mac' }]);
    expect(await storage.load()).toEqual([{ ...PAIRED, name: 'Studio Mac' }]);
    // The Host isn't told: the name is this device's own.
    expect(host.asked.length).toBe(asked);
    await expect(store.actions.renameHost(HOST, ' ')).rejects.toThrow("A Host's name can't be empty.");
    expect(store.snapshot().hosts[0].name).toBe('Studio Mac');
    store.stop();
  });

  it('forgets the pairing when the Host revokes the device (4000), and says to pair again', async () => {
    const host = scriptedHost(() => []);
    const storage = memoryStorage([PAIRED]);
    const forgotten: string[] = [];
    const store = storeFor(host.connector, {
      storage,
      keyFor: (keyId) => ({
        publicKey: async () => ({ kty: 'EC', crv: 'P-256', x: '', y: '' }),
        sign: async () => 'signature',
        forget: async () => { forgotten.push(keyId); },
      }),
      backoff: [5],
    });
    await store.start();
    store.actions.selectSession(sessionKey(HOST, SESSION));
    await settle();
    expect(store.snapshot().session).toBeDefined();

    host.close(HOST_PROTOCOL.websocket.closeRevoked, 'the device was revoked');
    await settle(30);
    expect(store.snapshot().hosts).toMatchObject([{ id: HOST, status: 'revoked', error: expect.stringContaining('Pair it again') }]);
    expect(store.snapshot().sessions).toEqual([]);
    expect(store.snapshot().session).toBeUndefined();
    expect(forgotten).toEqual(['k']);
    expect(await storage.load()).toEqual([]);
    // Nothing to connect with: coming to the front, or asking, tries nothing.
    await store.refresh();
    await store.actions.reconnectHost(HOST);
    expect(host.connects.opened).toBe(1);
    await store.actions.forgetHost(HOST);
    expect(store.snapshot().hosts).toEqual([]);
    store.stop();
  });

  it('reconnects at once when it fell behind (4001), and gets only what it missed', async () => {
    const host = scriptedHost(() => [], {
      'session/attach': (given) => {
        const after = (given as { after?: { seq: number } }).after;
        return { result: { ...host.state, journal: { id: 'j-1', head: after?.seq ?? 0 }, replay: { from: (after?.seq ?? 0) + 1, reset: !after } } };
      },
    });
    const store = storeFor(host.connector, { backoff: [60_000] });
    await store.start();
    store.actions.selectSession(sessionKey(HOST, SESSION));
    await settle();
    host.notify('session/event', chunk(1, 'Chunk 1. '));
    host.notify('session/event', chunk(2, 'Chunk 2. '));
    await settle();

    host.close(HOST_PROTOCOL.websocket.closeBehind, 'fell behind; attach again after your position');
    await settle();
    // Not after the minute the backoff would wait.
    expect(host.connects.opened).toBe(2);
    expect(store.snapshot().hosts[0].status).toBe('connected');
    expect(host.params['session/attach']?.at(-1)).toMatchObject({ sessionId: SESSION, after: { journal: 'j-1', seq: 2 } });
    host.notify('session/event', chunk(2, 'Chunk 2. '));
    host.notify('session/event', chunk(3, 'Chunk 3. '));
    await settle();
    expect(said(store)).toBe('Chunk 1. Chunk 2. Chunk 3. ');
    store.stop();
  });

  it('loads a thread it opens before showing it, and keeps one on screen showing as it catches up', async () => {
    let head = 2;
    const host = scriptedHost(() => [], {
      'session/attach': (given) => {
        const after = (given as { after?: { seq: number } }).after;
        return { result: { ...host.state, journal: { id: 'j-1', head }, replay: { from: (after?.seq ?? 0) + 1, reset: !after } } };
      },
    });
    const store = storeFor(host.connector, { backoff: [60_000] });
    await store.start();
    store.actions.selectSession(sessionKey(HOST, SESSION));
    await settle();
    expect(store.snapshot().session?.loading).toBe(true);
    host.notify('session/event', chunk(1, 'Chunk 1. '));
    await settle();
    expect(store.snapshot().session?.loading).toBe(true);
    host.notify('session/event', chunk(2, 'Chunk 2. '));
    await settle();
    expect(store.snapshot().session?.loading).toBeUndefined();
    expect(said(store)).toBe('Chunk 1. Chunk 2. ');

    // Caught up after a reconnect, it shows throughout.
    head = 3;
    host.close(HOST_PROTOCOL.websocket.closeBehind, 'fell behind; attach again after your position');
    await settle();
    expect(host.connects.opened).toBe(2);
    expect(store.snapshot().session?.loading).toBeUndefined();
    host.notify('session/event', chunk(3, 'Chunk 3. '));
    await settle();
    expect(store.snapshot().session?.loading).toBeUndefined();
    expect(said(store)).toBe('Chunk 1. Chunk 2. Chunk 3. ');
    store.stop();
  });

  it("backs off, and doesn't say the thread couldn't open, when an attach falls behind before its answer (4001)", async () => {
    let attaches = 0;
    const host = scriptedHost(() => [], {
      'session/attach': () => {
        attaches += 1;
        if (attaches > 1) return undefined;
        setTimeout(() => host.close(HOST_PROTOCOL.websocket.closeBehind, 'fell behind; attach again after your position'));
        return 'silent';
      },
    });
    const store = storeFor(host.connector, { backoff: [60] });
    await store.start();
    store.actions.selectSession(sessionKey(HOST, SESSION));
    await settle();
    // Not again at once, which would ask for the same replay.
    expect(host.connects.opened).toBe(1);
    expect(store.snapshot().hosts[0].status).toBe('reconnecting');
    expect(store.snapshot().error).toBeUndefined();

    await settle(120);
    expect(host.connects.opened).toBe(2);
    expect(attaches).toBe(2);
    expect(store.snapshot().hosts[0].status).toBe('connected');
    expect(store.snapshot().error).toBeUndefined();
    store.stop();
  });

  it("says why the Host refused the device's hello, and doesn't try again (4002)", async () => {
    const host = scriptedHost(() => [], {
      'host/hello': () => {
        setTimeout(() => host.close(HOST_PROTOCOL.websocket.closeUnauthenticated, 'not authenticated'));
        return { error: { code: HOST_PROTOCOL.errors.unauthenticated, message: "this device couldn't be authenticated" } };
      },
    });
    const store = storeFor(host.connector, { backoff: [5] });
    await store.start();
    await settle(30);
    expect(store.snapshot().hosts).toMatchObject([{
      status: 'disconnected',
      error: "The Host refused this device (this device couldn't be authenticated). Pair it again.",
    }]);
    await store.refresh();
    expect(host.connects.opened).toBe(1);
    store.stop();
  });

  it('tries again after a close during hello, unless the Host gave up on the hello (4002)', async () => {
    let code = 1006;
    const host = scriptedHost(() => [], {
      'host/hello': () => {
        setTimeout(() => host.close(code));
        return 'silent';
      },
    });
    const store = storeFor(host.connector, { backoff: [5] });
    await store.start();
    await settle(30);
    expect(host.connects.opened).toBeGreaterThan(1);
    expect(store.snapshot().hosts[0].status).toBe('reconnecting');

    code = HOST_PROTOCOL.websocket.closeUnauthenticated;
    await settle(30);
    const opened = host.connects.opened;
    expect(store.snapshot().hosts[0]).toMatchObject({ status: 'disconnected', error: expect.stringContaining('refused this device') });
    await settle(30);
    expect(host.connects.opened).toBe(opened);
    store.stop();
  });

  it('shows a Host that shares no protocol version as needing another version of the app, with its range', async () => {
    let range = { min: APP_PROTOCOL.max + 1, max: APP_PROTOCOL.max + 2 };
    const host = scriptedHost(() => [], {
      'host/hello': () => ({ error: { code: HOST_PROTOCOL.errors.incompatibleProtocol, message: 'no common version', data: range } }),
    });
    const store = storeFor(host.connector, { backoff: [5] });
    await store.start();
    const app = APP_PROTOCOL.min === APP_PROTOCOL.max ? `version ${APP_PROTOCOL.min}` : `versions ${APP_PROTOCOL.min} to ${APP_PROTOCOL.max}`;
    expect(store.snapshot().hosts).toMatchObject([{
      status: 'incompatible',
      error: `This Host needs a newer version of the app: it speaks protocol versions ${range.min} to ${range.max}; this app speaks ${app}.`,
    }]);
    await settle(30);
    expect(host.connects.opened).toBe(1);

    range = { min: APP_PROTOCOL.min - 1, max: APP_PROTOCOL.min - 1 };
    await store.actions.reconnectHost(HOST);
    expect(store.snapshot().hosts[0].error).toBe(
      `This Host needs an older version of the app, or a newer weave on its computer: it speaks protocol version ${range.min}; this app speaks ${app}.`,
    );
    store.stop();
  });

  it('replaces a connection that no longer answers when the app comes to the front, and keeps one that does', async () => {
    let silent = false;
    const host = scriptedHost(() => [], { 'sessions/list': () => silent ? 'silent' : undefined });
    const store = storeFor(host.connector, { probeTimeout: 20 });
    await store.start();
    await store.refresh();
    expect(host.connects.opened).toBe(1);

    // Silent, as over a network that's gone.
    silent = true;
    const refreshing = store.refresh();
    silent = false;
    await refreshing;
    expect(host.connects.opened).toBe(2);
    expect(store.snapshot().hosts[0].status).toBe('connected');
    expect(store.snapshot().error).toBeUndefined();
    store.stop();
  });

  it('tries again at once when the app comes to the front, rather than waiting out the backoff', async () => {
    const host = scriptedHost(() => []);
    const store = storeFor(host.connector, { backoff: [60_000] });
    await store.start();
    host.close(1006);
    await settle();
    expect(store.snapshot().hosts[0].status).toBe('reconnecting');
    await store.refresh();
    expect(host.connects.opened).toBe(2);
    expect(store.snapshot().hosts[0].status).toBe('connected');
    store.stop();
  });

  it('gives up on a try that never opens, and tries again', async () => {
    const host = scriptedHost(() => []);
    host.connects.hang = 1;
    const store = storeFor(host.connector, { connectTimeout: 20, backoff: [5] });
    await store.start();
    expect(store.snapshot().hosts[0]).toMatchObject({ status: 'reconnecting', error: expect.stringContaining("didn't answer") });
    await settle(30);
    expect(store.snapshot().hosts[0].status).toBe('connected');
    expect(host.connects.opened).toBe(1);
    store.stop();
  });
});

describe('HostStore terminals', () => {
  const hello = (features: string[]) => () => ({
    result: { protocol: 2, clientId: 'c1', host: { id: HOST, version: '0', pid: 1, startedAt: 0 }, features, acp: { protocolVersion: 1 }, device: { id: 'd-1', name: 'iPad' } },
  });
  const terminal = (id: string, extra: Record<string, unknown> = {}) => ({ id, scope: '/work', size: { cols: 80, rows: 24 }, startedAt: 1, ...extra });

  it("lists the open thread's terminals and keeps them up to date, until it's left", async () => {
    const host = scriptedHost(() => [], {
      'host/hello': hello([HOST_PROTOCOL.features.terminals]),
      'terminals/watch': () => ({ result: { scope: '/work', terminals: [terminal('t-1', { openedFrom: SESSION, command: { running: true, command: 'cargo test' } })] } }),
      'terminals/new': (params) => ({ result: { terminal: terminal('t-3', { openedFrom: (params as { openedFrom: string }).openedFrom }) } }),
      'terminals/attach': () => ({ result: { ticket: 'k2Vx', expiresAt: 30_000 } }),
      'terminals/setLabel': (params) => ({ result: { terminal: terminal('t-3', { label: (params as { label?: string }).label }) } }),
    });
    const store = storeFor(host.connector);
    await store.start();
    store.actions.selectSession(sessionKey(HOST, SESSION));
    await settle();
    expect(store.snapshot().hosts[0].canTerminals).toBe(true);
    expect(host.params['terminals/watch']).toEqual([{ directory: '/work' }]);
    expect(store.snapshot().session?.terminals).toEqual([
      { id: 't-1', scope: '/work', openedFrom: SESSION, size: { cols: 80, rows: 24 }, command: { running: true, command: 'cargo test' }, startedAt: 1 },
    ]);

    // Another client's terminal in the worktree, a change, and one of another worktree's.
    host.notify('terminals/updated', { terminal: terminal('t-2', { title: 'nvim' }) });
    host.notify('terminals/updated', { terminal: terminal('t-1', { command: { running: false, exitCode: 1 } }) });
    host.notify('terminals/updated', { terminal: { ...terminal('t-9'), scope: '/elsewhere' } });
    await settle();
    expect(store.snapshot().session?.terminals?.map(({ id, title, command }) => ({ id, title, command }))).toEqual([
      { id: 't-1', title: undefined, command: { running: false, exitCode: 1 } },
      { id: 't-2', title: 'nvim', command: undefined },
    ]);
    host.notify('terminals/removed', { id: 't-1', scope: '/work', exitCode: 0 });
    await settle();
    expect(store.snapshot().session?.terminals?.map(({ id }) => id)).toEqual(['t-2']);

    // A new one is the open thread's, in its directory.
    expect(await store.actions.newTerminal()).toBe('t-3');
    expect(host.params['terminals/new']).toEqual([{ directory: '/work', openedFrom: SESSION }]);
    expect(store.snapshot().session?.terminals?.map(({ id }) => id)).toEqual(['t-2', 't-3']);
    // Its stream is on the Host's own listener.
    expect(await store.actions.attachTerminal('t-3')).toEqual({ url: 'wss://mac', ticket: 'k2Vx' });
    await store.actions.renameTerminal('t-3', '  tests ');
    expect(store.snapshot().session?.terminals?.find(({ id }) => id === 't-3')?.label).toBe('tests');
    await store.actions.renameTerminal('t-3', '');
    expect(host.params['terminals/setLabel']).toEqual([{ id: 't-3', label: 'tests' }, { id: 't-3' }]);

    store.actions.selectSession(undefined);
    await settle();
    expect(host.params['terminals/unwatch']).toEqual([{ scope: '/work' }]);
    store.stop();
  });

  it("doesn't ask a Host without terminals for them", async () => {
    const host = scriptedHost(() => []);
    const store = storeFor(host.connector);
    await store.start();
    store.actions.selectSession(sessionKey(HOST, SESSION));
    await settle();
    expect(host.asked).not.toContain('terminals/watch');
    expect(store.snapshot().hosts[0].canTerminals).toBeUndefined();
    expect(store.snapshot().session).not.toHaveProperty('terminals');
    store.stop();
  });

  it("says a worktree's terminals keep it, as its threads do", async () => {
    const busy = (data: unknown) => () => ({ error: { code: HOST_PROTOCOL.errors.worktreeBusy, message: 'busy', data } });
    const removal = async (data: unknown) => {
      const host = scriptedHost(() => [], { 'worktrees/remove': busy(data) });
      const store = storeFor(host.connector);
      await store.start();
      await settle();
      const removed = store.actions.removeWorktree({ hostId: HOST, path: '/work.feature' });
      await expect(removed).rejects.toThrow();
      store.stop();
      return removed.catch((error: Error) => error.message);
    };
    expect(await removal({ sessions: [SESSION], terminals: [] }))
      .toBe('A thread in it is running a turn or waiting on you. Let it finish, or stop it, first.');
    expect(await removal({ sessions: [], terminals: ['t-1'] }))
      .toBe('A terminal in it is running a command. Let it finish, or stop it, first.');
    expect(await removal({ sessions: [SESSION], terminals: ['t-1'] }))
      .toBe('A thread in it is running a turn or waiting on you, and a terminal in it is running a command. Let them finish, or stop them, first.');
  });
});
