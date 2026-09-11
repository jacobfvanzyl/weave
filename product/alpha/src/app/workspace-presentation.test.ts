import { expect, it } from 'vitest';
import { showWorkspaceHostIdentity, reconcileWorkspacePresentation, activateWorkspace, closeWorkspace, emptyWorkspacePresentation, parseWorkspacePresentation, workspaceKey } from './workspace-presentation';

it('recovers presentation fields independently and preserves deterministic recent workspace selection', () => {
  const first = { hostId: 'host', workspaceId: 'first' };
  const second = { ...first, workspaceId: 'second' };
  let state = activateWorkspace(activateWorkspace(emptyWorkspacePresentation(), first), second);
  state = activateWorkspace(state, first);
  expect(state.openWorkspaces).toEqual([first, second]);
  expect(state.activeWorkspace).toBe(workspaceKey(first));
  const recovered = parseWorkspacePresentation(JSON.stringify({ ...state, focusedPanes: [], maximizedPanes: { [workspaceKey(first)]: 'pane' }, openWorkspaces: [...state.openWorkspaces, first, null] }));
  expect(recovered.openWorkspaces).toEqual([first, second]);
  expect(recovered.focusedPanes).toEqual({});
  expect(recovered.maximizedPanes).toEqual({ [workspaceKey(first)]: 'pane' });
  expect(recovered.activeWorkspace).toBe(workspaceKey(first));
  expect(closeWorkspace(recovered, workspaceKey(first)).activeWorkspace).toBe(workspaceKey(second));
  expect(parseWorkspacePresentation('{broken')).toEqual(emptyWorkspacePresentation());
});


it('migrates device selections without changing pane identity', () => {
  const old = JSON.stringify(['host', 'directory', 'arrangement']);
  const current = JSON.stringify(['host', 'arrangement']);
  const value = parseWorkspacePresentation(JSON.stringify({ schemaVersion: 1, openTabs: [{ hostId: 'host', workspaceId: 'directory', tabId: 'arrangement' }], activeTab: old, recentTabs: [old], focusedPanes: { [old]: 'pane' }, maximizedPanes: { [old]: 'pane' } }));
  expect(value.openWorkspaces).toEqual([{ hostId: 'host', workspaceId: 'arrangement' }]);
  expect(value.activeWorkspace).toBe(current);
  expect(value.focusedPanes[current]).toBe('pane');
  expect(value.maximizedPanes[current]).toBe('pane');
});

it('shows Host identity only when saved Workspaces span configured Hosts, including hidden or offline ones', () => {
  const connections = [{ hostId: 'one' }, { hostId: 'two' }];
  const state = emptyWorkspacePresentation();
  expect(showWorkspaceHostIdentity(connections, {}, state)).toBe(false);
  expect(showWorkspaceHostIdentity(connections, { one: { workspaces: ['first', 'second'] }, two: { workspaces: [] } }, state)).toBe(false);
  expect(showWorkspaceHostIdentity(connections, { one: { workspaces: ['hidden'] }, two: { workspaces: ['other'] } }, state)).toBe(true);
  const offline = activateWorkspace(state, { hostId: 'two', workspaceId: 'remembered' });
  expect(showWorkspaceHostIdentity(connections, { one: { workspaces: ['first'] } }, offline)).toBe(true);
  expect(showWorkspaceHostIdentity([{ hostId: 'one' }], { one: { workspaces: ['first'] }, two: { workspaces: ['forgotten'] } }, offline)).toBe(false);
});

it('reveals all Host workspaces, recovers previously hidden ones, and forgets removed workspaces', () => {
  const current = { hostId: 'host', workspaceId: 'active' };
  const recovered = { hostId: 'host', workspaceId: 'ordinary-workspace' };
  const state = activateWorkspace(emptyWorkspacePresentation(), current);
  const revealed = reconcileWorkspacePresentation(state, 'host', [current, recovered]);
  expect(revealed.openWorkspaces).toEqual([current, recovered]);
  expect(revealed.activeWorkspace).toBe(workspaceKey(current));
  const hidden = parseWorkspacePresentation(JSON.stringify(closeWorkspace(revealed, workspaceKey(recovered))));
  expect(reconcileWorkspacePresentation(hidden, 'host', [current, recovered]).openWorkspaces).toEqual([current, recovered]);
  const removed = reconcileWorkspacePresentation(revealed, 'host', [recovered]);
  expect(removed.openWorkspaces).toEqual([recovered]);
  expect(removed.activeWorkspace).toBe(workspaceKey(recovered));
  expect(reconcileWorkspacePresentation(removed, 'host', [recovered])).toBe(removed);
});
