import { useCallback, useEffect, useState } from 'react';
import type { TerminalSummary } from '@/app/app-controller';
import {
  activeTab,
  clampFontSize,
  emptyThread,
  forgetEnded,
  loadTerminalLayout,
  otherTerminals,
  saveTerminalLayout,
  terminalTabs,
  type TerminalLayout,
  type ThreadTerminals,
} from './terminal-layout';

/** A thread's terminals as this device lays them out, kept in the web view's storage. */
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

  const thread = layout.threads[key] ?? emptyThread();
  const list = terminals ?? [];
  const tabs = terminalTabs(thread, list, sessionId);

  // Once the Host has listed them, terminals that ended leave the layout.
  useEffect(() => {
    if (!terminals) return;
    const stored = layout.threads[key];
    if (stored && forgetEnded(stored, terminals) !== stored) change((current) => forgetEnded(current, terminals));
    // Only the list's changes matter here.
  }, [terminals, key]);

  return {
    thread,
    tabs,
    others: otherTerminals(thread, list, sessionId),
    active: activeTab(thread, tabs),
    fontSize: layout.fontSize,
    change,
    setFontSize,
  };
}
