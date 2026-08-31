import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { alphaBrowserSession } from './alpha-browser-session';

export function useAlphaBrowserSession(presentationSuspended = false) {
  const session = useMemo(() => alphaBrowserSession(), []);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    session.setVisible(true);
    let frameRequest: number | undefined;
    const obstructingOverlayVisible = () => [...document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], [role="menu"], [data-slot="dropdown-menu-content"], [data-slot="popover-content"], [data-slot="select-content"]',
    )].some((element) => !surface.contains(element) && element.getClientRects().length > 0);
    let overlayBlocked = presentationSuspended || obstructingOverlayVisible();
    const cancelPresent = () => {
      if (frameRequest === undefined) return;
      window.cancelAnimationFrame(frameRequest);
      frameRequest = undefined;
    };
    const present = () => {
      if (presentationSuspended || obstructingOverlayVisible()) {
        if (!overlayBlocked) session.send({ type: 'hide' });
        overlayBlocked = true;
        cancelPresent();
        return;
      }
      if (overlayBlocked || frameRequest !== undefined) return;
      frameRequest = window.requestAnimationFrame(() => {
        frameRequest = undefined;
        if (presentationSuspended || obstructingOverlayVisible()) {
          overlayBlocked = true;
          session.send({ type: 'hide' });
          return;
        }
        if (overlayBlocked) return;
        const { x, y, width, height } = surface.getBoundingClientRect();
        session.send({ type: 'present', frame: { x, y, width, height } });
      });
    };
    const syncOverlay = () => {
      const blocked = presentationSuspended || obstructingOverlayVisible();
      if (blocked === overlayBlocked) return;
      overlayBlocked = blocked;
      if (blocked) {
        cancelPresent();
        session.send({ type: 'hide' });
      } else present();
    };
    const observer = new ResizeObserver(present);
    const overlayObserver = new MutationObserver(syncOverlay);
    observer.observe(surface);
    overlayObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'data-open', 'hidden', 'style'],
      childList: true,
      subtree: true,
    });
    window.addEventListener('resize', present);
    window.addEventListener('scroll', present, true);
    if (overlayBlocked) session.send({ type: 'hide' });
    else present();
    const visibilityChanged = () => {
      if (document.hidden) {
        session.send({ type: 'hide' });
        session.setVisible(false);
      } else {
        session.setVisible(true);
        if (overlayBlocked) session.send({ type: 'hide' });
        else present();
      }
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      observer.disconnect();
      overlayObserver.disconnect();
      window.removeEventListener('resize', present);
      window.removeEventListener('scroll', present, true);
      document.removeEventListener('visibilitychange', visibilityChanged);
      cancelPresent();
      session.send({ type: 'hide' });
      session.setVisible(false);
    };
  }, [presentationSuspended, session]);

  return {
    state,
    surfaceRef,
    send: session.send,
    setAgentControlEnabled: session.setAgentControlEnabled,
    setAgentAccess: session.setAgentAccess,
  };
}
