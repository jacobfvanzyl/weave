import { expect, test } from 'bun:test';
import { parsePortalRpcParams, parsePortalRpcResult } from './index.ts';

test('Host Profile contracts reject Workspace addressing and client-supplied storage paths', () => {
  expect(parsePortalRpcParams('browser.profile.create', { name: ' Work ' })).toEqual({ name: 'Work' });
  for (const input of [{ name: 'Work', workspaceId: 'w' }, { name: 'Work', directory: '/tmp/profile' }, { name: 'Work', profileId: crypto.randomUUID() }]) {
    expect(() => parsePortalRpcParams('browser.profile.create', input)).toThrow();
  }
  expect(() => parsePortalRpcParams('browser.profile.list', { workspaceId: 'w' })).toThrow();
  expect(() => parsePortalRpcParams('browser.profile.rename', { profileId: '../profile', name: 'Work', expectedRevision: 0 })).toThrow();
  expect(() => parsePortalRpcParams('browser.profile.rename', { profileId: crypto.randomUUID(), name: 'Work', expectedRevision: -1 })).toThrow();
});

test('Profile responses reject duplicate identities and malformed revisions', () => {
  const profile = { profileId: crypto.randomUUID(), name: 'Work', revision: 0 };
  expect(parsePortalRpcResult('browser.profile.list', { profiles: [profile] })).toEqual({ profiles: [profile] });
  expect(() => parsePortalRpcResult('browser.profile.list', { profiles: [profile, profile] })).toThrow('Duplicate');
  expect(() => parsePortalRpcResult('browser.profile.create', { profile: { ...profile, revision: 0.5 } })).toThrow();
});
