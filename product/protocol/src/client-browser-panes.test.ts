import { expect, test } from 'bun:test';
import { parsePortalRpcParams, parsePortalRpcResult, parseWorkspaceComposition, paneTargets, PORTAL_PROTOCOL_VERSION } from './index.ts';
const params = { hostId: 'host', workspaceId: 'workspace', expectedRevision: 4, paneId: 'client-pane', sourcePaneId: 'source', axis: 'horizontal', initialUrl: 'https://linear.app/' };
test('Client Browser creation shares only its initial address and placement', () => {
  expect(parsePortalRpcParams('client-browser.pane.create', params)).toEqual(params);
  for (const extra of [{ profileId: 'local' }, { currentUrl: 'https://private.example/' }, { cookies: [] }, { workspaceName: 'New' }]) expect(() => parsePortalRpcParams('client-browser.pane.create', { ...params, ...extra })).toThrow('Unexpected');
  for (const initialUrl of ['file:///etc/passwd', 'javascript:alert(1)', 'about:config', 'https://user:pass@example.com/']) expect(() => parsePortalRpcParams('client-browser.pane.create', { ...params, initialUrl })).toThrow();
});
test('schema 3 Host Browser migration preserves identities and does not mutate its input', () => {
  const legacy = { schemaVersion: 3, hostId: 'host', revision: 7, workspaces: [{ workspaceId: 'work', name: 'Work', layout: { kind: 'browser', nodeId: 'node', paneId: 'pane', profileId: 'profile', lastCommittedUrl: 'https://github.com/' } }] };
  const migrated = parseWorkspaceComposition(legacy);
  expect(migrated).toEqual({ ...legacy, schemaVersion: 4, workspaces: [{ ...legacy.workspaces[0], layout: { ...legacy.workspaces[0]!.layout, kind: 'host-browser' } }] });
  expect(legacy.workspaces[0]!.layout.kind).toBe('browser');
  expect(parseWorkspaceComposition(migrated)).toEqual(migrated);
  expect(() => parsePortalRpcResult('portal.capabilities', { protocolVersion: PORTAL_PROTOCOL_VERSION - 1 })).toThrow();
});
test('Client Browser leaves reject local state in a composition', () => {
  const node = { kind: 'client-browser', nodeId: 'node', paneId: params.paneId, initialUrl: params.initialUrl };
  const composition = { schemaVersion: 4, hostId: 'host', revision: 1, workspaces: [{ workspaceId: 'work', name: 'Work', layout: node }] };
  expect(paneTargets(parseWorkspaceComposition(composition).workspaces)).toEqual([node]);
  expect(() => parseWorkspaceComposition({ ...composition, workspaces: [{ ...composition.workspaces[0], layout: { ...node, profileId: 'local' } }] })).toThrow('belongs to the client');
});
