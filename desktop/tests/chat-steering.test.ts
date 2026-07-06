import { describe, expect, it, vi } from 'vitest';
import { sendSteeringMessageOrFallback } from '../../packages/client/src/lib/chat-steering';

const message = {
  id: 'user-1',
  role: 'user',
  parts: [{ type: 'text', text: 'steer now' }],
} as any;

describe('chat steering delivery', () => {
  it('sends steering messages to the active run path without fallback', async () => {
    const sendSteeringMessage = vi.fn(async () => ({
      ok: true,
      accepted: true,
      runId: 'run-1',
      messageId: 'message-1',
    }) as const);
    const sendFallbackMessage = vi.fn();

    await expect(sendSteeringMessageOrFallback('thread-1', message, {
      sendSteeringMessage,
      sendFallbackMessage,
    })).resolves.toEqual({
      ok: true,
      accepted: true,
      runId: 'run-1',
      messageId: 'message-1',
    });

    expect(sendSteeringMessage).toHaveBeenCalledWith('thread-1', message);
    expect(sendFallbackMessage).toHaveBeenCalledTimes(0);
  });

  it('falls back to a normal send when the active run has already finished', async () => {
    const run = { active: false, status: 'completed' as const };
    const sendSteeringMessage = vi.fn(async () => ({
      ok: false,
      reason: 'not_active',
      run,
    }) as const);
    const sendFallbackMessage = vi.fn();

    await expect(sendSteeringMessageOrFallback('thread-1', message, {
      sendSteeringMessage,
      sendFallbackMessage,
    })).resolves.toEqual({
      ok: false,
      reason: 'not_active',
      run,
    });

    expect(sendSteeringMessage).toHaveBeenCalledWith('thread-1', message);
    expect(sendFallbackMessage).toHaveBeenCalledTimes(1);
  });
});
