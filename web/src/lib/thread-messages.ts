import type { UIMessage } from 'ai';
import { useChatStore } from '../stores/chat-store';

const getStorageKey = (threadId: string) => `weave-chat-messages:${threadId}`;

export const loadThreadMessages = (threadId: string): UIMessage[] => {
  const raw = localStorage.getItem(getStorageKey(threadId));

  if (!raw) return [];

  try {
    const messages = JSON.parse(raw) as UIMessage[];
    return Array.isArray(messages) ? messages : [];
  } catch {
    return [];
  }
};

export const saveThreadMessages = (threadId: string, messages: UIMessage[], reorder = false) => {
  localStorage.setItem(getStorageKey(threadId), JSON.stringify(messages));

  const firstUserText = messages
    .find(message => message.role === 'user')
    ?.parts?.filter((part): part is { type: 'text'; text: string } =>
      Boolean(part.type === 'text' && 'text' in part && typeof part.text === 'string'),
    )
    .map(part => part.text)
    .join(' ')
    .trim();

  useChatStore.getState().touchThread(threadId, firstUserText?.slice(0, 64), reorder);
};

export const deleteThreadMessages = (threadId: string) => {
  localStorage.removeItem(getStorageKey(threadId));
};
