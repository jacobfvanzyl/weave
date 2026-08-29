import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { createAlphaBrowserSession } from './alpha-browser-session';

export function useAlphaBrowserSession() {
  const session = useMemo(() => createAlphaBrowserSession(), []);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
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
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', present);
      window.removeEventListener('scroll', present, true);
      if (frameRequest !== undefined) window.cancelAnimationFrame(frameRequest);
      session.send({ type: 'hide' });
    };
  }, [session]);

  return {
    state,
    surfaceRef,
    send: session.send,
  };
}
