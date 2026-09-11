import { useEffect } from 'react';

// Native traffic lights overlay whichever rail occupies the window's top-left.
// Observe rendered position so docking, splits, sidebar visibility and zoom all
// use the same rule without teaching each pane about macOS window chrome.
export function useDesktopTitlebar() {
  useEffect(() => {
    const setHeight = window.weaveDesktop?.setTopRailHeight;
    if (!setHeight) return;
    const overlay = (navigator as Navigator & { windowControlsOverlay?: EventTarget & { visible: boolean; getTitlebarAreaRect(): DOMRect } }).windowControlsOverlay;
    const selector = '[data-slot="sidebar-header"], [data-slot="thread-top-rail"], [data-slot="terminal-top-rail"]';
    const observed = new Set<HTMLElement>();
    let frame: number | undefined, previousMetrics = '', disposed = false;
    const measure = () => {
      frame = undefined;
      if (disposed) return;
      const rails = [...document.querySelectorAll<HTMLElement>(selector)];
      for (const old of observed) if (!rails.includes(old)) { resize.unobserve(old); observed.delete(old); }
      for (const rail of rails) {
        if (!observed.has(rail)) { observed.add(rail); resize.observe(rail); }
        const rect = rail.getBoundingClientRect();
        const top = rect.height > 0 && rect.width > 0 && Math.abs(rect.top) < 1;
        rail.toggleAttribute('data-window-top-rail', top);
        rail.toggleAttribute('data-window-controls-leading', top && Math.abs(rect.left) < 1 && overlay?.visible === true);
      }
      const top = rails.find((rail) => rail.hasAttribute('data-window-top-rail'));
      if (!top) return;
      const height = top.getBoundingClientRect().height;
      const overlayHeight = overlay?.getTitlebarAreaRect().height ?? 0;
      const metrics = JSON.stringify([height, window.devicePixelRatio, overlayHeight]);
      if (metrics !== previousMetrics) {
        previousMetrics = metrics;
        void setHeight(height, overlayHeight).then((radius) => {
          if (!disposed && previousMetrics === metrics && Number.isFinite(radius)) {
            document.documentElement.style.setProperty('--alpha-window-corner-radius', `${radius}px`);
          }
        }).catch(() => { previousMetrics = ''; });
      }
    };
    const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule);
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'hidden'] });
    window.addEventListener('resize', schedule);
    overlay?.addEventListener('geometrychange', schedule);
    schedule();
    return () => {
      disposed = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      resize.disconnect(); mutations.disconnect();
      window.removeEventListener('resize', schedule);
      overlay?.removeEventListener('geometrychange', schedule);
      document.documentElement.style.removeProperty('--alpha-window-corner-radius');
      for (const rail of observed) { rail.removeAttribute('data-window-top-rail'); rail.removeAttribute('data-window-controls-leading'); }
    };
  }, []);
}
