// A Session's layout (ADR 0031, WVE-203): the document its Host keeps without reading
// (`sessions/set`), as pure functions over it. A Block in a tab is docked in the tab's tree of
// rows and columns, alone in its place, or floats over it, where it can be minimized. Every
// change here gives a new document and leaves the old one alone, and one that names a Block or
// tab the document no longer has changes nothing: a change made on an older revision can then be
// made again on a newer one (`host/sessions.ts`).
//
// What a device keeps for itself (which tab is in front, focus, zoom) isn't here: see `view.ts`.
import { HOST_PROTOCOL, type SessionBlock, type SessionFloating, type SessionFrame, type SessionLayout, type SessionNode, type SessionTab } from '@/host/protocol';

export const LAYOUT_VERSION = HOST_PROTOCOL.sessions.layoutVersion;

export type Side = 'left' | 'right' | 'up' | 'down';
export type Split = Extract<SessionNode, { kind: 'row' | 'column' }>;

/** Where a docked Block is in its tab's tree: the index of the child to take at each split. */
export type Path = number[];

/** Where a Block goes. */
export type Target =
  /** Docked beside the docked Block `beside`, each taking half of what that one had. */
  | { beside: string; side: Side }
  /** In the place of the docked Block `swap`, which takes this one's. */
  | { swap: string }
  /** Docked in the tab `tab`: filling an empty one, else beside its largest Block, along that one's longer side. */
  | { tab: string }
  /** Docked along a whole side of the tab `edge`. */
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
/** How much wider than tall a tab is taken to be, where nothing measured it. */
export const TAB_ASPECT = 1.6;

const round = (value: number) => Math.round(value * 10_000) / 10_000;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** A frame inside its tab, no smaller than a Block can be used at. */
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

const leaf = (block: SessionBlock): SessionNode => ({ kind: 'block', id: block.id, type: block.type, ...(block.props ? { props: block.props } : {}) });
const blockOf = (node: Extract<SessionNode, { kind: 'block' }>): SessionBlock => ({ id: node.id, type: node.type, ...(node.props ? { props: node.props } : {}) });

/**
 * A node as the app keeps it: every leaf a Block, every split with two children or more and none
 * of its own kind, and its sizes one each. Nothing where nothing is left. A `stack`, which the
 * first version of the document had for Blocks one behind another, leaves its first Block where
 * it was: the rest are no longer in the layout, and what they showed carries on without a Block.
 */
