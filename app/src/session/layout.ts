// A Session's layout (ADR 0031, WVE-203): the document its Host keeps without reading
// (`sessions/set`), as pure functions over it. A tab's tree is rows and columns of panes, each
// pane a stack of Blocks shown one at a time, with Blocks floating over the tree. Every change
// here gives a new document and leaves the old one alone, and one that names a Block or tab the
// document no longer has changes nothing: a change made on an older revision can then be made
// again on a newer one (`host/sessions.ts`).
//
// What a device keeps for itself (which tab and Block are in front, focus, zoom) isn't here: see
// `view.ts`.
import { HOST_PROTOCOL, type SessionBlock, type SessionFloating, type SessionFrame, type SessionLayout, type SessionNode, type SessionTab } from '@/host/protocol';

export const LAYOUT_VERSION = HOST_PROTOCOL.sessions.layoutVersion;

export type Side = 'left' | 'right' | 'up' | 'down';
export type Split = Extract<SessionNode, { kind: 'row' | 'column' }>;
export type Pane = Extract<SessionNode, { kind: 'stack' }>;

/** Where a pane is in its tab's tree: the index of the child to take at each split. */
export type Path = number[];

/** Where a Block goes. */
export type Target =
  /** Into the pane that holds `into`, after it. */
  | { into: string }
  /** A new pane beside the one that holds `beside`. */
  | { beside: string; side: Side }
  /** Into the tab `tab`: its first pane, or a pane of its own in an empty tab. */
  | { tab: string }
  /** A new pane along a whole side of the tab `edge`. */
  | { edge: string; side: Side }
  /** A tab of its own, `newTab`, after the tab `after`, or last. */
  | { newTab: SessionTab; after?: string }
  /** Floating over the tab `floating`. */
  | { floating: string; frame: SessionFrame };

/** An id for a new Block or tab. */
export const newId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 12);

export const newTab = (id = newId()): SessionTab => ({ id });

export const emptyLayout = (tab = newTab()): SessionLayout => ({ version: LAYOUT_VERSION, tabs: [tab] });

/** Where a new floating Block sits. */
export const FLOATING_FRAME: SessionFrame = { x: 0.2, y: 0.15, width: 0.6, height: 0.6 };
const MIN_FRAME = 0.1;

const round = (value: number) => Math.round(value * 10_000) / 10_000;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** A frame inside its tab, no smaller than a pane can be used at. */
export function fitFrame(frame: SessionFrame): SessionFrame {
  const number = (value: unknown, otherwise: number) => typeof value === 'number' && Number.isFinite(value) ? value : otherwise;
  const width = clamp(number(frame.width, FLOATING_FRAME.width), MIN_FRAME, 1);
  const height = clamp(number(frame.height, FLOATING_FRAME.height), MIN_FRAME, 1);
  return {
    x: round(clamp(number(frame.x, FLOATING_FRAME.x), 0, 1 - width)),
    y: round(clamp(number(frame.y, FLOATING_FRAME.y), 0, 1 - height)),
    width: round(width),
    height: round(height),
  };
}

/** Each child's share of a split, adding up to 1. */
export function shares(split: Pick<Split, 'children' | 'sizes'>): number[] {
  const count = split.children.length;
  const sizes = split.sizes?.length === count && split.sizes.every((size) => typeof size === 'number' && Number.isFinite(size) && size > 0)
    ? split.sizes
    : split.children.map(() => 1);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return sizes.map((size) => size / total);
}

const isBlock = (value: unknown): value is SessionBlock =>
  typeof value === 'object' && value !== null && typeof (value as SessionBlock).id === 'string' && typeof (value as SessionBlock).type === 'string';

/**
 * A node as the app keeps it: every leaf a pane with a Block in it, every split with two children
 * or more and none of its own kind, and its sizes one each. Nothing where nothing is left.
 */
