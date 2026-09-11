import { terminalPaneTargets, type TerminalSummary, type Workspace } from '@weave/product-protocol';

// Compare complete paths before shortening labels; preserve pane display order.
export function workspaceDirectories(workspace: Workspace, terminals: TerminalSummary[]): string[] {
  const records = new Map(terminals.map((terminal) => [terminal.terminalId, terminal]));
  return [...new Set(terminalPaneTargets([workspace]).flatMap((pane) => {
    const path = pane.terminalId ? records.get(pane.terminalId)?.currentDirectory : undefined;
    return path ? [path] : [];
  }))];
}
