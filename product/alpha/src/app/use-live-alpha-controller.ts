import { useEffect, useMemo, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import type { HostSnapshot } from '@/portal-client';
import { DirectHostClient } from '@/portal-client';
import type {
  AlphaController,
  AlphaProject,
  AlphaViewModel,
} from './alpha-controller';

const hostName = (hostUrl: string) => {
  try {
    return new URL(hostUrl).hostname || 'Portal';
  } catch {
    return 'Portal';
  }
};

const mapProjects = (
  snapshot: HostSnapshot | undefined,
  currentHostName: string,
): AlphaProject[] => {
  if (!snapshot) return [];

  const agents = new Map(
    snapshot.agents.map((agent) => [agent.agentId, agent.name]),
  );

  return snapshot.workspaces.map((workspace) => ({
    id: workspace.workspaceId,
    name: workspace.name,
    threads: snapshot.threads
      .filter((thread) => thread.workspaceId === workspace.workspaceId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((thread) => ({
        id: thread.threadId,
        title: thread.title || workspace.name,
        agentName: agents.get(thread.agentId) || thread.agentId,
        hostName: currentHostName,
        status: thread.status,
        updatedAt: thread.updatedAt,
        projectId: workspace.workspaceId,
      })),
  }));
};

export function useLiveAlphaController(): AlphaController {
  const [hostUrl, setHostUrl] = useState('ws://127.0.0.1:4122');
  const [accessToken, setAccessToken] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [client, setClient] = useState<DirectHostClient>();
  const [snapshot, setSnapshot] = useState<HostSnapshot>();
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => () => client?.close(), [client]);

  const refresh = async (activeClient = client) => {
    if (!activeClient) return;
    setBusy(true);
    setError(undefined);
    try {
      setSnapshot(await activeClient.snapshot());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    setConnecting(true);
    setError(undefined);
    client?.close();
    let nextClient: DirectHostClient | undefined;
    try {
      nextClient = new DirectHostClient(hostUrl, accessToken, () => {
        // Conversation rendering is deliberately paused behind the workspace
        // placeholder while the new chat surface is built from shadcn primitives.
      });
      const nextSnapshot = await nextClient.snapshot();
      setClient(nextClient);
      setSnapshot(nextSnapshot);
      setSelectedThreadId(undefined);
    } catch (cause) {
      nextClient?.close();
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = () => {
    client?.close();
    setClient(undefined);
    setSnapshot(undefined);
    setSelectedThreadId(undefined);
    setError(undefined);
  };

  const selectThread = async (threadId: string) => {
    if (!client) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.attach(threadId);
      setSelectedThreadId(threadId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const createThread = async (projectId?: string) => {
    if (!client || !snapshot) return;
    const workspace = snapshot.workspaces.find(
      (candidate) => candidate.workspaceId === projectId,
    ) || snapshot.workspaces[0];
    const agent = snapshot.agents[0];
    if (!workspace || !agent) return;

    setBusy(true);
    setError(undefined);
    try {
      const thread = await client.createThread(
        workspace.workspaceId,
        agent.agentId,
      );
      setSnapshot(await client.snapshot());
      await client.attach(thread.threadId);
      setSelectedThreadId(thread.threadId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const model = useMemo<AlphaViewModel>(() => ({
    platform: Capacitor.getPlatform(),
    connection: {
      status: snapshot ? 'connected' : connecting ? 'connecting' : 'disconnected',
      hostUrl,
      hostName: hostName(hostUrl),
    },
    accessToken,
    searchQuery,
    projects: mapProjects(snapshot, hostName(hostUrl)),
    selectedThreadId,
    busy,
    error,
  }), [
    accessToken,
    busy,
    connecting,
    error,
    hostUrl,
    searchQuery,
    selectedThreadId,
    snapshot,
  ]);

  return {
    model,
    actions: {
      setHostUrl,
      setAccessToken,
      setSearchQuery,
      connect,
      disconnect,
      refresh,
      createThread,
      selectThread,
    },
  };
}
