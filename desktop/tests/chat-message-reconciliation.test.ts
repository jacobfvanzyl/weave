import { describe, expect, it } from 'vitest';
import { shouldApplyPersistedMessageSnapshot } from '../../packages/client/src/components/chat/persisted-message-reconciliation';

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
});
