import { test, expect } from 'bun:test';
import { parsePortalRpcParams, parsePortalRpcResult } from './index.ts';
test('browser grants validate identity, explicit scope, revisions and replies', () => {
  const threadId = crypto.randomUUID(), profileId = crypto.randomUUID();
  expect(parsePortalRpcParams('browser.grants.get', { threadId })).toEqual({ threadId });
  expect(parsePortalRpcParams('browser.grants.set', { threadId, profileIds: [profileId], expectedRevision: 0 })).toEqual({ threadId, profileIds: [profileId], expectedRevision: 0 });
  for (const profileIds of [['*'], [profileId, profileId], 'all']) expect(() => parsePortalRpcParams('browser.grants.set', { threadId, profileIds, expectedRevision: 0 })).toThrow();
  expect(() => parsePortalRpcParams('browser.grants.set', { threadId, profileIds: [], expectedRevision: -1 })).toThrow();
  expect(() => parsePortalRpcParams('browser.grants.get', { threadId, workspaceId: 'all' })).toThrow();
  expect(parsePortalRpcResult('browser.grants.set', { threadId, profileIds: [], revision: 1 })).toEqual({ threadId, profileIds: [], revision: 1 });
});
