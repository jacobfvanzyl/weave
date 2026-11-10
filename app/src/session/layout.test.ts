import { describe, expect, it } from 'vitest';
import type { SessionBlock, SessionLayout, SessionNode, SessionTab } from '@/host/protocol';
import {
  LAYOUT_VERSION,
  addTab,
  findBlock,
  firstLayout,
  fitFrame,
  frameBlock,
  layoutBlocks,
  moveTab,
  paneBeside,
  paneRects,
  panes,
  placeBlock,
  prune,
  removeBlock,
  removeTab,
  renameTab,
  resizeSplit,
  shares,
  tabBlocks,
  tidy,
} from './layout';

const block = (id: string, type = 'weave.thread'): SessionBlock => ({ id, type, props: { threadId: id } });
const stack = (...ids: string[]): SessionNode => ({ kind: 'stack', children: ids.map((id) => block(id)) });
const row = (...children: SessionNode[]): SessionNode => ({ kind: 'row', children });
const column = (...children: SessionNode[]): SessionNode => ({ kind: 'column', children });
const layout = (...tabs: SessionTab[]): SessionLayout => tidy({ version: LAYOUT_VERSION, tabs });

/** A tab's tree as text: `[a b]` a pane, `(x | y)` a row, `(x / y)` a column. */
const shape = (node?: SessionNode | null): string => {
  if (!node) return '∅';
  if (node.kind === 'stack') return `[${node.children.map(({ id }) => id).join(' ')}]`;
  if (node.kind === 'block') return `<${node.id}>`;
  return `(${node.children.map(shape).join(node.kind === 'row' ? ' | ' : ' / ')})`;
};
const shapes = (given: SessionLayout) => given.tabs.map((tab) => `${tab.id}:${shape(tab.root)}${tab.floating?.length ? `+{${tab.floating.map(({ block: floating }) => floating.id).join(' ')}}` : ''}`).join('  ');

describe('tidying a document', () => {
  it('makes every leaf a pane, and drops what holds nothing', () => {
    const given = tidy({
      version: 1,
      tabs: [{ id: 't', root: row({ kind: 'block', ...block('a') }, { kind: 'stack', children: [] }, column(stack('b'), { kind: 'stack', children: [] })) }],
    });
    expect(shapes(given)).toBe('t:([a] | [b])');
  });

  it('folds a split into one of its own kind, in its share', () => {
    const given = tidy({ version: 1, tabs: [{ id: 't', root: { kind: 'row', children: [stack('a'), row(stack('b'), stack('c'))], sizes: [1, 1] } }] });
    expect(shapes(given)).toBe('t:([a] | [b] | [c])');
    expect((given.tabs[0].root as { sizes: number[] }).sizes).toEqual([0.5, 0.25, 0.25]);
  });

  it('keeps the first of two Blocks or tabs with one id', () => {
    const given = tidy({
      version: 1,
      tabs: [
        { id: 't', root: row(stack('a', 'a'), stack('b')), floating: [{ block: block('b'), frame: { x: 0, y: 0, width: 0.5, height: 0.5 } }] },
        { id: 't', root: stack('c') },
        { id: 'u', root: stack('a', 'd') },
      ],
    });
    expect(shapes(given)).toBe('t:([a] | [b])  u:[d]');
  });

  it('always has a tab, and takes what isn’t a layout for none', () => {
    expect(tidy(undefined).tabs).toHaveLength(1);
    expect(tidy({ version: 1, tabs: 'nonsense' as never }).tabs).toHaveLength(1);
    expect(tidy({ version: 1, tabs: [{ id: 't', root: { kind: 'unknown' } as never }] }).tabs).toEqual([{ id: 't' }]);
  });

  it('keeps a floating Block inside its tab', () => {
    expect(fitFrame({ x: 0.9, y: -1, width: 0.5, height: 0.01 })).toEqual({ x: 0.5, y: 0, width: 0.5, height: 0.1 });
  });

  it('shares a split equally without usable sizes', () => {
    expect(shares({ children: [stack('a'), stack('b')], sizes: [3, 1] })).toEqual([0.75, 0.25]);
    expect(shares({ children: [stack('a'), stack('b')], sizes: [1] })).toEqual([0.5, 0.5]);
    expect(shares({ children: [stack('a'), stack('b')], sizes: [0, -1] })).toEqual([0.5, 0.5]);
  });
});

