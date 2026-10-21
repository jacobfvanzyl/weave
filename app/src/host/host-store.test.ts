// The Host store against a scripted Host, for what a dev Host can't produce on demand, such as a
// newer version of an agent being out.
import { describe, expect, it } from 'vitest';
import { sessionKey } from '@/app/app-controller';
import type { Connector, TransportEvents } from './connection';
import { HostStore } from './host-store';
import type { AgentSummary, SessionState } from './protocol';
import { memoryStorage } from './storage';

const HOST = 'host-1';
const SESSION = 's-1';

/** A Host that answers what the store asks, with the agents `agents` gives at the time. */
function scriptedHost(agents: () => AgentSummary[]) {
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
  const answers: Record<string, () => unknown> = {
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
        const { id, method } = JSON.parse(text) as { id: number; method: string };
        asked.push(method);
        const result = answers[method]?.() ?? {};
        queueMicrotask(() => events?.message(JSON.stringify({ jsonrpc: '2.0', id, result })));
      },
      close() {},
    };
  };
  const notify = (method: string, params: unknown) => events?.message(JSON.stringify({ jsonrpc: '2.0', method, params }));
  return { connector, asked, notify };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

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
});
