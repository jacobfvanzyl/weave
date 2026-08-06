import { describe, expect, it, vi } from 'vitest';
import {
  reconcileStoppedThreadMessageSnapshot,
  shouldApplyPersistedMessageSnapshot,
} from '../../packages/client/src/components/chat/persisted-message-reconciliation';

describe('persisted chat message reconciliation', () => {
  it('rejects a transient persisted snapshot that is shorter than the live thread', () => {
    expect(shouldApplyPersistedMessageSnapshot(
      [{ id: 'user-1' }, { id: 'assistant-1' }],
      [{ id: 'user-1' }],
    )).toBe(false);
  });

  it('allows complete snapshots to update or extend the live thread', () => {
    expect(shouldApplyPersistedMessageSnapshot(
      [{ id: 'user-1' }, { id: 'assistant-1' }],
      [{ id: 'user-1' }, { id: 'assistant-1' }],
    )).toBe(true);
    expect(shouldApplyPersistedMessageSnapshot(
      [{ id: 'user-1' }, { id: 'assistant-1' }],
      [{ id: 'user-1' }, { id: 'assistant-1' }, { id: 'user-2' }],
    )).toBe(true);
  });

  it('waits for the completed persisted assistant response after Stop', async () => {
    const live = [
      { id: 'user-live', role: 'user' },
      { id: 'assistant-live', role: 'assistant', status: { type: 'running' } },
    ];
    const snapshots = [
      [{ id: 'user-live', role: 'user' }],
      [
        { id: 'user-live', role: 'user' },
        { id: 'assistant-persisted', role: 'assistant', status: { type: 'complete' } },
      ],
    ];
    const loadMessages = vi.fn(async () => snapshots.shift() ?? []);

    const publishMessages = vi.fn();
    await expect(reconcileStoppedThreadMessageSnapshot({
      liveMessages: live,
      loadMessages,
      publishMessages,
      retryDelaysMs: [0, 0],
    })).resolves.toBe(true);
    expect(publishMessages).toHaveBeenCalledWith([
      { id: 'user-live', role: 'user' },
      { id: 'assistant-persisted', role: 'assistant', status: { type: 'complete' } },
    ]);
    expect(loadMessages).toHaveBeenCalledTimes(2);
  });
});
