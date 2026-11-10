// A tab's Blocks on the Mac and the iPad (WVE-203): those docked, in rows and columns with edges
// to drag, each under a rail with its name and the same icons for any Block; those floating over
// them; and, at the bottom right, the names of the floating ones put away. A docked Block is
// dragged by its rail to another's edge or middle, or to a tab.
import { Fragment, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowExpand01Icon,
  ArrowShrink01Icon,
  Cancel01Icon,
  LayoutTwoColumnIcon,
  LayoutTwoRowIcon,
  Maximize01Icon,
  MinusSignIcon,
  MoreHorizontalIcon,
  PictureInPictureExitIcon,
  PictureInPictureOnIcon,
} from '@hugeicons/core-free-icons';
import { NameInput } from '@/components/session/name-input';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { SessionBlock, SessionFloating, SessionFrame, SessionNode, SessionTab } from '@/host/protocol';
import { cn } from '@/lib/utils';
import { type Path, type Side, type Split, type Target, fitFrame, newTab, shares, tabBlocks } from '@/session/layout';

/** What a Block's rail and its edges do to the layout and the view, by Block. */
export type BlockActions = {
  focus(blockId: string): void;
  close(block: SessionBlock): void;
  zoom(blockId: string): void;
  /** Opens what docks on `side` of the Block. */
  split(blockId: string, side: Side): void;
  /** Floats a docked Block over its tab, or docks a floating one. */
  float(block: SessionBlock): void;
  /** Puts a floating Block away as its name, or brings it back. */
  minimize(block: SessionBlock, minimized: boolean): void;
  move(block: SessionBlock, target: Target): void;
  resize(path: Path, sizes: number[]): void;
  frame(blockId: string, frame: SessionFrame): void;
};

export type TabProps = {
  /** The Block with the keyboard. */
  focusedId?: string;
  /** The Block filling the tab. */
  zoomedId?: string;
  actions: BlockActions;
  title(block: SessionBlock): string;
  mark(block: SessionBlock): ReactNode;
  body(block: SessionBlock): ReactNode;
  /** What a Block's type offers in its rail's menu. */
  menu(block: SessionBlock): BlockAction[];
  /** Names what the Block shows, where its type's names are the person's to give. */
  rename?(block: SessionBlock): ((name: string) => void | Promise<void>) | undefined;
  /** How many Blocks the tab has: one alone has nothing to zoom over. */
  inTab: number;
  /** Whether the Block with the keyboard is marked: when the tab shows others to tell it from. */
  marksFocus: boolean;
};

/**
 * The edge of the Block with the keyboard, where its tab shows others to tell it from: drawn over
 * the Block, so nothing moves as the keyboard does.
 */
const FOCUS_EDGE = "after:pointer-events-none after:absolute after:inset-0 after:z-50 after:border-2 after:border-primary after:content-['']";

/** Something a Block's type offers of its own. */
export type BlockAction = { title: string; destructive?: boolean; run(): void };

/** An icon, as the icon set gives them. */
type IconSvgElement = Parameters<typeof HugeiconsIcon>[0]['icon'];

/** The least share of a split a Block keeps when its edge is dragged. */
const MIN_SHARE = 0.1;
/** How far a Block's rail moves under the pointer before the Block is being dragged, in pixels. */
const DRAG_START = 8;
/** How much of a Block, in from each edge, docks what's dropped there beside it; its middle swaps the two. */
const EDGE = 0.25;

type Drop = { target: Target; rect: { left: number; top: number; width: number; height: number } };

/**
 * Where a Block dragged to `x`, `y` would go: beside the docked Block there, when it's over one of
 * its edges, in its place when it's over its middle, or to a tab.
 */
function dropAt(x: number, y: number, dragged: string): Drop | undefined {
  const under = document.elementFromPoint(x, y);
  const tab = under?.closest<HTMLElement>('[data-tab-drop]');
  if (tab) {
    const rect = tab.getBoundingClientRect();
    const id = tab.dataset.tabDrop ?? '';
    return { target: id === 'new' ? { newTab: newTab() } : { tab: id }, rect };
  }
  const over = under?.closest<HTMLElement>('[data-block]');
  const anchor = over?.dataset.block;
  if (!over || !anchor || anchor === dragged) return undefined;
  const rect = over.getBoundingClientRect();
  const across = (x - rect.left) / rect.width;
  const down = (y - rect.top) / rect.height;
  const edge = Math.min(across, 1 - across, down, 1 - down);
  if (edge > EDGE) return { target: { swap: anchor }, rect };
  const side: Side = edge === across ? 'left' : edge === 1 - across ? 'right' : edge === down ? 'up' : 'down';
  const half = {
    left: { left: rect.left, top: rect.top, width: rect.width / 2, height: rect.height },
    right: { left: rect.left + rect.width / 2, top: rect.top, width: rect.width / 2, height: rect.height },
    up: { left: rect.left, top: rect.top, width: rect.width, height: rect.height / 2 },
    down: { left: rect.left, top: rect.top + rect.height / 2, width: rect.width, height: rect.height / 2 },
  }[side];
  return { target: { beside: anchor, side }, rect: half };
}