describe('placing a Block', () => {
  const start = layout({ id: 't', root: row(stack('a', 'b'), stack('c')) });

  it('joins a pane after the Block named', () => {
    expect(shapes(placeBlock(start, block('x'), { into: 'a' }))).toBe('t:([a x b] | [c])');
  });

  it('splits a pane on each side', () => {
    expect(shapes(placeBlock(start, block('x'), { beside: 'c', side: 'right' }))).toBe('t:([a b] | [c] | [x])');
    expect(shapes(placeBlock(start, block('x'), { beside: 'c', side: 'left' }))).toBe('t:([a b] | [x] | [c])');
    expect(shapes(placeBlock(start, block('x'), { beside: 'c', side: 'down' }))).toBe('t:([a b] | ([c] / [x]))');
    expect(shapes(placeBlock(start, block('x'), { beside: 'a', side: 'up' }))).toBe('t:(([x] / [a b]) | [c])');
  });

  it('halves the pane it splits', () => {
    const split = placeBlock(start, block('x'), { beside: 'c', side: 'right' });
    expect((split.tabs[0].root as { sizes: number[] }).sizes).toEqual([0.5, 0.25, 0.25]);
  });

  it('goes into a tab, along its edge, into a new tab, or floats over one', () => {
    expect(shapes(placeBlock(start, block('x'), { tab: 't' }))).toBe('t:([a b x] | [c])');
    expect(shapes(placeBlock(start, block('x'), { edge: 't', side: 'down' }))).toBe('t:(([a b] | [c]) / [x])');
    expect(shapes(placeBlock(start, block('x'), { newTab: { id: 'u' } }))).toBe('t:([a b] | [c])  u:[x]');
    expect(shapes(placeBlock(start, block('x'), { floating: 't', frame: { x: 0, y: 0, width: 0.5, height: 0.5 } }))).toBe('t:([a b] | [c])+{x}');
    expect(shapes(placeBlock(layout({ id: 't' }), block('x'), { tab: 't' }))).toBe('t:[x]');
  });

  it('moves a Block the layout already has, and the pane it leaves empty goes', () => {
    expect(shapes(placeBlock(start, block('c'), { into: 'b' }))).toBe('t:[a b c]');
    expect(shapes(placeBlock(start, block('a'), { beside: 'c', side: 'down' }))).toBe('t:([b] | ([c] / [a]))');
    expect(shapes(placeBlock(start, block('b'), { beside: 'b', side: 'right' }))).toBe('t:([a] | [b] | [c])');
  });

  it('takes its tab with it when it was the last there, but not the tab it goes to', () => {
    const two = layout({ id: 't', root: stack('a') }, { id: 'u', root: stack('b') });
    expect(shapes(placeBlock(two, block('a'), { into: 'b' }))).toBe('u:[b a]');
    expect(shapes(placeBlock(two, block('a'), { floating: 't', frame: { x: 0, y: 0, width: 0.5, height: 0.5 } }))).toBe('t:∅+{a}  u:[b]');
    expect(shapes(placeBlock(two, block('a'), { newTab: { id: 'v' }, after: 'u' }))).toBe('u:[b]  v:[a]');
  });

  it('changes nothing where it already is, or where the target is gone', () => {
    expect(placeBlock(start, block('c'), { into: 'c' })).toBe(start);
    expect(placeBlock(start, block('c'), { beside: 'c', side: 'left' })).toBe(start);
    expect(placeBlock(start, block('x'), { into: 'gone' })).toBe(start);
    expect(placeBlock(start, block('x'), { tab: 'gone' })).toBe(start);
    expect(placeBlock(start, block('x'), { newTab: { id: 't' } })).toBe(start);
    const alone = layout({ id: 't', root: stack('a') });
    expect(placeBlock(alone, block('a'), { tab: 't' })).toBe(alone);
  });
});

describe('removing a Block', () => {
  it('closes the pane and the split it leaves empty', () => {
    const start = layout({ id: 't', root: row(stack('a'), column(stack('b'), stack('c'))) });
    expect(shapes(removeBlock(start, 'b'))).toBe('t:([a] | [c])');
    expect(shapes(removeBlock(removeBlock(start, 'b'), 'c'))).toBe('t:[a]');
  });

  it('closes a tab left empty, unless it’s the only one', () => {
    const two = layout({ id: 't', root: stack('a') }, { id: 'u', root: stack('b') });
    expect(shapes(removeBlock(two, 'a'))).toBe('u:[b]');
    expect(shapes(removeBlock(removeBlock(two, 'a'), 'b'))).toBe('u:∅');
  });

  it('takes a floating Block off its tab, and nothing for one it doesn’t have', () => {
    const start = layout({ id: 't', root: stack('a'), floating: [{ block: block('f'), frame: { x: 0, y: 0, width: 0.5, height: 0.5 } }] });
    expect(shapes(removeBlock(start, 'f'))).toBe('t:[a]');
    expect(removeBlock(start, 'gone')).toBe(start);
  });

  it('prunes the Blocks a rule turns away', () => {
    const start = layout({ id: 't', root: row(stack('a', 'b'), stack('c')) });
    expect(shapes(prune(start, ({ id }) => id !== 'a' && id !== 'c'))).toBe('t:[b]');
  });
});

