import { describe, expect, it } from 'vitest';
import type { SessionBlock, SessionLayout, SessionNode } from '@/host/protocol';
import { type Pane, LAYOUT_VERSION, tidy } from './layout';
import {
  type SessionView,
  blockInFront,
  blocksShown,
  emptyView,
  focusBlock,
  focusedBlock,
  loadLastSession,
  loadView,
  saveLastSession,
  saveView,
  showTab,
  tabInFront,
  toggleZoom,
  trimView,
  zoomedIn,
} from './view';

const block = (id: string): SessionBlock => ({ id, type: 'weave.thread', props: { threadId: id } });
const stack = (...ids: string[]): SessionNode => ({ kind: 'stack', children: ids.map(block) });
const layout: SessionLayout = tidy({
  version: LAYOUT_VERSION,
  tabs: [
    { id: 't', root: { kind: 'row', children: [stack('a', 'b'), stack('c')] }, floating: [{ block: block('f'), frame: { x: 0, y: 0, width: 0.5, height: 0.5 } }] },
    { id: 'u', root: stack('d', 'e') },
  ],
});
const ids = (blocks: SessionBlock[]) => blocks.map(({ id }) => id);
const storage = () => {
  const kept = new Map<string, string>();
  return {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => { kept.set(key, value); },
    removeItem: (key: string) => { kept.delete(key); },
  };
};

describe('a device’s view of a layout', () => {
  it('starts on the first tab, the first Block of each pane in front, and the first of those with the keyboard', () => {
    const view = emptyView();
    expect(tabInFront(layout, view).id).toBe('t');
    expect(ids(blocksShown(layout.tabs[0], view))).toEqual(['a', 'c', 'f']);
    expect(focusedBlock(layout.tabs[0], view)?.id).toBe('a');
    expect(focusedBlock({ id: 'empty' }, view)).toBeUndefined();
  });

  it('brings a Block to the front of its pane, with the keyboard, in its tab', () => {
    const view = focusBlock(emptyView(), layout, 'e');
    expect(tabInFront(layout, view).id).toBe('u');
    expect(blockInFront(layout.tabs[1].root as Pane, view).id).toBe('e');
    expect(focusedBlock(layout.tabs[1], view)?.id).toBe('e');
    // Each tab keeps its own, and the latest brought forward wins its pane.
    const both = focusBlock(focusBlock(view, layout, 'b'), layout, 'c');
    expect(ids(blocksShown(layout.tabs[0], both))).toEqual(['b', 'c', 'f']);
    expect(focusedBlock(layout.tabs[0], both)?.id).toBe('c');
    expect(focusedBlock(layout.tabs[1], showTab(both, 'u'))?.id).toBe('e');
    expect(focusBlock(view, layout, 'gone')).toBe(view);
  });

  it('zooms a Block to fill its tab, until it’s zoomed again or another of the tab takes the keyboard', () => {
    const zoomed = toggleZoom(emptyView(), layout, 'c');
    expect(zoomedIn(layout.tabs[0], zoomed)?.id).toBe('c');
    expect(ids(blocksShown(layout.tabs[0], zoomed))).toEqual(['c']);
    expect(focusedBlock(layout.tabs[0], zoomed)?.id).toBe('c');
    // Not in another tab.
    expect(zoomedIn(layout.tabs[1], zoomed)).toBeUndefined();
    expect(zoomedIn(layout.tabs[0], toggleZoom(zoomed, layout, 'c'))).toBeUndefined();
    expect(zoomedIn(layout.tabs[0], focusBlock(zoomed, layout, 'a'))).toBeUndefined();
    // A Block of another tab leaves it zoomed where it is.
    expect(focusBlock(zoomed, layout, 'd').zoom).toBe('c');
  });

  it('lets go of what the layout no longer has', () => {
    const view: SessionView = { tab: 'gone', focus: { t: 'a', u: 'gone', gone: 'x' }, fronted: ['x', 'b', 'a'], zoom: 'x' };
    expect(trimView(view, layout)).toEqual({ focus: { t: 'a' }, fronted: ['b', 'a'] });
  });
});

describe('what this device keeps', () => {
  it('is each Session’s view, and the Session it last showed', () => {
    const store = storage();
    expect(loadView('h:/work', store)).toEqual(emptyView());
    const view = focusBlock(emptyView(), layout, 'b');
    saveView('h:/work', view, store);
    saveView('h:/other', emptyView(), store);
    expect(loadView('h:/work', store)).toEqual(view);
    expect(loadLastSession(store)).toBeUndefined();
    saveLastSession('h:/work', store);
    expect(loadLastSession(store)).toBe('h:/work');
    saveLastSession(undefined, store);
    expect(loadLastSession(store)).toBeUndefined();
  });

  it('is nothing where storage can’t be read', () => {
    expect(loadView('h:/work', { getItem: () => 'nonsense' })).toEqual(emptyView());
    expect(loadView('h:/work', { getItem: () => JSON.stringify({ 'h:/work': { focus: 'wrong' } }) })).toEqual(emptyView());
    expect(loadLastSession({ getItem: () => { throw new Error('blocked'); } })).toBeUndefined();
  });
});
