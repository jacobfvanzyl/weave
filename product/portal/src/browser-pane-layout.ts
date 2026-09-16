import { paneTargets, parseWorkspaces, type PaneLayoutNode, type Workspace } from '@weave/product-protocol';
type BrowserPane = Extract<PaneLayoutNode, { kind: 'host-browser' | 'client-browser' }>;
export function insertBrowserPane(workspaces: Workspace[], workspaceId: string, pane: BrowserPane, sourcePaneId: string | undefined, axis: 'horizontal' | 'vertical'): Workspace[] {
  const workspace = workspaces.find(workspace => workspace.workspaceId === workspaceId);
  if (!workspace) throw new Error('Browser Workspace is unavailable');
  if (paneTargets(workspaces).some(existing => existing.paneId === pane.paneId)) throw new Error('Browser Pane is already placed');
  if (workspace.layout && !paneTargets([workspace]).some(node => node.paneId === sourcePaneId)) throw new Error('Browser split source is unavailable');
  const insert = (node: PaneLayoutNode): PaneLayoutNode => {
    if (node.kind === 'split') return { ...node, children: [insert(node.children[0]), insert(node.children[1])] };
    return node.paneId === sourcePaneId ? { kind: 'split', nodeId: crypto.randomUUID(), axis, ratio: 0.5, children: [node, pane] } : node;
  };
  return parseWorkspaces(workspaces.map(item => item === workspace ? { ...item, layout: item.layout ? insert(item.layout) : pane } : item));
}
export function removeBrowserPane(workspaces: Workspace[], paneId: string, kind: BrowserPane['kind']): Workspace[] {
  const remove = (node: PaneLayoutNode | null): PaneLayoutNode | null => {
    if (!node) return null;
    if (node.kind !== 'split') return node.kind === kind && node.paneId === paneId ? null : node;
    const left = remove(node.children[0]), right = remove(node.children[1]);
    return left && right ? { ...node, children: [left, right] } : left ?? right;
  };
  return workspaces.map(workspace => ({ ...workspace, layout: remove(workspace.layout) }));
}

/** Rebuild placement from the durable page catalog, including after Portal reconnects. */
export function reconcileHostBrowserPanes(workspaces: Workspace[], pages: Array<{ pageId: string; profileId: string; url: string; openerPageId?: string }>, profiles: Set<string>) {
  const catalog = new Map(pages.map(page => [page.pageId, page]));
  let next = structuredClone(workspaces);
  for (const pane of paneTargets(next)) if (pane.kind === 'host-browser' && profiles.has(pane.profileId)) {
    const page = catalog.get(pane.paneId);
    if (!page) next = removeBrowserPane(next, pane.paneId, 'host-browser');
    else if (page.profileId !== pane.profileId) throw new Error('Browser page changed Profile');
    else pane.lastCommittedUrl = page.url;
  }
  const rejected: string[] = [];
  const pending = pages.filter(page => page.openerPageId && !paneTargets(next).some(pane => pane.paneId === page.pageId));
  // A child may precede its opener in a restored catalog. Each pass places at least one page.
  for (let pass = 0; pending.length && pass < pages.length; pass++) {
    let progressed = false;
    for (let index = pending.length - 1; index >= 0; index--) {
      const page = pending[index]!;
      const workspace = next.find(workspace => paneTargets([workspace]).some(pane => pane.kind === 'host-browser' && pane.paneId === page.openerPageId && pane.profileId === page.profileId));
      if (!workspace) continue;
      try { next = insertBrowserPane(next, workspace.workspaceId, { kind: 'host-browser', nodeId: crypto.randomUUID(), paneId: page.pageId, profileId: page.profileId, lastCommittedUrl: page.url }, page.openerPageId, 'horizontal'); }
      catch { rejected.push(page.pageId); }
      pending.splice(index, 1); progressed = true;
    }
    if (!progressed) break;
  }
  // Native window.close can remove an opener before its children are placed.
  for (const page of pending) if (!catalog.has(page.openerPageId!)) rejected.push(page.pageId);
  // Descendants of a rejected popup cannot be placed either.
  for (let pass = 0; pass < pending.length + 1; pass++) for (const page of pending) if (rejected.includes(page.openerPageId!) && !rejected.includes(page.pageId)) rejected.push(page.pageId);
  return { workspaces: parseWorkspaces(next), rejected, changed: JSON.stringify(next) !== JSON.stringify(workspaces) };
}

export const insertHostBrowserPane = insertBrowserPane;
export const removeHostBrowserPane = (workspaces: Workspace[], paneId: string) => removeBrowserPane(workspaces, paneId, 'host-browser');
