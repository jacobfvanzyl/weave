import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { alphaBrowserSession } from './alpha-browser-session';

export function useAlphaBrowserSession(
  controlTarget?: { threadId: string; title: string; controller: string },
) {
  const session = useMemo(() => alphaBrowserSession(), []);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );

  useLayoutEffect(() => {
    session.setControlTarget(controlTarget);
  }, [controlTarget?.controller, controlTarget?.threadId, controlTarget?.title, session]);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    session.setVisible(true);
    let frameRequest: number | undefined;
    const present = () => {
      if (frameRequest !== undefined) return;
      frameRequest = window.requestAnimationFrame(() => {
        frameRequest = undefined;
        const { x, y, width, height } = surface.getBoundingClientRect();
        session.send({ type: 'present', frame: { x, y, width, height } });
      });
    };
    const observer = new ResizeObserver(present);
    observer.observe(surface);
    window.addEventListener('resize', present);
    window.addEventListener('scroll', present, true);
    present();
    const visibilityChanged = () => {
      if (document.hidden) {
        session.send({ type: 'hide' });
        session.setVisible(false);
      } else {
        session.setVisible(true);
        present();
      }
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', present);
      window.removeEventListener('scroll', present, true);
      document.removeEventListener('visibilitychange', visibilityChanged);
      if (frameRequest !== undefined) window.cancelAnimationFrame(frameRequest);
      session.send({ type: 'hide' });
      session.setVisible(false);
    };
  }, [session]);

  return {
    state,
    surfaceRef,
    send: session.send,
    setAgentControlEnabled: session.setAgentControlEnabled,
    setAgentAccess: session.setAgentAccess,
  };
}
