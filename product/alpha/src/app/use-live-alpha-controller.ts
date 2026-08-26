import { useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import type { HostSnapshot } from '@/portal-client';
import { DirectHostClient } from '@/portal-client';
import { portalCredentialSigner, type PortalCredentialSigner, deletePortalCredentialKey } from '@/portal-credential';
import { pairPortalHost, parsePortalPairingCode } from '@/portal-pairing';
import { type AcpTranscript, createTranscript, queueOptimisticPrompt, reduceAcpEvent } from '@/chat/acp-transcript';
import type { AlphaController, AlphaWorkspace, AlphaViewModel } from './alpha-controller';
import {
  loadPortalConnections,
  type PersistedPortalConnection,
  savePortalConnections,
} from './portal-connection-storage';
import { useWorkspaceFileBrowser } from './use-workspace-file-browser';

export const HOST_SNAPSHOT_REFRESH_INTERVAL_MS = 5_000;

type HostClientFactory = (
  hostUrl: string,
  credential: PortalCredentialSigner,
  onEvent: ConstructorParameters<typeof DirectHostClient>[2],
  onUnexpectedClose: (error: Error) => void,
) => DirectHostClient;

const createHostClient: HostClientFactory = (...args) => new DirectHostClient(...args);
const resourceId = (hostId: string, id: string) => `${hostId}:${id}`;

const mapWorkspaces = (
  snapshot: HostSnapshot | undefined,
  connection: PersistedPortalConnection | undefined,
): AlphaWorkspace[] => {
  if (!snapshot || !connection) return [];
  const agents = new Map(snapshot.agents.map((agent) => [agent.agentId, agent.name]));
  return snapshot.workspaces.map((workspace) => ({
    id: resourceId(connection.hostId, workspace.workspaceId),
    workspaceId: workspace.workspaceId,
    hostId: connection.hostId,
    name: workspace.name,
    threads: snapshot.threads
      .filter((thread) => thread.workspaceId === workspace.workspaceId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((thread) => ({
        id: resourceId(connection.hostId, thread.threadId),
        threadId: thread.threadId,
        hostId: connection.hostId,
        title: thread.title || workspace.name,
        agentName: agents.get(thread.agentId) || thread.agentId,
        hostName: connection.displayName,
        status: thread.status,
        updatedAt: thread.updatedAt,
        workspaceId: workspace.workspaceId,
      })),
  }));
};

export function useLiveAlphaController(
  clientFactory: HostClientFactory = createHostClient,
): AlphaController {
  const [connections, setConnections] = useState<PersistedPortalConnection[]>([]);
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [selectedHostId, setSelectedHostId] = useState<string>();
  const [searchQuery, setSearchQuery] = useState('');
  const [client, setClient] = useState<DirectHostClient>();
  const [snapshot, setSnapshot] = useState<HostSnapshot>();
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const [transcript, setTranscript] = useState<AcpTranscript>();
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const clientRef = useRef<DirectHostClient | undefined>(undefined);
  const refreshErrorRef = useRef<string | undefined>(undefined);
  const autoConnectRef = useRef<string | undefined>(undefined);
  const workspaceFileBrowser = useWorkspaceFileBrowser(client);
  const selectedConnection = connections.find(({ hostId }) => hostId === selectedHostId);

  const persist = async (nextConnections: PersistedPortalConnection[], nextSelectedHostId?: string) => {
    try {
      await savePortalConnections({
        connections: nextConnections,
        ...(nextSelectedHostId ? { selectedHostId: nextSelectedHostId } : {}),
      });
    } catch (cause) {
      console.error('Unable to save Portal connections', cause);
    }
  };

  useEffect(() => {
    let active = true;
    void loadPortalConnections().then((stored) => {
      if (!active) return;
      setConnections(stored.connections);
      setSelectedHostId(stored.selectedHostId);
      setConnectionsOpen(stored.connections.length === 0);
      setConnectionsLoaded(true);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => () => client?.close(), [client]);

  useEffect(() => {
    if (!client) return;
    let refreshing = false;
    const refreshSilently = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        setSnapshot(await client.snapshot());
        const recoveredError = refreshErrorRef.current;
        refreshErrorRef.current = undefined;
        if (recoveredError) setError((current) => current === recoveredError ? undefined : current);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        refreshErrorRef.current = message;
        setError(message);
      } finally {
        refreshing = false;
      }
    };
    const interval = window.setInterval(() => void refreshSilently(), HOST_SNAPSHOT_REFRESH_INTERVAL_MS);
    const onFocus = () => void refreshSilently();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [client]);

  const clearHostView = () => {
    workspaceFileBrowser.close();
    setSnapshot(undefined);
    setSelectedThreadId(undefined);
    setTranscript(undefined);
    setBusy(false);
  };

  const connectToHost = async (connection: PersistedPortalConnection) => {
    setConnecting(true);
    setError(undefined);
    clientRef.current = undefined;
    client?.close();
    setClient(undefined);
    clearHostView();
    let nextClient: DirectHostClient | undefined;
    try {
      nextClient = clientFactory(
        connection.hostUrl,
        portalCredentialSigner(connection),
        (event) => {
          setTranscript((current) => {
            if (!current) return event.type === 'history/reset' ? createTranscript(event.sessionId ?? 'unattached') : current;
            return reduceAcpEvent(current, event);
          });
        },
        (closeError) => {
          if (clientRef.current !== nextClient) return;
          clientRef.current = undefined;
          setClient(undefined);
          clearHostView();
          refreshErrorRef.current = undefined;
          setError(closeError.message);
        },
      );
      const nextSnapshot = await nextClient.snapshot();
      if (nextSnapshot.hostId !== connection.hostId) throw new Error('Portal Host identity changed. Pair this Host again.');
      clientRef.current = nextClient;
      setClient(nextClient);
      setSnapshot(nextSnapshot);
      if (nextSnapshot.displayName !== connection.displayName) {
        const updated = connections.map((candidate) =>
          candidate.hostId === connection.hostId ? { ...candidate, displayName: nextSnapshot.displayName } : candidate
        );
        setConnections(updated);
        void persist(updated, connection.hostId);
      }
    } catch (cause) {
      nextClient?.close();
      if (clientRef.current === nextClient) clientRef.current = undefined;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setConnecting(false);
    }
  };

  useEffect(() => {
    if (!connectionsLoaded || !selectedConnection || autoConnectRef.current === selectedConnection.hostId) return;
    autoConnectRef.current = selectedConnection.hostId;
    void connectToHost(selectedConnection);
  }, [connectionsLoaded, selectedConnection?.hostId]);

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

  const disconnect = () => {
    clientRef.current = undefined;
    refreshErrorRef.current = undefined;
    client?.close();
    setClient(undefined);
    clearHostView();
    setError(undefined);
  };

  const performAcpAction = async (action: () => Promise<void>, rethrow = false) => {
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      if (rethrow) throw cause;
    }
  };

  const sendPrompt = async (text: string) => {
    if (!client || !transcript) return;
    const content = [{ type: 'text' as const, text }];
    setTranscript((current) =>
      current ? queueOptimisticPrompt(current, `local-${crypto.randomUUID()}`, content) : current
    );
    await performAcpAction(async () => await client.prompt(content), true);
  };

  const selectThread = async (id: string) => {
    if (!client) return;
    const thread = modelWorkspaces.flatMap((workspace) => workspace.threads).find((candidate) => candidate.id === id);
    const workspace = snapshot?.workspaces.find((candidate) => candidate.workspaceId === thread?.workspaceId);
    if (!thread) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.attach(thread.threadId);
      setSelectedThreadId(id);
      if (workspace) await workspaceFileBrowser.open(workspace.workspaceId, workspace.name);
      else workspaceFileBrowser.close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const createThread = async (workspaceId?: string) => {
    if (!client || !snapshot || !selectedConnection) return;
    const workspaceModel = modelWorkspaces.find((candidate) => candidate.id === workspaceId) || modelWorkspaces[0];
    const workspace = snapshot.workspaces.find((candidate) => candidate.workspaceId === workspaceModel?.workspaceId);
    const agent = snapshot.agents[0];
    if (!workspace || !agent) return;
    setBusy(true);
    setError(undefined);
    try {
      const thread = await client.createThread(workspace.workspaceId, agent.agentId);
      setSnapshot(await client.snapshot());
      setSelectedThreadId(resourceId(selectedConnection.hostId, thread.threadId));
      await client.attach(thread.threadId);
      await workspaceFileBrowser.open(workspace.workspaceId, workspace.name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const modelWorkspaces = mapWorkspaces(snapshot, selectedConnection);
  const model = useMemo<AlphaViewModel>(() => ({
    platform: Capacitor.getPlatform(),
    connectionsLoaded,
    connectionsOpen,
    connections: connections.map((connection) => ({
      hostId: connection.hostId,
      displayName: connection.displayName,
      hostUrl: connection.hostUrl,
      selected: connection.hostId === selectedHostId,
      status: connection.hostId === selectedHostId
        ? snapshot ? 'connected' : connecting ? 'connecting' : 'disconnected'
        : 'disconnected',
    })),
    connection: {
      status: snapshot ? 'connected' : connecting ? 'connecting' : 'disconnected',
      hostUrl: selectedConnection?.hostUrl ?? '',
      hostName: selectedConnection?.displayName ?? 'Portal',
    },
    searchQuery,
    workspaces: modelWorkspaces,
    selectedThreadId,
    transcript,
    workspaceFiles: workspaceFileBrowser.files,
    busy: busy || workspaceFileBrowser.busy,
    error: workspaceFileBrowser.error ?? error,
  }), [
    busy,
    connecting,
    connections,
    connectionsLoaded,
    connectionsOpen,
    error,
    searchQuery,
    selectedConnection,
    selectedHostId,
    selectedThreadId,
    snapshot,
    transcript,
    workspaceFileBrowser.busy,
    workspaceFileBrowser.error,
    workspaceFileBrowser.files,
  ]);

  return {
    model,
    actions: {
      setSearchQuery,
      openConnections: () => setConnectionsOpen(true),
      closeConnections: () => {
        if (connections.length) setConnectionsOpen(false);
      },
      pairHost: async (input) => {
        setBusy(true);
        setError(undefined);
        try {
          const code = parsePortalPairingCode(input.pairingCode);
          if (connections.some(({ hostId }) => hostId === code.hostId)) throw new Error('This Host is already configured.');
          const paired = await pairPortalHost(input);
          const updated = [...connections, paired];
          setConnections(updated);
          setSelectedHostId(paired.hostId);
          setConnectionsOpen(false);
          autoConnectRef.current = paired.hostId;
          await persist(updated, paired.hostId);
          await connectToHost(paired);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
          throw cause;
        } finally {
          setBusy(false);
        }
      },
      selectHost: async (hostId) => {
        const connection = connections.find((candidate) => candidate.hostId === hostId);
        if (!connection) return;
        setSelectedHostId(hostId);
        autoConnectRef.current = hostId;
        await persist(connections, hostId);
        await connectToHost(connection);
      },
      forgetHost: async (hostId) => {
        const forgotten = connections.find((connection) => connection.hostId === hostId);
        if (!forgotten) return;
        if (hostId === selectedHostId) disconnect();
        const updated = connections.filter((connection) => connection.hostId !== hostId);
        const nextHostId = hostId === selectedHostId ? updated[0]?.hostId : selectedHostId;
        setConnections(updated);
        setSelectedHostId(nextHostId);
        setConnectionsOpen(updated.length === 0);
        autoConnectRef.current = undefined;
        await persist(updated, nextHostId);
        await deletePortalCredentialKey(forgotten.keyId).catch(() => undefined);
      },
      connect: () => selectedConnection && connectToHost(selectedConnection),
      disconnect,
      refresh,
      createThread,
      selectThread,
      openWorkspaceDirectory: workspaceFileBrowser.openDirectory,
      openWorkspaceFile: workspaceFileBrowser.openFile,
      activateWorkspaceFile: workspaceFileBrowser.activateFile,
      closeWorkspaceFile: workspaceFileBrowser.closeFile,
      reloadWorkspaceFile: workspaceFileBrowser.reloadFile,
      sendPrompt,
      cancelPrompt: () => performAcpAction(async () => await client?.cancelPrompt()),
      respondToPermission: (requestId, optionId) => client?.respondToPermission(requestId, optionId),
      respondToElicitation: (requestId, response) => client?.respondToElicitation(requestId, response),
      setMode: (modeId) => performAcpAction(async () => await client?.setMode(modeId)),
      setConfigOption: (optionId, value) =>
        performAcpAction(async () => await client?.setConfigOption(optionId, value)),
    },
  };
}
