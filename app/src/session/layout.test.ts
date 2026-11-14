import { describe, expect, it } from 'vitest';
import type { SessionBlock, SessionLayout, SessionNode, SessionTab } from '@/host/protocol';
import {
  LAYOUT_VERSION,
  blockBeside,
  blockRects,
  docked,
  findBlock,
  fitFrame,
  frameBlock,
  layoutBlocks,
  layoutWith,
  minimizeBlock,
  moveTab,
  placeBlock,
  prune,
  removeBlock,
  removeTab,
  renameTab,
  resizeSplit,
  roomierSide,
  shares,
  tabBlocks,
  tidy,
  withoutEmptyTabs,
} from './layout';

const block = (id: string, type = 'weave.thread'): SessionBlock => ({ id, type, props: { threadId: id } });
const leaf = (id: string): SessionNode => ({ kind: 'block', ...block(id) });
const row = (...children: SessionNode[]): SessionNode => ({ kind: 'row', children });
const column = (...children: SessionNode[]): SessionNode => ({ kind: 'column', children });
const layout = (...tabs: SessionTab[]): SessionLayout => tidy({ version: LAYOUT_VERSION, tabs });
const FRAME = { x: 0.1, y: 0.1, width: 0.4, height: 0.4 };
/** What the first version of the document had: Blocks one behind another in one place. */
const stack = (...ids: string[]) => ({ kind: 'stack', children: ids.map((id) => block(id)) }) as unknown as SessionNode;

/** A tab's tree as text: `a` a docked Block, `(x | y)` a row, `(x / y)` a column, `+{f g-}` floating, `-` minimized. */
const shape = (node?: SessionNode | null): string => {
  if (!node) return '∅';
  if (node.kind === 'block') return node.id;
  return `(${node.children.map(shape).join(node.kind === 'row' ? ' | ' : ' / ')})`;
};
const shapes = (given: SessionLayout) => given.tabs
  .map((tab) => `${tab.id}:${shape(tab.root)}${tab.floating?.length ? `+{${tab.floating.map(({ block: floating, minimized }) => `${floating.id}${minimized ? '-' : ''}`).join(' ')}}` : ''}`)
  .join('  ');

describe('tidying a document', () => {
  it('drops what holds nothing, and a split of one is that one', () => {
    const given = tidy({
      version: 2,
      tabs: [{ id: 't', root: row(leaf('a'), { kind: 'row', children: [] }, column(leaf('b'), { kind: 'column', children: [] })) }],
    });
    expect(shapes(given)).toBe('t:(a | b)');
  });

  it('keeps the first Block of a stack, as the first version of the document had them', () => {
    const given = tidy({ version: 1, tabs: [{ id: 't', root: row(stack('a', 'b', 'c'), column(stack('d'), stack())) }] });
    expect(shapes(given)).toBe('t:(a | d)');
    // What the others showed is no longer in the layout, to be given a Block again.
    expect(layoutBlocks(given).map(({ id }) => id)).toEqual(['a', 'd']);
    expect(given.version).toBe(LAYOUT_VERSION);
  });

  it('folds a split into one of its own kind, in its share', () => {
    const given = tidy({ version: 2, tabs: [{ id: 't', root: { kind: 'row', children: [leaf('a'), row(leaf('b'), leaf('c'))], sizes: [1, 1] } }] });
    expect(shapes(given)).toBe('t:(a | b | c)');
    expect((given.tabs[0].root as { sizes: number[] }).sizes).toEqual([0.5, 0.25, 0.25]);
  });

  it('keeps the first of two Blocks or tabs with one id', () => {
    const given = tidy({
      version: 2,
      tabs: [
        { id: 't', root: row(leaf('a'), leaf('a'), leaf('b')), floating: [{ block: block('b'), frame: { x: 0, y: 0, width: 0.5, height: 0.5 } }] },
        { id: 't', root: leaf('c') },
        { id: 'u', root: row(leaf('a'), leaf('d')) },
      ],
    });
    expect(shapes(given)).toBe('t:(a | b)  u:d');
  });

  it('always has a tab, and takes what isn’t a layout for none', () => {
    expect(tidy(undefined).tabs).toHaveLength(1);
    expect(tidy({ version: 2, tabs: 'nonsense' as never }).tabs).toHaveLength(1);
    expect(tidy({ version: 2, tabs: [{ id: 't', root: { kind: 'unknown' } as never }] }).tabs).toEqual([{ id: 't' }]);
  });

  it('keeps a floating Block inside its tab, minimized or not', () => {
    expect(fitFrame({ x: 0.9, y: -1, width: 0.5, height: 0.01 })).toEqual({ x: 0.5, y: 0, width: 0.5, height: 0.1 });
    const given = tidy({ version: 2, tabs: [{ id: 't', floating: [{ block: block('f'), frame: FRAME, minimized: true }, { block: block('g'), frame: FRAME, minimized: false }] }] });
    expect(given.tabs[0].floating).toEqual([{ block: block('f'), frame: FRAME, minimized: true }, { block: block('g'), frame: FRAME }]);
  });

  it('shares a split equally without usable sizes', () => {
    expect(shares({ children: [leaf('a'), leaf('b')], sizes: [3, 1] })).toEqual([0.75, 0.25]);
    expect(shares({ children: [leaf('a'), leaf('b')], sizes: [1] })).toEqual([0.5, 0.5]);
    expect(shares({ children: [leaf('a'), leaf('b')], sizes: [0, -1] })).toEqual([0.5, 0.5]);
  });
});