function tidyNode(node: SessionNode | null | undefined, seen: Set<string>): SessionNode | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const fresh = (block: SessionBlock) => {
    if (!isBlock(block) || seen.has(block.id)) return false;
    seen.add(block.id);
    return true;
  };
  switch (node.kind) {
    case 'block':
      return fresh(node) ? { kind: 'stack', children: [{ id: node.id, type: node.type, ...(node.props ? { props: node.props } : {}) }] } : undefined;
    case 'stack': {
      const children = (Array.isArray(node.children) ? node.children : []).filter(fresh);
      return children.length > 0 ? { kind: 'stack', children } : undefined;
    }
    case 'row':
    case 'column': {
      const given = Array.isArray(node.children) ? node.children : [];
      const sizes = shares({ children: given, sizes: node.sizes });
      const children: SessionNode[] = [];
      const kept: number[] = [];
      given.forEach((child, index) => {
        const tidied = tidyNode(child, seen);
        if (!tidied) return;
        if (tidied.kind === node.kind) {
          // A split inside one of its own kind is that split's children, in its share.
          const inner = shares(tidied);
          tidied.children.forEach((grandchild, at) => {
            children.push(grandchild);
            kept.push(sizes[index] * inner[at]);
          });
          return;
        }
        children.push(tidied);
        kept.push(sizes[index]);
      });
      if (children.length === 0) return undefined;
      if (children.length === 1) return children[0];
      const total = kept.reduce((sum, size) => sum + size, 0);
      return { kind: node.kind, children, sizes: kept.map((size) => round(size / total)) };
    }
    default:
      return undefined;
  }
}

/**
 * The document as the app keeps it, whatever wrote it: at least one tab, tab and Block ids each
 * unique (a later one with an id already used goes), trees as `tidyNode` leaves them, and
 * floating Blocks inside their tabs.
 */
export function tidy(layout: SessionLayout | null | undefined): SessionLayout {
  const seen = new Set<string>();
  const tabIds = new Set<string>();
  const tabs: SessionTab[] = [];
  for (const tab of Array.isArray(layout?.tabs) ? layout.tabs : []) {
    if (!tab || typeof tab.id !== 'string' || tabIds.has(tab.id)) continue;
    tabIds.add(tab.id);
    const root = tidyNode(tab.root, seen);
    const floating: SessionFloating[] = [];
    for (const item of Array.isArray(tab.floating) ? tab.floating : []) {
      if (!item || !isBlock(item.block) || seen.has(item.block.id)) continue;
      seen.add(item.block.id);
      floating.push({ block: item.block, frame: fitFrame(item.frame ?? FLOATING_FRAME) });
    }
    tabs.push({
      id: tab.id,
      ...(typeof tab.title === 'string' && tab.title.trim() ? { title: tab.title.trim() } : {}),
      ...(root ? { root } : {}),
      ...(floating.length > 0 ? { floating } : {}),
    });
  }
  return { version: LAYOUT_VERSION, tabs: tabs.length > 0 ? tabs : [newTab()] };
}

/** A tab's panes, in the order they read: left to right, top to bottom. */
export function panes(tab: SessionTab): { path: Path; pane: Pane }[] {
  const found: { path: Path; pane: Pane }[] = [];
  const walk = (node: SessionNode | null | undefined, path: Path) => {
    if (!node) return;
    if (node.kind === 'stack') found.push({ path, pane: node });
    else if (node.kind === 'row' || node.kind === 'column') node.children.forEach((child, index) => walk(child, [...path, index]));
  };
  walk(tab.root, []);
  return found;
}

/** A tab's Blocks: its panes' in order, then those floating over them. */
export const tabBlocks = (tab: SessionTab): SessionBlock[] => [
  ...panes(tab).flatMap(({ pane }) => pane.children),
  ...(tab.floating ?? []).map(({ block }) => block),
];

export const layoutBlocks = (layout: SessionLayout): SessionBlock[] => layout.tabs.flatMap(tabBlocks);

export type Found = {
  tab: SessionTab;
  block: SessionBlock;
  /** Its pane, and its place in it; none for a floating Block. */
  pane?: Pane;
  path?: Path;
  index?: number;
  frame?: SessionFrame;
};

export function findBlock(layout: SessionLayout, id: string): Found | undefined {
  for (const tab of layout.tabs) {
    for (const { path, pane } of panes(tab)) {
      const index = pane.children.findIndex((block) => block.id === id);
      if (index >= 0) return { tab, block: pane.children[index], pane, path, index };
    }
    const floating = tab.floating?.find(({ block }) => block.id === id);
    if (floating) return { tab, block: floating.block, frame: floating.frame };
  }
  return undefined;
}