function tidyNode(node: SessionNode | null | undefined, seen: Set<string>): SessionNode | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const fresh = (block: SessionBlock) => {
    if (!isBlock(block) || seen.has(block.id)) return false;
    seen.add(block.id);
    return true;
  };
  switch ((node as { kind: string }).kind) {
    case 'block':
      return node.kind === 'block' && fresh(node) ? leaf(node) : undefined;
    case 'stack': {
      const children = (node as unknown as { children?: unknown }).children;
      const first = (Array.isArray(children) ? children as SessionBlock[] : []).find(fresh);
      return first ? leaf(first) : undefined;
    }
    case 'row':
    case 'column': {
      if (node.kind !== 'row' && node.kind !== 'column') return undefined;
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
      floating.push({ block: item.block, frame: fitFrame(item.frame ?? FLOATING_FRAME), ...(item.minimized === true ? { minimized: true } : {}) });
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

/**
 * The layout without its empty tabs (WVE-228): nothing here leaves one but the last, so one
 * among others is from before that, and shows nowhere. With no Block at all, its first tab alone.
 */
export function withoutEmptyTabs(layout: SessionLayout): SessionLayout {
  const full = layout.tabs.filter((tab) => tab.root || tab.floating?.length);
  if (full.length === layout.tabs.length || layout.tabs.length <= 1) return layout;
  return { ...layout, tabs: full.length > 0 ? full : layout.tabs.slice(0, 1) };
}

/** A tab's docked Blocks, in the order they read: left to right, top to bottom. */
export function docked(tab: SessionTab): { path: Path; block: SessionBlock }[] {
  const found: { path: Path; block: SessionBlock }[] = [];
  const walk = (node: SessionNode | null | undefined, path: Path) => {
    if (!node) return;
    if (node.kind === 'block') found.push({ path, block: blockOf(node) });
    else if (node.kind === 'row' || node.kind === 'column') node.children.forEach((child, index) => walk(child, [...path, index]));
  };
  walk(tab.root, []);
  return found;
}

/** A tab's Blocks: those docked, in order, then those floating over them, minimized or not. */
export const tabBlocks = (tab: SessionTab): SessionBlock[] => [
  ...docked(tab).map(({ block }) => block),
  ...(tab.floating ?? []).map(({ block }) => block),
];

export const layoutBlocks = (layout: SessionLayout): SessionBlock[] => layout.tabs.flatMap(tabBlocks);

export type Found = {
  tab: SessionTab;
  block: SessionBlock;
  /** Where it's docked in its tab's tree; none for a floating Block. */
  path?: Path;
  /** Where it floats, and whether it's minimized; none for a docked Block. */
  frame?: SessionFrame;
  minimized?: boolean;
};

export function findBlock(layout: SessionLayout, id: string): Found | undefined {
  for (const tab of layout.tabs) {
    const at = docked(tab).find(({ block }) => block.id === id);
    if (at) return { tab, block: at.block, path: at.path };
    const floating = tab.floating?.find(({ block }) => block.id === id);
    if (floating) return { tab, block: floating.block, frame: floating.frame, minimized: floating.minimized === true };
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

/** `root` with the node at `path` replaced by what `change` makes of it, or gone where it makes nothing. */
function replaceAt(root: SessionNode, path: Path, change: (node: SessionNode) => SessionNode | undefined): SessionNode | undefined {
  if (path.length === 0) return change(root);
  if (root.kind !== 'row' && root.kind !== 'column') return root;
  const [index, ...rest] = path;
  const sizes = shares(root);
  const children: SessionNode[] = [];
  const kept: number[] = [];
  root.children.forEach((child, at) => {
    const next = at === index ? replaceAt(child, rest, change) : child;
    if (!next) return;
    children.push(next);
    kept.push(sizes[at]);
  });
  return { ...root, children, sizes: kept };
}

const withTab = (layout: SessionLayout, id: string, change: (tab: SessionTab) => SessionTab): SessionLayout =>
  ({ ...layout, tabs: layout.tabs.map((tab) => tab.id === id ? change(tab) : tab) });

const withRoot = (tab: SessionTab, root: SessionNode | undefined): SessionTab => {
  const { root: _was, ...rest } = tab;
  return root ? { ...rest, root } : rest;
};

const horizontal = (side: Side) => side === 'left' || side === 'right';
const before = (side: Side) => side === 'left' || side === 'up';

/** `node` with `block` docked on `side` of it, each taking half of what it had. */
function splitNode(node: SessionNode, block: SessionBlock, side: Side): SessionNode {
  return {
    kind: horizontal(side) ? 'row' : 'column',
    children: before(side) ? [leaf(block), node] : [node, leaf(block)],
    sizes: [0.5, 0.5],
  };
}

/**
 * The layout without the Block `id`. What was beside it takes its space, and a tab left empty
 * goes, unless it's the only one.
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
  const next = found.path
    ? withRoot(tab, replaceAt(tab.root as SessionNode, found.path, () => undefined))
    : { ...tab, floating: tab.floating?.filter(({ block }) => block.id !== id) };
  const tidied = tidy(withTab(layout, tab.id, () => next));
  const after = findTab(tidied, tab.id);
  return after && emptied(after) ? { ...tidied, tabs: tidied.tabs.filter(({ id: tabId }) => tabId !== tab.id) } : tidied;
}

export type Rect = { x: number; y: number; width: number; height: number };

/** Where each of a tab's docked Blocks is, in a square of side 1. */
export function blockRects(tab: SessionTab): { path: Path; block: SessionBlock; rect: Rect }[] {
  const found: { path: Path; block: SessionBlock; rect: Rect }[] = [];
  const walk = (node: SessionNode | null | undefined, path: Path, rect: Rect) => {
    if (!node) return;
    if (node.kind === 'block') {
      found.push({ path, block: blockOf(node), rect });
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
 * The side of the docked Block `blockId` a new one docks on when nothing says: to its right while
 * it's wider than tall, else below it, in a tab `aspect` times as wide as tall.
 */
export function roomierSide(tab: SessionTab, blockId: string, aspect = TAB_ASPECT): Side {
  const rect = blockRects(tab).find(({ block }) => block.id === blockId)?.rect;
  return !rect || rect.width * aspect >= rect.height ? 'right' : 'down';
}

/** Where a Block docks in a tab when nothing says where: beside its largest Block, on that one's roomier side. */
function roomiest(tab: SessionTab, except?: string): { beside: string; side: Side } | undefined {
  let best: { id: string; area: number } | undefined;
  for (const { block, rect } of blockRects(tab)) {
    if (block.id === except) continue;
    const area = rect.width * rect.height;
    if (!best || area > best.area + 1e-9) best = { id: block.id, area };
  }
  return best ? { beside: best.id, side: roomierSide(tab, best.id) } : undefined;
}

/**
 * The layout with `block` at `target`. A Block the layout already has moves there, and a target
 * the layout no longer has changes nothing.
 */
export function placeBlock(layout: SessionLayout, block: SessionBlock, target: Target): SessionLayout {
  const from = findBlock(layout, block.id);
  if ('swap' in target) {
    // Each takes the other's place, wherever in the layout that is. Both are docked.
    const other = findBlock(layout, target.swap);
    if (!from?.path || !other?.path || other.block.id === block.id) return layout;
    const put = (current: SessionLayout, tabId: string, path: Path, placed: SessionBlock) =>
      withTab(current, tabId, (tab) => withRoot(tab, replaceAt(tab.root as SessionNode, path, () => leaf(placed))));
    return tidy(put(put(layout, from.tab.id, from.path, other.block), other.tab.id, other.path, from.block));
  }
  if ('beside' in target) {
    const at = findBlock(layout, target.beside);
    if (!at?.path || target.beside === block.id) return layout;
  }
  const tabId = 'tab' in target ? target.tab : 'edge' in target ? target.edge : 'floating' in target ? target.floating : undefined;
  if (tabId !== undefined && !findTab(layout, tabId)) return layout;
  if ('newTab' in target && findTab(layout, target.newTab.id)) return layout;
  // Alone in its tab already: a tab of its own is where it is.
  if ('newTab' in target && from && tabBlocks(from.tab).length === 1) return layout;
  // Alone among the Blocks of the tab it's bound for: where it already is, unless it's to float there.
  if (from?.path && tabId === from.tab.id && tabBlocks(from.tab).length === 1 && !('floating' in target)) return layout;
  // Docked in a tab it's docked in already: where it is.
  if (from?.path && 'tab' in target && target.tab === from.tab.id) return layout;
  // A tab it leaves empty goes with it, but not the one it's bound for.
  const next = from ? takeOut(layout, block.id, tabId) : layout;
  const placed: SessionBlock = { id: block.id, type: block.type, ...(block.props ? { props: block.props } : {}) };
  const beside = (current: SessionLayout, anchor: string, side: Side) => {
    const at = findBlock(current, anchor);
    if (!at?.path) return layout;
    const root = replaceAt(at.tab.root as SessionNode, at.path, (node) => splitNode(node, placed, side));
    return tidy(withTab(current, at.tab.id, (tab) => withRoot(tab, root)));
  };

  if ('beside' in target) return beside(next, target.beside, target.side);
  if ('newTab' in target) {
    const tab: SessionTab = { ...target.newTab, root: leaf(placed) };
    const after = target.after ? next.tabs.findIndex(({ id }) => id === target.after) : -1;
    const tabs = [...next.tabs];
    tabs.splice(after >= 0 ? after + 1 : tabs.length, 0, tab);
    return tidy({ ...next, tabs });
  }
  if ('floating' in target) {
    const floating: SessionFloating = { block: placed, frame: fitFrame(target.frame) };
    return tidy(withTab(next, target.floating, (tab) => ({ ...tab, floating: [...(tab.floating ?? []), floating] })));
  }
  if ('edge' in target) {
    return tidy(withTab(next, target.edge, (tab) => withRoot(tab, tab.root ? splitNode(tab.root, placed, target.side) : leaf(placed))));
  }
  const tab = findTab(next, target.tab);
  if (!tab) return layout;
  const room = roomiest(tab);
  return room ? beside(next, room.beside, room.side) : tidy(withTab(next, tab.id, (current) => withRoot(current, leaf(placed))));
}

/**
 * The layout with `block` docked in the place of the docked Block `id`, which leaves the layout.
 * `block` leaves where it was, if the layout has it. Nothing changes where `id` isn't docked.
 */
export function replaceBlock(layout: SessionLayout, id: string, block: SessionBlock): SessionLayout {
  if (block.id === id || !findBlock(layout, id)?.path) return layout;
  const next = findBlock(layout, block.id) ? takeOut(layout, block.id, findBlock(layout, id)?.tab.id) : layout;
  const at = findBlock(next, id);
  if (!at?.path) return layout;
  const placed: SessionBlock = { id: block.id, type: block.type, ...(block.props ? { props: block.props } : {}) };
  return tidy(withTab(next, at.tab.id, (tab) => withRoot(tab, replaceAt(tab.root as SessionNode, at.path ?? [], () => leaf(placed)))));
}

/** The layout with the split at `path` in `tabId` shared out as `sizes`, one for each child. */
export function resizeSplit(layout: SessionLayout, tabId: string, path: Path, sizes: number[]): SessionLayout {
  const tab = findTab(layout, tabId);
  const node = nodeAt(tab?.root, path);
  if (!tab || !node || (node.kind !== 'row' && node.kind !== 'column') || sizes.length !== node.children.length) return layout;
  if (!sizes.every((size) => Number.isFinite(size) && size > 0)) return layout;
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const root = replaceAt(tab.root as SessionNode, path, (split) => ({ ...split, sizes: sizes.map((size) => round(size / total)) }));
  return withTab(layout, tabId, (current) => withRoot(current, root));
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

/** The layout with the floating Block `id` at `frame`, on top of the others, and not minimized. */
export function frameBlock(layout: SessionLayout, id: string, frame: SessionFrame): SessionLayout {
  const found = findBlock(layout, id);
  if (!found || found.path) return layout;
  return withTab(layout, found.tab.id, (tab) => ({
    ...tab,
    floating: [...(tab.floating ?? []).filter(({ block }) => block.id !== id), { block: found.block, frame: fitFrame(frame) }],
  }));
}

/**
 * The layout with the floating Block `id` minimized, put away as its name until it's brought
 * back, or back where it floated, on top of the others. A docked Block has nowhere to be put away
 * to, and stays.
 */
export function minimizeBlock(layout: SessionLayout, id: string, minimized: boolean): SessionLayout {
  const found = findBlock(layout, id);
  if (!found?.frame || found.minimized === minimized) return layout;
  const { frame, block } = found;
  return withTab(layout, found.tab.id, (tab) => {
    const others = (tab.floating ?? []).filter((item) => item.block.id !== id);
    return { ...tab, floating: [...others, { block, frame, ...(minimized ? { minimized: true } : {}) }] };
  });
}

/** The layout without the Blocks `keep` turns away. */
export function prune(layout: SessionLayout, keep: (block: SessionBlock) => boolean): SessionLayout {
  return layoutBlocks(layout).filter((block) => !keep(block)).reduce((next, block) => removeBlock(next, block.id), layout);
}

/**
 * The docked Block to `side` of the docked Block `blockId`: of those that lie that way and overlap
 * it across, the nearest, and of those the one that overlaps it most.
 */
export function blockBeside(tab: SessionTab, blockId: string, side: Side): SessionBlock | undefined {
  const all = blockRects(tab);
  const from = all.find(({ block }) => block.id === blockId);
  if (!from) return undefined;
  const overlap = (low: number, size: number, otherLow: number, otherSize: number) =>
    Math.min(low + size, otherLow + otherSize) - Math.max(low, otherLow);
  const edge = 1e-6;
  let best: { block: SessionBlock; distance: number; across: number } | undefined;
  for (const { block, rect } of all) {
    if (block.id === blockId) continue;
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
      best = { block, distance, across };
    }
  }
  return best?.block;
}

/** One tab with `blocks` docked in it, each beside the largest so far: a layout to start from, as a fixture's. */
export function layoutWith(blocks: SessionBlock[], tab = newTab()): SessionLayout {
  return blocks.reduce((layout, block) => placeBlock(layout, block, { tab: tab.id }), emptyLayout(tab));
}
