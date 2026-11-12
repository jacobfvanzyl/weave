// A tab's Blocks on the Mac and the iPad (WVE-203): those docked, in rows and columns with edges
// to drag, each with a rail of its name and the same icons for any Block, as pills in a row atop
// it that show under the pointer or when tapped; those floating over them; and, at the bottom right,
// the names of the floating ones put away. A docked Block is dragged by its rail to
// another's edge or middle, or to a tab.
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
import { platform } from '@/app/platform';
import { NameInput } from '@/components/session/name-input';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { SessionBlock, SessionFloating, SessionFrame, SessionNode, SessionTab } from '@/host/protocol';
import { cn } from '@/lib/utils';
import { THREAD_BLOCK } from '@/session/blocks';
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
  /** Its type's icon, before its name in its rail. */
  icon?(block: SessionBlock): IconSvgElement | undefined;
  body(block: SessionBlock): ReactNode;
  /** What a Block's type offers in its rail's menu. */
  menu(block: SessionBlock): BlockAction[];
  /** Names what the Block shows, where its type's names are the person's to give. */
  rename?(block: SessionBlock): ((name: string) => void | Promise<void>) | undefined;
  /** How many Blocks the tab has: one alone has nothing to zoom over. */
  inTab: number;
  /** Whether the Block with the keyboard is marked: when the tab shows others to tell it from. */
  marksFocus: boolean;
  /**
   * A Block that stays where it is, as a Bot's Thread Block (WVE-178): not dragged, floated,
   * minimized or closed. Device-local things, focus and zoom, still work.
   */
  locked?: string;
  /** Whether a Block may be dropped at a target; anywhere when not given. */
  allows?(block: SessionBlock, target: Target): boolean;
};

/**
 * The edge of the Block with the keyboard, where its tab shows others to tell it from: its border
 * in Mocha's blue at half strength (`--block-focus`), and a ring just outside it, so nothing moves as the keyboard does.
 */
const FOCUS_EDGE = 'border-block-focus ring-1 ring-block-focus';

/**
 * A docked Block: a rounded card with a thin edge, 4px in from the tab's sides and bottom, flush
 * under the Session's rail, and 8px from the next (`Divider`). Its shadow is the background, as wide as that inset: it fills the corners
 * outside its rounding, so a terminal drawn natively beneath the page (the iPad's) shows no square
 * corners there, where the page above it is otherwise clear.
 */
const BLOCK_CARD = 'overflow-hidden rounded-xl border border-border shadow-[0_0_0_4px_var(--background)]';

/** A Block's surface, its rail's row included: a thread's is its chat's, any other's a terminal's. */
const surface = (block: SessionBlock) => block.type === THREAD_BLOCK ? 'bg-chat-background' : 'bg-block-background';

/** Something a Block's type offers of its own. */
export type BlockAction = { title: string; destructive?: boolean; run(): void };

/** An icon, as the icon set gives them. */
type IconSvgElement = Parameters<typeof HugeiconsIcon>[0]['icon'];

/** The least share of a split a Block keeps when its edge is dragged. */
const MIN_SHARE = 0.1;
/** How far a Block's handle moves under the pointer before the Block is being dragged, in pixels. */
const DRAG_START = 8;
/** How much of a Block, in from each edge, docks what's dropped there beside it; its middle swaps the two. */
const EDGE = 0.25;