export const findTab = (layout: SessionLayout, id: string) => layout.tabs.find((tab) => tab.id === id);

/** The tab a Block is in. */
export const tabOf = (layout: SessionLayout, blockId: string) => findBlock(layout, blockId)?.tab;

const nodeAt = (root: SessionNode | null | undefined, path: Path): SessionNode | undefined => {
  let node = root ?? undefined;
  for (const index of path) {
    if (!node || (node.kind !== 'row' && node.kind !== 'column')) return undefined;
    node = node.children[index];
  }
  return node;
};

/** `root` with the node at `path` replaced by what `change` makes of it. */
function replaceAt(root: SessionNode, path: Path, change: (node: SessionNode) => SessionNode): SessionNode {
  if (path.length === 0) return change(root);
  if (root.kind !== 'row' && root.kind !== 'column') return root;
  const [index, ...rest] = path;
  return { ...root, children: root.children.map((child, at) => at === index ? replaceAt(child, rest, change) : child) };
}

const withTab = (layout: SessionLayout, id: string, change: (tab: SessionTab) => SessionTab): SessionLayout =>
  ({ ...layout, tabs: layout.tabs.map((tab) => tab.id === id ? change(tab) : tab) });

const horizontal = (side: Side) => side === 'left' || side === 'right';
const before = (side: Side) => side === 'left' || side === 'up';

/** `node` with a pane of `block` on `side` of it, each taking half of what it had. */
function splitNode(node: SessionNode, block: SessionBlock, side: Side): SessionNode {
  const pane: Pane = { kind: 'stack', children: [block] };
  return {
    kind: horizontal(side) ? 'row' : 'column',
    children: before(side) ? [pane, node] : [node, pane],
    sizes: [0.5, 0.5],
  };
}

/**
 * The layout without the Block `id`. A pane left empty goes, and so does a tab left empty, unless
 * it's the only one.
 */
export function removeBlock(layout: SessionLayout, id: string): SessionLayout {
  return takeOut(layout, id);
}

/** `removeBlock`, keeping the tab `keepTab` even when it's left empty. */
function takeOut(layout: SessionLayout, id: string, keepTab?: string): SessionLayout {
  const found = findBlock(layout, id);
  if (!found) return layout;
  const { tab } = found;
  const emptied = (next: SessionTab) => !next.root && !next.floating?.length && layout.tabs.length > 1 && next.id !== keepTab;
  let next: SessionTab;
  if (found.pane && found.path) {
    const root = replaceAt(tab.root as SessionNode, found.path, (node) =>
      node.kind === 'stack' ? { ...node, children: node.children.filter((block) => block.id !== id) } : node);
    next = { ...tab, root };
  } else {
    next = { ...tab, floating: tab.floating?.filter(({ block }) => block.id !== id) };
  }
  const tidied = tidy(withTab(layout, tab.id, () => next));
  const after = findTab(tidied, tab.id);
  return after && emptied(after) ? { ...tidied, tabs: tidied.tabs.filter(({ id: tabId }) => tabId !== tab.id) } : tidied;
}

/**
 * The layout with `block` at `target`. A Block the layout already has moves there, and a target
 * the layout no longer has changes nothing.
 */