describe('placing a Block', () => {
  const start = layout({ id: 't', root: row(leaf('a'), leaf('b')) });

  it('docks beside another, each taking half of what that one had', () => {
    expect(shapes(placeBlock(start, block('x'), { beside: 'b', side: 'down' }))).toBe('t:(a | (b / x))');
    expect(shapes(placeBlock(start, block('x'), { beside: 'b', side: 'up' }))).toBe('t:(a | (x / b))');
    const beside = placeBlock(start, block('x'), { beside: 'a', side: 'right' });
    expect(shapes(beside)).toBe('t:(a | x | b)');
    expect((beside.tabs[0].root as { sizes: number[] }).sizes).toEqual([0.25, 0.25, 0.5]);
  });

  it('docks along a whole side of a tab, fills an empty one, or takes a tab of its own', () => {
    expect(shapes(placeBlock(start, block('x'), { edge: 't', side: 'left' }))).toBe('t:(x | a | b)');
    expect(shapes(placeBlock(start, block('x'), { edge: 't', side: 'down' }))).toBe('t:((a | b) / x)');
    expect(shapes(placeBlock(layout({ id: 't' }), block('x'), { tab: 't' }))).toBe('t:x');
    expect(shapes(placeBlock(start, block('x'), { newTab: { id: 'u' } }))).toBe('t:(a | b)  u:x');
    expect(shapes(placeBlock(layout({ id: 't', root: leaf('a') }, { id: 'v' }), block('x'), { newTab: { id: 'u' }, after: 't' }))).toBe('t:a  u:x  v:∅');
  });

  it('docks in a tab beside its largest Block, on the roomier side', () => {
    // Alone, a Block is wider than tall: to its right. Then each half is taller than wide: below the first.
    const one = layout({ id: 't', root: leaf('a') });
    const two = placeBlock(one, block('b'), { tab: 't' });
    expect(shapes(two)).toBe('t:(a | b)');
    expect(shapes(placeBlock(two, block('c'), { tab: 't' }))).toBe('t:((a / c) | b)');
    expect(shapes(layoutWith([block('a'), block('b'), block('c'), block('d')], { id: 't' }))).toBe('t:((a / c) | (b / d))');
    expect(roomierSide(two.tabs[0], 'a')).toBe('down');
    // A narrow tab splits its one Block downwards, a wide one a half sideways.
    expect(roomierSide(one.tabs[0], 'a', 0.5)).toBe('down');
    expect(roomierSide(two.tabs[0], 'a', 3)).toBe('right');
  });

  it('moves a Block the layout already has, taking what it leaves empty with it', () => {
    expect(shapes(placeBlock(start, block('a'), { beside: 'b', side: 'right' }))).toBe('t:(b | a)');
    const two = layout({ id: 't', root: leaf('a') }, { id: 'u', root: leaf('b') });
    // The tab it leaves empty goes, but not the one it's bound for.
    expect(shapes(placeBlock(two, block('a'), { beside: 'b', side: 'left' }))).toBe('u:(a | b)');
    // Alone in its tab, a tab of its own is where it is.
    expect(placeBlock(two, block('a'), { newTab: { id: 'v' } })).toBe(two);
    expect(shapes(placeBlock(start, block('a'), { newTab: { id: 'v' } }))).toBe('t:b  v:a');
    expect(shapes(placeBlock(two, block('a'), { tab: 'u' }))).toBe('u:(b | a)');
  });

  it('trades places with the Block it’s dropped on the middle of, each keeping the other’s space', () => {
    const three = layout({ id: 't', root: { kind: 'row', sizes: [0.7, 0.3], children: [leaf('a'), column(leaf('b'), leaf('c'))] } });
    const swapped = placeBlock(three, block('a'), { swap: 'c' });
    expect(shapes(swapped)).toBe('t:(c | (b / a))');
    expect((swapped.tabs[0].root as { sizes: number[] }).sizes).toEqual([0.7, 0.3]);
    // Across tabs too, and nothing for a Block that isn't docked or one that's gone.
    const two = layout({ id: 't', root: leaf('a') }, { id: 'u', root: row(leaf('b'), leaf('c')), floating: [{ block: block('f'), frame: FRAME }] });
    expect(shapes(placeBlock(two, block('a'), { swap: 'c' }))).toBe('t:c  u:(b | a)+{f}');
    expect(placeBlock(two, block('f'), { swap: 'a' })).toBe(two);
    expect(placeBlock(two, block('a'), { swap: 'f' })).toBe(two);
    expect(placeBlock(two, block('a'), { swap: 'a' })).toBe(two);
    expect(placeBlock(two, block('x'), { swap: 'a' })).toBe(two);
  });

  it('changes nothing where it already is, or where the target has gone', () => {
    expect(placeBlock(start, block('a'), { beside: 'a', side: 'left' })).toBe(start);
    expect(placeBlock(start, block('a'), { tab: 't' })).toBe(start);
    expect(placeBlock(start, block('x'), { beside: 'gone', side: 'left' })).toBe(start);
    expect(placeBlock(start, block('x'), { tab: 'gone' })).toBe(start);
    expect(placeBlock(start, block('x'), { newTab: { id: 't' } })).toBe(start);
    const alone = layout({ id: 't', root: leaf('a') });
    expect(placeBlock(alone, block('a'), { edge: 't', side: 'left' })).toBe(alone);
  });

  it('floats over a tab, and docks again', () => {
    const floated = placeBlock(start, block('a'), { floating: 't', frame: FRAME });
    expect(shapes(floated)).toBe('t:b+{a}');
    expect(findBlock(floated, 'a')).toMatchObject({ frame: FRAME, minimized: false });
    expect(findBlock(floated, 'a')?.path).toBeUndefined();
    expect(shapes(placeBlock(floated, block('a'), { tab: 't' }))).toBe('t:(b | a)');
    // The only Block of a tab floats there too, over nothing.
    expect(shapes(placeBlock(layout({ id: 't', root: leaf('a') }), block('a'), { floating: 't', frame: FRAME }))).toBe('t:∅+{a}');
  });
});

