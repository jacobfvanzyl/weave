import { useEffect } from 'react';
import { nativeSoftwareKeyboard, nativeTerminalBridge } from '@/terminal/native-terminal';

// Native traffic lights overlay whichever rail occupies the window's top-left.
// Observe rendered position so docking, splits, sidebar visibility and zoom all
// use the same rule without teaching each pane about macOS window chrome.
export function useDesktopTitlebar(reserveSidebarToggle = false) {
  useEffect(() => {
    const setHeight = window.weaveDesktop?.setTopRailHeight;
    const overlay = (navigator as Navigator & { windowControlsOverlay?: EventTarget & { visible: boolean; getTitlebarAreaRect(): DOMRect } }).windowControlsOverlay;
    const selector = '[data-slot="global-top-rail"], [data-slot="sidebar-header"], [data-slot="thread-top-rail"], [data-slot="terminal-top-rail"]';
    const paneSelector = '[data-slot="terminal-focus-border"], [data-slot="thread-pane"]';
    const observed = new Set<HTMLElement>();
    let frame: number | undefined, previousMetrics = '', disposed = false, geometryRevision = 0;
    const measure = () => {
      frame = undefined;
      if (disposed) return;
      const rails = [...document.querySelectorAll<HTMLElement>(selector)];
      const visible = rails.map((rail) => rail.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0);
      const topEdge = Math.min(...visible.map((rect) => rect.top));
      const controlsWidth = overlay?.visible ? overlay.getTitlebarAreaRect().x : 0;
      document.documentElement.style.setProperty('--alpha-window-controls-width', `${controlsWidth}px`);
      const panes = [...document.querySelectorAll<HTMLElement>(paneSelector)];
      const elements = [...rails, ...panes];
      for (const pane of panes) {
        const rect = pane.getBoundingClientRect();
        pane.toggleAttribute('data-window-bottom-right', rect.width > 0 && rect.height > 0 && !pane.closest('[hidden], [inert], [aria-hidden="true"]') && Math.abs(rect.right - innerWidth) < 1.5 && Math.abs(rect.bottom - innerHeight) < 1.5);
      }
      for (const element of elements) if (!observed.has(element)) { observed.add(element); resize.observe(element); }
      if (nativeSoftwareKeyboard) {
        const revision = ++geometryRevision;
        void nativeTerminalBridge.windowGeometry?.().then(({ bottomRightRadius, width }) => {
          if (!disposed && revision === geometryRevision && width > 0 && Number.isFinite(bottomRightRadius)) {
            document.documentElement.style.setProperty('--alpha-window-corner-radius', `${bottomRightRadius * innerWidth / width}px`);
            window.dispatchEvent(new Event('alpha-window-corner-change'));
          }
        }).catch(() => {});
      }
      for (const old of observed) if (!elements.includes(old)) { resize.unobserve(old); observed.delete(old); }
      for (const rail of rails) {
        if (!observed.has(rail)) { observed.add(rail); resize.observe(rail); }
        const rect = rail.getBoundingClientRect();
        const top = rect.height > 0 && rect.width > 0 && Math.abs(rect.top - topEdge) < 1;
        rail.toggleAttribute('data-window-top-rail', top);
        rail.toggleAttribute('data-window-controls-leading', top && Math.abs(rect.left) < 1 && overlay?.visible === true);
        rail.toggleAttribute('data-shell-controls-leading', top && Math.abs(rect.left) < 1 && reserveSidebarToggle && !rail.querySelector('[data-slot="sidebar-toggle"]'));
      }
      const top = rails.find((rail) => rail.hasAttribute('data-window-top-rail'));
      if (!top || !setHeight) return;
      const height = top.getBoundingClientRect().height;
      const overlayHeight = overlay?.getTitlebarAreaRect().height ?? 0;
      const metrics = JSON.stringify([height, window.devicePixelRatio, overlayHeight]);
      if (metrics !== previousMetrics) {
        previousMetrics = metrics;
        void setHeight(height, overlayHeight).then((radius) => {
          if (!disposed && previousMetrics === metrics && Number.isFinite(radius)) {
            document.documentElement.style.setProperty('--alpha-window-corner-radius', `${radius}px`);
            window.dispatchEvent(new Event('alpha-window-corner-change'));
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
      document.documentElement.style.removeProperty('--alpha-window-controls-width');
      for (const rail of observed) { rail.removeAttribute('data-window-top-rail'); rail.removeAttribute('data-window-controls-leading'); rail.removeAttribute('data-shell-controls-leading'); rail.removeAttribute('data-window-bottom-right'); }
    };
  }, [reserveSidebarToggle]);
}