/**
 * Dragging a docked Block by its rail: past a few pixels it's being moved, a frame shows where it
 * would land, and letting go there moves it. A press that goes nowhere stays a click.
 */
function useBlockDrag(move: BlockActions['move']) {
  const [drag, setDrag] = useState<{ block: SessionBlock; title: string; x: number; y: number; drop?: Drop }>();
  const start = (event: ReactPointerEvent, block: SessionBlock, title: string) => {
    if (event.button !== 0) return;
    const from = { x: event.clientX, y: event.clientY };
    let moving = false;
    let latest: Drop | undefined;
    const moved = (next: PointerEvent) => {
      if (!moving && Math.hypot(next.clientX - from.x, next.clientY - from.y) < DRAG_START) return;
      moving = true;
      latest = dropAt(next.clientX, next.clientY, block.id);
      setDrag({ block, title, x: next.clientX, y: next.clientY, ...(latest ? { drop: latest } : {}) });
    };
    const done = (next: PointerEvent) => {
      window.removeEventListener('pointermove', moved);
      window.removeEventListener('pointerup', done);
      window.removeEventListener('pointercancel', done);
      setDrag(undefined);
      if (moving && latest && next.type === 'pointerup') move(block, latest.target);
    };
    window.addEventListener('pointermove', moved);
    window.addEventListener('pointerup', done);
    window.addEventListener('pointercancel', done);
  };
  const overlay = drag && (
    <>
      {drag.drop && (
        <div data-slot='drop-frame' aria-hidden='true' className='pointer-events-none fixed z-50 rounded-md border-2 border-primary bg-primary/15'
          style={{ left: drag.drop.rect.left, top: drag.drop.rect.top, width: drag.drop.rect.width, height: drag.drop.rect.height }} />
      )}
      <div aria-hidden='true' className='pointer-events-none fixed z-50 max-w-48 truncate rounded-md border border-border bg-popover px-2 py-1 text-xs shadow-md'
        style={{ left: drag.x + 12, top: drag.y + 12 }}>
        {drag.title}
      </div>
    </>
  );
  return { start, overlay };
}

type Drag = ReturnType<typeof useBlockDrag>;

/** One of a rail's icons: named with its Block for a screen reader, and by what it does under the pointer. */
function RailButton({ label, hint, icon, pressed, onClick }: { label: string; hint: string; icon: IconSvgElement; pressed?: boolean; onClick(): void }) {
  return (
    <Button size='icon-sm' variant='ghost' aria-label={label} title={hint} aria-pressed={pressed} onClick={onClick}>
      <HugeiconsIcon icon={icon} strokeWidth={2} />
    </Button>
  );
}

/**
 * A Block's rail, atop it: its name, then the same icons whatever the Block is. Docked, it has
 * split right, split down, float, zoom when its tab has another Block to zoom over, a menu of
 * what its type offers, and close; floating, it has dock and minimize in place of the splits.
 * The whole rail is the Block's handle: dragging it moves a docked Block, and `onHandle` takes
 * the drags for a floating one, to move it. A name clicked twice is typed over in place, where
 * the Block's type lets it be renamed. With `among`, as on the iPhone, which shows one Block at a
 * time, it names each of the tab's Blocks to pick between, and has only the menu and close.
 */
