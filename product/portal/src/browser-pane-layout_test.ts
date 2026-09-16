import { test, expect } from 'bun:test';
import { reconcileHostBrowserPanes } from './browser-pane-layout.ts';
import type { PaneLayoutNode, Workspace } from '@weave/product-protocol';
const page = () => ({ pageId: crypto.randomUUID(), profileId: 'profile', url: 'about:blank' });
const leaf = (item: ReturnType<typeof page>): PaneLayoutNode => ({ kind: 'host-browser', nodeId: crypto.randomUUID(), paneId: item.pageId, profileId: item.profileId, lastCommittedUrl: item.url });
test('popup overflow preserves the existing tree and rejects its unplaced descendants', () => {
  const source = page(), popup = { ...page(), openerPageId: source.pageId }, grandchild = { ...page(), openerPageId: popup.pageId };
  let layout = leaf(source);
  const pages = [source];
  for (let i = 0; i < 8; i++) { const sibling = page(); pages.push(sibling); layout = { kind: 'split', nodeId: crypto.randomUUID(), axis: 'vertical', ratio: 0.5, children: [layout, leaf(sibling)] }; }
  const workspaces: Workspace[] = [{ workspaceId: 'work', name: 'Research', layout }];
  const next = reconcileHostBrowserPanes(workspaces, [...pages, popup, grandchild], new Set(['profile']));
  expect(next.workspaces).toEqual(workspaces); expect(next.rejected.sort()).toEqual([popup.pageId, grandchild.pageId].sort());
});
test('an unplaced popup is rejected after native opener closure while already placed pages survive', () => {
  const source = page(), popup = { ...page(), openerPageId: source.pageId };
  const next = reconcileHostBrowserPanes([{ workspaceId: 'work', name: 'Research', layout: leaf(source) }], [popup], new Set(['profile']));
  expect(next.rejected).toEqual([popup.pageId]); expect(next.workspaces[0]!.layout).toBeNull();
  const placed = reconcileHostBrowserPanes([{ workspaceId: 'work', name: 'Research', layout: leaf(popup) }], [popup], new Set(['profile']));
  expect(placed.rejected).toEqual([]); expect(placed.changed).toBe(false);
});
