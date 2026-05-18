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

export type Demiplane = {
  id: string;
  planeId: string;
  portalId?: string;
  mountId?: string;
  workspaceKind: 'primary' | 'worktree';
  source?: 'primary' | 'worktrunk' | 'adopted' | 'legacy';
  name: string;
  path?: string;
  status: 'ready' | 'offline' | 'creating' | 'dirty' | 'missing' | 'virtual' | 'error';
  locked?: boolean;
  branch?: string;
  baseBranch?: string;
  sortOrder?: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type Plane = {
  id: string;
  userId: string;
  name: string;
  projectKind: 'standard' | 'git';
  description?: string;
  portalId?: string;
  portalRootId?: string;
  repoPath?: string;
  gitRemote?: string;
  defaultBranch?: string;
  rootPathHint?: string;
  sortOrder?: number;
  demiplanes: Demiplane[];
  createdAt: string;
  updatedAt: string;
};

const toChatThread = (thread: ServerThread): ChatThread => ({
  id: thread.id,
  title: thread.title || '...',
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  sortOrder: typeof thread.metadata?.sortOrder === 'number' ? thread.metadata.sortOrder : undefined,
  planeId: typeof thread.metadata?.planeId === 'string' ? thread.metadata.planeId : undefined,
  demiplaneId: typeof thread.metadata?.demiplaneId === 'string' ? thread.metadata.demiplaneId : undefined,
  archived: thread.metadata?.archived === true,
  adHoc: thread.metadata?.adHoc === true,
  workspacePath: typeof thread.metadata?.workspacePath === 'string' ? thread.metadata.workspacePath : undefined,
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

export const createServerThread = async (threadId: string, planeId?: string, demiplaneId?: string) => {
  const result = await parseJson<{ thread: ServerThread }>(
    await fetch(`${mastraUrl}/chat-state/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ threadId, title: '...', planeId, demiplaneId }),
    }),
  );

  return toChatThread(result.thread);
};

export const archiveServerThread = async (threadId: string, archived = true) => {
  const result = await parseJson<{ thread: ServerThread }>(
    await fetch(`${mastraUrl}/chat-state/threads/${threadId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ archived }),
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

export const listPlanes = async () => {
  const result = await parseJson<{ planes: Plane[] }>(
    await fetch(`${mastraUrl}/planes`, { headers: getAuthHeaders() }),
  );

  return result.planes;
};

export type PortalRoot = {
  id: string;
  name?: string;
};

export type PortalConnection = {
  portalId: string;
  userId: string;
  name?: string;
  roots: PortalRoot[];
  status: 'online' | 'offline';
};

export type PortalBrowseEntry = {
  name: string;
  type: 'directory' | 'file' | 'other';
  hidden?: boolean;
};

export type PortalBrowseResult = {
  ok?: boolean;
  rootId: string;
  path: string;
  entries: PortalBrowseEntry[];
  isGitRepo?: boolean;
  git?: Record<string, unknown>;
  error?: string;
};

export type CreatePlaneInput = {
  name: string;
  projectKind?: 'standard' | 'git';
  portalId?: string;
  rootId?: string;
  repoPath?: string;
};

const normalizePortalRoots = (roots: unknown): PortalRoot[] => Array.isArray(roots)
  ? roots.flatMap(root => {
      const record = root && typeof root === 'object' ? root as Record<string, unknown> : undefined;
      const id = typeof record?.id === 'string' ? record.id.trim() : '';
      if (!id) return [];
      return [{ id, name: typeof record?.name === 'string' ? record.name : undefined }];
    })
  : [];

const normalizePortalConnection = (portal: unknown): PortalConnection | undefined => {
  const record = portal && typeof portal === 'object' ? portal as Record<string, unknown> : undefined;
  if (typeof record?.portalId !== 'string' || typeof record.userId !== 'string') return undefined;
  return {
    portalId: record.portalId,
    userId: record.userId,
    name: typeof record.name === 'string' ? record.name : undefined,
    roots: normalizePortalRoots(record.roots),
    status: record.status === 'online' ? 'online' : 'offline',
  };
};

export const listPortals = async () => {
  const result = await parseJson<{ portals: unknown[] }>(
    await fetch(`${mastraUrl}/portals`, { headers: getAuthHeaders() }),
  );

  return result.portals.flatMap(portal => normalizePortalConnection(portal) ?? []);
};

export const browsePortal = async (portalId: string, rootId = 'default', path = '') => {
  const params = new URLSearchParams({ rootId, path });
  return parseJson<PortalBrowseResult>(
    await fetch(`${mastraUrl}/portals/${portalId}/browse?${params}`, { headers: getAuthHeaders() }),
  );
};

export const createPlane = async (input: string | CreatePlaneInput) => {
  const body = typeof input === 'string' ? { name: input, projectKind: 'standard' } : input;
  const result = await parseJson<{ plane: Plane }>(
    await fetch(`${mastraUrl}/planes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(body),
    }),
  );

  return result.plane;
};

export const deletePlane = async (planeId: string) => {
  await parseJson<{ ok: true }>(
    await fetch(`${mastraUrl}/planes/${planeId}`, { method: 'DELETE', headers: getAuthHeaders() }),
  );
};

export const reorderPlanes = async (planeIds: string[]) => {
  const result = await parseJson<{ planes: Plane[] }>(
    await fetch(`${mastraUrl}/planes/reorder`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ planeIds }),
    }),
  );

  return result.planes;
};

export const createDemiplane = async (planeId: string, name: string) => {
  const result = await parseJson<{ plane: Plane; demiplane: Demiplane }>(
    await fetch(`${mastraUrl}/planes/${planeId}/demiplanes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ name }),
    }),
  );

  return result.demiplane;
};

export const adoptDemiplane = async (planeId: string, path: string, name?: string) => {
  const result = await parseJson<{ plane: Plane; demiplane: Demiplane }>(
    await fetch(`${mastraUrl}/planes/${planeId}/demiplanes/adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ path, name }),
    }),
  );

  return result.demiplane;
};

export const deleteDemiplane = async (planeId: string, demiplaneId: string, mode: 'detach' | 'remove') => {
  const result = await parseJson<{ plane: Plane; demiplane: Demiplane; mode: 'detach' | 'remove' }>(
    await fetch(`${mastraUrl}/planes/${planeId}/demiplanes/${demiplaneId}?mode=${mode}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    }),
  );

  return result;
};

export const discoverDemiplanes = async (planeId: string) => {
  const result = await parseJson<{ worktrees: Array<Record<string, unknown>> }>(
    await fetch(`${mastraUrl}/planes/${planeId}/demiplanes/discover`, { headers: getAuthHeaders() }),
  );

  return result.worktrees;
};

export const reorderDemiplanes = async (planeId: string, demiplaneIds: string[]) => {
  const result = await parseJson<{ plane: Plane }>(
    await fetch(`${mastraUrl}/planes/${planeId}/demiplanes/reorder`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ demiplaneIds }),
    }),
  );

  return result.plane;
};

export const createPlaneThread = async (planeId: string, threadId: string, demiplaneId?: string) => {
  const result = await parseJson<{ thread: ServerThread; demiplane: Demiplane }>(
    await fetch(`${mastraUrl}/planes/${planeId}/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ threadId, title: '...', demiplaneId }),
    }),
  );

  return { thread: toChatThread(result.thread), demiplane: result.demiplane };
};

export const reorderThreads = async (scope: { plain?: true; planeId?: string; demiplaneId?: string }, threadIds: string[]) => {
  await parseJson<{ ok: true }>(
    await fetch(`${mastraUrl}/chat-state/threads/reorder`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ scope, threadIds }),
    }),
  );
};

export const listServerMessages = async (threadId: string) => {
  const result = await parseJson<{ messages: UIMessage[] }>(
    await fetch(`${mastraUrl}/chat-state/threads/${threadId}/messages`, { headers: getAuthHeaders() }),
  );

  return result.messages;
};
