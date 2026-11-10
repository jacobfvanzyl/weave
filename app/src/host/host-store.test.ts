// The Host store against a scripted Dispatcher and Host, for what a dev Host can't produce on
// demand, such as a newer version of an agent being out, or what the Dispatcher says of a Host.
import { describe, expect, it } from 'vitest';
import { sessionKey, threadKey } from '@/app/app-controller';
import { threadBlock, threadOf } from '@/session/blocks';
import { layoutBlocks, placeBlock } from '@/session/layout';
import { blocksText } from '@/chat/acp-transcript';
import type { TransportEvents } from './connection';
import { APP_PROTOCOL } from './connection';
import { DISPATCHER, type SocketOpener } from './dispatcher';
import { HOST_PROTOCOL } from './protocol';
import { HostStore, type HostStoreOptions } from './host-store';
import type { AgentSummary, DispatcherHost, PendingRequest, ThreadListing, ThreadState } from './protocol';
import { type DispatcherRecord, memoryStorage } from './storage';

const HOST = 'host-1';
const THREAD = 's-1';
const DISPATCHER_ID = 'dispatcher-1';

type Answer = { result: unknown } | { error: { code: number; message: string; data?: unknown } };
type Answers = Record<string, (params: unknown) => Answer | 'silent' | undefined>;

/** What the Dispatcher lists of the scripted Host. */
const listed = (host: Partial<DispatcherHost> = {}): DispatcherHost => ({
  hostId: HOST, name: 'mac', deviceId: 'dispatcher-device', pairedAt: 0, joinedAt: 0, connected: true, status: 'reachable', pending: 0, ...host,
});

/** Messages over a fake WebSocket: each request answered by `answer`, unless it says nothing. */
function fakeSocket(transport: TransportEvents, answer: (method: string, params: unknown) => Answer | 'silent') {
  let open = true;
  return {
    send(text: string) {
      const { id, method, params } = JSON.parse(text) as { id: number; method: string; params: unknown };
      const answered = answer(method, params);
      if (answered === 'silent') return;
      queueMicrotask(() => { if (open) transport.message(JSON.stringify({ jsonrpc: '2.0', id, ...answered })); });
    },
    close() { open = false; },
  };
}

/**
 * A Dispatcher and the one Host it carries connections to, which answer what the store asks, the
 * Host with the agents `agents` gives at the time; `answers` overrides what either answers a
 * method, and one answering `'silent'` answers nothing.
 */
function scriptedHost(agents: () => AgentSummary[], answers: Answers = {}) {
  let events: TransportEvents | undefined;
  let api: TransportEvents | undefined;
  /** What the store asked the Host, after the Dispatcher carried the connection. */
  const asked: string[] = [];
  const params: Record<string, unknown[]> = {};
  /** What the store asked the Dispatcher's API. */
  const askedDispatcher: string[] = [];
  /** Connections carried to the Host, and how many tries to leave opening until they're abandoned. */
  const connects = { opened: 0, hang: 0, api: 0 };
  const dispatcher = { hosts: [listed()], refuse: false };
  const state = {
    threadId: THREAD,
    agent: { id: 'claude', name: 'Claude', initialize: { protocolVersion: 1 }, release: { name: 'claude-agent-acp', version: '0.86.0' } },
    cwd: '/work',
    state: 'open',
    activity: 'idle',
    clients: 1,
    blank: false,
    policy: {},
    journal: { id: 'j-1', head: 0 },
    update: { agentId: 'claude', name: '@agentclientprotocol/claude-agent-acp', running: '0.86.0', latest: '0.94.0' },
  } satisfies Partial<ThreadState> as unknown as ThreadState;
  const preamble: Record<string, () => Answer> = {
    'dispatcher/challenge': () => ({ result: { dispatcherId: DISPATCHER_ID, nonce: 'n', expiresAt: 0 } }),
    'dispatcher/hello': () => dispatcher.refuse
      ? { error: { code: HOST_PROTOCOL.errors.unauthenticated, message: "this device couldn't be authenticated" } }
      : { result: { protocol: DISPATCHER.protocol, version: '0', id: DISPATCHER_ID, device: { id: 'd-1', name: 'iPad' } } },
  };
  const results: Record<string, () => unknown> = {
    'hosts/list': () => ({ hosts: dispatcher.hosts }),
    'dispatcher/status': () => ({ name: 'homelab' }),
    'host/hello': () => ({ protocol: 3, clientId: 'c1', host: { id: HOST, version: '0', pid: 1, startedAt: 0 }, features: [], acp: { protocolVersion: 1 }, device: { id: 'd-1', name: 'iPad' } }),
    'agents/list': () => ({ agents: agents() }),
    'threads/list': () => ({ threads: [{ info: { sessionId: THREAD, cwd: '/work' }, agentId: 'claude', state: 'open', activity: 'idle', clients: 1, headless: false }] }),
    'thread/attach': () => ({ ...state, replay: { from: 1, reset: true } }),
  };
  const answer = (method: string, given: unknown): Answer | 'silent' =>
    answers[method]?.(given) ?? preamble[method]?.() ?? { result: results[method]?.() ?? {} };
  const socket: SocketOpener = (_url, subprotocol) => async (transport, signal) => {
    if (subprotocol === DISPATCHER.subprotocol) {
      connects.api += 1;
      api = transport;
      return fakeSocket(transport, (method, given) => {
        askedDispatcher.push(method);
        return answer(method, given);
      });
    }
    if (connects.hang > 0) {
      connects.hang -= 1;
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
    }
    connects.opened += 1;
    events = transport;
    return fakeSocket(transport, (method, given) => {
      if (method === 'hosts/open') {
        const host = dispatcher.hosts.find(({ hostId }) => hostId === (given as { host: string }).host);
        return host?.connected
          ? { result: { hostId: host.hostId, name: host.name } }
          : { error: { code: HOST_PROTOCOL.errors.hostUnavailable, message: 'unavailable', data: { status: host?.status ?? 'unreachable', why: host?.why ?? "It isn't connected." } } };
      }
      if (!(method in preamble)) {
        asked.push(method);
        (params[method] ??= []).push(given);
      }
      return answer(method, given);
    });
  };
  const notify = (method: string, params: unknown) => events?.message(JSON.stringify({ jsonrpc: '2.0', method, params }));
  /** The Host closes the latest connection carried to it, with a WebSocket close code. */
  const close = (code: number, reason = '') => events?.closed({ code, reason });
  /** The Dispatcher closes its API's latest connection. */
  const closeApi = (code: number, reason = '') => api?.closed({ code, reason });
  return { socket, asked, askedDispatcher, params, connects, notify, close, closeApi, state, dispatcher };
}

