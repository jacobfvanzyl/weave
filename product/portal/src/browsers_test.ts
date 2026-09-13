import { afterEach, expect, test } from 'bun:test';
import { BrowserSession, type BrowserBackend } from './browsers.ts';
import type { BrowserNotification, BrowserViewGrant } from '@weave/product-protocol';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function setup() {
  let allowed = true;
  let finishAttach: (() => void) | undefined;
  const detached: string[] = [], renewed: string[] = [], calls: string[] = [], notifications: BrowserNotification[] = [];
  const polls = new Map<string, { resolve: (events: BrowserNotification[]) => void; reject: (error: Error) => void }>();
  let delayed = false;
  const backend: BrowserBackend = {
    async browser(method: any, input: any): Promise<any> {
      calls.push(method);
      if (method === 'browser.view.attach') {
        if (delayed) await new Promise<void>(resolve => { finishAttach = resolve; });
        return { grant: { workspaceId: input.workspaceId, tabId: input.tabId, viewId: crypto.randomUUID(), expiresAt: Date.now() + 30000 } };
      }
      return {};
    },
    events(_workspace, view) { return new Promise((resolve, reject) => polls.set(view, { resolve, reject })); },
    async renew(_workspace, view) { renewed.push(view); return { expiresAt: Date.now() + 30000 }; },
    async detach(_workspace, view) { detached.push(view); polls.get(view)?.reject(new Error('Detached')); polls.delete(view); },
    dispose() {},
  };
  const make = () => {
    const session = new BrowserSession(backend, async (workspace) => { if (!allowed || workspace !== 'allowed') throw new Error('Denied'); }, event => { notifications.push(event); return true; }, () => {});
    cleanup.push(() => session.close()); return session;
  };
  return { make, detached, renewed, calls, notifications, polls, deny: () => { allowed = false; }, delay: () => { delayed = true; }, finish: () => finishAttach?.() };
}
const attach = (session: BrowserSession, mode: 'observe' | 'control' = 'control') => session.request('browser.view.attach', { workspaceId: 'allowed', tabId: 'tab', mode });

test('another connection cannot signal or control a grant; observers cannot claim input', async () => {
  const state = setup(), a = state.make(), b = state.make();
  const { grant } = await attach(a, 'observe');
  await expect(b.request('browser.view.focus', { workspaceId: 'allowed', viewId: grant.viewId, width: 800, height: 600 })).rejects.toThrow('unavailable');
  await expect(a.request('browser.view.focus', { workspaceId: 'allowed', viewId: grant.viewId, width: 800, height: 600 })).rejects.toThrow('read-only');
  await expect(a.request('browser.tab.create', { workspaceId: 'denied', url: 'about:blank' })).rejects.toThrow('Denied');
  expect(state.calls).toEqual(['browser.view.attach']);
});
test('revocation stops renewal and releases the service peer', async () => {
  const state = setup(), session = state.make();
  const { grant } = await attach(session);
  await session.renew(); expect(state.renewed).toEqual([grant.viewId]);
  state.deny(); await session.renew();
  expect(state.renewed).toHaveLength(1);
  expect(state.detached).toContain(grant.viewId);
  expect(state.notifications.at(-1)?.message.type).toBe('revoked');
});
test('disconnect during an awaited attachment revokes its late result', async () => {
  const state = setup(), session = state.make(); state.delay();
  const pending = attach(session);
  await Bun.sleep(0); session.close(); state.finish();
  await expect(pending).rejects.toThrow('closed');
  expect(state.detached).toHaveLength(1);
});
test('revocation during attachment cannot establish a view', async () => {
  const state = setup(), session = state.make(); state.delay();
  const pending = attach(session);
  await Bun.sleep(0); state.deny(); state.finish();
  await expect(pending).rejects.toThrow('Denied');
  expect(state.detached).toHaveLength(1);
});
test('misaddressed service events revoke the view instead of reaching another Workspace', async () => {
  const state = setup(), session = state.make();
  const { grant } = await attach(session);
  state.polls.get(grant.viewId)!.resolve([{ workspaceId: 'wrong', viewId: grant.viewId, message: { type: 'inputReady', generation: 1 } }]);
  await Bun.sleep(0);
  expect(state.notifications.every(event => event.message.type === 'revoked')).toBe(true);
  expect(state.detached).toContain(grant.viewId);
});
