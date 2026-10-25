const STORAGE_KEY = 'weave.sidebarWidth';

/** The session list's width beside a session, in CSS pixels: shadcn's 16rem until it's dragged. */
export const SIDEBAR_WIDTH = { initial: 256, min: 224, max: 480 } as const;

/** The widest the list goes in a window `windowWidth` wide: half of it, up to `SIDEBAR_WIDTH.max`. */
export const widestSidebar = (windowWidth: number) =>
  Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, Math.floor(windowWidth / 2)));

/** `width`, in whole pixels, within what the list takes in a window `windowWidth` wide. */
export const clampSidebarWidth = (width: number, windowWidth: number) =>
  Math.round(Math.min(Math.max(width, SIDEBAR_WIDTH.min), widestSidebar(windowWidth)));

/** The width this device kept, in the web view's storage, or the initial one. */
export function storedSidebarWidth(): number {
  try {
    const stored = Number(globalThis.localStorage?.getItem(STORAGE_KEY));
    return stored >= SIDEBAR_WIDTH.min && stored <= SIDEBAR_WIDTH.max ? stored : SIDEBAR_WIDTH.initial;
  } catch {
    return SIDEBAR_WIDTH.initial;
  }
}

export function storeSidebarWidth(width: number) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, String(width));
  } catch {
    // Full or unavailable: the width lasts until the app quits.
  }
}