/** Has an element keep a pointer until it lifts, where the browser can. */
function keepPointer(element: Element, pointerId: number) {
  try {
    element.setPointerCapture?.(pointerId);
  } catch {
    // The pointer has gone already.
  }
}

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
function useBlockDrag(move: BlockActions['move'], allows?: TabProps['allows']) {
  const [drag, setDrag] = useState<{ block: SessionBlock; title: string; x: number; y: number; drop?: Drop }>();
  const start = (event: ReactPointerEvent, block: SessionBlock, title: string) => {
    if (event.button !== 0) return;
    // The press selects nothing, and once it's a drag the rail keeps the pointer: what it passes
    // over, a thread's text or a terminal, hears nothing of it.
    event.preventDefault();
    const handle = event.currentTarget;
    const from = { x: event.clientX, y: event.clientY };
    let moving = false;
    let latest: Drop | undefined;
    const moved = (next: PointerEvent) => {
      if (!moving && Math.hypot(next.clientX - from.x, next.clientY - from.y) < DRAG_START) return;
      if (!moving) {
        keepPointer(handle, next.pointerId);
        document.body.style.userSelect = 'none';
        document.body.style.setProperty('-webkit-user-select', 'none');
      }
      moving = true;
      latest = dropAt(next.clientX, next.clientY, block.id);
      // A target refused, as one before a Bot's Thread Block, shows nothing and takes nothing.
      if (latest && allows && !allows(block, latest.target)) latest = undefined;
      setDrag({ block, title, x: next.clientX, y: next.clientY, ...(latest ? { drop: latest } : {}) });
    };
    const done = (next: PointerEvent) => {
      window.removeEventListener('pointermove', moved);
      window.removeEventListener('pointerup', done);
      window.removeEventListener('pointercancel', done);
      document.body.style.userSelect = '';
      document.body.style.removeProperty('-webkit-user-select');
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
function RailButton({ label, hint, icon, pressed, className, onClick }: {
  label: string;
  hint: string;
  icon: IconSvgElement;
  pressed?: boolean;
  className?: string;
  onClick(): void;
}) {
  return (
    <Button size='icon-sm' variant='ghost' aria-label={label} title={hint} aria-pressed={pressed} className={className} onClick={onClick}>
      <HugeiconsIcon icon={icon} strokeWidth={2} />
    </Button>
  );
}

/** Where the pointer hovers, as the Mac's does, and a touch screen's doesn't. */
const HOVERS = '(hover: hover) and (pointer: fine)';

/**
 * Whether a Block's controls wait for the pointer over it, as on the Mac, rather than for a tap:
 * not on a touch screen, nor where terminals are drawn natively beneath the page (the iPad's),
 * which take the touches over a Block's body. Where there's no `matchMedia` to ask, they wait for
 * the pointer.
 */
function useHoverControls() {
  const query = () => (platform().terminals === 'native' || typeof window.matchMedia !== 'function' ? undefined : window.matchMedia(HOVERS));
  const [hovers, setHovers] = useState(() => platform().terminals !== 'native' && (query()?.matches ?? true));
  useEffect(() => {
    const list = query();
    if (!list) return;
    const update = () => setHovers(list.matches);
    update();
    list.addEventListener?.('change', update);
    return () => list.removeEventListener?.('change', update);
  }, []);
  return hovers;
}

/** A Block's title and its icons, each a pill over or atop it, as Rex's are. */
const PILL = 'pointer-events-auto flex h-7 items-center rounded-full border border-foreground/10 bg-muted/60 shadow-sm backdrop-blur-md';

/**
 * A Block's rail: its name and, apart from it, the same icons whatever the Block is. Docked, it has
 * split right, split down, float, zoom when its tab has another Block to zoom over, a menu of what
 * its type offers, and close; floating, it has dock and minimize in place of the splits. They're
 * two pills, the name's at the left and the icons' at the right: where the pointer hovers, as on
 * the Mac, they keep a row atop the Block, empty until the pointer is over that row, one of them
 * has the keyboard, the name is typed over or the menu is open; on a touch
 * screen, a slim strip atop the Block shows them in a row of its own when tapped, pushing the body
 * down (a native terminal under it follows), until it's tapped again or something outside the
 * Block is pressed. The rail is the Block's handle wherever it isn't a button (on a touch screen, its name's pill), but for a locked one: dragging it moves
 * a docked Block, and `onHandle` takes the drags for a floating one, to move it. A name clicked
 * twice is typed over in place, where the Block's type lets it be renamed. With `among`, as on the
 * iPhone, which shows one Block at a time, the rail is a row atop it that names each of the tab's
 * Blocks to pick between, and has only the menu and close.
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
  const pinned = props.locked === block.id;
  const handle = !pinned && Boolean(onHandle ?? drag);
  const arrange = !among;
  const [renaming, setRenaming] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);
  const hovers = useHoverControls();
  // On a touch screen: whether the strip has been tapped to show the controls.
  const [expanded, setExpanded] = useState(false);
  const rail = useRef<HTMLDivElement>(null);
  // The controls stay while the name is typed over or the menu is open.
  const keep = menuOpen || Boolean(renaming);
  const keepOpen = useRef(keep);
  keepOpen.current = keep;
  useEffect(() => {
    if (!expanded) return;
    // A press outside the Block puts the controls away, but not one in the menu they opened.
    const press = (event: PointerEvent) => {
      const card = rail.current?.parentElement;
      if (keepOpen.current || !card || (event.target instanceof Node && card.contains(event.target))) return;
      setExpanded(false);
    };
    document.addEventListener('pointerdown', press, true);
    return () => document.removeEventListener('pointerdown', press, true);
  }, [expanded]);
  /** A Block's name: typed over while it's being renamed, else what a double click renames. */
  const named = (shown: SessionBlock) => {
    const label = title(shown);
    const rename = props.rename?.(shown);
    if (rename && renaming === shown.id) {
      return <NameInput label='Block name' name={label} maxLength={200} className='w-44' onKeep={rename} onDone={() => setRenaming(undefined)} />;
    }
    return <span className='truncate' onDoubleClick={() => { if (rename) setRenaming(shown.id); }}>{label}</span>;
  };
  const icon = among ? undefined : 'rounded-full';
  const buttons = (
    <>
      {arrange && !floating && <RailButton label={`Split ${name} right`} hint='Split Right' icon={LayoutTwoColumnIcon} className={icon} onClick={() => actions.split(block.id, 'right')} />}
      {arrange && !floating && <RailButton label={`Split ${name} down`} hint='Split Down' icon={LayoutTwoRowIcon} className={icon} onClick={() => actions.split(block.id, 'down')} />}
      {arrange && !pinned && (
        <RailButton label={floating ? `Dock ${name}` : `Float ${name}`} hint={floating ? 'Dock' : 'Float'}
          icon={floating ? PictureInPictureExitIcon : PictureInPictureOnIcon} className={icon} onClick={() => actions.float(block)} />
      )}
      {arrange && floating && !pinned && <RailButton label={`Minimize ${name}`} hint='Minimize' icon={MinusSignIcon} className={icon} onClick={() => actions.minimize(block, true)} />}
      {arrange && (props.inTab > 1 || zoomed) && (
        <RailButton label={zoomed ? `Unzoom ${name}` : `Zoom ${name}`} hint={zoomed ? 'Unzoom' : 'Zoom'}
          icon={zoomed ? ArrowShrink01Icon : ArrowExpand01Icon} pressed={zoomed} className={icon} onClick={() => actions.zoom(block.id)} />
      )}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger disabled={own.length === 0} render={<Button size='icon-sm' variant='ghost' aria-label={`${name} actions`} title='More' className={icon} />}>
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
      {!pinned && <RailButton label={`Close ${name}`} hint='Close' icon={Cancel01Icon} className={icon} onClick={() => actions.close(block)} />}
    </>
  );

  if (among) {
    return (
      <div data-slot='block-rail' className={cn('flex h-9 shrink-0 items-stretch gap-px pr-1 text-xs', surface(block), handle && 'cursor-grab touch-none')}
        onPointerDown={(event) => {
          if (renaming || pinned) return;
          if (onHandle) onHandle(event);
          else drag?.start(event, block, name);
        }}>
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
        <div className='flex shrink-0 items-center gap-0.5' onPointerDown={(event) => event.stopPropagation()}>
          {buttons}
        </div>
      </div>
    );
  }

  const typeIcon = props.icon?.(block);
  // A press on the rail that isn't on one of its buttons, or the name being typed, drags the Block.
  const grab = (event: ReactPointerEvent) => {
    if (!handle || renaming) return;
    if (event.target instanceof Element && event.target.closest('button, input, [role="menu"]')) return;
    if (onHandle) onHandle(event);
    else drag?.start(event, block, name);
  };
  const pills = (
    <>
      <div data-slot='block-title' title={name}
        className={cn(PILL, 'relative min-w-0 max-w-80 gap-1.5 pr-3 pl-2 text-xs text-foreground', handle && !hovers && 'cursor-grab touch-none')}
        onPointerDown={hovers ? undefined : grab}>
        {typeIcon && <HugeiconsIcon icon={typeIcon} strokeWidth={2} aria-hidden='true' className='size-3.5 shrink-0 text-muted-foreground' />}
        {mark(block)}
        {named(block)}
      </div>
      <div data-slot='block-actions' className={cn(PILL, 'relative shrink-0 gap-px px-0.5')}>
        {buttons}
      </div>
    </>
  );

  if (hovers) {
    // A row of its own atop the Block, empty until the pointer is over the row, one of the pills
    // has the keyboard, the name is typed over or the menu is open. All of it but its buttons is
    // the Block's handle.
    return (
      <div ref={rail} data-slot='block-rail' data-shown={keep || undefined} onPointerDown={grab}
        className={cn(handle && 'cursor-grab touch-none', 'flex h-10 shrink-0 items-center justify-between gap-2 px-1.5 opacity-0 transition-opacity duration-150 hover:opacity-100 has-focus-visible:opacity-100 data-shown:opacity-100 motion-reduce:transition-none')}>
        {pills}
      </div>
    );
  }

  // A touch screen's: a slim strip atop the Block, its row of controls once it's tapped.
  return (
    <div ref={rail} data-slot='block-rail' data-expanded={expanded || undefined}
      className={cn('relative flex shrink-0 items-center justify-between gap-2', expanded ? 'h-9 px-1' : 'h-3')}>
      <button type='button' aria-label={`${name} controls`} aria-expanded={expanded}
        className='absolute inset-0 flex justify-center pt-1 outline-none focus-visible:bg-accent/50'
        onClick={() => setExpanded((shown) => !shown)}>
        {!expanded && <span aria-hidden='true' className='h-1 w-8 rounded-full bg-muted-foreground/40' />}
      </button>
      {expanded && pills}
    </div>
  );
}

/** What fills a Block, under its rail's row, or strip on a touch screen. */
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
      className={cn('group/block relative isolate flex min-h-0 min-w-0 flex-1 flex-col', BLOCK_CARD, surface(block), focused && props.marksFocus && FOCUS_EDGE)}
      onPointerDownCapture={() => { if (!focused) actions.focus(block.id); }}>
      <BlockRail {...props} block={block} drag={drag} />
      <Body key={block.id} block={block} body={props.body} />
    </div>
  );
}

