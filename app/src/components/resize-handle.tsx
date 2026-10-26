import { cn } from '@/lib/utils';

/** Arrow keys move an edge by this much. */
const KEY_STEP = 16;

/**
 * A pane's edge, with a grip: dragging it, or the arrow keys, make the pane wider or narrower, and
 * a double-click puts its initial width back. `edge` is the side of the pane it's on.
 */
export function ResizeHandle({ label, edge, width, min, max, initial, resizing, onResizing, onPointer, onResize, className }: {
  label: string;
  edge: 'left' | 'right';
  width: number;
  min: number;
  max: number;
  initial: number;
  resizing: boolean;
  onResizing(resizing: boolean): void;
  /** Where the pointer is across the window, while it drags the edge. */
  onPointer(clientX: number): void;
  /** A width the arrow keys or a double-click ask for. */
  onResize(width: number): void;
  className?: string;
}) {
  const end = () => onResizing(false);
  return (
    <div role='separator' aria-orientation='vertical' aria-label={label} tabIndex={0}
      aria-valuemin={min} aria-valuemax={max} aria-valuenow={width}
      data-slot='resize-handle' data-resizing={resizing || undefined}
      className={cn(
        'group/resize absolute inset-y-0 z-20 cursor-col-resize touch-none select-none outline-none',
        'after:absolute after:inset-y-0 after:w-0.5 after:transition-colors',
        'hover:after:bg-muted-foreground/50 focus-visible:after:bg-ring data-resizing:after:bg-ring',
        edge === 'right'
          ? 'right-0 w-4 translate-x-1/2 after:left-1/2 after:-translate-x-1/2'
          // On a pane's left edge, all of it is outside the pane: a native terminal beneath the
          // pane takes the touches over it.
          : 'left-0 w-3 -translate-x-full after:right-0 after:translate-x-1/2',
        className,
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        onResizing(true);
      }}
      onPointerMove={(event) => { if (resizing) onPointer(event.clientX); }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => onResize(initial)}
      onKeyDown={(event) => {
        const toward = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
        if (!toward) return;
        event.preventDefault();
        // The edge moves with the arrow; a pane whose left edge it is grows as it moves left.
        onResize(width + toward * (edge === 'right' ? KEY_STEP : -KEY_STEP));
      }}>
      <span aria-hidden className={cn(
        'absolute top-1/2 z-10 h-10 w-1.5 -translate-y-1/2 rounded-full bg-muted-foreground/40 transition-colors',
        'group-hover/resize:bg-muted-foreground group-focus-visible/resize:bg-ring group-data-resizing/resize:bg-ring',
        edge === 'right' ? 'left-1/2 -translate-x-1/2' : 'right-0 translate-x-1/2',
      )} />
    </div>
  );
}
