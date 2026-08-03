import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTerminalInputBatcher } from '../../packages/client/src/components/terminal/terminal-input-batcher';

describe('terminal input batcher', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('combines terminal replies emitted during the same event-loop turn', () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const batcher = createTerminalInputBatcher(emit);

    batcher.push('\x1b]10;rgb:d6d6/d6d6/f4f4\x1b\\');
    batcher.push('\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\');
    batcher.push('\x1b[?1;2c');

    expect(emit).not.toHaveBeenCalled();
    vi.runOnlyPendingTimers();

    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(
      '\x1b]10;rgb:d6d6/d6d6/f4f4\x1b\\' +
      '\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\' +
      '\x1b[?1;2c',
    );
  });

  it('preserves input order across batches', () => {
    vi.useFakeTimers();
    const emitted: string[] = [];
    const batcher = createTerminalInputBatcher(data => emitted.push(data));

    batcher.push('a');
    batcher.push('b');
    vi.runOnlyPendingTimers();
    batcher.push('c');
    vi.runOnlyPendingTimers();

    expect(emitted).toEqual(['ab', 'c']);
  });

  it('flushes pending input when disposed', () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const batcher = createTerminalInputBatcher(emit);

    batcher.push('\r');
    batcher.dispose();

    expect(emit).toHaveBeenCalledWith('\r');
    vi.runOnlyPendingTimers();
    expect(emit).toHaveBeenCalledOnce();
  });
});
