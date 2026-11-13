// A software keyboard over the page (WVE-221). The iPad's and iPhone's web view keeps its size
// when the keyboard comes up, and only what's visible of it shrinks, so the page follows that:
// while a keyboard covers part of it, `--app-height` on the root is the height left above it, which
// the shell and its dialogs lay out in (`src/styles.css`), and `data-keyboard` is set. The web
// view also scrolls the page to bring a field into sight, which a page that already fits undoes.
// A browser on a touch screen gets the same; where there's no touch, nothing is watched.
import { useSyncExternalStore } from 'react';

/** How much of the page a keyboard covers, in points, before it counts as one: a toolbar is less. */
const COVERS = 120;

let shown = false;
const listeners = new Set<() => void>();

function measure() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const root = document.documentElement;
  const covered = window.innerHeight - viewport.height;
  const now = covered > COVERS;
  if (now) {
    root.style.setProperty('--app-height', `${Math.round(viewport.height)}px`);
    root.dataset.keyboard = '';
    if (viewport.offsetTop > 0 || window.scrollY > 0) window.scrollTo(0, 0);
  } else {
    root.style.removeProperty('--app-height');
    delete root.dataset.keyboard;
  }
  if (now === shown) return;
  shown = now;
  for (const listener of listeners) listener();
}

/** Starts following a software keyboard, where there may be one. Returns what stops it. */
export function watchSoftKeyboard(): () => void {
  const viewport = window.visualViewport;
  if (!viewport || !(navigator.maxTouchPoints > 0)) return () => {};
  viewport.addEventListener('resize', measure);
  viewport.addEventListener('scroll', measure);
  measure();
  return () => {
    viewport.removeEventListener('resize', measure);
    viewport.removeEventListener('scroll', measure);
  };
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** Whether this device types on a software keyboard: a touch screen with no mouse to point with. */
export const softKeyboard = () => navigator.maxTouchPoints > 0 && !window.matchMedia?.('(hover: hover)').matches;

/** Whether a software keyboard is up. */
export const useSoftKeyboard = () => useSyncExternalStore(subscribe, () => shown, () => false);
