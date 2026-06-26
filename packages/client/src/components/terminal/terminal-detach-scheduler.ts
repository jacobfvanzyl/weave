import type { TerminalTransport } from '../../lib/terminal-types';

export const terminalDetachGraceMs = 350;

const pendingTerminalDetachTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const cancelScheduledTerminalDetach = (terminalId: string) => {
  const timer = pendingTerminalDetachTimers.get(terminalId);
  if (timer === undefined) return;
  clearTimeout(timer);
  pendingTerminalDetachTimers.delete(terminalId);
};

export const scheduleTerminalDetach = (transport: TerminalTransport, terminalId: string) => {
  cancelScheduledTerminalDetach(terminalId);
  const timer = setTimeout(() => {
    pendingTerminalDetachTimers.delete(terminalId);
    void transport.detach(terminalId).catch(() => undefined);
  }, terminalDetachGraceMs);
  pendingTerminalDetachTimers.set(terminalId, timer);
};

export const clearScheduledTerminalDetaches = () => {
  for (const timer of pendingTerminalDetachTimers.values()) clearTimeout(timer);
  pendingTerminalDetachTimers.clear();
};
