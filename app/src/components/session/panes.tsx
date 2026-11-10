// A tab's panes on the Mac and the iPad (WVE-203): rows and columns with edges to drag, a strip
// of its Blocks atop each pane, Blocks floating over them, and dragging a Block by its name to
// another pane's middle or edge, or to a tab.
import { Fragment, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Cancel01Icon, MoreHorizontalIcon } from '@hugeicons/core-free-icons';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { SessionBlock, SessionFloating, SessionFrame, SessionNode, SessionTab } from '@/host/protocol';
import { cn } from '@/lib/utils';
import { type Pane, type Path, type Side, type Split, type Target, fitFrame, newTab, shares } from '@/session/layout';
import { type SessionView, blockInFront } from '@/session/view';

/** What a pane does to the layout and the view, by Block. */
export type PaneActions = {
  focus(blockId: string): void;
  close(block: SessionBlock): void;
  zoom(blockId: string): void;
  /** Opens what goes in a new pane on `side` of the Block's. */
  split(blockId: string, side: Side): void;
  toNewTab(block: SessionBlock): void;
  /** Floats a Block over its tab, or puts a floating one back among the panes. */
  float(block: SessionBlock): void;
  move(block: SessionBlock, target: Target): void;
  resize(path: Path, sizes: number[]): void;
  frame(blockId: string, frame: SessionFrame): void;
};

export type PaneProps = {
  view: SessionView;
  /** The Block with the keyboard. */
  focusedId?: string;
  /** The Block filling the tab. */
  zoomedId?: string;
  actions: PaneActions;
  title(block: SessionBlock): string;
  mark(block: SessionBlock): ReactNode;
  body(block: SessionBlock): ReactNode;
  /** What a Block's type adds to its menu. */
  menu(block: SessionBlock): { title: string; run(): void }[];
};

/** The least share of a split a pane keeps when its edge is dragged. */
const MIN_SHARE = 0.1;
/** How far a Block's name moves under the pointer before it's being dragged, in pixels. */
const DRAG_START = 8;

type Drop = { target: Target; rect: { left: number; top: number; width: number; height: number } };

/** Where a Block dragged to `x`, `y` would go: a pane's middle or edge, or a tab. */
function dropAt(x: number, y: number, dragged: string): Drop | undefined {
  const under = document.elementFromPoint(x, y);
  const tab = under?.closest<HTMLElement>('[data-tab-drop]');
  if (tab) {
    const rect = tab.getBoundingClientRect();
    const id = tab.dataset.tabDrop ?? '';
    return { target: id === 'new' ? { newTab: newTab() } : { tab: id }, rect };
  }
  const pane = under?.closest<HTMLElement>('[data-pane]');
  const anchor = pane?.dataset.pane;
  if (!pane || !anchor) return undefined;
  const rect = pane.getBoundingClientRect();
  const across = (x - rect.left) / rect.width;
  const down = (y - rect.top) / rect.height;
  const edge = Math.min(across, 1 - across, down, 1 - down);
  if (edge > 0.25) return anchor === dragged && pane.dataset.alone ? undefined : { target: { into: anchor }, rect };
  const side: Side = edge === across ? 'left' : edge === 1 - across ? 'right' : edge === down ? 'up' : 'down';
  if (anchor === dragged && pane.dataset.alone) return undefined;
  const half = {
    left: { left: rect.left, top: rect.top, width: rect.width / 2, height: rect.height },
    right: { left: rect.left + rect.width / 2, top: rect.top, width: rect.width / 2, height: rect.height },
    up: { left: rect.left, top: rect.top, width: rect.width, height: rect.height / 2 },
    down: { left: rect.left, top: rect.top + rect.height / 2, width: rect.width, height: rect.height / 2 },
  }[side];
  return { target: { beside: anchor, side }, rect: half };
}

/**
 * Dragging a Block by its name in a pane's strip: past a few pixels it's being moved, a frame
 * shows where it would land, and letting go there moves it. A press that goes nowhere stays a
 * click.
 */
