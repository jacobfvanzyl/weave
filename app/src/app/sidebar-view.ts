// What this device keeps of the sidebar (WVE-231): which of its two views shows below the Bots,
// and which Projects' and Hosts' headings are collapsed. The device's own, in the web view's
// storage, as its width is (`sidebar-width.ts`).
import { useCallback, useState } from 'react';

const STORAGE_KEY = 'weave.sidebarView';

/** Sessions under their Projects and Hosts, or a tab at a time for those with threads. */
export type SidebarViewName = 'sessions' | 'threads';

export type SidebarView = {
  view: SidebarViewName;
  /** The headings collapsed, by `projectGroup` or `hostGroup`. Everything else is open. */
  collapsed: string[];
};

export const projectGroup = (id: string) => `project:${id}`;
export const hostGroup = (id: string) => `host:${id}`;

const initial = (): SidebarView => ({ view: 'sessions', collapsed: [] });

export function loadSidebarView(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): SidebarView {
  try {
    const stored = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null') as Partial<SidebarView> | null;
    if (typeof stored !== 'object' || stored === null) return initial();
    return {
      view: stored.view === 'threads' ? 'threads' : 'sessions',
      collapsed: Array.isArray(stored.collapsed) ? stored.collapsed.filter((group): group is string => typeof group === 'string') : [],
    };
  } catch {
    return initial();
  }
}

export function saveSidebarView(view: SidebarView, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(view));
  } catch {
    // Full or unavailable: it lasts until the app quits.
  }
}

/** `view` with the heading `group` collapsed if it was open, and open if it wasn't. */
export const toggleGroup = (view: SidebarView, group: string): SidebarView => ({
  ...view,
  collapsed: view.collapsed.includes(group) ? view.collapsed.filter((other) => other !== group) : [...view.collapsed, group],
});

/** The sidebar's view on this device, kept as it changes. */
export function useSidebarView() {
  const [view, setView] = useState(loadSidebarView);
  const change = useCallback((next: (current: SidebarView) => SidebarView) => {
    setView((current) => {
      const changed = next(current);
      saveSidebarView(changed);
      return changed;
    });
  }, []);
  return [view, change] as const;
}