const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

const PAIRED: DispatcherRecord = { dispatcherId: DISPATCHER_ID, name: 'homelab', url: 'wss://homelab', deviceId: 'd-1', keyId: 'k' };

const storeFor = (socket: SocketOpener, options: Partial<HostStoreOptions> = {}) => new HostStore({
  storage: memoryStorage(PAIRED),
  keyFor: () => ({ publicKey: async () => ({ kty: 'EC', crv: 'P-256', x: '', y: '' }), sign: async () => 'signature', forget: async () => {} }),
  newKey: () => Promise.reject(new Error('no pairing here')),
  socket,
  client: { name: 'test', version: '0' },
  deviceName: 'iPad',
  schedule: (notify) => queueMicrotask(notify),
  ...options,
});

const chunk = (seq: number, text: string) => ({
  threadId: THREAD, seq, at: 0,
  event: { kind: 'update', notification: { sessionId: THREAD, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } },
});

const write: PendingRequest = {
  id: 'p-1',
  threadId: THREAD,
  createdAt: 0,
  kind: 'permission',
  request: {
    sessionId: THREAD,
    toolCall: { toolCallId: 't-1', title: 'Write a.txt' },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  },
};

const tools = (store: HostStore) => store.snapshot().thread!.transcript.entries.filter((entry) => entry.kind === 'tool');

/** What the agent said in the thread on screen. */
const said = (store: HostStore) => store.snapshot().thread!.transcript.entries
  .flatMap((entry) => entry.kind === 'message' && entry.role === 'assistant'
    ? [blocksText(entry.chunks.filter(({ kind }) => kind === 'message').flatMap(({ content }) => content))]
    : [])
  .join('');

