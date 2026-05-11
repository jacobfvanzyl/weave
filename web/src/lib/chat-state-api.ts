import type { UIMessage } from 'ai';
import { getAuthHeaders, mastraUrl } from './mastra-client';
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
  title: thread.title || '...',
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
});

const parseJson = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json() as Promise<T>;
};

export type AuthUser = {
  id: string;
  name: string;
};

export const getAuthUser = async () => {
  const result = await parseJson<{ user: AuthUser }>(
    await fetch(`${mastraUrl}/chat-state/me`, { headers: getAuthHeaders() }),
  );

  return result.user;
};

export const listServerThreads = async () => {
  const result = await parseJson<{ threads: ServerThread[] }>(
    await fetch(`${mastraUrl}/chat-state/threads`, { headers: getAuthHeaders() }),
  );

  return result.threads.map(toChatThread);
};

export const createServerThread = async (threadId: string) => {
  const result = await parseJson<{ thread: ServerThread }>(
    await fetch(`${mastraUrl}/chat-state/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ threadId, title: '...' }),
    }),
  );

  return toChatThread(result.thread);
};

export const renameServerThread = async (threadId: string, title: string) => {
  const result = await parseJson<{ thread: ServerThread }>(
    await fetch(`${mastraUrl}/chat-state/threads/${threadId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ title }),
    }),
  );

  return toChatThread(result.thread);
};

export const deleteServerThread = async (threadId: string) => {
  await parseJson<{ ok: true }>(
    await fetch(`${mastraUrl}/chat-state/threads/${threadId}`, { method: 'DELETE', headers: getAuthHeaders() }),
  );
};

export const listServerMessages = async (threadId: string) => {
  const result = await parseJson<{ messages: UIMessage[] }>(
    await fetch(`${mastraUrl}/chat-state/threads/${threadId}/messages`, { headers: getAuthHeaders() }),
  );

  return result.messages;
};