describe('a floating Block', () => {
  const start = layout({ id: 't', root: leaf('a'), floating: [{ block: block('f'), frame: FRAME }, { block: block('g'), frame: FRAME }] });

  it('is put away as its name and brought back where it floated, on top', () => {
    const away = minimizeBlock(start, 'f', true);
    expect(shapes(away)).toBe('t:a+{g f-}');
    expect(findBlock(away, 'f')).toMatchObject({ frame: FRAME, minimized: true });
    const back = minimizeBlock(minimizeBlock(away, 'g', true), 'f', false);
    expect(shapes(back)).toBe('t:a+{g- f}');
    // Again changes nothing, and a docked Block has nowhere to go.
    expect(minimizeBlock(away, 'f', true)).toBe(away);
    expect(minimizeBlock(start, 'a', true)).toBe(start);
    expect(minimizeBlock(start, 'gone', true)).toBe(start);
  });

  it('moves and is sized inside its tab, coming to the top', () => {
    const moved = frameBlock(start, 'f', { x: 0.9, y: 0.9, width: 0.5, height: 0.5 });
    expect(shapes(moved)).toBe('t:a+{g f}');
    expect(findBlock(moved, 'f')?.frame).toEqual({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 });
    expect(frameBlock(start, 'a', FRAME)).toBe(start);
  });
});