export function BlockRail({ block, among, floating = false, drag, onHandle, ...props }: TabProps & {
  block: SessionBlock;
  /** The Blocks to pick between, this one among them. */
  among?: SessionBlock[];
  floating?: boolean;
  drag?: Drag;
  onHandle?(event: ReactPointerEvent): void;
}) {
  const { actions, title, mark } = props;
  const name = title(block);
  const own = props.menu(block);
  const zoomed = props.zoomedId === block.id;
  const handle = Boolean(onHandle ?? drag);
  const arrange = !among;
  const [renaming, setRenaming] = useState<string>();
  /** A Block's name: typed over while it's being renamed, else what a double click renames. */
  const named = (shown: SessionBlock) => {
    const label = title(shown);
    const rename = props.rename?.(shown);
    if (rename && renaming === shown.id) {
      return <NameInput label='Block name' name={label} maxLength={200} className='w-44' onKeep={rename} onDone={() => setRenaming(undefined)} />;
    }
    return <span className='truncate' onDoubleClick={() => { if (rename) setRenaming(shown.id); }}>{label}</span>;
  };
  return (
    <div data-slot='block-rail' className={cn('flex h-9 shrink-0 items-stretch gap-px border-b border-border bg-title-bar pr-1 text-xs', handle && 'cursor-grab touch-none')}
      onPointerDown={(event) => {
        if (renaming) return;
        if (onHandle) onHandle(event);
        else drag?.start(event, block, name);
      }}>
      {among
        ? (
          <div role='tablist' aria-label='Blocks in this tab' className='flex min-w-0 flex-1 items-stretch overflow-x-auto'>
            {among.map((listed) => {
              const selected = listed.id === block.id;
              return (
                <div key={listed.id} role='tab' tabIndex={0} aria-selected={selected} title={title(listed)}
                  className={cn('flex max-w-56 min-w-0 shrink-0 cursor-default items-center gap-1.5 px-3 text-muted-foreground outline-none focus-visible:bg-accent', selected && 'text-foreground')}
                  onClick={() => actions.focus(listed.id)}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
                    event.preventDefault();
                    actions.focus(listed.id);
                  }}>
                  {mark(listed)}
                  {named(listed)}
                </div>
              );
            })}
          </div>
        )
        : (
          <div data-slot='block-title' title={name} className='flex min-w-0 flex-1 items-center gap-1.5 px-3 text-foreground'>
            {mark(block)}
            {named(block)}
          </div>
        )}
      <div className='flex shrink-0 items-center gap-0.5' onPointerDown={(event) => event.stopPropagation()}>
        {arrange && !floating && <RailButton label={`Split ${name} right`} hint='Split Right' icon={LayoutTwoColumnIcon} onClick={() => actions.split(block.id, 'right')} />}
        {arrange && !floating && <RailButton label={`Split ${name} down`} hint='Split Down' icon={LayoutTwoRowIcon} onClick={() => actions.split(block.id, 'down')} />}
        {arrange && (
          <RailButton label={floating ? `Dock ${name}` : `Float ${name}`} hint={floating ? 'Dock' : 'Float'}
            icon={floating ? PictureInPictureExitIcon : PictureInPictureOnIcon} onClick={() => actions.float(block)} />
        )}
        {arrange && floating && <RailButton label={`Minimize ${name}`} hint='Minimize' icon={MinusSignIcon} onClick={() => actions.minimize(block, true)} />}
        {arrange && (props.inTab > 1 || zoomed) && (
          <RailButton label={zoomed ? `Unzoom ${name}` : `Zoom ${name}`} hint={zoomed ? 'Unzoom' : 'Zoom'}
            icon={zoomed ? ArrowShrink01Icon : ArrowExpand01Icon} pressed={zoomed} onClick={() => actions.zoom(block.id)} />
        )}
        <DropdownMenu>
          <DropdownMenuTrigger disabled={own.length === 0} render={<Button size='icon-sm' variant='ghost' aria-label={`${name} actions`} title='More' />}>
            <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end'>
            <DropdownMenuGroup>
              {own.map((item) => (
                <DropdownMenuItem key={item.title} variant={item.destructive ? 'destructive' : undefined} onClick={item.run}>{item.title}</DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <RailButton label={`Close ${name}`} hint='Close' icon={Cancel01Icon} onClick={() => actions.close(block)} />
      </div>
    </div>
  );
}

/** What fills a Block under its rail. */
const Body = ({ block, body }: { block: SessionBlock; body: TabProps['body'] }) => (
  <div data-block-id={block.id} className='flex min-h-0 min-w-0 flex-1 flex-col'>
    {body(block)}
  </div>
);

/** A Block in its place in the tab's tree, or the one zoomed to fill the tab. */
function DockedBlock({ block, drag, ...props }: TabProps & { block: SessionBlock; drag?: Drag }) {
  const { actions, focusedId } = props;
  const focused = block.id === focusedId;
  return (
    <div role='group' data-slot='docked-block' data-block={block.id} data-focused={focused || undefined}
      data-focus-edge={(focused && props.marksFocus) || undefined} aria-label={`Block, ${props.title(block)}`}
      className={cn('relative isolate flex min-h-0 min-w-0 flex-1 flex-col bg-background', focused && props.marksFocus && FOCUS_EDGE)}
      onPointerDownCapture={() => { if (!focused) actions.focus(block.id); }}>
      <BlockRail {...props} block={block} drag={drag} />
      <Body key={block.id} block={block} body={props.body} />
    </div>
  );
}

/** The edge between two docked Blocks of a split, dragged to share their space out again. */
function Divider({ row, onDrag, onDone }: { row: boolean; onDrag(position: { x: number; y: number }): void; onDone(): void }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div role='separator' aria-orientation={row ? 'vertical' : 'horizontal'} aria-label='Resize Blocks' data-slot='block-divider'
      className={cn('relative shrink-0 touch-none bg-border', row ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize', dragging && 'bg-primary')}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => { if (dragging) onDrag({ x: event.clientX, y: event.clientY }); }}
      onPointerUp={() => {
        if (!dragging) return;
        setDragging(false);
        onDone();
      }}
      onPointerCancel={() => setDragging(false)}>
      {/* Wider than it looks, so a finger finds it. */}
      <span aria-hidden='true' className={cn('absolute z-10', row ? '-inset-x-1.5 inset-y-0' : 'inset-x-0 -inset-y-1.5')} />
    </div>
  );
}

function SplitView({ node, path, drag, ...props }: TabProps & { node: Split; path: Path; drag?: Drag }) {
  const row = node.kind === 'row';
  const container = useRef<HTMLDivElement>(null);
  // The shares while an edge is dragged, until the layout has them.
  const [live, setLive] = useState<number[]>();
  const saved = shares(node);
  useEffect(() => setLive(undefined), [saved.join(' ')]);
  const sizes = live?.length === saved.length ? live : saved;
  const dragEdge = (index: number, position: { x: number; y: number }) => {
    const rect = container.current?.getBoundingClientRect();
    if (!rect) return;
    const at = row ? (position.x - rect.left) / rect.width : (position.y - rect.top) / rect.height;
    const before = sizes.slice(0, index - 1).reduce((sum, size) => sum + size, 0);
    const pair = sizes[index - 1] + sizes[index];
    const least = Math.min(MIN_SHARE, pair / 2);
    const first = Math.min(pair - least, Math.max(least, at - before));
    setLive(sizes.map((size, child) => child === index - 1 ? first : child === index ? pair - first : size));
  };
  return (
    <div ref={container} data-slot='block-split' className={cn('flex min-h-0 min-w-0 flex-1', row ? 'flex-row' : 'flex-col')}>
      {node.children.map((child, index) => (
        <Fragment key={index}>
          {index > 0 && <Divider row={row} onDrag={(position) => dragEdge(index, position)} onDone={() => { if (live) props.actions.resize(path, live); }} />}
          <div className='flex min-h-0 min-w-0' style={{ flex: `${sizes[index]} 1 0%` }}>
            <NodeView {...props} node={child} path={[...path, index]} drag={drag} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function NodeView({ node, path, drag, ...props }: TabProps & { node: SessionNode; path: Path; drag?: Drag }) {
  if (node.kind === 'block') return <DockedBlock {...props} block={{ id: node.id, type: node.type, ...(node.props ? { props: node.props } : {}) }} drag={drag} />;
  if (node.kind === 'row' || node.kind === 'column') return <SplitView {...props} node={node} path={path} drag={drag} />;
  return null;
}

/** A Block over the tab's docked ones: its rail moves it, and its corner sizes it. */
function FloatingBlock({ item, bounds, ...props }: TabProps & { item: SessionFloating; bounds(): DOMRect | undefined }) {
  const { actions, focusedId } = props;
  const { block } = item;
  const [live, setLive] = useState<SessionFrame>();
  useEffect(() => setLive(undefined), [item.frame.x, item.frame.y, item.frame.width, item.frame.height]);
  const frame = live ?? item.frame;
  const focused = block.id === focusedId;
  const track = (event: ReactPointerEvent, change: (from: SessionFrame, dx: number, dy: number) => SessionFrame) => {
    const rect = bounds();
    if (!rect || event.button !== 0) return;
    event.preventDefault();
    const from = frame;
    const origin = { x: event.clientX, y: event.clientY };
    let latest: SessionFrame | undefined;
    const moved = (next: PointerEvent) => {
      latest = fitFrame(change(from, (next.clientX - origin.x) / rect.width, (next.clientY - origin.y) / rect.height));
      setLive(latest);
    };
    const done = () => {
      window.removeEventListener('pointermove', moved);
      window.removeEventListener('pointerup', done);
      window.removeEventListener('pointercancel', done);
      if (latest) actions.frame(block.id, latest);
    };
    window.addEventListener('pointermove', moved);
    window.addEventListener('pointerup', done);
    window.addEventListener('pointercancel', done);
  };
  const style: CSSProperties = { left: `${frame.x * 100}%`, top: `${frame.y * 100}%`, width: `${frame.width * 100}%`, height: `${frame.height * 100}%` };
  return (
    <div role='group' data-slot='floating-block' data-focused={focused || undefined} data-focus-edge={(focused && props.marksFocus) || undefined}
      aria-label={`Floating, ${props.title(block)}`} style={style}
      className={cn(
        'absolute z-10 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-border bg-background shadow-xl',
        focused && props.marksFocus && cn(FOCUS_EDGE, 'after:rounded-md'),
      )}
      onPointerDownCapture={() => { if (!focused) actions.focus(block.id); }}>
      <BlockRail {...props} block={block} floating
        onHandle={(event) => track(event, (from, dx, dy) => ({ ...from, x: from.x + dx, y: from.y + dy }))} />
      <Body key={block.id} block={block} body={props.body} />
      <div role='separator' aria-label={`Resize ${props.title(block)}`} className='absolute right-0 bottom-0 z-10 size-4 cursor-nwse-resize touch-none'
        onPointerDown={(event) => track(event, (from, dx, dy) => ({ ...from, width: from.width + dx, height: from.height + dy }))} />
    </div>
  );
}

/**
 * The floating Blocks put away, one above another at the tab's bottom right: each its mark and
 * name, which brings it back where it floated.
 */
function MinimizedBlocks({ blocks, ...props }: TabProps & { blocks: SessionBlock[] }) {
  if (blocks.length === 0) return null;
  return (
    <div role='group' aria-label='Minimized Blocks' data-slot='minimized-blocks' className='absolute right-2 bottom-2 z-20 flex max-w-64 flex-col items-end gap-1'>
      {blocks.map((block) => {
        const name = props.title(block);
        return (
          <button key={block.id} type='button' data-slot='minimized-block' aria-label={`Maximize ${name}`} title='Maximize'
            className='flex h-7 max-w-full items-center gap-1.5 rounded-md border border-border bg-popover pr-1.5 pl-2 text-xs text-foreground shadow-md outline-none hover:bg-accent focus-visible:bg-accent'
            onClick={() => props.actions.minimize(block, false)}>
            {props.mark(block)}
            <span className='truncate'>{name}</span>
            <HugeiconsIcon icon={Maximize01Icon} strokeWidth={2} className='size-3.5 shrink-0 text-icon-muted' />
          </button>
        );
      })}
    </div>
  );
}

/**
 * A tab: its docked Blocks, those floating over them and the names of those put away, or the one
 * Block zoomed to fill it. `empty` shows in a tab with nothing docked.
 */
export function TabBlocks({ tab, empty, ...props }: TabProps & { tab: SessionTab; empty: ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  const drag = useBlockDrag(props.actions.move);
  const zoomed = props.zoomedId ? tabBlocks(tab).find(({ id }) => id === props.zoomedId) : undefined;
  const floating = tab.floating ?? [];
  return (
    <div ref={body} data-slot='session-tab' role='tabpanel' className='relative flex min-h-0 min-w-0 flex-1'>
      {zoomed
        ? <DockedBlock {...props} block={zoomed} />
        : tab.root
          ? <NodeView {...props} node={tab.root} path={[]} drag={drag} />
          : empty}
      {!zoomed && floating.filter(({ minimized }) => !minimized).map((item) => (
        <FloatingBlock key={item.block.id} {...props} item={item} bounds={() => body.current?.getBoundingClientRect()} />
      ))}
      <MinimizedBlocks {...props} blocks={floating.filter(({ minimized, block }) => minimized && block.id !== zoomed?.id).map(({ block }) => block)} />
      {drag.overlay}
    </div>
  );
}
