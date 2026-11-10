import { describe, expect, it } from 'vitest';
import type { SessionBlock, SessionLayout, SessionNode } from '@/host/protocol';
import { LAYOUT_VERSION, tidy } from './layout';
import {
  type SessionView,
  blockOnPhone,
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
const leaf = (id: string): SessionNode => ({ kind: 'block', ...block(id) });
const FRAME = { x: 0, y: 0, width: 0.5, height: 0.5 };
const layout: SessionLayout = tidy({
  version: LAYOUT_VERSION,
  tabs: [
    { id: 't', root: { kind: 'row', children: [leaf('a'), leaf('c')] }, floating: [{ block: block('f'), frame: FRAME }, { block: block('m'), frame: FRAME, minimized: true }] },
    { id: 'u', root: { kind: 'column', children: [leaf('d'), leaf('e')] } },
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
  it('starts on the first tab, showing what’s docked and what floats but not what’s minimized, the first with the keyboard', () => {
    const view = emptyView();
    expect(tabInFront(layout, view).id).toBe('t');
    expect(ids(blocksShown(layout.tabs[0], view))).toEqual(['a', 'c', 'f']);
    expect(focusedBlock(layout.tabs[0], view)?.id).toBe('a');
    expect(focusedBlock({ id: 'empty' }, view)).toBeUndefined();
  });

  it('gives a Block the keyboard, in its tab', () => {
    const view = focusBlock(emptyView(), layout, 'e');
    expect(tabInFront(layout, view).id).toBe('u');
    expect(focusedBlock(layout.tabs[1], view)?.id).toBe('e');
    // Each tab keeps its own.
    const both = focusBlock(view, layout, 'c');
    expect(focusedBlock(layout.tabs[0], both)?.id).toBe('c');
    expect(focusedBlock(layout.tabs[1], showTab(both, 'u'))?.id).toBe('e');
    expect(focusBlock(view, layout, 'gone')).toBe(view);
    // One that's minimized doesn't show, so the keyboard stays with one that does.
    expect(focusedBlock(layout.tabs[0], focusBlock(emptyView(), layout, 'm'))?.id).toBe('a');
  });

  it('shows an iPhone one Block of a tab at a time, a minimized one among them', () => {
    expect(blockOnPhone(layout.tabs[0], emptyView())?.id).toBe('a');
    expect(blockOnPhone(layout.tabs[0], focusBlock(emptyView(), layout, 'm'))?.id).toBe('m');
    expect(blockOnPhone({ id: 'empty' }, emptyView())).toBeUndefined();
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
    const view: SessionView = { tab: 'gone', focus: { t: 'a', u: 'gone', gone: 'x' }, zoom: 'x' };
    expect(trimView(view, layout)).toEqual({ focus: { t: 'a' } });
  });
});

describe('what this device keeps', () => {
  it('is each Session’s view, and the Session it last showed', () => {
    const store = storage();
    expect(loadView('h:/work', store)).toEqual(emptyView());
    const view = focusBlock(emptyView(), layout, 'c');
    saveView('h:/work', view, store);
    saveView('h:/other', emptyView(), store);
    expect(loadView('h:/work', store)).toEqual(view);
    expect(loadLastSession(store)).toBeUndefined();
    saveLastSession('h:/work', store);
    expect(loadLastSession(store)).toBe('h:/work');
    saveLastSession(undefined, store);
    expect(loadLastSession(store)).toBeUndefined();
  });

  it('drops what a view kept before stacks went: which Block was in front of each', () => {
    const store = storage();
    store.setItem('weave.sessionViews', JSON.stringify({ 'h:/old': { focus: { t: 'a' }, fronted: ['a'], usedAt: 1 } }));
    expect(loadView('h:/old', store)).toEqual({ focus: { t: 'a' } });
  });

  it('is nothing where storage can’t be read', () => {
    expect(loadView('h:/work', { getItem: () => 'nonsense' })).toEqual(emptyView());
    expect(loadView('h:/work', { getItem: () => JSON.stringify({ 'h:/work': { focus: 'wrong' } }) })).toEqual(emptyView());
    expect(loadLastSession({ getItem: () => { throw new Error('blocked'); } })).toBeUndefined();
  });
});
