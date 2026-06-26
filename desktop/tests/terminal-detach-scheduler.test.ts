import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelScheduledTerminalDetach,
  clearScheduledTerminalDetaches,
  scheduleTerminalDetach,
  terminalDetachGraceMs,
} from '../../packages/client/src/components/terminal/terminal-detach-scheduler';
import type { TerminalTransport } from '../../packages/client/src/lib/terminal-types';

const createTransport = () => {
  const detach = vi.fn(() => Promise.resolve());
  return {
    detach,
    transport: { detach } as unknown as TerminalTransport,
  };
};

describe('terminal detach scheduler', () => {
  afterEach(() => {
    clearScheduledTerminalDetaches();
    vi.useRealTimers();
  });

  it('cancels a pending detach when the same terminal remounts during pane handoff', () => {
    vi.useFakeTimers();
    const { detach, transport } = createTransport();

    scheduleTerminalDetach(transport, 'terminal-1');
    cancelScheduledTerminalDetach('terminal-1');
    vi.advanceTimersByTime(terminalDetachGraceMs + 1);

    expect(detach).toHaveBeenCalledTimes(0);
  });

  it('detaches after the grace period when nothing remounts', () => {
    vi.useFakeTimers();
    const { detach, transport } = createTransport();

    scheduleTerminalDetach(transport, 'terminal-1');
    vi.advanceTimersByTime(terminalDetachGraceMs + 1);

    expect(detach).toHaveBeenCalledWith('terminal-1');
  });

  it('keeps only the latest pending detach per terminal id', () => {
    vi.useFakeTimers();
    const first = createTransport();
    const second = createTransport();

    scheduleTerminalDetach(first.transport, 'terminal-1');
    scheduleTerminalDetach(second.transport, 'terminal-1');
    vi.advanceTimersByTime(terminalDetachGraceMs + 1);

    expect(first.detach).toHaveBeenCalledTimes(0);
    expect(second.detach).toHaveBeenCalledWith('terminal-1');
  });
});
