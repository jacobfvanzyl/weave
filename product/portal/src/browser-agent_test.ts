import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { BrowserAgentGateway } from './browser-agent.ts';
import type { ThreadSummary } from '@weave/product-protocol';

test('agent gateway rejects origin/token forgery and discards results across session rotation', async () => {
  const root = await mkdtemp('/tmp/weave-agent-gateway-');
  const threadId = crypto.randomUUID(), profileId = crypto.randomUUID();
  let finish!: () => void, started!: () => void;
  const dispatched = new Promise<void>(resolve => { started = resolve; });
  const barrier = new Promise<void>(resolve => { finish = resolve; });
  const gateway = new BrowserAgentGateway({
    thread: id => ({ threadId: id, status: 'active' }) as ThreadSummary,
    profiles: async () => [{ profileId, name: 'Private', revision: 0 }],
    backend: { managedPage: async <T>(method: string): Promise<T> => {
      if (method === 'debugger.open') return { debuggerId: crypto.randomUUID(), generation: crypto.randomUUID() } as T;
      if (method === 'debugger.send') { started(); await barrier; return { id: 1, result: { secret: true } } as T; }
      return { events: [] } as T;
    } },
    create: async () => ({ targetId: 'unused' }), close: async () => {},
  }, { node: '/unused', script: '/unused' });
  try {
    const descriptor = gateway.servers(threadId)[0]!;
    const env = Object.fromEntries(descriptor.env.map(item => [item.name, item.value]));
    const endpoint = env.WEAVE_BROWSER_ENDPOINT + '/control';
    const headers = { authorization: `Bearer ${env.WEAVE_BROWSER_TOKEN}`, 'content-type': 'application/json' };
    expect((await fetch(endpoint, { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await fetch(endpoint, { method: 'POST', headers: { ...headers, origin: 'http://malicious.test' }, body: '{}' })).status).toBe(403);
    const request = fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ action: 'cdp', method: 'Runtime.evaluate' }) });
    await dispatched;
    gateway.servers(threadId);
    finish(); const response = await request;
    expect(response.status).toBe(400); expect(await response.text()).not.toContain('secret');
    gateway.servers(threadId);
    expect((await fetch(endpoint, { method: 'POST', headers, body: '{}' })).status).toBe(401);
  } finally { finish?.(); await gateway.close(); await rm(root, { recursive: true, force: true }); }
});


test('session rotation during debugger creation closes the late session before dispatch', async () => {
  const root = await mkdtemp('/tmp/weave-agent-open-');
  const threadId = crypto.randomUUID(), profileId = crypto.randomUUID();
  let finish!: () => void, started!: () => void, sent = false, closed = false;
  const opened = new Promise<void>(resolve => { started = resolve; });
  const barrier = new Promise<void>(resolve => { finish = resolve; });
  const gateway = new BrowserAgentGateway({
    thread: id => ({ threadId: id, status: 'active' }) as ThreadSummary, profiles: async () => [{ profileId, name: 'Work', revision: 0 }],
    backend: { managedPage: async <T>(method: string): Promise<T> => {
      if (method === 'debugger.open') { started(); await barrier; return { debuggerId: 'late', generation: 'test' } as T; }
      if (method === 'debugger.send') sent = true;
      if (method === 'debugger.close') closed = true;
      return { events: [] } as T;
    } }, create: async () => ({ targetId: 'unused' }), close: async () => {},
  }, { node: '/unused', script: '/unused' });
  try {
    const env = Object.fromEntries(gateway.servers(threadId)[0]!.env.map(item => [item.name, item.value]));
    const request = fetch(env.WEAVE_BROWSER_ENDPOINT + '/control', { method: 'POST', headers: { authorization: `Bearer ${env.WEAVE_BROWSER_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'cdp', method: 'Runtime.evaluate' }) });
    await opened;
    gateway.servers(threadId);
    finish(); expect((await request).status).toBe(400); expect(sent).toBe(false); expect(closed).toBe(true);
  } finally { finish?.(); await gateway.close(); await rm(root, { recursive: true, force: true }); }
});
