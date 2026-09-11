import { useState } from 'react';

export type AgentDockPosition = 'left' | 'right';
export const agentDockStorageKey = 'weave.alpha.agent-dock.v1';

export function useAgentDockPosition() {
  const [position, setPosition] = useState<AgentDockPosition>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(agentDockStorageKey) ?? 'null');
      if (stored?.schemaVersion === 1 && stored.position === 'left') return 'left';
    } catch { /* Use the default when device storage is unavailable. */ }
    return 'right';
  });
  const remember = (next: AgentDockPosition) => {
    setPosition(next);
    try { localStorage.setItem(agentDockStorageKey, JSON.stringify({ schemaVersion: 1, position: next })); }
    catch { /* Docking still works without persistence. */ }
  };
  return [position, remember] as const;
}
