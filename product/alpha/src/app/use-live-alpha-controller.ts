import { useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import type { HostSnapshot } from '@/portal-client';
import { DirectHostClient } from '@/portal-client';
import { portalHostName } from '@/portal-address';
import { type AcpTranscript, createTranscript, queueOptimisticPrompt, reduceAcpEvent } from '@/chat/acp-transcript';
import type { AlphaController, AlphaWorkspace, AlphaViewModel } from './alpha-controller';
import { DEFAULT_PORTAL_URL, loadPortalConnection, savePortalConnection } from './portal-connection-storage';
import { useWorkspaceFileBrowser } from './use-workspace-file-browser';

export const HOST_SNAPSHOT_REFRESH_INTERVAL_MS = 5_000;

type HostClientFactory = (
  hostUrl: string,
  accessToken: string,
  onEvent: ConstructorParameters<typeof DirectHostClient>[2],
  onUnexpectedClose: (error: Error) => void,
) => DirectHostClient;

const createHostClient: HostClientFactory = (...args) => new DirectHostClient(...args);

const mapWorkspaces = (
  snapshot: HostSnapshot | undefined,
  currentHostName: string,
): AlphaWorkspace[] => {
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
        workspaceId: workspace.workspaceId,
      })),
  }));
};

export function useLiveAlphaController(
  clientFactory: HostClientFactory = createHostClient,
): AlphaController {
  const [hostUrl, setHostUrl] = useState(DEFAULT_PORTAL_URL);
  const [accessToken, setAccessToken] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [client, setClient] = useState<DirectHostClient>();
  const [snapshot, setSnapshot] = useState<HostSnapshot>();
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const [transcript, setTranscript] = useState<AcpTranscript>();
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const connectionEdited = useRef(false);
  const clientRef = useRef<DirectHostClient | undefined>(undefined);
  const refreshErrorRef = useRef<string | undefined>(undefined);
  const workspaceFileBrowser = useWorkspaceFileBrowser(client);

  useEffect(() => {
    let active = true;

    void loadPortalConnection().then((connection) => {
      if (!active || !connection || connectionEdited.current) return;
      setHostUrl(connection.hostUrl);
      setAccessToken(connection.accessToken);
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
        if (recoveredError) {
          setError((current) => current === recoveredError ? undefined : current);
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        refreshErrorRef.current = message;
        setError(message);
      } finally {
        refreshing = false;
      }
    };
    const interval = window.setInterval(
      () => void refreshSilently(),
      HOST_SNAPSHOT_REFRESH_INTERVAL_MS,
    );
    const onFocus = () => void refreshSilently();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [client]);

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
      nextClient = clientFactory(
        hostUrl,
        accessToken,
        (event) => {
          setTranscript((current) => {
            if (!current) {
              return event.type === 'history/reset' ? createTranscript(event.sessionId ?? 'unattached') : current;
            }
            return reduceAcpEvent(current, event);
          });
        },
        (closeError) => {
          if (clientRef.current !== nextClient) return;
          clientRef.current = undefined;
          setClient(undefined);
          setSnapshot(undefined);
          setSelectedThreadId(undefined);
          setTranscript(undefined);
          workspaceFileBrowser.close();
          setBusy(false);
          refreshErrorRef.current = undefined;
          setError(closeError.message);
        },
      );
      const nextSnapshot = await nextClient.snapshot();
      try {
        await savePortalConnection({ hostUrl, accessToken });
      } catch (persistError) {
        console.error('Unable to save the Portal connection', persistError);
      }
      clientRef.current = nextClient;
      setClient(nextClient);
      setSnapshot(nextSnapshot);
      setSelectedThreadId(undefined);
      setTranscript(undefined);
      workspaceFileBrowser.close();
    } catch (cause) {
      nextClient?.close();
      if (clientRef.current === nextClient) clientRef.current = undefined;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = () => {
    clientRef.current = undefined;
    refreshErrorRef.current = undefined;
    client?.close();
    workspaceFileBrowser.close();
    setClient(undefined);
    setSnapshot(undefined);
    setSelectedThreadId(undefined);
    setTranscript(undefined);
    setError(undefined);
  };

  const performAcpAction = async (
    action: () => Promise<void>,
    rethrow = false,
  ) => {
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

  const selectThread = async (threadId: string) => {
    if (!client) return;
    const thread = snapshot?.threads.find((candidate) => candidate.threadId === threadId);
    const workspace = snapshot?.workspaces.find(
      (candidate) => candidate.workspaceId === thread?.workspaceId,
    );
    setBusy(true);
    setError(undefined);
    try {
      await client.attach(threadId);
      setSelectedThreadId(threadId);
      if (workspace) {
        await workspaceFileBrowser.open(workspace.workspaceId, workspace.name);
      } else {
        workspaceFileBrowser.close();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const createThread = async (workspaceId?: string) => {
    if (!client || !snapshot) return;
    const workspace = snapshot.workspaces.find(
      (candidate) => candidate.workspaceId === workspaceId,
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
      await workspaceFileBrowser.open(workspace.workspaceId, workspace.name);
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
      hostName: portalHostName(hostUrl),
    },
    accessToken,
    searchQuery,
    workspaces: mapWorkspaces(snapshot, portalHostName(hostUrl)),
    selectedThreadId,
    transcript,
    workspaceFiles: workspaceFileBrowser.files,
    busy: busy || workspaceFileBrowser.busy,
    error: workspaceFileBrowser.error ?? error,
  }), [
    accessToken,
    busy,
    connecting,
    error,
    hostUrl,
    searchQuery,
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
      setHostUrl: (value) => {
        connectionEdited.current = true;
        setHostUrl(value);
      },
      setAccessToken: (value) => {
        connectionEdited.current = true;
        setAccessToken(value);
      },
      setSearchQuery,
      connect,
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
      respondToPermission: (requestId, optionId) => {
        client?.respondToPermission(requestId, optionId);
      },
      respondToElicitation: (requestId, response) => {
        client?.respondToElicitation(requestId, response);
      },
      setMode: (modeId) => performAcpAction(async () => await client?.setMode(modeId)),
      setConfigOption: (optionId, value) =>
        performAcpAction(
          async () => await client?.setConfigOption(optionId, value),
        ),
    },
  };
}
