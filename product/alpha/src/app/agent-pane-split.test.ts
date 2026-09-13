import { expect, it } from 'vitest';
import { paneTargets, type PaneNode, type Workspace } from '@weave/product-protocol';
import { placePaneBeside } from './agent-pane-split';
const pane = (id: string): PaneNode => ({ kind: 'agent', nodeId: `node-${id}`, paneId: id, threadId: `thread-${id}` });
it.each(['vertical', 'horizontal'] as const)('places the new Thread beside its actual source with %s orientation and preserves neighbors', axis => {
  const source = pane('source'), neighbor = pane('neighbor'), added = pane('new');
  const workspaces: Workspace[] = [{ workspaceId: 'work', name: 'Work', layout: { kind: 'split', nodeId: 'root', axis: 'horizontal', ratio: .6, children: [source, { kind: 'split', nodeId: 'old-insertion', axis: 'vertical', ratio: .5, children: [neighbor, added] }] } }];
  const next = placePaneBeside(workspaces, 'work', source.paneId, added, axis);
  expect(next[0]?.layout).toMatchObject({ nodeId: 'root', ratio: .6, children: [{ axis, children: [source, added] }, neighbor] });
  expect(paneTargets(next)).toHaveLength(3);
  expect(workspaces[0]?.layout).toMatchObject({ children: [source, { nodeId: 'old-insertion' }] });
});
it('rejects a missing source and validates layout depth before creating a new Thread', () => {
  const source = pane('source');
  const workspace: Workspace = { workspaceId: 'work', name: 'Work', layout: source };
  expect(() => placePaneBeside([workspace], 'work', 'missing', pane('new'), 'vertical')).toThrow('Source Pane');
  for (let depth = 0; depth < 8; depth++) workspace.layout = { kind: 'split', nodeId: `split-${depth}`, axis: 'horizontal', ratio: .5, children: [workspace.layout!, pane(`other-${depth}`)] };
  expect(() => placePaneBeside([workspace], 'work', source.paneId, pane('new'), 'vertical')).toThrow('too deep');
});
