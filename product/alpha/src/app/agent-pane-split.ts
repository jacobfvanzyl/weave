import { paneTargets, parseWorkspaces, type PaneLayoutNode, type PaneNode, type Workspace } from '@weave/product-protocol';

// Reuse Host-owned Pane identities when positioning a newly created Thread.
// The Host's normal revision check arbitrates concurrent layout edits.
export function placePaneBeside(workspaces: Workspace[], workspaceId: string, sourcePaneId: string, pane: PaneNode, axis: 'horizontal' | 'vertical'): Workspace[] {
  const workspace = workspaces.find(value => value.workspaceId === workspaceId);
  if (!workspace || sourcePaneId === pane.paneId || !paneTargets([workspace]).some(value => value.paneId === sourcePaneId)) throw new Error('Source Pane is unavailable.');
  const remove = (node: PaneLayoutNode | null): PaneLayoutNode | null => {
    if (!node) return null;
    if (node.kind !== 'split') return node.paneId === pane.paneId ? null : node;
    const left = remove(node.children[0]), right = remove(node.children[1]);
    return left && right ? { ...node, children: [left, right] } : left ?? right;
  };
  const insert = (node: PaneLayoutNode): PaneLayoutNode => node.kind === 'split'
    ? { ...node, children: [insert(node.children[0]), insert(node.children[1])] }
    : node.paneId === sourcePaneId ? { kind: 'split', nodeId: crypto.randomUUID(), axis, ratio: 0.5, children: [node, pane] } : node;
  return parseWorkspaces(workspaces.map(value => value === workspace ? { ...value, layout: insert(remove(value.layout)!) } : value));
}
