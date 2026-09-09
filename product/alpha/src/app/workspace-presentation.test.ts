import { expect, it } from 'vitest';
import { activateWorkspaceTab, closeWorkspaceTab, emptyWorkspacePresentation, parseWorkspacePresentation, tabReferenceKey } from './workspace-presentation';

it('recovers presentation fields independently and preserves deterministic recent workspace selection', () => {
  const first = { hostId: 'host', workspaceId: 'workspace', tabId: 'first' };
  const second = { ...first, tabId: 'second' };
  let state = activateWorkspaceTab(activateWorkspaceTab(emptyWorkspacePresentation(), first), second);
  state = activateWorkspaceTab(state, first);
  expect(state.openTabs).toEqual([first, second]);
  expect(state.activeTab).toBe(tabReferenceKey(first));
  const recovered = parseWorkspacePresentation(JSON.stringify({ ...state, focusedPanes: [], maximizedPanes: { [tabReferenceKey(first)]: 'pane' }, openTabs: [...state.openTabs, first, null] }));
  expect(recovered.openTabs).toEqual([first, second]);
  expect(recovered.focusedPanes).toEqual({});
  expect(recovered.maximizedPanes).toEqual({ [tabReferenceKey(first)]: 'pane' });
  expect(recovered.activeTab).toBe(tabReferenceKey(first));
  expect(closeWorkspaceTab(recovered, tabReferenceKey(first)).activeTab).toBe(tabReferenceKey(second));
  expect(parseWorkspacePresentation('{broken')).toEqual(emptyWorkspacePresentation());
});
