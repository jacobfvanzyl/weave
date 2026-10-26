import { createContext, useContext, useEffect, useMemo, useState, type ComponentProps, type CSSProperties } from 'react';
import { clampSidebarWidth, SIDEBAR_WIDTH, storedSidebarWidth, storeSidebarWidth, widestSidebar } from '@/app/sidebar-width';
import { ResizeHandle } from '@/components/resize-handle';
import { SidebarProvider, useSidebar } from '@/components/ui/sidebar';

type SidebarWidth = {
  width: number;
  resizing: boolean;
  resize(width: number): void;
  setResizing(resizing: boolean): void;
};

const SidebarWidthContext = createContext<SidebarWidth | null>(null);

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
  return (
    <ResizeHandle label='Resize threads' edge='right' width={width} min={SIDEBAR_WIDTH.min}
      max={widestSidebar(window.innerWidth)} initial={SIDEBAR_WIDTH.initial} resizing={resizing}
      onResizing={setResizing}
      // The sidebar starts at the window's left edge, so its width is where the pointer is.
      onPointer={resize} onResize={resize}
      className='group-data-[collapsible=offcanvas]:hidden' />
  );
}
