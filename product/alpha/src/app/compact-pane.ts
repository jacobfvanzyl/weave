import { useCallback, useState } from 'react';
import type { AlphaThread } from './alpha-controller';
import { terminalPaneTargets, type Workspace } from '@weave/product-protocol';

export type CompactPane = { kind: 'terminal'; id: string } | { kind: 'agent'; id: string };
export type CompactPaneMemory = Record<string, CompactPane>;
const storageKey = 'weave.alpha.compact-panes.v1';
export function parseCompactPanes(raw: string | null): CompactPaneMemory {
  try {
    const input = JSON.parse(raw ?? 'null');
    if (input?.schemaVersion !== 1 || !input.panes || typeof input.panes !== 'object' || Array.isArray(input.panes)) return {};
    return Object.fromEntries(Object.entries(input.panes).filter((entry): entry is [string, CompactPane] => {
      const value = entry[1] as CompactPane | null;
      return Boolean(value && (value.kind === 'terminal' || value.kind === 'agent') && typeof value.id === 'string' && value.id.length > 0 && value.id.length < 1000);
    }).slice(0, 256));
  } catch { return {}; }
}
export function resolveCompactPane(saved: CompactPane | undefined, workspace: Workspace, threads: Pick<AlphaThread, 'id'>[]): CompactPane | undefined {
  const terminals = terminalPaneTargets([workspace]);
  if (saved?.kind === 'terminal' && terminals.some(pane => pane.paneId === saved.id)) return saved;
  if (saved?.kind === 'agent' && threads.some(thread => thread.id === saved.id)) return saved;
  if (terminals[0]) return { kind: 'terminal', id: terminals[0].paneId };
  if (threads[0]) return { kind: 'agent', id: threads[0].id };
}
export function useCompactPanes() {
  const [panes, setPanes] = useState(() => { try { return parseCompactPanes(localStorage.getItem(storageKey)); } catch { return {}; } });
  const remember = useCallback((key: string, pane: CompactPane) => setPanes(current => {
    if (current[key]?.kind === pane.kind && current[key]?.id === pane.id) return current;
    const next = { ...current, [key]: pane };
    try { localStorage.setItem(storageKey, JSON.stringify({ schemaVersion: 1, panes: next })); } catch { /* Navigation still works without device storage. */ }
    return next;
  }), []);
  return [panes, remember] as const;
}
