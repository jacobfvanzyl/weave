import { useCallback, useState } from 'react';
import type { TerminalSummary } from '@/app/app-controller';
import {
  activeTab,
  clampFontSize,
  emptyThread,
  loadTerminalLayout,
  saveTerminalLayout,
  terminalTabs,
  type TerminalLayout,
  type ThreadTerminals,
} from './terminal-layout';

/** A thread's terminals, as tabs, and how this device lays them out, kept in the web view's storage. */
export function useThreadTerminals(key: string, sessionId: string, terminals: TerminalSummary[] | undefined) {
  const [layout, setLayout] = useState<TerminalLayout>(loadTerminalLayout);
  const store = useCallback((change: (layout: TerminalLayout) => TerminalLayout) => setLayout((current) => {
    const next = change(current);
    saveTerminalLayout(next);
    return next;
  }), []);
  const change = useCallback((next: (thread: ThreadTerminals) => ThreadTerminals) => store((current) => ({
    ...current,
    threads: { ...current.threads, [key]: { ...next(current.threads[key] ?? emptyThread()), usedAt: Date.now() } },
  })), [key, store]);
  const setFontSize = useCallback((size: number) => store((current) => ({ ...current, fontSize: clampFontSize(size) })), [store]);
  /** The pane's width, kept once `keep` says a drag ended rather than at every step of it. */
  const setWidth = useCallback((width: number, keep = true) =>
    (keep ? store : setLayout)((current) => ({ ...current, width })), [store]);

  const thread = layout.threads[key] ?? emptyThread();
  const tabs = terminalTabs(terminals ?? []);
  return { thread, tabs, active: activeTab(thread, tabs, sessionId), fontSize: layout.fontSize, width: layout.width, change, setFontSize, setWidth };
}
