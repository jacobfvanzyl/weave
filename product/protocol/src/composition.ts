export const COMPOSITION_TERMINAL_CREATION_CAPABILITY = 'workspace.composition.terminal-create';
// In replace requests, null asks the Host to create a terminal for the new pane.
// Readers still accept null to recover arrangements saved by older Hosts.
export const COMPOSITION_RPC_METHODS = ['workspace.composition.get', 'workspace.composition.replace'] as const;
export type CompositionRpcMethod = typeof COMPOSITION_RPC_METHODS[number];
export type PaneLayoutNode =
  | { kind: 'terminal'; nodeId: string; paneId: string; terminalId: string | null; executionContextId: string; launchDirectory?: string }
  | { kind: 'agent'; nodeId: string; paneId: string; threadId: string }
  | { kind: 'browser'; nodeId: string; paneId: string; profileId: string; lastCommittedUrl: string }
  | { kind: 'split'; nodeId: string; axis: 'horizontal' | 'vertical'; ratio: number; children: [PaneLayoutNode, PaneLayoutNode] };
// Compatibility name for callers that operate on the split tree.
export type TerminalLayoutNode = PaneLayoutNode;
export type PaneNode = Exclude<PaneLayoutNode, { kind: 'split' }>;
export type Workspace = { workspaceId: string; name: string; layout: TerminalLayoutNode | null };
export type WorkspaceComposition = { schemaVersion: 3; hostId: string; revision: number; workspaces: Workspace[] };
export type CompositionRpcContracts = {
  'workspace.composition.get': { params: { hostId: string }; result: { composition: WorkspaceComposition } };
  'workspace.composition.replace': {
    params: { hostId: string; expectedRevision: number; workspaces: Workspace[] };
    result: { composition: WorkspaceComposition };
  };
};
export type CompositionErrorData = { domain: 'composition'; code: 'STALE_REVISION' | 'INVALID_TARGET'; currentRevision?: number };

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Composition must be an object.');
  return value as Record<string, unknown>;
};
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || value.includes('\0')) throw new Error('Invalid composition identity.');
  return value;
};
const path = (value: unknown): string => {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) throw new Error('Invalid launch directory.');
  return value;
};
const revision = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid composition revision.');
  return value as number;
};
export function parseWorkspaces(value: unknown, options: { allowDuplicateTerminals?: boolean } = {}): Workspace[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('Composition supports at most 64 Workspaces.');
  const ids = new Set<string>();
  const terminals = new Set<string>();
  const threads = new Set<string>();
  let panes = 0;
  const unique = (value: unknown) => {
    const result = id(value);
    if (ids.has(result)) throw new Error('Duplicate composition identity.');
    ids.add(result);
    return result;
  };
  const layout = (value: unknown, depth = 0): TerminalLayoutNode => {
    if (depth > 8) throw new Error('Composition layout is too deep.');
    const node = record(value);
    const nodeId = unique(node.nodeId);
    if (node.kind === 'terminal') {
      if (++panes > 128) throw new Error('Composition supports at most 128 panes.');
      const terminalId = node.terminalId === null ? null : id(node.terminalId);
      if (terminalId && terminals.has(terminalId) && !options.allowDuplicateTerminals) throw new Error('A terminal can only appear once in a Workspace.');
      if (terminalId) terminals.add(terminalId);
      return { kind: 'terminal', nodeId, paneId: unique(node.paneId), terminalId, executionContextId: id(node.executionContextId), ...(node.launchDirectory === undefined ? {} : { launchDirectory: path(node.launchDirectory) }) };
    }
    if (node.kind === 'agent' || node.kind === 'browser') {
      if (++panes > 128) throw new Error('Composition supports at most 128 panes.');
      const paneId = unique(node.paneId);
      if (node.kind === 'agent') {
        const threadId = id(node.threadId);
        if (threads.has(threadId)) throw new Error('A Thread can only occupy one Agent Pane.');
        threads.add(threadId);
        return { kind: 'agent', nodeId, paneId, threadId };
      }
      if (typeof node.lastCommittedUrl !== 'string' || node.lastCommittedUrl.length > 16384) throw new Error('Invalid browser URL.');
      const url = new URL(node.lastCommittedUrl);
      if (!['https:', 'http:', 'about:'].includes(url.protocol)) throw new Error('Unsupported browser URL.');
      return { kind: 'browser', nodeId, paneId, profileId: id(node.profileId), lastCommittedUrl: node.lastCommittedUrl };
    }
    if (node.kind !== 'split' || !['horizontal', 'vertical'].includes(String(node.axis)) ||
        typeof node.ratio !== 'number' || !Number.isFinite(node.ratio) || node.ratio < 0.1 || node.ratio > 0.9 ||
        !Array.isArray(node.children) || node.children.length !== 2) throw new Error('Invalid composition split.');
    return { kind: 'split', nodeId, axis: node.axis as 'horizontal' | 'vertical', ratio: node.ratio,
      children: [layout(node.children[0], depth + 1), layout(node.children[1], depth + 1)] };
  };
  return value.map((value) => {
    const tab = record(value);
    const workspaceId = unique(tab.workspaceId);
    if (typeof tab.name !== 'string' || !tab.name.trim() || tab.name.length > 120) throw new Error('Invalid Workspace name.');
    return { workspaceId, name: tab.name.trim(), layout: tab.layout === null ? null : layout(tab.layout) };
  });
}
export function parseWorkspaceComposition(value: unknown, options: { allowDuplicateTerminals?: boolean } = {}): WorkspaceComposition {
  const input = record(value);
  if (input.schemaVersion !== 2 && input.schemaVersion !== 3) throw new Error('Unsupported composition schema version.');
  return { schemaVersion: 3, hostId: id(input.hostId), revision: revision(input.revision), workspaces: parseWorkspaces(input.workspaces, options) };
}
export function parseCompositionRpcParams<M extends CompositionRpcMethod>(method: M, value: unknown): CompositionRpcContracts[M]['params'] {
  const input = record(value);
  return (method === 'workspace.composition.get' ? { hostId: id(input.hostId) } : {
    hostId: id(input.hostId), expectedRevision: revision(input.expectedRevision), workspaces: parseWorkspaces(input.workspaces),
  }) as CompositionRpcContracts[M]['params'];
}
export function parseCompositionRpcResult(value: unknown) {
  return { composition: parseWorkspaceComposition(record(value).composition) };
}
export function paneTargets(workspaces: Workspace[]): PaneNode[] {
  const targets: PaneNode[] = [];
  const visit = (node: PaneLayoutNode) => {
    if (node.kind === 'split') node.children.forEach(visit);
    else targets.push(node);
  };
  workspaces.forEach((workspace) => { if (workspace.layout) visit(workspace.layout); });
  return targets;
}
export function terminalPaneTargets(workspaces: Workspace[]) {
  return paneTargets(workspaces).filter((node) => node.kind === 'terminal');
}
