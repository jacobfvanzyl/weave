import type { UIMessage } from 'ai';
import { mastraUrl } from './mastra-client';
import type { ChatThread } from '../stores/chat-store';

type ServerThread = {
  id: string;
  title?: string;
  resourceId: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
};

const toChatThread = (thread: ServerThread): ChatThread => ({
  id: thread.id,
  title: thread.title || 'New chat',
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
});

const parseJson = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json() as Promise<T>;
};

export const listServerThreads = async (resourceId: string) => {
  const params = new URLSearchParams({ resourceId });
  const result = await parseJson<{ threads: ServerThread[] }>(
    await fetch(`${mastraUrl}/chat-state/threads?${params}`),
  );

  return result.threads.map(toChatThread);
};

export const createServerThread = async (resourceId: string, threadId: string) => {
  const result = await parseJson<{ thread: ServerThread }>(
    await fetch(`${mastraUrl}/chat-state/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceId, threadId, title: 'New chat' }),
    }),
  );

  return toChatThread(result.thread);
};

export const renameServerThread = async (resourceId: string, threadId: string, title: string) => {
  const params = new URLSearchParams({ resourceId });
  const result = await parseJson<{ thread: ServerThread }>(
    await fetch(`${mastraUrl}/chat-state/threads/${threadId}?${params}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    }),
  );

  return toChatThread(result.thread);
};

export const deleteServerThread = async (resourceId: string, threadId: string) => {
  const params = new URLSearchParams({ resourceId });
  await parseJson<{ ok: true }>(await fetch(`${mastraUrl}/chat-state/threads/${threadId}?${params}`, { method: 'DELETE' }));
};

export const listServerMessages = async (resourceId: string, threadId: string) => {
  const params = new URLSearchParams({ resourceId });
  const result = await parseJson<{ messages: UIMessage[] }>(
    await fetch(`${mastraUrl}/chat-state/threads/${threadId}/messages?${params}`),
  );

  return result.messages;
};