export function placeBlock(layout: SessionLayout, block: SessionBlock, target: Target): SessionLayout {
  let anchor = 'into' in target ? target.into : 'beside' in target ? target.beside : undefined;
  if (anchor !== undefined) {
    const at = findBlock(layout, anchor);
    if (!at?.pane) return layout;
    if (anchor === block.id) {
      // Into its own pane, or beside itself alone: where it already is.
      const other = at.pane.children.find(({ id }) => id !== block.id);
      if ('into' in target || !other) return layout;
      anchor = other.id;
    }
  }
  const tabId = 'tab' in target ? target.tab : 'edge' in target ? target.edge : 'floating' in target ? target.floating : undefined;
  if (tabId !== undefined && !findTab(layout, tabId)) return layout;
  if ('newTab' in target && findTab(layout, target.newTab.id)) return layout;
  const from = findBlock(layout, block.id);
  // Alone among the panes of the tab it's bound for: where it already is, unless it's to float there.
  if (from?.pane && tabId === from.tab.id && tabBlocks(from.tab).length === 1 && !('floating' in target)) return layout;
  // A tab it leaves empty goes with it, but not the one it's bound for.
  const next = from ? takeOut(layout, block.id, tabId) : layout;
  const placed = { id: block.id, type: block.type, ...(block.props ? { props: block.props } : {}) };

  if (anchor !== undefined) {
    const at = findBlock(next, anchor);
    if (!at?.pane || !at.path) return layout;
    const { path, index } = at;
    const root = replaceAt(at.tab.root as SessionNode, path, (node) => {
      if (node.kind !== 'stack') return node;
      if ('into' in target) {
        const children = [...node.children];
        children.splice((index ?? children.length - 1) + 1, 0, placed);
        return { ...node, children };
      }
      return splitNode(node, placed, (target as { side: Side }).side);
    });
    return tidy(withTab(next, at.tab.id, (tab) => ({ ...tab, root })));
  }
  if ('newTab' in target) {
    const tab: SessionTab = { ...target.newTab, root: { kind: 'stack', children: [placed] } };
    const after = target.after ? next.tabs.findIndex(({ id }) => id === target.after) : -1;
    const tabs = [...next.tabs];
    tabs.splice(after >= 0 ? after + 1 : tabs.length, 0, tab);
    return tidy({ ...next, tabs });
  }
  if ('floating' in target) {
    const floating = { block: placed, frame: fitFrame(target.frame) };
    return tidy(withTab(next, target.floating, (tab) => ({ ...tab, floating: [...(tab.floating ?? []), floating] })));
  }
  if ('edge' in target) {
    return tidy(withTab(next, target.edge, (tab) => ({
      ...tab,
      root: tab.root ? splitNode(tab.root, placed, target.side) : { kind: 'stack', children: [placed] },
    })));
  }
  if (!('tab' in target)) return layout;
  return tidy(withTab(next, target.tab, (tab) => {
    const first = panes(tab)[0];
    if (!first) return { ...tab, root: { kind: 'stack', children: [placed] } };
    const root = replaceAt(tab.root as SessionNode, first.path, (node) =>
      node.kind === 'stack' ? { ...node, children: [...node.children, placed] } : node);
    return { ...tab, root };
  }));
}

/** The layout with the split at `path` in `tabId` shared out as `sizes`, one for each child. */
export function resizeSplit(layout: SessionLayout, tabId: string, path: Path, sizes: number[]): SessionLayout {
  const tab = findTab(layout, tabId);
  const node = nodeAt(tab?.root, path);
  if (!tab || !node || (node.kind !== 'row' && node.kind !== 'column') || sizes.length !== node.children.length) return layout;
  if (!sizes.every((size) => Number.isFinite(size) && size > 0)) return layout;
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const root = replaceAt(tab.root as SessionNode, path, (split) => ({ ...split, sizes: sizes.map((size) => round(size / total)) }));
  return withTab(layout, tabId, (current) => ({ ...current, root }));
}

/** The layout with `tab`, empty, after the tab `after`, or last. */
export function addTab(layout: SessionLayout, tab: SessionTab, after?: string): SessionLayout {
  if (findTab(layout, tab.id)) return layout;
  const at = after ? layout.tabs.findIndex(({ id }) => id === after) : -1;
  const tabs = [...layout.tabs];
  tabs.splice(at >= 0 ? at + 1 : tabs.length, 0, { id: tab.id, ...(tab.title ? { title: tab.title } : {}) });
  return { ...layout, tabs };
}

/** The layout without the tab `id` and the Blocks in it; the only tab is emptied instead. */
export function removeTab(layout: SessionLayout, id: string): SessionLayout {
  if (!findTab(layout, id)) return layout;
  return layout.tabs.length === 1
    ? { ...layout, tabs: [{ id }] }
    : { ...layout, tabs: layout.tabs.filter((tab) => tab.id !== id) };
}

export function renameTab(layout: SessionLayout, id: string, title?: string): SessionLayout {
  const name = title?.trim();
  return withTab(layout, id, ({ title: _was, ...tab }) => ({ ...tab, ...(name ? { title: name } : {}) }));
}

