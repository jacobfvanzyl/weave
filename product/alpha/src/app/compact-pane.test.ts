import { expect, it } from 'vitest';
import { parseCompactPanes, resolveCompactPane } from './compact-pane';
import type { Workspace } from '@weave/product-protocol';
const workspace: Workspace = { workspaceId: 'w', name: 'Workspace', layout: { kind: 'split', nodeId: 'split', axis: 'horizontal', ratio: 0.4, children: ['a', 'b'].map(id => ({ kind: 'terminal', nodeId: id, paneId: id, terminalId: id, executionContextId: 'ctx' })) as Extract<NonNullable<Workspace['layout']>, { kind: 'split' }>['children'] } };
it('restores an individual pane without changing the shared split tree', () => {
  const before = structuredClone(workspace);
  expect(resolveCompactPane({ kind: 'terminal', id: 'b' }, workspace, [])).toEqual({ kind: 'terminal', id: 'b' });
  expect(resolveCompactPane({ kind: 'agent', id: 'chat' }, workspace, [{ id: 'chat' }])).toEqual({ kind: 'agent', id: 'chat' });
  expect(workspace).toEqual(before);
});
it('falls back deterministically after remote deletion or moving an agent', () => {
  expect(resolveCompactPane({ kind: 'agent', id: 'gone' }, workspace, [])).toEqual({ kind: 'terminal', id: 'a' });
  expect(resolveCompactPane({ kind: 'terminal', id: 'gone' }, { ...workspace, layout: null }, [{ id: 'chat' }])).toEqual({ kind: 'agent', id: 'chat' });
  expect(resolveCompactPane(undefined, { ...workspace, layout: null }, [])).toBeUndefined();
});
it('recovers valid per-workspace selections independently from corrupt entries', () => {
  expect(parseCompactPanes('{')).toEqual({});
  expect(parseCompactPanes(JSON.stringify({ schemaVersion: 1, panes: { first: { kind: 'terminal', id: 'a' }, second: { kind: 'agent', id: 'chat' }, corrupt: { kind: 'split', id: 'bad' } } }))).toEqual({ first: { kind: 'terminal', id: 'a' }, second: { kind: 'agent', id: 'chat' } });
});
