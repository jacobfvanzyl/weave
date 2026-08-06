type ReconciliationMessage = {
  id?: string;
  role?: string;
  status?: { type?: string };
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
  liveMessages: readonly ReconciliationMessage[],
  persistedMessages: readonly ReconciliationMessage[],
) => persistedMessages.length >= liveMessages.length;

const hasCompletedAssistantAfterLatestUser = (messages: readonly ReconciliationMessage[]) => {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'user') continue;
    latestUserIndex = index;
    break;
  }
  return messages.some((message, index) =>
    index > latestUserIndex && message.role === 'assistant' && message.status?.type === 'complete'
  );
};

const waitForDelay = (delayMs: number) =>
  delayMs > 0 ? new Promise<void>((resolve) => window.setTimeout(resolve, delayMs)) : Promise.resolve();

/**
 * A Stop response can arrive before the server has exposed the run's final
 * persisted messages. Read through that bounded persistence gap instead of
 * replacing the live list with an incomplete snapshot.
 */
const waitForStoppedThreadMessageSnapshot = async <T extends ReconciliationMessage>({
  liveMessages,
  loadMessages,
  retryDelaysMs = [0, 50, 150, 300, 600, 1_000, 1_500],
  wait = waitForDelay,
}: {
  liveMessages: readonly ReconciliationMessage[];
  loadMessages: () => Promise<T[]>;
  retryDelaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
}): Promise<T[] | undefined> => {
  let latestApplicableSnapshot: T[] | undefined;

  for (const delayMs of retryDelaysMs) {
    await wait(delayMs);
    const persistedMessages = await loadMessages();
    if (!shouldApplyPersistedMessageSnapshot(liveMessages, persistedMessages)) continue;

    latestApplicableSnapshot = persistedMessages;
    if (hasCompletedAssistantAfterLatestUser(persistedMessages)) return persistedMessages;
  }

  return latestApplicableSnapshot;
};

export const reconcileStoppedThreadMessageSnapshot = async <T extends ReconciliationMessage>({
  publishMessages,
  ...options
}: {
  liveMessages: readonly ReconciliationMessage[];
  loadMessages: () => Promise<T[]>;
  publishMessages: (messages: T[]) => void;
  retryDelaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
}) => {
  const persistedMessages = await waitForStoppedThreadMessageSnapshot(options);
  if (!persistedMessages) return false;
  publishMessages(persistedMessages);
  return true;
};
