type MessageIdentity = {
  id?: string;
};

/**
 * Persisted chat reads can briefly lag behind the live AI SDK state while a
 * completed assistant message is being stored. Weave does not delete messages
 * through this reconciliation path, so a shorter snapshot is incomplete and
 * must not replace the live list.
 *
 * Besides hiding a completed turn, shrinking the external message list can
 * invalidate assistant-ui's mounted index-based message providers and crash
 * the renderer before their parent list unmounts them.
 */
export const shouldApplyPersistedMessageSnapshot = (
  liveMessages: readonly MessageIdentity[],
  persistedMessages: readonly MessageIdentity[],
) => persistedMessages.length >= liveMessages.length;