/**
 * The gap between two docked Blocks of a split, 8px, dragged to share their space out again: a
 * line shows in it under the pointer, and while it's dragged. Above the Blocks' shadows, which
 * fill the gap with the background.
 */
function Divider({ row, onDrag, onDone }: { row: boolean; onDrag(position: { x: number; y: number }): void; onDone(): void }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div role='separator' aria-orientation={row ? 'vertical' : 'horizontal'} aria-label='Resize Blocks' data-slot='block-divider'
      className={cn(
        "relative z-10 shrink-0 touch-none after:pointer-events-none after:absolute after:rounded-full after:content-[''] hover:after:bg-border",
        row ? 'w-2 cursor-col-resize after:inset-y-2 after:left-[3px] after:w-0.5' : 'h-2 cursor-row-resize after:inset-x-2 after:top-[3px] after:h-0.5',
        dragging && 'after:bg-primary hover:after:bg-primary',
      )}
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
      {/* A little wider than the gap, so a finger finds it. */}
      <span aria-hidden='true' className={cn('absolute z-10', row ? '-inset-x-0.5 inset-y-0' : 'inset-x-0 -inset-y-0.5')} />
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
    const handle = event.currentTarget;
    const moved = (next: PointerEvent) => {
      if (!latest) keepPointer(handle, next.pointerId);
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
        'group/block absolute z-10 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border shadow-xl',
        surface(block),
        focused && props.marksFocus && FOCUS_EDGE,
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
  const drag = useBlockDrag(props.actions.move, props.allows);
  const zoomed = props.zoomedId ? tabBlocks(tab).find(({ id }) => id === props.zoomedId) : undefined;
  const floating = tab.floating ?? [];
  return (
    // Inset from the window's edges, so the Blocks' rounded corners show.
    <div ref={body} data-slot='session-tab' role='tabpanel' className='relative flex min-h-0 min-w-0 flex-1 p-1 pt-0'>
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
