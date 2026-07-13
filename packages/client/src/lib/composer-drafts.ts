import {
  claimLegacyClientSessionValue,
  getActiveClientSessionIdentity,
  getClientSessionScopeKey,
} from './client-session';
import { useClientSessionViewStore } from '../stores/client-session-view-store';const storageKeyPrefix = 'weave-chat-composer-draft:';
const pendingServerAckDrafts = new Map<string, string>();

const getStorage = (): Storage | undefined => {
  if (typeof window !== 'undefined' && window.localStorage) { return window.localStorage;
  }
  if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
    return globalThis.localStorage as Storage | undefined;
  }
  return undefined;
};

const getStorageKey = (threadId: string) => `${storageKeyPrefix}${threadId}`;
const getPendingKey = (threadId: string) => {
  const identity = getActiveClientSessionIdentity();
  return identity ? `${getClientSessionScopeKey(identity)}:${threadId}` : threadId;
};

export const loadComposerDraft = (threadId: string) => {
  if (!threadId) return '';
  if (getActiveClientSessionIdentity()) {
    const sessionDraft = useClientSessionViewStore.getState().composerDrafts[threadId];
    if (sessionDraft) return sessionDraft;
  }
  try {
    const legacyDraft = getActiveClientSessionIdentity()
      ? claimLegacyClientSessionValue(getStorageKey(threadId)) ?? ''
      : getStorage()?.getItem(getStorageKey(threadId)) ?? '';
    if (legacyDraft && getActiveClientSessionIdentity()) {
      useClientSessionViewStore.getState().setComposerDraft(threadId, legacyDraft);
    }
    return legacyDraft;
  } catch {
    return '';
  }
};

export const saveComposerDraft = (threadId: string, text: string) => {
  if (!threadId) return;
  if (getActiveClientSessionIdentity()) {
    if (text.length > 0) {
      useClientSessionViewStore.getState().setComposerDraft(threadId, text);
    } else if (!pendingServerAckDrafts.has(getPendingKey(threadId))) {
      useClientSessionViewStore.getState().clearComposerDraft(threadId);
    }
    return;
  }
  const storage = getStorage();
  if (!storage) return;

  try {
    if (text.length > 0) {
      storage.setItem(getStorageKey(threadId), text);
    } else {
      if (pendingServerAckDrafts.has(getPendingKey(threadId))) return;
      storage.removeItem(getStorageKey(threadId));
    }
  } catch {
    // Ignore quota/security failures; composer drafts are best-effort.
  }
};

export const markComposerDraftAwaitingServerAck = (threadId: string, text: string) => {
  if (!threadId || text.length === 0) return;
  pendingServerAckDrafts.set(getPendingKey(threadId), text);
  saveComposerDraft(threadId, text);
};

export const abandonComposerDraftServerAck = (threadId: string) => {
  if (!threadId) return;
  pendingServerAckDrafts.delete(getPendingKey(threadId));
};

export const confirmComposerDraftReceived = (threadId: string) => {
  if (!threadId) return;
  const pendingKey = getPendingKey(threadId);
  const pendingText = pendingServerAckDrafts.get(pendingKey);
  pendingServerAckDrafts.delete(pendingKey);
  if (pendingText === undefined) return;
  if (loadComposerDraft(threadId) !== pendingText) return;
  clearComposerDraft(threadId);
};

export const clearComposerDraft = (threadId: string) => {
  if (!threadId) return;
  pendingServerAckDrafts.delete(getPendingKey(threadId));
  if (getActiveClientSessionIdentity()) {
    useClientSessionViewStore.getState().clearComposerDraft(threadId);
    return;
  }
  try {
    getStorage()?.removeItem(getStorageKey(threadId));
  } catch {
    // Ignore quota/security failures; composer drafts are best-effort.
  }
};