/** The layout with the tab `id` at `index` among the tabs. */
export function moveTab(layout: SessionLayout, id: string, index: number): SessionLayout {
  const from = layout.tabs.findIndex((tab) => tab.id === id);
  if (from < 0) return layout;
  const tabs = [...layout.tabs];
  const [tab] = tabs.splice(from, 1);
  tabs.splice(clamp(index, 0, tabs.length), 0, tab);
  return { ...layout, tabs };
}

/** The layout with the floating Block `id` at `frame`, on top of the others. */
export function frameBlock(layout: SessionLayout, id: string, frame: SessionFrame): SessionLayout {
  const found = findBlock(layout, id);
  if (!found || found.pane) return layout;
  return withTab(layout, found.tab.id, (tab) => ({
    ...tab,
    floating: [...(tab.floating ?? []).filter(({ block }) => block.id !== id), { block: found.block, frame: fitFrame(frame) }],
  }));
}

/** The layout without the Blocks `keep` turns away. */
export function prune(layout: SessionLayout, keep: (block: SessionBlock) => boolean): SessionLayout {
  return layoutBlocks(layout).filter((block) => !keep(block)).reduce((next, block) => removeBlock(next, block.id), layout);
}

export type Rect = { x: number; y: number; width: number; height: number };

/** Where each of a tab's panes is, in a square of side 1. */
export function paneRects(tab: SessionTab): { path: Path; pane: Pane; rect: Rect }[] {
  const found: { path: Path; pane: Pane; rect: Rect }[] = [];
  const walk = (node: SessionNode | null | undefined, path: Path, rect: Rect) => {
    if (!node) return;
    if (node.kind === 'stack') {
      found.push({ path, pane: node, rect });
      return;
    }
    if (node.kind !== 'row' && node.kind !== 'column') return;
    let offset = 0;
    shares(node).forEach((share, index) => {
      const child = node.kind === 'row'
        ? { x: rect.x + offset * rect.width, y: rect.y, width: share * rect.width, height: rect.height }
        : { x: rect.x, y: rect.y + offset * rect.height, width: rect.width, height: share * rect.height };
      walk(node.children[index], [...path, index], child);
      offset += share;
    });
  };
  walk(tab.root, [], { x: 0, y: 0, width: 1, height: 1 });
  return found;
}

/**
 * The pane to `side` of the one that holds `blockId`: of those that lie that way and overlap it
 * across, the nearest, and of those the one that overlaps it most.
 */
export function paneBeside(tab: SessionTab, blockId: string, side: Side): Pane | undefined {
  const all = paneRects(tab);
  const from = all.find(({ pane }) => pane.children.some(({ id }) => id === blockId));
  if (!from) return undefined;
  const overlap = (low: number, size: number, otherLow: number, otherSize: number) =>
    Math.min(low + size, otherLow + otherSize) - Math.max(low, otherLow);
  const edge = 1e-6;
  let best: { pane: Pane; distance: number; across: number } | undefined;
  for (const { pane, rect } of all) {
    if (pane === from.pane) continue;
    const a = from.rect;
    let distance: number;
    let across: number;
    switch (side) {
      case 'left': distance = a.x - (rect.x + rect.width); across = overlap(a.y, a.height, rect.y, rect.height); break;
      case 'right': distance = rect.x - (a.x + a.width); across = overlap(a.y, a.height, rect.y, rect.height); break;
      case 'up': distance = a.y - (rect.y + rect.height); across = overlap(a.x, a.width, rect.x, rect.width); break;
      case 'down': distance = rect.y - (a.y + a.height); across = overlap(a.x, a.width, rect.x, rect.width); break;
    }
    if (distance < -edge || across <= edge) continue;
    if (!best || distance < best.distance - edge || (Math.abs(distance - best.distance) <= edge && across > best.across)) {
      best = { pane, distance, across };
    }
  }
  return best?.pane;
}

/** One tab with one pane holding `blocks`, the first in front: what a Session shows before anyone arranged it. */
export function firstLayout(blocks: SessionBlock[], tab = newTab()): SessionLayout {
  return tidy({ version: LAYOUT_VERSION, tabs: [{ ...tab, ...(blocks.length > 0 ? { root: { kind: 'stack', children: blocks } } : {}) }] });
}