describe('removing', () => {
  it('gives what was beside a Block its space, and drops a tab left empty unless it’s the only one', () => {
    const start = layout({ id: 't', root: row(leaf('a'), column(leaf('b'), leaf('c'))) }, { id: 'u', root: leaf('d') });
    expect(shapes(removeBlock(start, 'b'))).toBe('t:(a | c)  u:d');
    expect(shapes(removeBlock(start, 'd'))).toBe('t:(a | (b / c))');
    expect(shapes(removeBlock(layout({ id: 't', root: leaf('a') }), 'a'))).toBe('t:∅');
    expect(removeBlock(start, 'gone')).toBe(start);
  });

  it('prunes the Blocks a test turns away', () => {
    const start = layout({ id: 't', root: row(leaf('a'), leaf('b')), floating: [{ block: block('f'), frame: FRAME, minimized: true }] });
    expect(shapes(prune(start, ({ id }) => id !== 'b' && id !== 'f'))).toBe('t:a');
  });

  it('takes a tab and its Blocks, and empties the only one', () => {
    const start = layout({ id: 't', root: leaf('a') }, { id: 'u', root: leaf('b') });
    expect(shapes(removeTab(start, 't'))).toBe('u:b');
    expect(shapes(removeTab(removeTab(start, 't'), 'u'))).toBe('u:∅');
  });
});

describe('empty tabs', () => {
  it('leave a layout read with them, down to the first when nothing has a Block', () => {
    const mixed = layout({ id: 't' }, { id: 'u', root: leaf('a') }, { id: 'v' }, { id: 'w', floating: [{ block: block('f'), frame: FRAME }] });
    expect(shapes(withoutEmptyTabs(mixed))).toBe('u:a  w:∅+{f}');
    expect(shapes(withoutEmptyTabs(layout({ id: 't' }, { id: 'u' })))).toBe('t:∅');
    const full = layout({ id: 't', root: leaf('a') });
    expect(withoutEmptyTabs(full)).toBe(full);
    const one = layout({ id: 't' });
    expect(withoutEmptyTabs(one)).toBe(one);
  });
});

describe('tabs and splits', () => {
  const start = layout({ id: 't', root: row(leaf('a'), column(leaf('b'), leaf('c'))) }, { id: 'u' });

  it('names and orders tabs', () => {
    expect(renameTab(start, 'u', '  Notes ').tabs[1].title).toBe('Notes');
    expect(renameTab(renameTab(start, 'u', 'Notes'), 'u', ' ').tabs[1].title).toBeUndefined();
    expect(moveTab(start, 'u', 0).tabs.map(({ id }) => id)).toEqual(['u', 't']);
  });

  it('shares a split out again', () => {
    const resized = resizeSplit(start, 't', [], [3, 1]);
    expect((resized.tabs[0].root as { sizes: number[] }).sizes).toEqual([0.75, 0.25]);
    expect(resizeSplit(start, 't', [], [1])).toBe(start);
    expect(resizeSplit(start, 't', [0], [1, 1])).toBe(start);
  });

  it('lists a tab’s Blocks in the order they read, the floating ones last', () => {
    const withFloating = layout({ id: 't', root: row(leaf('a'), column(leaf('b'), leaf('c'))), floating: [{ block: block('f'), frame: FRAME, minimized: true }] });
    expect(docked(withFloating.tabs[0]).map(({ path }) => path)).toEqual([[0], [1, 0], [1, 1]]);
    expect(tabBlocks(withFloating.tabs[0]).map(({ id }) => id)).toEqual(['a', 'b', 'c', 'f']);
    expect(findBlock(withFloating, 'c')?.path).toEqual([1, 1]);
  });

  it('knows where each docked Block is, and which is beside which', () => {
    expect(blockRects(start.tabs[0]).map(({ rect }) => rect)).toEqual([
      { x: 0, y: 0, width: 0.5, height: 1 },
      { x: 0.5, y: 0, width: 0.5, height: 0.5 },
      { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
    ]);
    const beside = (id: string, side: Parameters<typeof blockBeside>[2]) => blockBeside(start.tabs[0], id, side)?.id;
    expect(beside('a', 'right')).toBe('b');
    expect(beside('b', 'down')).toBe('c');
    expect(beside('c', 'left')).toBe('a');
    expect(beside('a', 'left')).toBeUndefined();
    expect(beside('gone', 'left')).toBeUndefined();
  });
});
