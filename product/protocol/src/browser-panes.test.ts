import { test, expect } from 'bun:test';
import { parseHostBrowserPaneRpcParams, parseHostBrowserPaneRpcResult } from './browser-panes.ts';
import { parseWorkspaceLifecycleResult } from './workspace-lifecycle.ts';
const base = { hostId: 'host', expectedRevision: 1, paneId: crypto.randomUUID(), profileId: crypto.randomUUID() };
test('Browser Pane creation validates Workspace, URL, revision and permitted parameters', () => {
  const create = { ...base, workspaceId: 'work', workspaceName: 'Research', axis: 'vertical', url: 'https://example.com/' };
  expect(parseHostBrowserPaneRpcParams('browser.pane.create', create)).toEqual(create);
  for (const bad of [{ ...create, url: 'file:///etc/passwd' }, { ...create, paneId: 'not-a-page-id' }, { ...create, expectedRevision: Number.MAX_SAFE_INTEGER }, { ...create, axis: 'down' }, { ...create, workspaceName: '' }, { ...create, profileOverride: crypto.randomUUID() }]) expect(() => parseHostBrowserPaneRpcParams('browser.pane.create', bad)).toThrow();
  expect(() => parseHostBrowserPaneRpcParams('browser.pane.move', create)).toThrow();
});
test('Browser Pane close requires explicit confirmation and never exposes the private display path', () => {
  expect(() => parseHostBrowserPaneRpcParams('browser.pane.close', base)).toThrow();
  expect(parseHostBrowserPaneRpcParams('browser.pane.close', { ...base, confirmed: false })).toEqual({ ...base, confirmed: false });
  const result = parseHostBrowserPaneRpcResult('browser.pane.create', { composition: { schemaVersion: 4, hostId: 'host', revision: 2, workspaces: [] }, page: { pageId: base.paneId, profileId: base.profileId, title: 'Research', url: 'about:blank', available: false, rfbSocket: '/private/page.sock' } });
  expect(result.page).not.toHaveProperty('rfbSocket');
});
test('Workspace close parsing retains the browser page generation and uncertain-work consequence', () => {
  const plan = { workspaceId: 'work', name: 'Research', token: 'token', terminals: [], threads: [], browsers: [{ pageId: base.paneId, profileId: base.profileId, title: 'R'.repeat(1024), dirty: true, generation: crypto.randomUUID() }] };
  expect(parseWorkspaceLifecycleResult('workspace.close.preview', { plan })).toEqual({ plan });
});
