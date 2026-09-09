export const COMPOSITION_RPC_METHODS = ['workspace.composition.get', 'workspace.composition.replace'] as const;
export type CompositionRpcMethod = typeof COMPOSITION_RPC_METHODS[number];
export type TerminalLayoutNode =
  | { kind: 'terminal'; nodeId: string; paneId: string; terminalId: string | null }
  | { kind: 'split'; nodeId: string; axis: 'horizontal' | 'vertical'; ratio: number; children: [TerminalLayoutNode, TerminalLayoutNode] };
export type WorkspaceTab = { tabId: string; name: string; layout: TerminalLayoutNode };
export type WorkspaceComposition = { schemaVersion: 1; workspaceId: string; revision: number; tabs: WorkspaceTab[] };
export type CompositionRpcContracts = {
  'workspace.composition.get': { params: { workspaceId: string }; result: { composition: WorkspaceComposition } };
  'workspace.composition.replace': {
    params: { workspaceId: string; expectedRevision: number; tabs: WorkspaceTab[] };
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
const revision = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid composition revision.');
  return value as number;
};
export function parseWorkspaceTabs(value: unknown): WorkspaceTab[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('Composition supports at most 64 workspace tabs.');
  const ids = new Set<string>();
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
      return { kind: 'terminal', nodeId, paneId: unique(node.paneId), terminalId: node.terminalId === null ? null : id(node.terminalId) };
    }
    if (node.kind !== 'split' || !['horizontal', 'vertical'].includes(String(node.axis)) ||
        typeof node.ratio !== 'number' || !Number.isFinite(node.ratio) || node.ratio < 0.1 || node.ratio > 0.9 ||
        !Array.isArray(node.children) || node.children.length !== 2) throw new Error('Invalid composition split.');
    return { kind: 'split', nodeId, axis: node.axis as 'horizontal' | 'vertical', ratio: node.ratio,
      children: [layout(node.children[0], depth + 1), layout(node.children[1], depth + 1)] };
  };
  return value.map((value) => {
    const tab = record(value);
    const tabId = unique(tab.tabId);
    if (typeof tab.name !== 'string' || !tab.name.trim() || tab.name.length > 120) throw new Error('Invalid workspace tab name.');
    return { tabId, name: tab.name.trim(), layout: layout(tab.layout) };
  });
}
export function parseWorkspaceComposition(value: unknown): WorkspaceComposition {
  const input = record(value);
  if (input.schemaVersion !== 1) throw new Error('Unsupported composition schema version.');
  return { schemaVersion: 1, workspaceId: id(input.workspaceId), revision: revision(input.revision), tabs: parseWorkspaceTabs(input.tabs) };
}
export function parseCompositionRpcParams<M extends CompositionRpcMethod>(method: M, value: unknown): CompositionRpcContracts[M]['params'] {
  const input = record(value);
  return (method === 'workspace.composition.get' ? { workspaceId: id(input.workspaceId) } : {
    workspaceId: id(input.workspaceId), expectedRevision: revision(input.expectedRevision), tabs: parseWorkspaceTabs(input.tabs),
  }) as CompositionRpcContracts[M]['params'];
}
export function parseCompositionRpcResult(value: unknown) {
  return { composition: parseWorkspaceComposition(record(value).composition) };
}
export function terminalPaneTargets(tabs: WorkspaceTab[]) {
  const targets: Array<{ paneId: string; terminalId: string | null }> = [];
  const visit = (node: TerminalLayoutNode) => {
    if (node.kind === 'terminal') targets.push({ paneId: node.paneId, terminalId: node.terminalId });
    else node.children.forEach(visit);
  };
  tabs.forEach((tab) => visit(tab.layout));
  return targets;
}