describe('tabs', () => {
  const start = layout({ id: 't', root: stack('a') }, { id: 'u', root: stack('b') });

  it('adds one after another, or last', () => {
    expect(shapes(addTab(start, { id: 'v' }, 't'))).toBe('t:[a]  v:∅  u:[b]');
    expect(shapes(addTab(start, { id: 'v' }))).toBe('t:[a]  u:[b]  v:∅');
    expect(addTab(start, { id: 't' })).toBe(start);
  });

  it('removes one with its Blocks, and empties the only one', () => {
    expect(shapes(removeTab(start, 't'))).toBe('u:[b]');
    expect(shapes(removeTab(removeTab(start, 't'), 'u'))).toBe('u:∅');
  });

  it('renames and moves one', () => {
    expect(renameTab(start, 't', '  Build ').tabs[0].title).toBe('Build');
    expect(renameTab(renameTab(start, 't', 'Build'), 't', '').tabs[0]).not.toHaveProperty('title');
    expect(shapes(moveTab(start, 't', 1))).toBe('u:[b]  t:[a]');
    expect(shapes(moveTab(start, 'u', -3))).toBe('u:[b]  t:[a]');
  });
});

describe('sizes and frames', () => {
  const start = layout({ id: 't', root: row(stack('a'), column(stack('b'), stack('c'))) });

  it('shares a split out again', () => {
    const resized = resizeSplit(start, 't', [], [3, 1]);
    expect((resized.tabs[0].root as { sizes: number[] }).sizes).toEqual([0.75, 0.25]);
    const inner = resizeSplit(start, 't', [1], [1, 4]);
    expect(((inner.tabs[0].root as { children: { sizes: number[] }[] }).children[1]).sizes).toEqual([0.2, 0.8]);
  });

  it('changes nothing for a split it doesn’t have, or sizes that don’t fit it', () => {
    expect(resizeSplit(start, 't', [0], [1, 1])).toBe(start);
    expect(resizeSplit(start, 't', [], [1, 1, 1])).toBe(start);
    expect(resizeSplit(start, 't', [], [1, 0])).toBe(start);
    expect(resizeSplit(start, 'gone', [], [1, 1])).toBe(start);
  });

  it('moves a floating Block and puts it on top', () => {
    const frame = { x: 0, y: 0, width: 0.3, height: 0.3 };
    const floating = layout({ id: 't', root: stack('a'), floating: [{ block: block('f'), frame }, { block: block('g'), frame }] });
    const moved = frameBlock(floating, 'f', { x: 0.5, y: 0.5, width: 0.3, height: 0.3 });
    expect(moved.tabs[0].floating?.map(({ block: floatingBlock }) => floatingBlock.id)).toEqual(['g', 'f']);
    expect(findBlock(moved, 'f')?.frame).toEqual({ x: 0.5, y: 0.5, width: 0.3, height: 0.3 });
    expect(frameBlock(floating, 'a', frame)).toBe(floating);
  });
});

describe('reading a layout', () => {
  const start = layout(
    { id: 't', root: row(stack('a', 'b'), column(stack('c'), stack('d'))), floating: [{ block: block('f'), frame: { x: 0, y: 0, width: 0.5, height: 0.5 } }] },
    { id: 'u', root: stack('e') },
  );

  it('lists panes and Blocks in reading order, floating ones last', () => {
    expect(panes(start.tabs[0]).map(({ path }) => path)).toEqual([[0], [1, 0], [1, 1]]);
    expect(tabBlocks(start.tabs[0]).map(({ id }) => id)).toEqual(['a', 'b', 'c', 'd', 'f']);
    expect(layoutBlocks(start).map(({ id }) => id)).toEqual(['a', 'b', 'c', 'd', 'f', 'e']);
  });

  it('finds a Block with its pane, or its frame', () => {
    expect(findBlock(start, 'd')).toMatchObject({ tab: { id: 't' }, path: [1, 1], index: 0 });
    expect(findBlock(start, 'f')).toMatchObject({ tab: { id: 't' }, frame: { width: 0.5 } });
    expect(findBlock(start, 'f')?.pane).toBeUndefined();
    expect(findBlock(start, 'gone')).toBeUndefined();
  });

  it('places panes in a unit square', () => {
    expect(paneRects(start.tabs[0]).map(({ rect }) => rect)).toEqual([
      { x: 0, y: 0, width: 0.5, height: 1 },
      { x: 0.5, y: 0, width: 0.5, height: 0.5 },
      { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
    ]);
  });

  it('finds the pane to each side', () => {
    const beside = (id: string, side: Parameters<typeof paneBeside>[2]) => paneBeside(start.tabs[0], id, side)?.children.map((found) => found.id).join(' ');
    expect(beside('a', 'right')).toBe('c');
    expect(beside('d', 'left')).toBe('a b');
    expect(beside('c', 'down')).toBe('d');
    expect(beside('d', 'up')).toBe('c');
    expect(beside('a', 'left')).toBeUndefined();
    expect(beside('c', 'up')).toBeUndefined();
    // The nearest pane wins over a nearer overlap further away.
    const wide = layout({ id: 't', root: row(stack('a'), stack('b'), stack('c')) });
    expect(paneBeside(wide.tabs[0], 'a', 'right')?.children[0].id).toBe('b');
  });
});

describe('a Session’s first layout', () => {
  it('is one tab with one pane of the Blocks given', () => {
    expect(shapes(firstLayout([block('a'), block('b')], { id: 't' }))).toBe('t:[a b]');
    expect(shapes(firstLayout([], { id: 't' }))).toBe('t:∅');
  });
});
