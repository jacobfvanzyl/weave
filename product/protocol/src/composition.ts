export const COMPOSITION_TERMINAL_CREATION_CAPABILITY = 'workspace.composition.terminal-create';
// In replace requests, null asks the Host to create a terminal for the new pane.
// Readers still accept null to recover arrangements saved by older Hosts.
export const COMPOSITION_RPC_METHODS = ['workspace.composition.get', 'workspace.composition.replace'] as const;
export type CompositionRpcMethod = typeof COMPOSITION_RPC_METHODS[number];
export type TerminalLayoutNode =
  | { kind: 'terminal'; nodeId: string; paneId: string; terminalId: string | null; executionContextId: string; launchDirectory?: string }
  | { kind: 'split'; nodeId: string; axis: 'horizontal' | 'vertical'; ratio: number; children: [TerminalLayoutNode, TerminalLayoutNode] };
export type Workspace = { workspaceId: string; name: string; layout: TerminalLayoutNode | null };
export type WorkspaceComposition = { schemaVersion: 2; hostId: string; revision: number; workspaces: Workspace[] };
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
  if (!Array.isArray(value) || value.length > 64) throw new Error('Composition supports at most 64 workspace tabs.');
  const ids = new Set<string>();
  const terminals = new Set<string>();
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
    if (node.kind !== 'split' || !['horizontal', 'vertical'].includes(String(node.axis)) ||
        typeof node.ratio !== 'number' || !Number.isFinite(node.ratio) || node.ratio < 0.1 || node.ratio > 0.9 ||
        !Array.isArray(node.children) || node.children.length !== 2) throw new Error('Invalid composition split.');
    return { kind: 'split', nodeId, axis: node.axis as 'horizontal' | 'vertical', ratio: node.ratio,
      children: [layout(node.children[0], depth + 1), layout(node.children[1], depth + 1)] };
  };
  return value.map((value) => {
    const tab = record(value);
    const workspaceId = unique(tab.workspaceId);
    if (typeof tab.name !== 'string' || !tab.name.trim() || tab.name.length > 120) throw new Error('Invalid workspace tab name.');
    return { workspaceId, name: tab.name.trim(), layout: tab.layout === null ? null : layout(tab.layout) };
  });
}
export function parseWorkspaceComposition(value: unknown, options: { allowDuplicateTerminals?: boolean } = {}): WorkspaceComposition {
  const input = record(value);
  if (input.schemaVersion !== 2) throw new Error('Unsupported composition schema version.');
  return { schemaVersion: 2, hostId: id(input.hostId), revision: revision(input.revision), workspaces: parseWorkspaces(input.workspaces, options) };
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
export function terminalPaneTargets(workspaces: Workspace[]) {
  const targets: Array<{ paneId: string; terminalId: string | null; executionContextId: string; launchDirectory?: string }> = [];
  const visit = (node: TerminalLayoutNode) => {
    if (node.kind === 'terminal') targets.push(node);
    else node.children.forEach(visit);
  };
  workspaces.forEach((tab) => { if (tab.layout) visit(tab.layout); });
  return targets;
}
