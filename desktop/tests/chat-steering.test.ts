import { describe, expect, it, vi } from 'vitest';
import { sendSteeringMessageToActiveRun } from '../../packages/client/src/lib/chat-steering';

const message = {
  id: 'user-1',
  role: 'user',
  parts: [{ type: 'text', text: 'steer now' }],
} as any;

describe('chat steering delivery', () => {
  it('sends steering messages to the active run path with the expected run id', async () => {
    const sendSteeringMessage = vi.fn(async () => ({
      ok: true,
      accepted: true,
      runId: 'run-1',
      messageId: 'message-1',
    }) as const);

    await expect(sendSteeringMessageToActiveRun('thread-1', message, {
      sendSteeringMessage,
      runId: 'active-run-1',
    })).resolves.toEqual({
      ok: true,
      accepted: true,
      runId: 'run-1',
      messageId: 'message-1',
    });

    expect(sendSteeringMessage).toHaveBeenCalledWith('thread-1', message, { runId: 'active-run-1' });
  });

  it('does not fall back when the active run has already finished', async () => {
    const run = { active: false, status: 'completed' as const };
    const sendSteeringMessage = vi.fn(async () => ({
      ok: false,
      reason: 'not_active',
      run,
    }) as const);

    await expect(sendSteeringMessageToActiveRun('thread-1', message, {
      sendSteeringMessage,
      runId: 'active-run-1',
    })).resolves.toEqual({
      ok: false,
      reason: 'not_active',
      run,
    });

    expect(sendSteeringMessage).toHaveBeenCalledWith('thread-1', message, { runId: 'active-run-1' });
  });

  it('does not fall back when the steering request reaches a stale run', async () => {
    const run = { active: true, status: 'running' as const, runId: 'next-run' };
    const sendSteeringMessage = vi.fn(async () => ({
      ok: false,
      reason: 'stale_run',
      run,
    }) as const);

    await expect(sendSteeringMessageToActiveRun('thread-1', message, {
      sendSteeringMessage,
      runId: 'old-run',
    })).resolves.toEqual({
      ok: false,
      reason: 'stale_run',
      run,
    });

    expect(sendSteeringMessage).toHaveBeenCalledWith('thread-1', message, { runId: 'old-run' });
  });
});
