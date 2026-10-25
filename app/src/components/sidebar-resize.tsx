import { createContext, useContext, useEffect, useMemo, useState, type ComponentProps, type CSSProperties } from 'react';
import { clampSidebarWidth, SIDEBAR_WIDTH, storedSidebarWidth, storeSidebarWidth, widestSidebar } from '@/app/sidebar-width';
import { SidebarProvider, useSidebar } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

type SidebarWidth = {
  width: number;
  resizing: boolean;
  resize(width: number): void;
  setResizing(resizing: boolean): void;
};

const SidebarWidthContext = createContext<SidebarWidth | null>(null);

/** Arrow keys move the sidebar's edge by this much. */
const KEY_STEP = 16;

/**
 * `SidebarProvider`, with the sidebar as wide as the person dragged it (`SidebarResizeHandle`),
 * which this device keeps. A drag changes only the sidebar's width: what's in it, and the session
 * beside it, don't render again.
 */
export function ResizableSidebarProvider({ style, children, ...props }: ComponentProps<typeof SidebarProvider>) {
  const [width, setWidth] = useState(storedSidebarWidth);
  const [resizing, setResizing] = useState(false);
  // Kept once a drag ends, not at every step of it.
  useEffect(() => {
    if (!resizing) storeSidebarWidth(width);
  }, [width, resizing]);
  const value = useMemo<SidebarWidth>(() => ({
    width,
    resizing,
    resize: (next) => setWidth(clampSidebarWidth(next, window.innerWidth)),
    setResizing,
  }), [width, resizing]);
  return (
    <SidebarWidthContext.Provider value={value}>
      {/* A window narrowed since keeps the list to half of it, as `widestSidebar` does. */}
      <SidebarProvider {...props} data-resizing={resizing || undefined}
        style={{ ...style, '--sidebar-width': `max(${SIDEBAR_WIDTH.min}px, min(${width}px, 50vw))` } as CSSProperties}>
        {children}
      </SidebarProvider>
    </SidebarWidthContext.Provider>
  );
}

/**
 * The sidebar's right edge, with a grip: dragging it, or the arrow keys, make the list wider or
 * narrower, and a double-click puts the initial width back. Not in the sheet a narrow window shows
 * the sidebar in.
 */
export function SidebarResizeHandle() {
  const context = useContext(SidebarWidthContext);
  const { isMobile } = useSidebar();
  if (!context || isMobile) return null;
  const { width, resizing, resize, setResizing } = context;
  const end = () => setResizing(false);
  return (
    <div role='separator' aria-orientation='vertical' aria-label='Resize threads' tabIndex={0}
      aria-valuemin={SIDEBAR_WIDTH.min} aria-valuemax={widestSidebar(window.innerWidth)} aria-valuenow={width}
      data-slot='sidebar-resize-handle' data-resizing={resizing || undefined}
      className={cn(
        'group/resize absolute inset-y-0 right-0 z-20 w-4 translate-x-1/2 cursor-col-resize touch-none select-none outline-none',
        'group-data-[collapsible=offcanvas]:hidden',
        'after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:transition-colors',
        'hover:after:bg-muted-foreground/50 focus-visible:after:bg-ring data-resizing:after:bg-ring',
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setResizing(true);
      }}
      // The sidebar starts at the window's left edge, so its width is where the pointer is.
      onPointerMove={(event) => { if (resizing) resize(event.clientX); }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => resize(SIDEBAR_WIDTH.initial)}
      onKeyDown={(event) => {
        const step = event.key === 'ArrowLeft' ? -KEY_STEP : event.key === 'ArrowRight' ? KEY_STEP : 0;
        if (!step) return;
        event.preventDefault();
        resize(width + step);
      }}>
      <span aria-hidden className={cn(
        'absolute top-1/2 left-1/2 z-10 h-10 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground/40 transition-colors',
        'group-hover/resize:bg-muted-foreground group-focus-visible/resize:bg-ring group-data-resizing/resize:bg-ring',
      )} />
    </div>
  );
}