describe('HostStore', () => {
  it('offers to move a thread to a newer agent only once the Host launches it', async () => {
    let launches = '0.86.0';
    const host = scriptedHost(() => [{ id: 'claude', name: 'Claude', source: 'preset', version: launches, installed: true }]);
    const store = storeFor(host.socket);
    await store.start();
    store.actions.selectThread(threadKey(HOST, THREAD));
    await settle();
    // Out, but not on the Host yet: its new threads launch what this one runs.
    expect(store.snapshot().thread?.update).toEqual({ agentId: 'claude', name: '@agentclientprotocol/claude-agent-acp', running: '0.86.0', latest: '0.94.0' });

    // `weave agents update claude` on the Host: it tells open threads again, and the store looks again.
    launches = '0.94.0';
    const listed = host.asked.filter((method) => method === 'agents/list').length;
    host.notify('agents/updateAvailable', { threadId: THREAD, agentId: 'claude', name: '@agentclientprotocol/claude-agent-acp', running: '0.86.0', latest: '0.94.0' });
    await settle();
    expect(host.asked.filter((method) => method === 'agents/list')).toHaveLength(listed + 1);
    expect(store.snapshot().thread?.update).toMatchObject({ available: '0.94.0' });

    // Moved: the thread runs the newest, and the notice goes.
    host.notify('thread/event', {
      threadId: THREAD, seq: 1, at: 0,
      event: { kind: 'agentReopened', agent: { id: 'claude', name: 'Claude', initialize: { protocolVersion: 1 }, release: { name: 'claude-agent-acp', version: '0.94.0' } }, configOptions: [] },
    });
    await settle();
    expect(store.snapshot().thread?.update).toBeUndefined();
    store.stop();
  });

  it('updates the agent on the Host, then moves the thread there', async () => {
    const host = scriptedHost(() => [{ id: 'claude', name: 'Claude', source: 'preset', version: '0.86.0', installed: true }], {
      'agents/update': () => ({ result: { version: '0.94.0' } }),
    });
    const store = storeFor(host.socket);
    await store.start();
    store.actions.selectThread(threadKey(HOST, THREAD));
    await settle();
    const updated = store.actions.updateAgent();
    expect(store.snapshot().thread?.updating).toBe(true);
    await updated;
    expect(host.asked.filter((method) => method === 'agents/update' || method === 'thread/reopen')).toEqual(['agents/update', 'thread/reopen']);
    expect(host.params['agents/update']).toEqual([{ agentId: 'claude' }]);
    expect(host.params['thread/reopen']).toEqual([{ threadId: THREAD }]);
    expect(store.snapshot().thread).not.toHaveProperty('updating');
    expect(store.snapshot().error).toBeUndefined();
    store.stop();
  });

  it('says where to update an agent when the Host won\'t let a device, and moves nothing', async () => {
    const host = scriptedHost(() => [{ id: 'claude', name: 'Claude', source: 'preset', version: '0.86.0', installed: true }], {
      'agents/update': () => ({ error: { code: HOST_PROTOCOL.errors.forbidden, message: 'Remote clients can\'t administer the Host' } }),
    });
    const store = storeFor(host.socket);
    await store.start();
    store.actions.selectThread(threadKey(HOST, THREAD));
    await settle();
    await store.actions.updateAgent();
    expect(store.snapshot().error).toBe('Remote clients can\'t administer the Host. That\'s done on the Host\'s computer.');
    expect(host.asked).not.toContain('thread/reopen');
    expect(store.snapshot().thread).not.toHaveProperty('updating');
    store.stop();
  });

  it('shows what waits once the history before it is in, and ends what stopped waiting meanwhile', async () => {
    let attach: () => Answer = () => ({ result: {} });
    const host = scriptedHost(() => [], { 'thread/attach': () => attach() });
    attach = () => ({ result: { ...host.state, journal: { id: 'j-1', head: 2 }, pending: [write], replay: { from: 1, reset: true } } });
    const store = storeFor(host.socket);
    await store.start();
    store.actions.selectThread(threadKey(HOST, THREAD));
    await settle();
    // Not before the replay: the request belongs after it.
    expect(tools(store)).toEqual([]);
    host.notify('thread/event', {
      threadId: THREAD, seq: 1, at: 0,
      event: { kind: 'turnStarted', threadId: THREAD, prompt: [{ type: 'text', text: 'write a.txt' }], origin: { client: { name: 'weave-tui', id: 'c9' } } },
    });
    host.notify('thread/event', {
      threadId: THREAD, seq: 2, at: 0,
      event: { kind: 'update', notification: { sessionId: THREAD, update: { sessionUpdate: 'tool_call', toolCallId: 't-1', title: 'Write a.txt', status: 'pending' } } },
    });
    await settle();
    expect(store.snapshot().thread!.transcript.entries.map(({ kind }) => kind)).toEqual(['message', 'tool']);
    expect(tools(store)[0]).toMatchObject({ permission: { requestId: 'p-1', status: 'pending' } });

    // Away, and back once the TUI answered it.
    store.actions.selectThread(undefined);
    attach = () => ({ result: { ...host.state, journal: { id: 'j-1', head: 2 }, pending: [], replay: { from: 3, reset: false } } });
    store.actions.selectThread(threadKey(HOST, THREAD));
    await settle();
    expect(tools(store)[0]).toMatchObject({ permission: { status: 'ended' } });
    store.stop();
  });

  it('shows a request again when answering it fails, and says why', async () => {
    let answer: Answer = { error: { code: -32602, message: 'Invalid params' } };
    const host = scriptedHost(() => [], {
      'thread/attach': () => ({ result: { ...host.state, journal: { id: 'j-1', head: 0 }, pending: [write], replay: { from: 1, reset: true } } }),
      'pending/answer': () => answer,
    });
    const store = storeFor(host.socket);
    await store.start();
    store.actions.selectThread(threadKey(HOST, THREAD));
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

  it('keeps the list live from a Host that offers threads/watch, and lists once from one that doesn\'t', async () => {
    const listing = (threadId: string, more: Partial<ThreadListing> = {}): ThreadListing => ({
      info: { sessionId: threadId, cwd: '/work', title: 'Fix it' }, agentId: 'claude', state: 'open', activity: 'idle', clients: 0, headless: false, ...more,
    });
    const host = scriptedHost(() => [], {
      'host/hello': () => ({
        result: { protocol: 3, clientId: 'c1', host: { id: HOST, version: '0', pid: 1, startedAt: 0 }, features: [HOST_PROTOCOL.features.watch], acp: { protocolVersion: 1 }, device: { id: 'd-1', name: 'iPad' } },
      }),
      'threads/watch': () => ({ result: { threads: [listing(THREAD)] } }),
    });
    const store = storeFor(host.socket);
    await store.start();
    await settle();
    expect(host.asked).toContain('threads/watch');
    expect(host.asked).not.toContain('threads/list');

    host.notify('threads/updated', { thread: listing('s-2', { activity: 'waiting', info: { sessionId: 's-2', cwd: '/elsewhere' } }) });
    // Closed, the Host lists it without the title it had.
    host.notify('threads/updated', { thread: listing(THREAD, { state: 'closed', activity: null, info: { sessionId: THREAD, cwd: '/work' } }) });
    await settle();
    expect(store.snapshot().threads.map(({ threadId, state, activity, title }) => ({ threadId, state, activity, title }))).toEqual([
      { threadId: THREAD, state: 'closed', activity: undefined, title: 'Fix it' },
      { threadId: 's-2', state: 'open', activity: 'waiting', title: undefined },
    ]);
    host.notify('threads/removed', { threadId: 's-2' });
    await settle();
    expect(store.snapshot().threads.map(({ threadId }) => threadId)).toEqual([THREAD]);
    store.stop();

    const older = scriptedHost(() => []);
    const listed = storeFor(older.socket);
    await listed.start();
    await settle();
    expect(older.asked).toContain('threads/list');
    expect(older.asked).not.toContain('threads/watch');
    listed.stop();
  });
});

describe('HostStore closing and deleting', () => {
  it('says what failed and why when the Host can\'t delete a thread', async () => {
    const host = scriptedHost(() => [], {
      'thread/delete': () => ({ error: { code: -32603, message: 'Internal error', data: 'the agent couldn\'t start' } }),
    });
    const store = storeFor(host.socket);
    await store.start();
    await settle();
    await store.actions.deleteThread(threadKey(HOST, THREAD));
    expect(store.snapshot().error).toBe("Couldn't delete the thread: the agent couldn't start");
    expect(store.snapshot().threads.map(({ threadId }) => threadId)).toEqual([THREAD]);
    store.stop();
  });
});

describe('HostStore journal times', () => {
  it('dates the transcript\'s entries by when the journal says their events happened', async () => {
    const host = scriptedHost(() => []);
    const store = storeFor(host.socket);
    await store.start();
    store.actions.selectThread(threadKey(HOST, THREAD));
    await settle();
    host.notify('thread/event', { ...chunk(1, 'Chunk 1. '), at: 1_000 });
    host.notify('thread/event', { ...chunk(2, 'Chunk 2. '), at: 2_500 });
    await settle();
    expect(store.snapshot().thread!.transcript.entries).toMatchObject([{ kind: 'message', startedAt: 1_000, updatedAt: 2_500 }]);
    store.stop();
  });
});

describe('HostStore and the Dispatcher', () => {
  it('pairs with the Dispatcher, keeps the one record, and deletes the Hosts it paired with before', async () => {
    const host = scriptedHost(() => []);
    const storage = memoryStorage(undefined, ['old-mac', 'old-studio']);
    const forgotten: string[] = [];
    const store = storeFor(host.socket, {
      storage,
      keyFor: (keyId) => ({ publicKey: async () => ({ kty: 'EC', crv: 'P-256', x: '', y: '' }), sign: async () => 'signature', forget: async () => { forgotten.push(keyId); } }),
      newKey: async () => ({ keyId: 'new', key: { publicKey: async () => ({ kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }), sign: async () => 'signature', forget: async () => { forgotten.push('new'); } } }),
    });
    await store.start();
    // Not paired yet: the pairing screen, and nothing deleted.
    expect(store.snapshot()).toMatchObject({ hosts: [], threads: [] });
    expect(store.snapshot().dispatcher).toBeUndefined();
    expect(store.snapshot().starting).toBeUndefined();
    expect(forgotten).toEqual([]);

    await store.actions.pairDispatcher({ url: 'https://homelab.example.ts.net:7342', code: 'abcd-efgh', name: 'Test iPad' });
    expect(host.askedDispatcher).toEqual(['dispatcher/hello', 'dispatcher/status', 'hosts/list']);
    expect(store.snapshot().dispatcher).toEqual({ id: DISPATCHER_ID, name: 'homelab', url: 'wss://homelab.example.ts.net:7342', status: 'connected' });
    expect(store.snapshot().hosts).toMatchObject([{ id: HOST, name: 'mac', status: 'connected' }]);
    expect(storage.current()).toEqual({
      dispatcherId: DISPATCHER_ID, name: 'homelab', url: 'wss://homelab.example.ts.net:7342', deviceId: 'd-1', keyId: 'new',
      hosts: [{ id: HOST, name: 'mac' }],
    });
    expect(forgotten).toEqual(['old-mac', 'old-studio']);
    expect(await storage.oldHostKeys()).toEqual([]);
    store.stop();
  });

  it('deletes the Hosts an earlier version paired with once it starts paired', async () => {
    const host = scriptedHost(() => []);
    const forgotten: string[] = [];
    const store = storeFor(host.socket, {
      storage: memoryStorage(PAIRED, ['old-mac']),
      keyFor: (keyId) => ({ publicKey: async () => ({ kty: 'EC', crv: 'P-256', x: '', y: '' }), sign: async () => 'signature', forget: async () => { forgotten.push(keyId); } }),
    });
    await store.start();
    expect(forgotten).toEqual(['old-mac']);
    expect(store.snapshot().hosts).toMatchObject([{ id: HOST, status: 'connected' }]);
    store.stop();
  });

  it("says why a Host the Dispatcher can't reach isn't connected, and connects once it lists it connected", async () => {
    const host = scriptedHost(() => []);
    host.dispatcher.hosts = [listed({ connected: false, status: 'unreachable', why: 'Its connection dropped 2 minutes ago.' })];
    const store = storeFor(host.socket, { backoff: [20] });
    await store.start();
    expect(store.snapshot().hosts).toMatchObject([{ id: HOST, status: 'unreachable', error: 'Its connection dropped 2 minutes ago.' }]);
    expect(host.connects.opened).toBe(0);

    host.dispatcher.hosts = [listed()];
    await settle(60);
    expect(host.connects.opened).toBe(1);
    expect(store.snapshot().hosts).toMatchObject([{ id: HOST, status: 'connected' }]);
    store.stop();
  });

  it('says why when the Dispatcher no longer reaches a Host it listed, and lists again', async () => {
    const host = scriptedHost(() => []);
    const store = storeFor(host.socket, { backoff: [20] });
    await store.start();
    host.dispatcher.hosts = [listed({ connected: false, status: 'unreachable', why: 'It went away.' })];
    host.close(1006);
    await settle(60);
    expect(store.snapshot().hosts).toMatchObject([{ id: HOST, status: 'unreachable', error: 'It went away.' }]);
    expect(host.askedDispatcher.filter((method) => method === 'hosts/list').length).toBeGreaterThan(1);
    store.stop();
  });

  it('drops a Host the Dispatcher no longer lists, with its threads', async () => {
    const host = scriptedHost(() => []);
    const store = storeFor(host.socket);
    await store.start();
    expect(store.snapshot().threads).toHaveLength(1);
    host.dispatcher.hosts = [];
    await store.refresh();
    expect(store.snapshot().hosts).toEqual([]);
    expect(store.snapshot().threads).toEqual([]);
    store.stop();
  });

  it("keeps the Hosts it last listed while the Dispatcher can't be reached, and connects again once it can", async () => {
    const host = scriptedHost(() => []);
    let down = true;
    const socket: SocketOpener = (url, subprotocol) => async (events, signal) => {
      if (down) throw new Error('connection refused');
      return host.socket(url, subprotocol)(events, signal);
    };
    const store = storeFor(socket, { storage: memoryStorage({ ...PAIRED, hosts: [{ id: HOST, name: 'mac' }] }), backoff: [20] });
    await store.start();
    expect(store.snapshot().dispatcher).toMatchObject({ status: 'reconnecting', error: expect.stringContaining("Couldn't reach the Dispatcher") });
    expect(store.snapshot().hosts).toMatchObject([{ id: HOST, name: 'mac' }]);
    expect(host.connects.opened).toBe(0);

    down = false;
    await settle(60);
    expect(store.snapshot().dispatcher?.status).toBe('connected');
    expect(store.snapshot().hosts).toMatchObject([{ id: HOST, status: 'connected' }]);

    // It drops: the Hosts stay as it last listed them, and it comes back.
    down = true;
    host.closeApi(1006);
    await settle(5);
    expect(store.snapshot().dispatcher?.status).toBe('reconnecting');
    expect(store.snapshot().hosts).toMatchObject([{ id: HOST }]);
    down = false;
    await settle(60);
    expect(store.snapshot().dispatcher?.status).toBe('connected');
    store.stop();
  });

  it("stops trying when the Dispatcher refuses the device, and says to pair again", async () => {
    const host = scriptedHost(() => []);
    host.dispatcher.refuse = true;
    const store = storeFor(host.socket, { backoff: [5] });
    await store.start();
    expect(store.snapshot().dispatcher).toMatchObject({ status: 'refused', error: expect.stringContaining('Pair it again') });
    await settle(30);
    expect(host.connects.api).toBe(1);
    await store.refresh();
    expect(host.connects.api).toBe(1);
    store.stop();
  });

  it('forgets the pairing when the Dispatcher revokes the device (4000), and says to pair again', async () => {
    const host = scriptedHost(() => []);
    const storage = memoryStorage(PAIRED);
    const forgotten: string[] = [];
    const store = storeFor(host.socket, {
      storage,
      keyFor: (keyId) => ({
        publicKey: async () => ({ kty: 'EC', crv: 'P-256', x: '', y: '' }),
        sign: async () => 'signature',
        forget: async () => { forgotten.push(keyId); },
      }),
      backoff: [5],
    });
    await store.start();
    store.actions.selectThread(threadKey(HOST, THREAD));
    await settle();
    expect(store.snapshot().thread).toBeDefined();

    host.close(HOST_PROTOCOL.websocket.closeRevoked, 'the device was revoked');
    await settle(30);
    expect(store.snapshot().dispatcher).toMatchObject({ status: 'revoked', error: expect.stringContaining('Pair it again') });
    expect(store.snapshot().hosts).toEqual([]);
    expect(store.snapshot().threads).toEqual([]);
    expect(store.snapshot().thread).toBeUndefined();
    expect(forgotten).toEqual(['k']);
    expect(storage.current()).toBeUndefined();
    // Nothing to connect with: coming to the front, or asking, tries nothing.
    await store.refresh();
    await store.actions.reconnectDispatcher();
    expect(host.connects.api).toBe(1);
    expect(host.connects.opened).toBe(1);
    store.stop();
  });

  it('forgets the Dispatcher and its key when asked', async () => {
    const host = scriptedHost(() => []);
    const storage = memoryStorage(PAIRED);
    const forgotten: string[] = [];
    const store = storeFor(host.socket, {
      storage,
      keyFor: (keyId) => ({ publicKey: async () => ({ kty: 'EC', crv: 'P-256', x: '', y: '' }), sign: async () => 'signature', forget: async () => { forgotten.push(keyId); } }),
    });
    await store.start();
    await store.actions.forgetDispatcher();
    expect(store.snapshot().dispatcher).toBeUndefined();
    expect(store.snapshot().hosts).toEqual([]);
    expect(forgotten).toEqual(['k']);
    expect(storage.current()).toBeUndefined();
    store.stop();
  });
});

describe('HostStore reconnecting', () => {
  it('reconnects at once when it fell behind (4001), and gets only what it missed', async () => {
    const host = scriptedHost(() => [], {
      'thread/attach': (given) => {
        const after = (given as { after?: { seq: number } }).after;
        return { result: { ...host.state, journal: { id: 'j-1', head: after?.seq ?? 0 }, replay: { from: (after?.seq ?? 0) + 1, reset: !after } } };
      },
    });
    const store = storeFor(host.socket, { backoff: [60_000] });
    await store.start();
    store.actions.selectThread(threadKey(HOST, THREAD));
    await settle();
    host.notify('thread/event', chunk(1, 'Chunk 1. '));
    host.notify('thread/event', chunk(2, 'Chunk 2. '));
    await settle();

    host.close(HOST_PROTOCOL.websocket.closeBehind, 'fell behind; attach again after your position');
    await settle();
    // Not after the minute the backoff would wait.
    expect(host.connects.opened).toBe(2);
    expect(store.snapshot().hosts[0].status).toBe('connected');
    expect(host.params['thread/attach']?.at(-1)).toMatchObject({ threadId: THREAD, after: { journal: 'j-1', seq: 2 } });
    host.notify('thread/event', chunk(2, 'Chunk 2. '));
    host.notify('thread/event', chunk(3, 'Chunk 3. '));
    await settle();
    expect(said(store)).toBe('Chunk 1. Chunk 2. Chunk 3. ');
    store.stop();
  });

  it('loads a thread it opens before showing it, and keeps one on screen showing as it catches up', async () => {
    let head = 2;
    const host = scriptedHost(() => [], {
      'thread/attach': (given) => {
        const after = (given as { after?: { seq: number } }).after;
        return { result: { ...host.state, journal: { id: 'j-1', head }, replay: { from: (after?.seq ?? 0) + 1, reset: !after } } };
      },
    });
    const store = storeFor(host.socket, { backoff: [60_000] });
    await store.start();
    store.actions.selectThread(threadKey(HOST, THREAD));
    await settle();
    expect(store.snapshot().thread?.loading).toBe(true);
    host.notify('thread/event', chunk(1, 'Chunk 1. '));
    await settle();
    expect(store.snapshot().thread?.loading).toBe(true);
    host.notify('thread/event', chunk(2, 'Chunk 2. '));
    await settle();
    expect(store.snapshot().thread?.loading).toBeUndefined();
    expect(said(store)).toBe('Chunk 1. Chunk 2. ');

    // Caught up after a reconnect, it shows throughout.
    head = 3;
    host.close(HOST_PROTOCOL.websocket.closeBehind, 'fell behind; attach again after your position');
    await settle();
    expect(host.connects.opened).toBe(2);
    expect(store.snapshot().thread?.loading).toBeUndefined();
    host.notify('thread/event', chunk(3, 'Chunk 3. '));
    await settle();
    expect(store.snapshot().thread?.loading).toBeUndefined();
    expect(said(store)).toBe('Chunk 1. Chunk 2. Chunk 3. ');
    store.stop();
  });

  it("backs off, and doesn't say the thread couldn't open, when an attach falls behind before its answer (4001)", async () => {
    let attaches = 0;
    const host = scriptedHost(() => [], {
      'thread/attach': () => {
        attaches += 1;
        if (attaches > 1) return undefined;
        setTimeout(() => host.close(HOST_PROTOCOL.websocket.closeBehind, 'fell behind; attach again after your position'));
        return 'silent';
      },
    });
    const store = storeFor(host.socket, { backoff: [60] });
    await store.start();
    store.actions.selectThread(threadKey(HOST, THREAD));
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
    const store = storeFor(host.socket, { backoff: [5] });
    await store.start();
    await settle(30);
    expect(store.snapshot().hosts).toMatchObject([{
      status: 'disconnected',
      error: "The Host refused this device (this device couldn't be authenticated).",
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
    const store = storeFor(host.socket, { backoff: [5] });
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
    const store = storeFor(host.socket, { backoff: [5] });
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
    const host = scriptedHost(() => [], { 'threads/list': () => silent ? 'silent' : undefined });
    const store = storeFor(host.socket, { probeTimeout: 20 });
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
    const store = storeFor(host.socket, { backoff: [60_000] });
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
    const store = storeFor(host.socket, { connectTimeout: 20, backoff: [5] });
    await store.start();
    expect(store.snapshot().hosts[0]).toMatchObject({ status: 'reconnecting', error: expect.stringContaining("didn't answer") });
    await settle(30);
    expect(store.snapshot().hosts[0].status).toBe('connected');
    expect(host.connects.opened).toBe(1);
    store.stop();
  });
});

describe('HostStore MCP servers', () => {
  const hello = (features: string[]) => () => ({
    result: { protocol: 3, clientId: 'c1', host: { id: HOST, version: '0', pid: 1, startedAt: 0 }, features, acp: { protocolVersion: 1 }, device: { id: 'd-1', name: 'iPad' } },
  });

  it("keeps the open thread's MCP servers as the Host reports them", async () => {
    const declared = { name: 'weave', source: 'host', transport: 'stdio', state: 'declared' } as const;
    const host = scriptedHost(() => [], { 'host/hello': hello([HOST_PROTOCOL.features.mcpServers]) });
    host.state.mcpServers = [declared];
    const store = storeFor(host.socket);
    await store.start();
    store.actions.selectThread(threadKey(HOST, THREAD));
    await settle();
    expect(store.snapshot().thread?.mcpServers).toEqual([declared]);

    host.notify('thread/changed', { threadId: THREAD, mcpServers: [{ ...declared, state: 'connected' }] });
    await settle();
    expect(store.snapshot().thread?.mcpServers?.map(({ state }) => state)).toEqual(['connected']);
    // A change of something else leaves them.
    host.notify('thread/changed', { threadId: THREAD, activity: 'running' });
    await settle();
    expect(store.snapshot().thread?.mcpServers?.map(({ state }) => state)).toEqual(['connected']);
    store.stop();
  });

  it("reports none from a Host that doesn't", async () => {
    const host = scriptedHost(() => []);
    const store = storeFor(host.socket);
    await store.start();
    store.actions.selectThread(threadKey(HOST, THREAD));
    await settle();
    expect(store.snapshot().thread).not.toHaveProperty('mcpServers');
    store.stop();
  });
});

describe('HostStore terminals', () => {
  const hello = (features: string[]) => () => ({
    result: { protocol: 3, clientId: 'c1', host: { id: HOST, version: '0', pid: 1, startedAt: 0 }, features, acp: { protocolVersion: 1 }, device: { id: 'd-1', name: 'iPad' } },
  });
  const terminal = (id: string, extra: Record<string, unknown> = {}) => ({ id, scope: '/work', size: { cols: 80, rows: 24 }, startedAt: 1, ...extra });

  it("lists the Session on screen's terminals and keeps them up to date, until it's left", async () => {
    const host = scriptedHost(() => [], {
      'host/hello': hello([HOST_PROTOCOL.features.terminals]),
      'terminals/watch': () => ({ result: { scope: '/work', terminals: [terminal('t-1', { openedFrom: THREAD, command: { running: true, command: 'cargo test' } })] } }),
      'terminals/new': (params) => ({ result: { terminal: terminal('t-3', { openedFrom: (params as { openedFrom: string }).openedFrom }) } }),
      'terminals/attach': () => ({ result: { ticket: 'k2Vx', expiresAt: 30_000 } }),
      'terminals/setLabel': (params) => ({ result: { terminal: terminal('t-3', { label: (params as { label?: string }).label }) } }),
    });
    const store = storeFor(host.socket);
    await store.start();
    store.actions.selectSession?.(sessionKey(HOST, '/work'));
    store.actions.selectThread(threadKey(HOST, THREAD));
    await settle();
    expect(store.snapshot().hosts[0].canTerminals).toBe(true);
    expect(host.params['terminals/watch']).toEqual([{ directory: '/work' }]);
    expect(store.snapshot().session?.terminals).toEqual([
      { id: 't-1', scope: '/work', openedFrom: THREAD, size: { cols: 80, rows: 24 }, command: { running: true, command: 'cargo test' }, startedAt: 1 },
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

    // A new one is the Session's, in its directory, opened from the thread in front.
    expect(await store.actions.newTerminal()).toBe('t-3');
    expect(host.params['terminals/new']).toEqual([{ directory: '/work', openedFrom: THREAD }]);
    expect(store.snapshot().session?.terminals?.map(({ id }) => id)).toEqual(['t-2', 't-3']);
    // Its stream is on the Host's own listener.
    expect(await store.actions.attachTerminal('t-3')).toEqual({ url: 'wss://homelab', ticket: 'k2Vx', carry: { dispatcherId: DISPATCHER_ID, deviceId: 'd-1', keyId: 'k', host: HOST } });
    await store.actions.renameTerminal('t-3', '  tests ');
    expect(store.snapshot().session?.terminals?.find(({ id }) => id === 't-3')?.label).toBe('tests');
    await store.actions.renameTerminal('t-3', '');
    expect(host.params['terminals/setLabel']).toEqual([{ id: 't-3', label: 'tests' }, { id: 't-3' }]);

    // Leaving the thread keeps them; leaving the Session lets them go.
    store.actions.selectThread(undefined);
    await settle();
    expect(host.asked).not.toContain('terminals/unwatch');
    store.actions.selectSession?.(undefined);
    await settle();
    expect(host.params['terminals/unwatch']).toEqual([{ scope: '/work' }]);
    expect(store.snapshot().session).toBeUndefined();
    store.stop();
  });

  it("doesn't ask a Host without terminals for them", async () => {
    const host = scriptedHost(() => []);
    const store = storeFor(host.socket);
    await store.start();
    store.actions.selectSession?.(sessionKey(HOST, '/work'));
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
      const store = storeFor(host.socket);
      await store.start();
      await settle();
      const removed = store.actions.removeWorktree({ hostId: HOST, path: '/work.feature' });
      await expect(removed).rejects.toThrow();
      store.stop();
      return removed.catch((error: Error) => error.message);
    };
    expect(await removal({ threads: [THREAD], terminals: [] }))
      .toBe('A thread in it is running a turn or waiting on you. Let it finish, or stop it, first.');
    expect(await removal({ threads: [], terminals: ['t-1'] }))
      .toBe('A terminal in it is running a command. Let it finish, or stop it, first.');
    expect(await removal({ threads: [THREAD], terminals: ['t-1'] }))
      .toBe('A thread in it is running a turn or waiting on you, and a terminal in it is running a command. Let them finish, or stop them, first.');
  });
});

describe('HostStore Sessions', () => {
  const hello = (features: string[]) => () => ({
    result: { protocol: 3, clientId: 'c1', host: { id: HOST, version: '0', pid: 1, startedAt: 0 }, features, acp: { protocolVersion: 1 }, device: { id: 'd-1', name: 'iPad' } },
  });
  const KEY = sessionKey(HOST, '/work');
  const blocks = (store: HostStore) => layoutBlocks(store.snapshot().session!.layout).map((block) => threadOf(block) ?? block.type);

  /**
   * A Host that keeps Sessions and what's in them: it saves what's set under the next revision,
   * unless told to conflict, and counts what's added as the Session's.
   */
  const sessionsHost = (kept: { revision: number; layout?: unknown; threads?: string[] } = { revision: 0 }) => {
    const conflicts = { next: 0 };
    const host = scriptedHost(() => [], {
      'host/hello': hello([HOST_PROTOCOL.features.sessions, HOST_PROTOCOL.features.sessionsAdd]),
      'sessions/watch': () => ({ result: { sessions: kept.revision > 0 || kept.layout ? [{ directory: '/work', revision: kept.revision, layout: kept.layout ?? null, createdAt: 1, threads: kept.threads ?? [], terminals: [] }] : [] } }),
      'sessions/get': () => ({ result: { session: { directory: '/work', revision: kept.revision, layout: kept.layout ?? null, createdAt: 1, threads: kept.threads ?? [] } } }),
      'sessions/add': (params) => {
        const { threads = [] } = params as { threads?: string[] };
        if (threads.includes('gone')) return { error: { code: -32602, message: 'Invalid params', data: "the thread gone isn't in /work" } };
        kept.threads = [...new Set([...(kept.threads ?? []), ...threads])];
        return { result: { session: { directory: '/work', revision: kept.revision, layout: kept.layout ?? null, createdAt: 1, updatedAt: 2, threads: kept.threads, terminals: [] } } };
      },
      'sessions/set': (params) => {
        const { layout, ifRevision } = params as { layout: unknown; ifRevision?: number };
        if (conflicts.next > 0 || (ifRevision !== undefined && ifRevision !== kept.revision)) {
          conflicts.next = Math.max(0, conflicts.next - 1);
          return { error: { code: HOST_PROTOCOL.errors.revisionConflict, message: 'another client saved first', data: { revision: kept.revision } } };
        }
        kept.revision += 1;
        kept.layout = layout;
        return { result: { session: { directory: '/work', revision: kept.revision, layout, createdAt: 1, updatedAt: 2, threads: kept.threads ?? [] } } };
      },
    });
    return { host, kept, conflicts };
  };
  /** A layout another device saved: its Blocks docked side by side. */
  const sideBySide = (...shown: ReturnType<typeof threadBlock>[]) => ({
    version: 2,
    tabs: [{ id: 't', root: shown.length === 1 ? { kind: 'block', ...shown[0] } : { kind: 'row', children: shown.map((block) => ({ kind: 'block', ...block })) } }],
  });

  it('shows a Session with no layout as an empty tab, saves one once it has a Block, and has its Host count what Blocks show as its own', async () => {
    const { host, kept } = sessionsHost();
    const store = storeFor(host.socket);
    await store.start();
    store.actions.selectSession?.(KEY);
    await settle();
    expect(host.asked).toContain('sessions/watch');
    // Nothing is placed for the person: its directory's thread is no Block of it, nor its own.
    expect(store.snapshot().session).toMatchObject({ key: KEY, hostId: HOST, directory: '/work', saved: false, own: { threads: [], terminals: [] } });
    expect(blocks(store)).toEqual([]);
    expect(host.asked).not.toContain('sessions/set');

    store.actions.updateLayout?.(KEY, (layout) => placeBlock(layout, threadBlock(THREAD, 'b-1'), { tab: layout.tabs[0].id }));
    // Here at once, and on the Host under the revision it was made on.
    expect(blocks(store)).toEqual([THREAD]);
    await settle();
    expect(host.params['sessions/set']).toEqual([{ directory: '/work', layout: kept.layout, ifRevision: 0 }]);
    expect(store.snapshot().session).toMatchObject({ saved: true });

    // What a Block shows is the Session's from then on: asked once each, and one that's gone not again.
    store.actions.addToSession?.(KEY, { threads: [THREAD, 'gone'], terminals: [] });
    await settle();
    store.actions.addToSession?.(KEY, { threads: [THREAD, 'gone'], terminals: [] });
    await settle();
    expect(host.params['sessions/add']).toEqual([{ directory: '/work', threads: [THREAD] }, { directory: '/work', threads: ['gone'] }]);
    expect(store.snapshot().session).toMatchObject({ saved: true, own: { threads: [THREAD], terminals: [] } });
    expect(blocks(store)).toEqual([THREAD]);
    expect(store.snapshot().known).toEqual([{ hostId: HOST, directory: '/work', threads: [THREAD], terminals: [], keepsOwn: true, updatedAt: 2 }]);
    store.stop();
  });

  it("takes another device's layout, and makes its own change again on top of one saved first", async () => {
    const { host, kept, conflicts } = sessionsHost({ revision: 1, layout: sideBySide(threadBlock(THREAD, 'b-1')), threads: [THREAD] });
    const store = storeFor(host.socket);
    await store.start();
    store.actions.selectSession?.(KEY);
    await settle();
    const own = layoutBlocks(store.snapshot().session!.layout)[0];
    expect(blocks(store)).toEqual([THREAD]);

    // Another device arranged it: this one shows that.
    const theirs = sideBySide(own, threadBlock('s-9', 'b-9'));
    kept.revision = 4;
    kept.layout = theirs;
    host.notify('sessions/updated', { session: { directory: '/work', revision: 4, layout: theirs, createdAt: 1 } });
    await settle();
    expect(blocks(store)).toEqual([THREAD, 's-9']);

    // It saves again before this device's change arrives: the change is made on what it saved.
    const newer = sideBySide(own, threadBlock('s-9', 'b-9'), threadBlock('s-10', 'b-10'));
    kept.revision = 5;
    kept.layout = newer;
    store.actions.updateLayout?.(KEY, (layout) => placeBlock(layout, threadBlock('s-2', 'b-2'), { beside: own.id, side: 'right' }));
    expect(blocks(store)).toEqual([THREAD, 's-2', 's-9']);
    await settle();
    expect(host.params['sessions/set'].map((params) => (params as { ifRevision: number }).ifRevision)).toEqual([4, 5]);
    expect(host.asked.filter((method) => method === 'sessions/get')).toHaveLength(1);
    expect(blocks(store)).toEqual([THREAD, 's-2', 's-9', 's-10']);
    expect(conflicts.next).toBe(0);

    // The Session ends, as with its worktree: nothing of it is left.
    host.notify('sessions/ended', { directory: '/work' });
    await settle();
    expect(store.snapshot().known).toEqual([]);
    expect(blocks(store)).toEqual([]);
    store.stop();
  });

  it('keeps a layout to itself on a Host from before Sessions', async () => {
    const host = scriptedHost(() => []);
    const store = storeFor(host.socket);
    await store.start();
    store.actions.selectSession?.(KEY);
    await settle();
    expect(host.asked).not.toContain('sessions/watch');
    store.actions.updateLayout?.(KEY, (layout) => placeBlock(layout, threadBlock('s-2', 'b-2'), { tab: layout.tabs[0].id }));
    await settle();
    expect(blocks(store)).toEqual(['s-2']);
    expect(host.asked).not.toContain('sessions/set');
    // It keeps nothing of what's whose either: everything in the directory is the Session's.
    expect(store.snapshot().session).not.toHaveProperty('own');
    expect(store.snapshot().session?.saved).toBe(false);
    store.stop();
  });

  it('follows every thread on screen, acts in the one named, and leaves those no longer there', async () => {
    const other = 's-2';
    const host = scriptedHost(() => [], {
      'threads/list': () => ({ result: { threads: [THREAD, other].map((id) => ({ info: { sessionId: id, cwd: '/work' }, agentId: 'claude', state: 'open', activity: 'idle', clients: 1, headless: false })) } }),
      'thread/attach': (params) => ({ result: { threadId: (params as { threadId: string }).threadId, agent: { id: 'claude', name: 'Claude', initialize: { protocolVersion: 1 } }, cwd: '/work', state: 'open', activity: 'idle', clients: 1, blank: false, policy: {}, journal: { id: 'j', head: 0 }, replay: { from: 1, reset: true } } }),
    });
    const store = storeFor(host.socket);
    await store.start();
    const [first, second] = [threadKey(HOST, THREAD), threadKey(HOST, other)];
    store.actions.showThreads?.([first, second], first);
    await settle();
    expect(host.params['thread/attach'].map((params) => (params as { threadId: string }).threadId)).toEqual([THREAD, other]);
    expect(Object.keys(store.snapshot().open ?? {})).toEqual([first, second]);
    expect(store.snapshot().selectedKey).toBe(first);
    expect(store.snapshot().thread?.key).toBe(first);

    // In the thread named, not the one in front.
    await store.actions.forThread?.(second).cancelTurn();
    await store.actions.cancelTurn();
    expect(host.params['turn/cancel']).toEqual([{ threadId: other }, { threadId: THREAD }]);

    // The same threads again attaches nothing; one fewer leaves it.
    store.actions.showThreads?.([first, second], second);
    await settle();
    expect(host.params['thread/attach']).toHaveLength(2);
    expect(store.snapshot().selectedKey).toBe(second);
    store.actions.showThreads?.([second], second);
    await settle();
    expect(host.params['thread/detach']).toEqual([{ threadId: THREAD, close: 'never' }]);
    expect(Object.keys(store.snapshot().open ?? {})).toEqual([second]);
    store.stop();
  });

  it('ends a Session on its Host, for good, and says why the Host wouldn’t', async () => {
    const { host, kept } = sessionsHost({ revision: 2, layout: { version: 1, tabs: [{ id: 't' }] } });
    const store = storeFor(host.socket);
    await store.start();
    store.actions.selectSession?.(KEY);
    await settle();
    // Only a Host whose `sessions/end` closes what's in the Session says so.
    expect(store.snapshot().hosts[0].canEndSessions).toBeUndefined();
    expect(store.snapshot().known).toHaveLength(1);
    await store.actions.endSession?.(KEY);
    expect(host.params['sessions/end']).toEqual([{ directory: '/work' }]);
    // Gone here at once: off the list, and off the screen.
    expect(store.snapshot().known).toEqual([]);
    expect(store.snapshot().session).toBeUndefined();
    expect(kept.revision).toBe(2);
    store.stop();

    const busy = scriptedHost(() => [], {
      'host/hello': hello([HOST_PROTOCOL.features.sessions, HOST_PROTOCOL.features.sessionsEnd]),
      'sessions/end': () => ({ error: { code: HOST_PROTOCOL.errors.sessionBusy, message: 'busy', data: { threads: [], terminals: ['t-1'] } } }),
    });
    const refused = storeFor(busy.socket);
    await refused.start();
    await settle();
    expect(refused.snapshot().hosts[0].canEndSessions).toBe(true);
    await expect(refused.actions.endSession?.(KEY)).rejects.toThrow('A terminal in it is running a command. Let it finish, or stop it, first.');
    refused.stop();
  });

  it("lists the person's Projects from a Dispatcher that keeps them", async () => {
    const host = scriptedHost(() => [], {
      'dispatcher/hello': () => ({ result: { protocol: DISPATCHER.protocol, version: '0', id: DISPATCHER_ID, device: { id: 'd-1', name: 'iPad' }, features: [DISPATCHER.features.projects] } }),
      'projects/list': () => ({ result: { projects: [{ id: 'p-1', name: 'weave', kind: 'git', locations: [{ hostId: HOST, path: '/work' }], createdAt: 1, updatedAt: 1 }] } }),
    });
    const store = storeFor(host.socket);
    await store.start();
    await settle();
    expect(host.askedDispatcher).toContain('projects/list');
    expect(store.snapshot().projects).toEqual([{ id: 'p-1', name: 'weave', locations: [{ hostId: HOST, path: '/work' }] }]);
    store.stop();

    // One that doesn't isn't asked.
    const plain = scriptedHost(() => []);
    const without = storeFor(plain.socket);
    await without.start();
    await settle();
    expect(plain.askedDispatcher).not.toContain('projects/list');
    expect(without.snapshot()).not.toHaveProperty('projects');
    without.stop();
  });
});