function useBlockDrag(move: PaneActions['move']) {
  const [drag, setDrag] = useState<{ block: SessionBlock; title: string; x: number; y: number; drop?: Drop }>();
  const dragged = useRef(false);
  const start = (event: ReactPointerEvent, block: SessionBlock, title: string) => {
    if (event.button !== 0) return;
    const from = { x: event.clientX, y: event.clientY };
    let moving = false;
    let latest: Drop | undefined;
    dragged.current = false;
    const moved = (next: PointerEvent) => {
      if (!moving && Math.hypot(next.clientX - from.x, next.clientY - from.y) < DRAG_START) return;
      moving = true;
      dragged.current = true;
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
  /** Whether the press that just ended was a drag, so its click isn't one. */
  const wasDrag = () => {
    const was = dragged.current;
    dragged.current = false;
    return was;
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
  return { start, wasDrag, overlay };
}

type Drag = ReturnType<typeof useBlockDrag>;

/** A Block's own menu: what its pane's strip offers for the Block in front. */
function BlockMenu({ block, title, floating, zoomed, actions, own }: {
  block: SessionBlock;
  title: string;
  floating: boolean;
  zoomed: boolean;
  actions: PaneActions;
  /** What the Block's type offers of its own. */
  own: { title: string; run(): void }[];
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size='icon-sm' variant='ghost' aria-label={`${title} Block actions`} />}>
        <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end'>
        <DropdownMenuGroup>
          {!floating && <DropdownMenuItem onClick={() => actions.split(block.id, 'right')}>Split right…</DropdownMenuItem>}
          {!floating && <DropdownMenuItem onClick={() => actions.split(block.id, 'down')}>Split down…</DropdownMenuItem>}
          <DropdownMenuItem onClick={() => actions.zoom(block.id)}>{zoomed ? 'Unzoom' : 'Zoom'}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => actions.float(block)}>{floating ? 'Dock' : 'Float'}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => actions.toNewTab(block)}>Move to a new tab</DropdownMenuItem>
        </DropdownMenuGroup>
        {own.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {own.map((item) => <DropdownMenuItem key={item.title} onClick={item.run}>{item.title}</DropdownMenuItem>)}
            </DropdownMenuGroup>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem variant='destructive' onClick={() => actions.close(block)}>Close</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A pane's strip: a name for each of its Blocks, the one in front picked out, then that Block's
 * menu and its close. A name is dragged to move its Block, unless `onHandle` takes the strip's
 * drags for itself, as a floating Block's does to move.
 */
function Strip({ blocks, front, focused, floating = false, drag, onHandle, ...props }: PaneProps & {
  blocks: SessionBlock[];
  front: SessionBlock;
  focused: boolean;
  floating?: boolean;
  drag?: Drag;
  onHandle?(event: ReactPointerEvent): void;
}) {
  const { actions, title, mark } = props;
  return (
    <div data-slot='pane-strip' className={cn('flex h-8 shrink-0 items-stretch gap-px border-b border-border bg-title-bar pr-1 text-xs', onHandle && 'cursor-grab touch-none')}
      onPointerDown={onHandle}>
      <div role='tablist' aria-label='Blocks in this pane' className='flex min-w-0 flex-1 items-stretch overflow-hidden'>
        {blocks.map((block) => {
          const selected = block.id === front.id;
          const name = title(block);
          return (
            <button key={block.id} type='button' role='tab' aria-selected={selected} title={name}
              className={cn(
                'flex min-w-0 max-w-56 items-center gap-1.5 border-b-2 border-transparent px-2.5 text-muted-foreground outline-none',
                !onHandle && 'touch-none',
                selected && 'text-foreground',
                selected && focused && 'border-primary',
                'focus-visible:bg-accent',
              )}
              onPointerDown={(event) => { if (!onHandle) drag?.start(event, block, name); }}
              onClick={() => { if (!drag?.wasDrag()) actions.focus(block.id); }}>
              {mark(block)}
              <span className='truncate'>{name}</span>
            </button>
          );
        })}
      </div>
      <div className='flex shrink-0 items-center gap-0.5' onPointerDown={(event) => event.stopPropagation()}>
        <BlockMenu block={front} title={title(front)} floating={floating} zoomed={props.zoomedId === front.id} actions={actions} own={props.menu(front)} />
        <Button size='icon-sm' variant='ghost' aria-label={`Close ${title(front)}`} onClick={() => actions.close(front)}>
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        </Button>
      </div>
    </div>
  );
}

/** What fills a pane under its strip: the Block in front. */
const Body = ({ block, body }: { block: SessionBlock; body: PaneProps['body'] }) => (
  <div data-block-id={block.id} role='tabpanel' className='flex min-h-0 min-w-0 flex-1 flex-col'>
    {body(block)}
  </div>
);

function PaneView({ pane, drag, ...props }: PaneProps & { pane: Pane; drag?: Drag }) {
  const { actions, focusedId } = props;
  const zoomed = pane.children.find(({ id }) => id === props.zoomedId);
  const front = zoomed ?? blockInFront(pane, props.view);
  const focused = front.id === focusedId;
  return (
    <div role='group' data-slot='pane' data-pane={front.id} data-alone={pane.children.length === 1 || undefined} data-focused={focused || undefined}
      aria-label={`Pane, ${props.title(front)}`} className='flex min-h-0 min-w-0 flex-1 flex-col bg-background'
      onPointerDownCapture={() => { if (!focused) actions.focus(front.id); }}>
      <Strip {...props} blocks={pane.children} front={front} focused={focused} drag={drag} />
      <Body key={front.id} block={front} body={props.body} />
    </div>
  );
}

/** The edge between two panes of a split, dragged to share their space out again. */
function Divider({ row, onDrag, onDone }: { row: boolean; onDrag(position: { x: number; y: number }): void; onDone(): void }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div role='separator' aria-orientation={row ? 'vertical' : 'horizontal'} aria-label='Resize panes' data-slot='pane-divider'
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

function SplitView({ node, path, drag, ...props }: PaneProps & { node: Split; path: Path; drag?: Drag }) {
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
    <div ref={container} data-slot='pane-split' className={cn('flex min-h-0 min-w-0 flex-1', row ? 'flex-row' : 'flex-col')}>
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

function NodeView({ node, path, drag, ...props }: PaneProps & { node: SessionNode; path: Path; drag?: Drag }) {
  if (node.kind === 'stack') return <PaneView {...props} pane={node} drag={drag} />;
  if (node.kind === 'row' || node.kind === 'column') return <SplitView {...props} node={node} path={path} drag={drag} />;
  return null;
}

/** A Block over the tab's panes: its strip moves it, and its corner sizes it. */
function FloatingView({ item, bounds, ...props }: PaneProps & { item: SessionFloating; bounds(): DOMRect | undefined }) {
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
    <div role='group' data-slot='floating-block' data-focused={focused || undefined} aria-label={`Floating, ${props.title(block)}`} style={style}
      className={cn('absolute z-10 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border bg-background shadow-xl', focused ? 'border-primary/60' : 'border-border')}
      onPointerDownCapture={() => { if (!focused) actions.focus(block.id); }}>
      <Strip {...props} blocks={[block]} front={block} focused={focused} floating
        onHandle={(event) => track(event, (from, dx, dy) => ({ ...from, x: from.x + dx, y: from.y + dy }))} />
      <Body key={block.id} block={block} body={props.body} />
      <div role='separator' aria-label={`Resize ${props.title(block)}`} className='absolute right-0 bottom-0 z-10 size-4 cursor-nwse-resize touch-none'
        onPointerDown={(event) => track(event, (from, dx, dy) => ({ ...from, width: from.width + dx, height: from.height + dy }))} />
    </div>
  );
}

/**
 * A tab: its panes, and the Blocks floating over them, or the one Block zoomed to fill it.
 * `empty` shows in a tab with nothing in it.
 */
export function TabPanes({ tab, empty, ...props }: PaneProps & { tab: SessionTab; empty: ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  const drag = useBlockDrag(props.actions.move);
  const zoomed = props.zoomedId
    ? [...(tab.floating ?? []).map(({ block }) => block)].find(({ id }) => id === props.zoomedId)
    : undefined;
  return (
    <div ref={body} data-slot='session-tab' role='tabpanel' className='relative flex min-h-0 min-w-0 flex-1'>
      {zoomed
        // A floating Block zoomed fills the tab as a pane of its own.
        ? <PaneView {...props} pane={{ kind: 'stack', children: [zoomed] }} />
        : props.zoomedId && tab.root
          ? <ZoomedPane {...props} root={tab.root} />
          : tab.root
            ? <NodeView {...props} node={tab.root} path={[]} drag={drag} />
            : empty}
      {!props.zoomedId && (tab.floating ?? []).map((item) => (
        <FloatingView key={item.block.id} {...props} item={item} bounds={() => body.current?.getBoundingClientRect()} />
      ))}
      {drag.overlay}
    </div>
  );
}

/** The pane that holds the zoomed Block, alone. */
function ZoomedPane({ root, ...props }: PaneProps & { root: SessionNode }) {
  const find = (node: SessionNode): Pane | undefined => {
    if (node.kind === 'stack') return node.children.some(({ id }) => id === props.zoomedId) ? node : undefined;
    if (node.kind === 'row' || node.kind === 'column') {
      for (const child of node.children) {
        const found = find(child);
        if (found) return found;
      }
    }
    return undefined;
  };
  const pane = find(root);
  return pane ? <PaneView {...props} pane={pane} /> : null;
}
