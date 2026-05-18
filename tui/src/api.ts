import type { ChatMessage, ChatThread, PortalConnection, ResolvedWorkspace, StreamChunk } from './types.ts';

export const normalizeHttpUrl = (server: string) => server.replace(/\/$/, '');

export const isConnectionError = (error: unknown) => {
  if (!(error instanceof Error)) return false;
  if (error instanceof TypeError) return true;
  return /fetch failed|error sending request|connection refused|econnrefused|connection reset|network error/i.test(error.message);
};

export const apiFetch = async (server: string, token: string, path: string, init: RequestInit = {}) => {
  const response = await fetch(`${server}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  return response;
};

export const listMessages = async (server: string, token: string, threadId: string) => {
  const response = await apiFetch(server, token, `/chat-state/threads/${threadId}/messages`);
  const body = await response.json() as { messages?: ChatMessage[] };
  return body.messages ?? [];
};

export const getContextUsage = async (server: string, token: string, threadId: string, contextWindow?: number) => {
  const query = contextWindow ? `?contextWindow=${contextWindow}` : '';
  const response = await apiFetch(server, token, `/chat-state/threads/${threadId}/context-usage${query}`);
  return await response.json() as { tokens: number; contextWindow?: number; percent?: number };
};

export const listDemiplaneThreads = async (server: string, token: string, planeId: string, demiplaneId?: string) => {
  const response = await apiFetch(server, token, '/chat-state/threads');
  const body = await response.json() as { threads?: ChatThread[] };
  return (body.threads ?? []).filter(thread => {
    const metadata = thread.metadata ?? {};
    return metadata.archived !== true && metadata.planeId === planeId && metadata.demiplaneId === demiplaneId;
  });
};

export const createThread = async (server: string, token: string, planeId: string, demiplaneId?: string) => {
  const response = await apiFetch(server, token, `/planes/${planeId}/threads`, {
    method: 'POST',
    body: JSON.stringify({ demiplaneId }),
  });
  const body = await response.json() as { thread?: { id?: string } };
  const threadId = body.thread?.id;
  if (!threadId) throw new Error('create thread response missing thread.id');
  return threadId;
};

export const listPortals = async (server: string, token: string) => {
  const response = await apiFetch(server, token, '/portals');
  const body = await response.json() as { portals?: PortalConnection[] };
  return body.portals ?? [];
};

export const resolveWorkspace = async (server: string, token: string, workspace: Record<string, unknown>, portalId?: string) => {
  const response = await apiFetch(server, token, '/planes/resolve-workspace', {
    method: 'POST',
    body: JSON.stringify({ ...workspace, portalId, allowAdHoc: true, createThread: false }),
  });
  return await response.json() as ResolvedWorkspace;
};

async function* parseSseJson(body: ReadableStream<Uint8Array>) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
      if (data && data !== '[DONE]') yield JSON.parse(data) as StreamChunk;
      boundary = buffer.indexOf('\n\n');
    }
  }
}

const streamToolId = (chunk: StreamChunk) => chunk.toolCallId ?? chunk.id;

const parseToolInputTitle = (rawInput: string) => {
  try {
    const input = rawInput ? JSON.parse(rawInput) as { title?: unknown } : undefined;
    return typeof input?.title === 'string' ? input.title.trim() : '';
  } catch {
    return '';
  }
};

export const streamChat = async (
  server: string,
  token: string,
  threadId: string,
  text: string,
  model: string,
  onDelta: (delta: string) => void,
  onTool: (toolName: string | undefined, toolCallId: string | undefined, input?: unknown, output?: unknown, isError?: boolean) => void,
  onRename: (title: string) => void,
  onUsage: (usage: StreamChunk['usage'] | StreamChunk['totalUsage']) => void,
  onDone: () => void,
) => {
  const response = await apiFetch(server, token, '/chat', {
    method: 'POST',
    body: JSON.stringify({
      messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
      memory: { thread: threadId },
      model,
    }),
  });

  if (!response.body) throw new Error('chat response missing body');
  const renameToolIds = new Set<string>();
  const toolInputById = new Map<string, string>();
  const toolNameById = new Map<string, string | undefined>();
  for await (const chunk of parseSseJson(response.body)) {
    if (chunk.type === 'text-delta') onDelta(chunk.delta ?? '');
    const toolId = streamToolId(chunk);
    if (toolId && chunk.toolName) toolNameById.set(toolId, chunk.toolName);
    if (chunk.type === 'tool-input-start' && toolId) {
      if (chunk.toolName === 'renameThreadTool' || chunk.toolName === 'rename-thread') {
        renameToolIds.add(toolId);
      } else {
        onTool(chunk.toolName, toolId);
      }
    }
    if (chunk.type === 'tool-input-delta' && toolId) {
      toolInputById.set(toolId, `${toolInputById.get(toolId) ?? ''}${chunk.delta ?? ''}`);
    }
    if (toolId && chunk.input !== undefined) {
      const toolName = chunk.toolName ?? toolNameById.get(toolId);
      if (renameToolIds.has(toolId)) {
        const rawInput = typeof chunk.input === 'string' ? chunk.input : toolInputById.get(toolId) ?? '';
        const title = parseToolInputTitle(rawInput);
        if (title) onRename(title);
      } else {
        onTool(toolName, toolId, chunk.input);
      }
    }
    if (chunk.type === 'tool-input-end' && toolId && !renameToolIds.has(toolId)) {
      onTool(toolNameById.get(toolId), toolId, toolInputById.get(toolId));
    }
    const output = chunk.output ?? chunk.result;
    if (toolId && output !== undefined && !renameToolIds.has(toolId)) {
      onTool(chunk.toolName ?? toolNameById.get(toolId), toolId, undefined, output, chunk.isError === true || chunk.type === 'tool-error');
    }
    if (chunk.usage) onUsage(chunk.usage);
    if (chunk.totalUsage) onUsage(chunk.totalUsage);
    if (chunk.type === 'error') onDelta(`\n[error] ${chunk.errorText ?? 'stream error'}`);
  }
  onDone();
};
