// A device's own view of a Session's layout (ADR 0031): the tab in front, the Block in front of
// each pane, the Block with the keyboard, and the one zoomed to fill its tab. None of it is in the
// document, so each device looks where it likes at a layout they all share. It's kept in the web
// view's storage, by Session.
import { useCallback, useEffect, useState } from 'react';
import type { SessionBlock, SessionLayout, SessionTab } from '@/host/protocol';
import { type Pane, findBlock, findTab, panes, tabBlocks } from './layout';

export type SessionView = {
  /** The tab in front. */
  tab?: string;
  /** The Block with the keyboard in each tab, by tab id. */
  focus: Record<string, string>;
  /** Blocks brought to the front of their panes, the latest first. */
  fronted: string[];
  /** The Block filling its tab. */
  zoom?: string;
};

export const emptyView = (): SessionView => ({ focus: {}, fronted: [] });

/** How many Blocks' turns at the front are remembered. */
const FRONTED = 200;

/** The tab in front: the one last chosen while the layout has it, else the first. */
export const tabInFront = (layout: SessionLayout, view: SessionView): SessionTab =>
  (view.tab ? findTab(layout, view.tab) : undefined) ?? layout.tabs[0];

/** The Block in front of a pane: the one last brought there, else its first. */
export function blockInFront(pane: Pane, view: SessionView): SessionBlock {
  let best: SessionBlock = pane.children[0];
  let rank = Infinity;
  for (const block of pane.children) {
    const at = view.fronted.indexOf(block.id);
    if (at >= 0 && at < rank) {
      best = block;
      rank = at;
    }
  }
  return best;
}

/** The Block filling the tab, while the tab still has it. */
export const zoomedIn = (tab: SessionTab, view: SessionView): SessionBlock | undefined =>
  view.zoom ? tabBlocks(tab).find(({ id }) => id === view.zoom) : undefined;

/** The Blocks a tab shows: the one zoomed, or the one in front of each pane and those floating. */
export function blocksShown(tab: SessionTab, view: SessionView): SessionBlock[] {
  const zoomed = zoomedIn(tab, view);
  if (zoomed) return [zoomed];
  return [...panes(tab).map(({ pane }) => blockInFront(pane, view)), ...(tab.floating ?? []).map(({ block }) => block)];
}

/**
 * The Block with the keyboard in a tab: the one last focused while it still shows, else the first
 * that does.
 */
export function focusedBlock(tab: SessionTab, view: SessionView): SessionBlock | undefined {
  const shown = blocksShown(tab, view);
  return shown.find(({ id }) => id === view.focus[tab.id]) ?? shown[0];
}

/** The view with the Block `id` in front of its pane, with the keyboard, in the tab in front. */
export function focusBlock(view: SessionView, layout: SessionLayout, id: string): SessionView {
  const found = findBlock(layout, id);
  if (!found) return view;
  const zoomed = view.zoom && view.zoom !== id && tabBlocks(found.tab).some((block) => block.id === view.zoom);
  return {
    tab: found.tab.id,
    focus: { ...view.focus, [found.tab.id]: id },
    fronted: [id, ...view.fronted.filter((other) => other !== id)].slice(0, FRONTED),
    // Another Block of the tab can't take the keyboard behind the one zoomed.
    ...(view.zoom && !zoomed ? { zoom: view.zoom } : {}),
  };
}

export const showTab = (view: SessionView, id: string): SessionView => ({ ...view, tab: id });

/** The view with the Block `id` filling its tab, or back among the others if it does. */
export function toggleZoom(view: SessionView, layout: SessionLayout, id: string): SessionView {
  if (view.zoom === id) {
    const { zoom: _was, ...rest } = view;
    return rest;
  }
  return { ...focusBlock(view, layout, id), zoom: id };
}

/** The view without what the layout no longer has, so it doesn't grow without end. */
export function trimView(view: SessionView, layout: SessionLayout): SessionView {
  const blocks = new Set(layout.tabs.flatMap(tabBlocks).map(({ id }) => id));
  const tabs = new Set(layout.tabs.map(({ id }) => id));
  return {
    ...(view.tab && tabs.has(view.tab) ? { tab: view.tab } : {}),
    focus: Object.fromEntries(Object.entries(view.focus).filter(([tab, block]) => tabs.has(tab) && blocks.has(block))),
    fronted: view.fronted.filter((id) => blocks.has(id)),
    ...(view.zoom && blocks.has(view.zoom) ? { zoom: view.zoom } : {}),
  };
}

const STORAGE_KEY = 'weave.sessionViews';
const SESSION_KEY = 'weave.session';
/** Sessions whose views are kept, the most recently used. */
const KEPT = 100;

type Stored = Record<string, SessionView & { usedAt: number }>;

const isView = (value: unknown): value is SessionView & { usedAt: number } => {
  const view = value as Partial<SessionView & { usedAt: number }> | null;
  return typeof view === 'object' && view !== null && typeof view.focus === 'object' && view.focus !== null
    && Array.isArray(view.fronted) && view.fronted.every((id) => typeof id === 'string') && typeof view.usedAt === 'number';
};

function loadViews(storage: Pick<Storage, 'getItem'> | undefined): Stored {
  try {
    const stored = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null') as unknown;
    if (typeof stored !== 'object' || stored === null) return {};
    return Object.fromEntries(Object.entries(stored).filter(([, view]) => isView(view))) as Stored;
  } catch {
    return {};
  }
}

/** The view this device kept of a Session. */
export function loadView(key: string, storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): SessionView {
  const { usedAt: _usedAt, ...view } = loadViews(storage)[key] ?? { ...emptyView(), usedAt: 0 };
  return view;
}

export function saveView(key: string, view: SessionView, storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage) {
  const views = { ...loadViews(storage), [key]: { ...view, usedAt: Date.now() } };
  const kept = Object.entries(views).sort(([, left], [, right]) => right.usedAt - left.usedAt).slice(0, KEPT);
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Full or unavailable: the view lasts until the app quits.
  }
}

/** The Session this device last showed, to show again when the app opens. */
export function loadLastSession(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): string | undefined {
  try {
    return storage?.getItem(SESSION_KEY) || undefined;
  } catch {
    return undefined;
  }
}

export function saveLastSession(key: string | undefined, storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined = globalThis.localStorage) {
  try {
    if (key) storage?.setItem(SESSION_KEY, key);
    else storage?.removeItem(SESSION_KEY);
  } catch {
    // It opens on the list next time.
  }
}

/** This device's view of the Session `key`, kept as it changes. */
export function useSessionView(key: string): [SessionView, (change: (view: SessionView) => SessionView) => void] {
  const [state, setState] = useState(() => ({ key, view: loadView(key) }));
  // Another Session: its own view, before anything renders with the last one's.
  const current = state.key === key ? state : { key, view: loadView(key) };
  if (current !== state) setState(current);
  const change = useCallback((next: (view: SessionView) => SessionView) => setState((latest) => {
    const base = latest.key === key ? latest.view : loadView(key);
    const view = next(base);
    return view === base && latest.key === key ? latest : { key, view };
  }), [key]);
  useEffect(() => {
    if (current.key === key) saveView(key, current.view);
  }, [key, current.view]);
  return [current.view, change];
}
