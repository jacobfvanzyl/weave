const storageKeyPrefix = 'weave-chat-composer-draft:';
const pendingServerAckDrafts = new Map<string, string>();

const getStorage = (): Storage | undefined => {
  if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
    return globalThis.localStorage as Storage | undefined;
  }
  return undefined;
};

const getStorageKey = (threadId: string) => `${storageKeyPrefix}${threadId}`;

export const loadComposerDraft = (threadId: string) => {
  if (!threadId) return '';
  try {
    return getStorage()?.getItem(getStorageKey(threadId)) ?? '';
  } catch {
    return '';
  }
};

export const saveComposerDraft = (threadId: string, text: string) => {
  if (!threadId) return;
  const storage = getStorage();
  if (!storage) return;

  try {
    if (text.length > 0) {
      storage.setItem(getStorageKey(threadId), text);
    } else {
      if (pendingServerAckDrafts.has(threadId)) return;
      storage.removeItem(getStorageKey(threadId));
    }
  } catch {
    // Ignore quota/security failures; composer drafts are best-effort.
  }
};

export const markComposerDraftAwaitingServerAck = (threadId: string, text: string) => {
  if (!threadId || text.length === 0) return;
  pendingServerAckDrafts.set(threadId, text);
  saveComposerDraft(threadId, text);
};

export const abandonComposerDraftServerAck = (threadId: string) => {
  if (!threadId) return;
  pendingServerAckDrafts.delete(threadId);
};

export const confirmComposerDraftReceived = (threadId: string) => {
  if (!threadId) return;
  const pendingText = pendingServerAckDrafts.get(threadId);
  pendingServerAckDrafts.delete(threadId);
  if (pendingText === undefined) return;
  if (loadComposerDraft(threadId) !== pendingText) return;
  clearComposerDraft(threadId);
};

export const clearComposerDraft = (threadId: string) => {
  if (!threadId) return;
  pendingServerAckDrafts.delete(threadId);
  try {
    getStorage()?.removeItem(getStorageKey(threadId));
  } catch {
    // Ignore quota/security failures; composer drafts are best-effort.
  }
};
