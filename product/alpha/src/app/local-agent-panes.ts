import { paneTargets, parseWorkspaces, type PaneLayoutNode, type PaneNode, type WorkspaceComposition, type Workspace } from '@weave/product-protocol';
import type { AlphaThread } from './alpha-controller';

export type LocalAgentPane = {
  thread: AlphaThread;
  agentId: string;
  pane: Extract<PaneNode, { kind: 'agent' }>;
  sourcePaneId?: string;
  splitNodeId: string;
  axis: 'horizontal' | 'vertical';
  ratio: number;
  beforeSource?: boolean;
  text: string;
  sending: boolean;
  createdThreadId?: string;
};

// Only this projection contains draft leaves. Host mutations always use the
// authoritative composition; neither draft content nor draft IDs are sent.
export function projectLocalAgentPanes(composition: WorkspaceComposition, drafts: LocalAgentPane[]): WorkspaceComposition {
  let workspaces = composition.workspaces;
  for (const draft of drafts) {
    if (draft.thread.hostId !== composition.hostId) continue;
    workspaces = workspaces.map(workspace => {
      if (workspace.workspaceId !== draft.thread.workspaceId) return workspace;
      const wrap = (node: PaneLayoutNode): PaneLayoutNode => ({ kind: 'split', nodeId: draft.splitNodeId, axis: draft.axis, ratio: draft.ratio, children: draft.beforeSource ? [draft.pane, node] : [node, draft.pane] });
      const insert = (node: PaneLayoutNode): PaneLayoutNode => node.kind === 'split'
        ? { ...node, children: [insert(node.children[0]), insert(node.children[1])] }
        : node.paneId === draft.sourcePaneId ? wrap(node) : node;
      if (draft.createdThreadId) {
        const hideCreated = (node: PaneLayoutNode | null): PaneLayoutNode | null => {
          if (!node) return null;
          if (node.kind !== 'split') return node.kind === 'agent' && node.threadId === draft.createdThreadId ? null : node;
          const left = hideCreated(node.children[0]), right = hideCreated(node.children[1]);
          return left && right ? { ...node, children: [left, right] } : left ?? right;
        };
        workspace = { ...workspace, layout: hideCreated(workspace.layout) };
      }
      const found = paneTargets([workspace]).some(pane => pane.paneId === draft.sourcePaneId);
      return { ...workspace, layout: !workspace.layout ? draft.pane : found ? insert(workspace.layout) : wrap(workspace.layout) };
    });
  }
  return { ...composition, workspaces };
}

export function validateLocalAgentPane(composition: WorkspaceComposition, drafts: LocalAgentPane[]) {
  parseWorkspaces(projectLocalAgentPanes(composition, drafts).workspaces);
}

// Promote at the draft's displayed position, collapsing the remaining local
// leaves. Existing Host IDs and concurrent edits survive the operation.
export function materializeAgentPane(composition: WorkspaceComposition, drafts: LocalAgentPane[], draft: LocalAgentPane, pane: PaneNode): Workspace[] {
  const localIds = new Set(drafts.map(item => item.pane.paneId));
  const project = projectLocalAgentPanes(composition, drafts);
  const remove = (node: PaneLayoutNode | null): PaneLayoutNode | null => {
    if (!node) return null;
    if (node.kind !== 'split') {
      if (node.paneId === draft.pane.paneId) return pane;
      return localIds.has(node.paneId) || node.paneId === pane.paneId ? null : node;
    }
    const left = remove(node.children[0]), right = remove(node.children[1]);
    return left && right ? { ...node, children: [left, right] } : left ?? right;
  };
  return parseWorkspaces(project.workspaces.map(workspace => ({ ...workspace, layout: remove(workspace.layout) })));
}
