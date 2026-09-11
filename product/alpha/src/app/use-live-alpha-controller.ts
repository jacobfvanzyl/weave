import { showWorkspaceHostIdentity, workspaceKey } from './workspace-presentation';
import { COMPOSITION_TERMINAL_CREATION_CAPABILITY } from '@weave/product-protocol';
import { useEffect, useMemo, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import type { HostSnapshot } from "@/portal-client";
import { DirectHostClient, PortalTransportError } from "@/portal-client";
import {
  deletePortalCredentialKey,
  type PortalCredentialSigner,
  portalCredentialSigner,
} from "@/portal-credential";
import { pairPortalHost, parsePortalPairingToken } from "@/portal-pairing";
import {
  type AcpTranscriptEvent,
  type AcpTranscript,
  createTranscript,
  queueOptimisticPrompt,
  reduceAcpEvent,
} from "@/chat/acp-transcript";
import type {
  AlphaConnectionStatus,
  AlphaController,
  AlphaThread,
  AlphaViewModel,
  AlphaExecutionContext,
  AlphaExecutionContextPlacement,
} from "./alpha-controller";
import {
  loadPortalConnections,
  type PersistedPortalConnection,
  savePortalConnections,
} from "./portal-connection-storage";
import { useAppResume } from "./use-app-resume";
import { useSavedThreadSelection } from "./use-saved-thread-selection";
import { ThreadReadState } from './thread-read-state';
import { useWorkspaceCompositions } from "./use-workspace-compositions";
import { useAlphaTerminals } from "./use-alpha-terminals";

export const HOST_SNAPSHOT_REFRESH_INTERVAL_MS = 5_000;
export const HOST_RECONNECT_TIMEOUT_MS = 10_000;

type HostClientFactory = (
  hostUrl: string,
  credential: PortalCredentialSigner,
  onEvent: ConstructorParameters<typeof DirectHostClient>[2],
  onUnexpectedClose: (error: Error) => void,
) => DirectHostClient;

type HostStatuses = Record<string, AlphaConnectionStatus>;
type HostErrors = Record<string, string | undefined>;
type ConnectionAttempt = "connect" | "reconnect";
type LocalThreadDraft = {
  contextId: string;
  placement: AlphaExecutionContextPlacement;
  agentId: string;
  prepared?: HostSnapshot["threads"][number];
  thread: AlphaThread;
};

const createHostClient: HostClientFactory = (...args) =>
  new DirectHostClient(...args);
const resourceId = (hostId: string, id: string) =>
  `${encodeURIComponent(hostId)}:${encodeURIComponent(id)}`;
const belongsToHost = (id: string | undefined, hostId: string) =>
  id?.startsWith(`${encodeURIComponent(hostId)}:`) ?? false;
const hostFailureMessage = (cause: unknown) =>
  cause instanceof Error && cause.message.includes("protocol version")
    ? "Update this Host to use the current Workspace model."
    : cause instanceof Error && cause.message.includes("identity changed")
    ? "This Portal Host changed identity. Pair it again to reconnect safely."
    : "Couldn’t reconnect to this Portal Host. Check that Portal is running and try again.";

const withTimeout = async <Value>(
  promise: Promise<Value>,
  timeoutMs: number,
): Promise<Value> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Portal Host reconnection timed out.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

const mapThread = (
  thread: HostSnapshot["threads"][number],
  workspaceName: string,
  connection: PersistedPortalConnection,
  agents: Map<string, string>,
  supportsThreadLifecycle: boolean,
  contextId?: string,
): AlphaThread => ({
  id: resourceId(connection.hostId, thread.threadId),
  threadId: thread.threadId,
  hostId: connection.hostId,
  title: thread.title || workspaceName,
  agentName: agents.get(thread.agentId) || thread.agentId,
  hostName: connection.displayName,
  supportsThreadLifecycle,
  status: thread.status,
  attention: thread.attention,
  updatedAt: thread.updatedAt,
  ...(thread.archivedAt ? { archivedAt: thread.archivedAt } : {}),
  executionContextId: thread.executionContextId,
  workspaceId: thread.workspaceId,
  membershipRevision: thread.membershipRevision,
  ...(contextId ? { contextId } : {}),
});

const logicalExecutionContextId = (context: HostSnapshot["executionContexts"][number], connection: PersistedPortalConnection) => resourceId(connection.hostId, context.executionContextId);

const mapHostExecutionContexts = (
  snapshot: HostSnapshot | undefined,
  connection: PersistedPortalConnection,
): AlphaExecutionContext[] => {
  if (!snapshot) return [];
  const agents = new Map(
    snapshot.agents.map((agent) => [agent.agentId, agent.name]),
  );
  const supportsThreadLifecycle =
    snapshot.capabilities.includes("thread.archive") &&
    snapshot.capabilities.includes("thread.restore");
  return snapshot.executionContexts.map((workspace) => {
    const contextId = logicalExecutionContextId(workspace, connection);
    return {
      id: contextId,
      executionContextId: workspace.executionContextId,
      hostId: connection.hostId,
      hostName: connection.displayName,
      name: workspace.name,
      canonicalPath: workspace.canonicalPath,
      availability: workspace.availability,
      placements: [
        {
          id: resourceId(connection.hostId, workspace.executionContextId),
          executionContextId: workspace.executionContextId,
          hostId: connection.hostId,
          hostName: connection.displayName,
        },
      ],
      threads: snapshot.threads
        .filter((thread) => thread.executionContextId === workspace.executionContextId)
        .map((thread) =>
          mapThread(
            thread,
            workspace.name,
            connection,
            agents,
            supportsThreadLifecycle,
            contextId,
          ),
        )
        .sort((left, right) => left.id.localeCompare(right.id)),
      repositoryIdentity: workspace.repositoryIdentity,
    };
  });
};

const groupHostExecutionContexts = (executionContexts: AlphaExecutionContext[]) => {
  const groups = new Map<string, AlphaExecutionContext[]>();
  for (const workspace of executionContexts) {
    groups.set(workspace.id, [...(groups.get(workspace.id) ?? []), workspace]);
  }
  return [...groups.entries()].map(([id, members]) => {
    const representative = members[0]!;
    const names = [
      ...new Set(members.map(({ name }) => name.trim()).filter(Boolean)),
    ];
    const repositoryIdentity = members.find(
      ({ repositoryIdentity }) => repositoryIdentity,
    )?.repositoryIdentity;
    const name =
      names.length === 1
        ? names[0]!
        : repositoryIdentity?.displayName ||
          repositoryIdentity?.name ||
          representative.name;
    return {
      ...representative,
      id,
      name,
      placements: members.flatMap(({ placements }) => placements ?? []),
      threads: members
        .flatMap(({ threads }) => threads)
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
  });
};

const mapHostArchivedThreads = (
  snapshot: HostSnapshot | undefined,
  connection: PersistedPortalConnection,
): AlphaThread[] => {
  if (!snapshot) return [];
  const agents = new Map(
    snapshot.agents.map((agent) => [agent.agentId, agent.name]),
  );
  const executionContexts = new Map(
    snapshot.executionContexts.map((workspace) => [
      workspace.executionContextId,
      workspace.name,
    ]),
  );
  return snapshot.archivedThreads.map((thread) =>
    mapThread(
      thread,
      executionContexts.get(thread.executionContextId) || thread.executionContextId,
      connection,
      agents,
      true,
    ),
  );
};

type SessionInfoUpdate = Extract<
  Extract<AcpTranscriptEvent, { type: "session/update" }>["update"],
  { sessionUpdate: "session_info_update" }
>;

const sessionInfoUpdatedAt = (
  update: SessionInfoUpdate,
  titleChanged: boolean,
) =>
  typeof update.updatedAt === "string" &&
  Number.isFinite(Date.parse(update.updatedAt))
    ? update.updatedAt
    : titleChanged
      ? new Date().toISOString()
      : undefined;

const applySessionInfoToThread = (
  thread: HostSnapshot["threads"][number],
  update: SessionInfoUpdate,
) => {
  const hasTitle = update.title !== undefined;
  const nextTitle = update.title === null ? undefined : update.title;
  const titleChanged = hasTitle && thread.title !== nextTitle;
  const updatedAt = sessionInfoUpdatedAt(update, titleChanged);
  if (!titleChanged && (!updatedAt || updatedAt === thread.updatedAt)) {
    return thread;
  }
  const next = {
    ...thread,
    ...(updatedAt ? { updatedAt } : {}),
    ...(nextTitle === undefined ? {} : { title: nextTitle }),
  };
  if (hasTitle && nextTitle === undefined) delete next.title;
  return next;
};

export function useLiveAlphaController(
  clientFactory: HostClientFactory = createHostClient,
): AlphaController {
  const [connections, setConnections] = useState<PersistedPortalConnection[]>(
    [],
  );
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [archivedThreadsOpen, setArchivedThreadsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [snapshots, setSnapshots] = useState<
    Record<string, HostSnapshot | undefined>
  >({});
  const [statuses, setStatuses] = useState<HostStatuses>({});
  const [hostErrors, setHostErrors] = useState<HostErrors>({});
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const [loadingThreadId, setLoadingThreadId] = useState<string>();
  const [creatingThreadExecutionContextId, setCreatingThreadExecutionContextId] =
    useState<string>();
  const [localThreadDraft, setLocalThreadDraft] = useState<LocalThreadDraft>();
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [composerFocusThreadId, setComposerFocusThreadId] = useState<string>();
  const [transcripts, setTranscripts] = useState<
    Record<string, AcpTranscript | undefined>
  >({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const clientsRef = useRef(new Map<string, DirectHostClient>());
  const activeThreadIdsRef = useRef(new Map<string, string>());
  const selectedThreadIdRef = useRef<string | undefined>(undefined);
  const localThreadDraftRef = useRef<LocalThreadDraft | undefined>(undefined);
  const [threadReadState] = useState(() => new ThreadReadState());
  const [, refreshThreadReadState] = useState(0);
  const connectionAttemptRef = useRef(new Map<string, number>());
  const reconnectTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const reconnectFailuresRef = useRef(new Map<string, number>());
  const creatingThreadRef = useRef(false);
  const promotingThreadIdRef = useRef<string | undefined>(undefined);
  const autoConnectRef = useRef(new Set<string>());
  const refreshingRef = useRef(new Set<string>());
  const reportActionError = (cause: unknown) => {
    if (cause instanceof PortalTransportError) return;
    setError(cause instanceof Error ? cause.message : String(cause));
  };

  const persist = async (nextConnections: PersistedPortalConnection[]) => {
    try {
      await savePortalConnections({
        connections: nextConnections,
        ...(nextConnections[0]
          ? { selectedHostId: nextConnections[0].hostId }
          : {}),
      });
    } catch (cause) {
      console.error("Unable to save Portal connections", cause);
    }
  };

  const acknowledgePromotion = (id: string) => {
    if (promotingThreadIdRef.current !== id) return;
    promotingThreadIdRef.current = undefined;
    creatingThreadRef.current = false;
    setBusy(false);
  };
  const reconcileArchivedSelectionRef = useRef<(hostId: string, snapshot: HostSnapshot) => void>(() => {});
  const pendingArchiveSelectionRef = useRef<{ threadId: string; workspace: string } | undefined>(undefined);
  const updateSnapshot = (hostId: string, snapshot: HostSnapshot, authoritative = true) => {
    for (const thread of snapshot.threads) threadReadState.observe(resourceId(hostId, thread.threadId), thread.attention);
    if (authoritative) {
      const promoted = snapshot.threads.find((thread) => resourceId(hostId, thread.threadId) === promotingThreadIdRef.current);
      if (promoted) acknowledgePromotion(resourceId(hostId, promoted.threadId));
      const archivedIds = new Set(snapshot.archivedThreads.map((thread) => resourceId(hostId, thread.threadId)));
      if (selectedThreadIdRef.current && archivedIds.has(selectedThreadIdRef.current)) {
        reconcileArchivedSelectionRef.current(hostId, snapshot);
        selectedThreadIdRef.current = undefined; setSelectedThreadId(undefined); setLoadingThreadId(undefined);
        activeThreadIdsRef.current.delete(hostId);
      }
      if (localThreadDraftRef.current && archivedIds.has(localThreadDraftRef.current.thread.id)) {
        localThreadDraftRef.current = undefined; setLocalThreadDraft(undefined);
      }
    }
    setSnapshots((current) => ({ ...current, [hostId]: snapshot }));
    setStatuses((current) => ({ ...current, [hostId]: "connected" }));
    setHostErrors((current) => ({ ...current, [hostId]: undefined }));
  };

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  const focusComposer = (threadId: string) => {
    setComposerFocusThreadId(threadId);
    setComposerFocusRequest((current) => current + 1);
  };

  const discardLocalThreadDraft = async () => {
    const draft = localThreadDraftRef.current;
    if (!draft) return;
    localThreadDraftRef.current = undefined;
    setLocalThreadDraft(undefined);
    setTranscripts((current) => {
      if (!(draft.thread.id in current)) return current;
      const next = { ...current };
      delete next[draft.thread.id];
      return next;
    });
    if (draft.prepared) {
      try {
        await clientsRef.current
          .get(draft.placement.hostId)
          ?.discardThreadDraft(draft.thread.threadId);
      } catch (cause) {
        if (!(cause instanceof PortalTransportError)) {
          console.warn("Unable to discard the provisional Thread.", cause);
        }
      }
    }
  };

  const connectToHost = async (
    connection: PersistedPortalConnection,
    attempt: ConnectionAttempt = "connect",
  ): Promise<boolean> => {
    clearTimeout(reconnectTimersRef.current.get(connection.hostId));
    reconnectTimersRef.current.delete(connection.hostId);
    const generation =
      (connectionAttemptRef.current.get(connection.hostId) ?? 0) + 1;
    connectionAttemptRef.current.set(connection.hostId, generation);
    setStatuses((current) => ({
      ...current,
      [connection.hostId]:
        attempt === "reconnect" ? "reconnecting" : "connecting",
    }));
    setHostErrors((current) => ({
      ...current,
      [connection.hostId]: undefined,
    }));
    clientsRef.current.get(connection.hostId)?.close();
    clientsRef.current.delete(connection.hostId);
    let nextClient: DirectHostClient | undefined;
    try {
      nextClient = clientFactory(
        connection.hostUrl,
        portalCredentialSigner(connection),
        (event, sourceThreadId) => {
          const id = sourceThreadId ? resourceId(connection.hostId, sourceThreadId) : activeThreadIdsRef.current.get(connection.hostId);
          if (!id) return;
          if (event.type === 'turn/started') { threadReadState.started(id); refreshThreadReadState((value) => value + 1); }
          if (event.type === 'turn/stopped' && ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal'].includes(event.stopReason)) {
            threadReadState.completed(id); refreshThreadReadState((value) => value + 1);
          }
          if (event.type === "permission/requested" || event.type === "elicitation/requested" ||
              event.type === "session/update" && ["user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call"].includes(event.update.sessionUpdate)) acknowledgePromotion(id);
          if (
            event.type === "session/update" &&
            event.update.sessionUpdate === "session_info_update"
          ) {
            const update = event.update;
            setSnapshots((current) => {
              const snapshot = current[connection.hostId];
              if (!snapshot) return current;
              let changed = false;
              const apply = (thread: HostSnapshot["threads"][number]) => {
                if (resourceId(connection.hostId, thread.threadId) !== id) {
                  return thread;
                }
                const next = applySessionInfoToThread(thread, update);
                changed ||= next !== thread;
                return next;
              };
              const threads = snapshot.threads.map(apply);
              const archivedThreads = snapshot.archivedThreads.map(apply);
              return changed
                ? {
                    ...current,
                    [connection.hostId]: {
                      ...snapshot,
                      threads,
                      archivedThreads,
                    },
                  }
                : current;
            });
            const draft = localThreadDraftRef.current;
            if (
              draft?.placement.hostId === connection.hostId &&
              draft.thread.id === id
            ) {
              const titleChanged =
                update.title !== undefined &&
                draft.thread.title !== update.title;
              const updatedAt = sessionInfoUpdatedAt(update, titleChanged);
              const nextDraft: LocalThreadDraft = {
                ...draft,
                ...(draft.prepared
                  ? {
                      prepared: applySessionInfoToThread(
                        draft.prepared,
                        update,
                      ),
                    }
                  : {}),
                thread: {
                  ...draft.thread,
                  ...(update.title === undefined
                    ? {}
                    : { title: update.title ?? "New thread" }),
                  ...(updatedAt ? { updatedAt } : {}),
                },
              };
              localThreadDraftRef.current = nextDraft;
              setLocalThreadDraft(nextDraft);
            }
          }
          setTranscripts((current) => {
            const transcript = current[id];
            const next = transcript
              ? reduceAcpEvent(transcript, event)
              : event.type === "history/reset"
                ? createTranscript(event.sessionId ?? "unattached")
                : transcript;
            return next === transcript ? current : { ...current, [id]: next };
          });
        },
        (closeError) => {
          if (clientsRef.current.get(connection.hostId) !== nextClient) return;
          clientsRef.current.delete(connection.hostId);
          console.info(
            `Portal Host ${connection.hostId} disconnected; reconnecting.`,
            closeError,
          );
          void connectToHost(connection, "reconnect");
        },
      );
      const snapshot = await withTimeout(
        nextClient.snapshot(),
        HOST_RECONNECT_TIMEOUT_MS,
      );
      if (connectionAttemptRef.current.get(connection.hostId) !== generation) {
        nextClient.close();
        return false;
      }
      if (snapshot.hostId !== connection.hostId) {
        throw new Error("Portal Host identity changed. Pair this Host again.");
      }
      const activeThreadId = activeThreadIdsRef.current.get(connection.hostId);
      if (
        attempt === "reconnect" &&
        activeThreadId &&
        activeThreadId === selectedThreadIdRef.current
      ) {
        const draft = localThreadDraftRef.current;
        const preparedDraft =
          draft?.prepared &&
          draft.placement.hostId === connection.hostId &&
          draft.thread.id === activeThreadId
            ? draft
            : undefined;
        const thread =
          preparedDraft?.thread ??
          snapshot.threads.find(
            (candidate) =>
              resourceId(connection.hostId, candidate.threadId) ===
              activeThreadId,
          );
        const workspace = snapshot.executionContexts.find(
          (candidate) =>
            candidate.executionContextId ===
            (preparedDraft?.placement.executionContextId ?? thread?.executionContextId),
        );
        if (!thread || !workspace) {
          throw new Error("The active Thread is no longer available.");
        }
        await withTimeout(
          (async () => {
            await nextClient.attach(thread.threadId);
          })(),
          HOST_RECONNECT_TIMEOUT_MS,
        );
      }
      if (connectionAttemptRef.current.get(connection.hostId) !== generation) {
        nextClient.close();
        return false;
      }
      reconnectFailuresRef.current.delete(connection.hostId);
      clientsRef.current.set(connection.hostId, nextClient);
      updateSnapshot(connection.hostId, snapshot);
      if (snapshot.displayName !== connection.displayName) {
        setConnections((current) => {
          const updated = current.map((candidate) =>
            candidate.hostId === connection.hostId
              ? { ...candidate, displayName: snapshot.displayName }
              : candidate,
          );
          void persist(updated);
          return updated;
        });
      }
      return true;
    } catch (cause) {
      nextClient?.close();
      if (clientsRef.current.get(connection.hostId) === nextClient) {
        clientsRef.current.delete(connection.hostId);
      }
      if (connectionAttemptRef.current.get(connection.hostId) === generation) {
        console.warn(
          `Unable to connect Portal Host ${connection.hostId}.`,
          cause,
        );
        setStatuses((current) => ({
          ...current,
          [connection.hostId]: "disconnected",
        }));
        setHostErrors((current) => ({
          ...current,
          [connection.hostId]: hostFailureMessage(cause),
        }));
        const activeThreadId = activeThreadIdsRef.current.get(
          connection.hostId,
        );
        const draft = localThreadDraftRef.current;
        if (draft?.placement.hostId === connection.hostId) {
          void discardLocalThreadDraft();
          activeThreadIdsRef.current.delete(connection.hostId);
          if (selectedThreadIdRef.current === draft.thread.id) {
            selectedThreadIdRef.current = undefined;
            setSelectedThreadId(undefined);
            setLoadingThreadId(undefined);
          }
        }
        // A disconnected Host retains the selected durable Thread and its last
        // transcript. Reconnection can restore the same attachment without moving focus.
        if (activeThreadId === selectedThreadIdRef.current) setLoadingThreadId(undefined);
        // Host restart/network loss can outlast the immediate reconnect attempt.
        // Retry only transport/timeouts; identity, authentication and protocol
        // failures require a deliberate correction, not an automatic loop.
        const message = cause instanceof Error ? cause.message : '';
        const retryable = (cause instanceof PortalTransportError || /timed out/i.test(message)) &&
          !/protocol version|identity changed|credential|authentication|unauthorized|forbidden/i.test(message) &&
          !(cause instanceof PortalTransportError && [1002, 1008].includes(cause.closeCode ?? 0));
        if (retryable) {
          const failures = (reconnectFailuresRef.current.get(connection.hostId) ?? 0) + 1;
          reconnectFailuresRef.current.set(connection.hostId, failures);
          const delay = Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5));
          reconnectTimersRef.current.set(connection.hostId, setTimeout(() => {
            reconnectTimersRef.current.delete(connection.hostId);
            if (connectionAttemptRef.current.get(connection.hostId) === generation) {
              void connectToHost(connection, 'reconnect');
            }
          }, delay));
        }

      }
      return false;
    }
  };

  const refreshHost = async (hostId: string) => {
    const client = clientsRef.current.get(hostId);
    if (!client || refreshingRef.current.has(hostId)) return;
    refreshingRef.current.add(hostId);
    try {
      updateSnapshot(hostId, await client.snapshot());
    } catch (cause) {
      console.warn(`Unable to refresh Portal Host ${hostId}.`, cause);
    } finally {
      refreshingRef.current.delete(hostId);
    }
  };

  useEffect(() => {
    let active = true;
    void loadPortalConnections().then((stored) => {
      if (!active) return;
      setConnections(stored.connections);
      setStatuses(
        Object.fromEntries(
          stored.connections.map(({ hostId }) => [hostId, "disconnected"]),
        ),
      );
      setConnectionsOpen(stored.connections.length === 0);
      setConnectionsLoaded(true);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!connectionsLoaded) return;
    for (const connection of connections) {
      if (autoConnectRef.current.has(connection.hostId)) continue;
      autoConnectRef.current.add(connection.hostId);
      void connectToHost(connection);
    }
  }, [connectionsLoaded, connections]);

  useEffect(() => {
    if (!connectionsLoaded) return;
    const refreshAll = () => {
      for (const hostId of clientsRef.current.keys()) void refreshHost(hostId);
    };
    const interval = window.setInterval(
      refreshAll,
      HOST_SNAPSHOT_REFRESH_INTERVAL_MS,
    );
    window.addEventListener("focus", refreshAll);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshAll);
    };
  }, [connectionsLoaded]);

  useAppResume(() => {
    if (!connectionsLoaded) return;
    for (const connection of connections) {
      void connectToHost(connection, "reconnect");
    }
  });

  useEffect(
    () => () => {
      for (const timer of reconnectTimersRef.current.values()) clearTimeout(timer);
      reconnectTimersRef.current.clear();
      for (const [hostId, generation] of connectionAttemptRef.current) {
        connectionAttemptRef.current.set(hostId, generation + 1);
      }
      for (const client of clientsRef.current.values()) client.close();
      clientsRef.current.clear();
    },
    [],
  );

  const persistedExecutionContexts = useMemo(
    () =>
      groupHostExecutionContexts(
        connections.flatMap((connection) =>
          mapHostExecutionContexts(snapshots[connection.hostId], connection),
        ),
      ).sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    [connections, snapshots, statuses],
  );

  const modelExecutionContexts = useMemo(
    () =>
      persistedExecutionContexts.map((workspace) =>
        localThreadDraft?.contextId === workspace.id
          ? {
              ...workspace,
              threads: [
                localThreadDraft.thread,
                ...workspace.threads.filter(
                  ({ id }) => id !== localThreadDraft.thread.id,
                ),
              ],
            }
          : workspace,
      ),
    [localThreadDraft, persistedExecutionContexts],
  );

  const modelArchivedThreads = useMemo(
    () =>
      connections
        .flatMap((connection) =>
          statuses[connection.hostId] === "connected" ||
          statuses[connection.hostId] === "reconnecting"
            ? mapHostArchivedThreads(snapshots[connection.hostId], connection)
            : [],
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [connections, snapshots, statuses],
  );

  const allThreads: AlphaThread[] = connections.flatMap((connection) => {
    const snapshot = snapshots[connection.hostId];
    if (!snapshot) return [];
    const agents = new Map(snapshot.agents.map((agent) => [agent.agentId, agent.name]));
    return snapshot.threads.map((thread) => {
      const context = snapshot.executionContexts.find((item) => item.executionContextId === thread.executionContextId);
      return { ...mapThread(thread, context?.name ?? 'Thread', connection, agents, true, resourceId(connection.hostId, thread.executionContextId)), workingDirectory: context?.canonicalPath, completionUnread: threadReadState.unread(resourceId(connection.hostId, thread.threadId)) };
    });
  });
  if (localThreadDraft) allThreads.unshift(localThreadDraft.thread);
  const selected = allThreads.find((thread) => thread.id === selectedThreadId);
  const selectedConnection = connections.find(
    (connection) => connection.hostId === selected?.hostId,
  );
  const selectedHostReconnecting = selected
    ? statuses[selected.hostId] === "reconnecting"
    : false;
  const workspaceController = useWorkspaceCompositions(modelExecutionContexts, connections.map((connection) => ({
    hostId: connection.hostId,
    available: statuses[connection.hostId] === "connected",
    supported: Boolean(snapshots[connection.hostId]?.capabilities.includes("workspace.composition.get") && snapshots[connection.hostId]?.capabilities.includes("workspace.composition.replace")),
    createsTerminals: Boolean(snapshots[connection.hostId]?.capabilities.includes(COMPOSITION_TERMINAL_CREATION_CAPABILITY)),
    client: clientsRef.current.get(connection.hostId),
  })), connectionsLoaded);
  // Terminal attachments are owned by individual composition panes. No Thread selection retargets them.
  const terminalController = useAlphaTerminals({});
  const aggregateStatus = Object.values(statuses).includes("connected")
    ? ("connected" as const)
    : Object.values(statuses).some(
          (status) => status === "connecting" || status === "reconnecting",
        )
      ? ("connecting" as const)
      : ("disconnected" as const);

  const performAcpAction = async (
    action: () => Promise<void>,
    rethrow = false,
  ) => {
    const actionThreadId = selectedThreadIdRef.current;
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      if (selectedThreadIdRef.current === actionThreadId) reportActionError(cause);
      if (rethrow) throw cause;
    }
  };

  const selectThread = async (id: string) => {
    const draft = localThreadDraftRef.current;
    if (id === draft?.thread.id) {
      selectedThreadIdRef.current = id;
      setSelectedThreadId(id);
      focusComposer(id);
      return;
    }
    if (id === selectedThreadIdRef.current && !loadingThreadId) return;
    const thread = allThreads.find((candidate) => candidate.id === id);
    const client = thread ? clientsRef.current.get(thread.hostId) : undefined;
    const snapshot = thread ? snapshots[thread.hostId] : undefined;
    const workspace = snapshot?.executionContexts.find(
      (candidate) => candidate.executionContextId === thread?.executionContextId,
    );
    if (!thread || !client) return;
    const previousSelectedThreadId =
      selectedThreadIdRef.current === draft?.thread.id ? undefined : selectedThreadIdRef.current;
    const previousActiveThreadId =
      selectedThreadIdRef.current === draft?.thread.id
        ? undefined
        : activeThreadIdsRef.current.get(thread.hostId);
    setBusy(true);
    setError(undefined);
    selectedThreadIdRef.current = id;
    setSelectedThreadId(id);
    setLoadingThreadId(id);
    activeThreadIdsRef.current.set(thread.hostId, id);
    try {
      if (draft) await discardLocalThreadDraft();
      await client.attach(thread.threadId);
    } catch (cause) {
      if (selectedThreadIdRef.current === id) {
        selectedThreadIdRef.current = previousSelectedThreadId;
        setSelectedThreadId(previousSelectedThreadId);
        if (previousActiveThreadId) {
          activeThreadIdsRef.current.set(thread.hostId, previousActiveThreadId);
        } else activeThreadIdsRef.current.delete(thread.hostId);
        reportActionError(cause);
      }
    } finally {
      setLoadingThreadId((current) => (current === id ? undefined : current));
      setBusy(false);
    }
  };

  // Snapshot callbacks outlive a render. Reconcile against the current navigation
  // and then attach after the authoritative catalog has reached the model.
  reconcileArchivedSelectionRef.current = (hostId, snapshot) => {
    pendingArchiveSelectionRef.current = undefined;
    const archived = snapshot.archivedThreads.find((thread) => resourceId(hostId, thread.threadId) === selectedThreadIdRef.current);
    if (!archived?.workspaceId) return;
    const workspace = workspaceKey({ hostId, workspaceId: archived.workspaceId });
    if (workspaceController.model.presentation.activeWorkspace !== workspace) return;
    const previous = allThreads.filter((thread) => thread.hostId === hostId && thread.workspaceId === archived.workspaceId);
    const index = previous.findIndex((thread) => thread.id === selectedThreadIdRef.current);
    const remaining = snapshot.threads.filter((thread) => thread.workspaceId === archived.workspaceId);
    const remainingIds = new Set(remaining.map((thread) => resourceId(hostId, thread.threadId)));
    const next = [...previous.slice(index + 1), ...previous.slice(0, index)].find((thread) => remainingIds.has(thread.id));
    const threadId = next?.id ?? (remaining[0] && resourceId(hostId, remaining[0].threadId));
    if (threadId) pendingArchiveSelectionRef.current = { threadId, workspace };
  };
  useEffect(() => {
    const pending = pendingArchiveSelectionRef.current;
    if (!pending) return;
    pendingArchiveSelectionRef.current = undefined;
    if (!selectedThreadIdRef.current && workspaceController.model.presentation.activeWorkspace === pending.workspace) {
      void selectThread(pending.threadId);
    }
  });

  const createThread = async (executionContextId?: string, placementId?: string, workspaceId?: string, target?: { context: AlphaExecutionContext; snapshot: HostSnapshot }) => {
    const workspaceModel = target?.context ??
      persistedExecutionContexts.find((candidate) => candidate.id === executionContextId) ??
      persistedExecutionContexts[0];
    if (!workspaceModel) return;
    if (!workspaceId) { setError("Choose a Workspace before creating an agent."); return; }
    const existingDraft = localThreadDraftRef.current;
    if (existingDraft?.contextId === workspaceModel.id && existingDraft.thread.workspaceId === workspaceId) {
      selectedThreadIdRef.current = existingDraft.thread.id;
      setSelectedThreadId(existingDraft.thread.id);
      focusComposer(existingDraft.thread.id);
      return;
    }
    if (creatingThreadRef.current) return;
    const placements = workspaceModel.placements ?? [
      {
        id: resourceId(workspaceModel.hostId, workspaceModel.executionContextId),
        hostId: workspaceModel.hostId,
        hostName: workspaceModel.hostName,
        executionContextId: workspaceModel.executionContextId,
      },
    ];
    const requestedPlacement = placementId
      ? placements.find(({ id }) => id === placementId)
      : undefined;
    if (placementId && !requestedPlacement) return;
    const placement =
      requestedPlacement ??
      placements.find(
        ({ hostId, executionContextId }) =>
          selected?.contextId === workspaceModel.id &&
          selected.hostId === hostId &&
          selected.executionContextId === executionContextId,
      ) ??
      placements.find(({ hostId }) => statuses[hostId] === "connected") ??
      placements[0];
    if (!placement) return;
    const client = clientsRef.current.get(placement.hostId);
    const snapshot = target?.snapshot ?? snapshots[placement.hostId];
    const workspace = snapshot?.executionContexts.find(
      (candidate) => candidate.executionContextId === placement.executionContextId,
    );
    const agent = snapshot?.agents[0];
    if (!client || !workspace || !agent) return;
    const supportsDrafts = snapshot.capabilities.includes("thread.draft");
    const previousSelectedThreadId = selectedThreadIdRef.current;
    const previousActiveThreadId = activeThreadIdsRef.current.get(
      placement.hostId,
    );
    creatingThreadRef.current = true;
    setCreatingThreadExecutionContextId(workspaceModel.id);
    setBusy(true);
    setError(undefined);
    try {
      await discardLocalThreadDraft();
      const prepared = supportsDrafts
        ? await client.createThreadDraft(placement.executionContextId, agent.agentId, undefined, workspaceId)
        : undefined;
      const id = prepared
        ? resourceId(placement.hostId, prepared.threadId)
        : `draft:${crypto.randomUUID()}`;
      const draft: LocalThreadDraft = {
        contextId: workspaceModel.id,
        placement,
        agentId: agent.agentId,
        ...(prepared ? { prepared } : {}),
        thread: {
          id,
          threadId: prepared?.threadId ?? id,
          hostId: placement.hostId,
          title: "New thread",
          agentName: agent.name,
          hostName: placement.hostName,
          supportsThreadLifecycle: false,
          status: "active",
          updatedAt: prepared?.updatedAt ?? new Date().toISOString(),
          executionContextId: placement.executionContextId,
          contextId: workspaceModel.id,
          workspaceId: prepared?.workspaceId ?? workspaceId,
          membershipRevision: 0,
          workingDirectory: workspace.canonicalPath,
          draft: true,
        },
      };
      localThreadDraftRef.current = draft;
      setLocalThreadDraft(draft);
      selectedThreadIdRef.current = id;
      setSelectedThreadId(id);
      setLoadingThreadId(prepared ? id : undefined);
      setTranscripts((current) => ({
        ...current,
        [id]: createTranscript(prepared?.acpSessionId ?? id),
      }));
      if (prepared) {
        activeThreadIdsRef.current.set(placement.hostId, id);
        await client.attach(prepared.threadId);
      }
      focusComposer(id);
    } catch (cause) {
      await discardLocalThreadDraft();
      selectedThreadIdRef.current = previousSelectedThreadId;
      setSelectedThreadId(previousSelectedThreadId);
      if (previousActiveThreadId) {
        activeThreadIdsRef.current.set(
          placement.hostId,
          previousActiveThreadId,
        );
      } else activeThreadIdsRef.current.delete(placement.hostId);
      reportActionError(cause);
    } finally {
      setLoadingThreadId(undefined);
      creatingThreadRef.current = false;
      setCreatingThreadExecutionContextId(undefined);
      setBusy(false);
    }
  };

  const archiveThread = async (id: string) => {
    const thread = allThreads.find((candidate) => candidate.id === id);
    const client = thread ? clientsRef.current.get(thread.hostId) : undefined;
    if (!thread || !client) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.archiveThread(thread.threadId);
      updateSnapshot(thread.hostId, await client.snapshot());
    } catch (cause) {
      reportActionError(cause);
      throw cause;
    } finally {
      setBusy(false);
    }
  };

  const restoreThread = async (id: string) => {
    const thread = modelArchivedThreads.find(
      (candidate) => candidate.id === id,
    );
    const client = thread ? clientsRef.current.get(thread.hostId) : undefined;
    if (!thread || !client) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.restoreThread(thread.threadId);
      updateSnapshot(thread.hostId, await client.snapshot());
    } catch (cause) {
      reportActionError(cause);
      throw cause;
    } finally {
      setBusy(false);
    }
  };

  useSavedThreadSelection(selectedThreadId, Boolean(selected && !selected.draft),
    allThreads.filter((thread) => !thread.draft && statuses[thread.hostId] === "connected").map((thread) => thread.id), selectThread);

  const selectedTranscript = selectedThreadId && loadingThreadId !== selectedThreadId ? transcripts[selectedThreadId] : undefined;
  const observedRunning = selected?.attention && Date.now() - Date.parse(selected.attention.observedAt) < 15_000 &&
    (selected.attention.state === "working" || selected.attention.state === "waiting");

  const model: AlphaViewModel = {
    platform: window.weaveDesktop?.platform ?? Capacitor.getPlatform(),
    connectionsLoaded,
    connectionsOpen,
    archivedThreadsOpen,
    connections: connections.map((connection) => ({
      hostId: connection.hostId,
      displayName: connection.displayName,
      hostUrl: connection.hostUrl,
      selected: connection.hostId === selected?.hostId,
      status: statuses[connection.hostId] ?? "disconnected",
      error: hostErrors[connection.hostId],
      supportsExecutionContextRegistration: Boolean(
        snapshots[connection.hostId]?.capabilities.includes("context.add"),
      ),
    })),
    connection: {
      status: aggregateStatus,
      hostUrl: selectedConnection?.hostUrl ?? "",
      hostName: selectedConnection?.displayName ?? "Portal Hosts",
    },
    searchQuery,
    executionContexts: modelExecutionContexts,
    threads: allThreads,
    archivedThreads: modelArchivedThreads,
    showHostIdentity: showWorkspaceHostIdentity(connections, workspaceController.model.compositions, workspaceController.model.presentation),
    selectedThreadId,
    loadingThreadId,
    creatingThreadExecutionContextId,
    composerFocusRequest,
    composerFocusThreadId,
    transcript: selectedTranscript && observedRunning && selectedTranscript.turn.status === "idle"
      ? { ...selectedTranscript, turn: { status: "running" } }
      : selectedTranscript,
    terminals: terminalController.model,
    workspaceCompositions: workspaceController.model,
    busy,
    error: selectedHostReconnecting
      ? undefined
      : error,
  };

  return {
    model,
    workspaceActions: { ...workspaceController.actions, close: async (...args) => { await workspaceController.actions.close(...args); await refreshHost(args[0].hostId); } },
    terminalClient: (hostId) => statuses[hostId] === "connected" ? clientsRef.current.get(hostId) : undefined,
    actions: {
      setSearchQuery,
      openConnections: () => setConnectionsOpen(true),
      closeConnections: () => {
        if (connections.length) setConnectionsOpen(false);
      },
      openArchivedThreads: () => setArchivedThreadsOpen(true),
      closeArchivedThreads: () => setArchivedThreadsOpen(false),
      pairHost: async (input) => {
        setBusy(true);
        setError(undefined);
        try {
          const pairing = parsePortalPairingToken(input.pairingToken);
          if (connections.some(({ hostId }) => hostId === pairing.hostId)) {
            throw new Error("This Host is already configured.");
          }
          const paired = await pairPortalHost(input);
          const updated = [...connections, paired];
          setConnections(updated);
          setConnectionsOpen(false);
          autoConnectRef.current.add(paired.hostId);
          await persist(updated);
          await connectToHost(paired);
        } finally {
          setBusy(false);
        }
      },
      forgetHost: async (hostId) => {
        const forgotten = connections.find(
          (connection) => connection.hostId === hostId,
        );
        if (!forgotten) return;
        connectionAttemptRef.current.set(
          hostId,
          (connectionAttemptRef.current.get(hostId) ?? 0) + 1,
        );
        clientsRef.current.get(hostId)?.close();
        clientsRef.current.delete(hostId);
        activeThreadIdsRef.current.delete(hostId);
        autoConnectRef.current.delete(hostId);
        const draft = localThreadDraftRef.current;
        if (draft?.placement.hostId === hostId) await discardLocalThreadDraft();
        if (selected?.hostId === hostId) {
          selectedThreadIdRef.current = undefined;
          setSelectedThreadId(undefined);
          setLoadingThreadId(undefined);
        }
        setSnapshots((current) => ({ ...current, [hostId]: undefined }));
        setStatuses((current) => ({ ...current, [hostId]: "disconnected" }));
        setHostErrors((current) => ({ ...current, [hostId]: undefined }));
        const updated = connections.filter(
          (connection) => connection.hostId !== hostId,
        );
        setConnections(updated);
        setConnectionsOpen(updated.length === 0);
        await persist(updated);
        await deletePortalCredentialKey(forgotten.keyId).catch(() => undefined);
      },
      reconnectHost: async (hostId) => {
        const connection = connections.find(
          (candidate) => candidate.hostId === hostId,
        );
        if (connection) await connectToHost(connection, "reconnect");
      },
      refresh: async () => {
        setBusy(true);
        await Promise.all(
          [...clientsRef.current.keys()].map((hostId) => refreshHost(hostId)),
        );
        setBusy(false);
      },
      addExecutionContext: async ({ hostId, path, name }) => {
        const client = clientsRef.current.get(hostId);
        if (!client) throw new Error("The selected Portal is not connected.");
        if (!snapshots[hostId]?.capabilities.includes("context.add")) {
          throw new Error(
            "The selected Portal must be updated before it can add directories.",
          );
        }
        setBusy(true);
        setError(undefined);
        try {
          await client.addWorkspace(path, name);
          updateSnapshot(hostId, await client.snapshot());
        } finally {
          setBusy(false);
        }
      },
      removeExecutionContext: async (executionContextId, placementId) => {
        const workspace = persistedExecutionContexts.find(
          ({ id }) => id === executionContextId,
        );
        if (!workspace) return;
        const placements = workspace.placements ?? [
          {
            id: `${workspace.hostId}:${workspace.executionContextId}`,
            executionContextId: workspace.executionContextId,
            hostId: workspace.hostId,
            hostName: workspace.hostName,
          },
        ];
        const placement = placementId
          ? placements.find(({ id }) => id === placementId)
          : placements[0];
        if (!placement) return;
        const client = clientsRef.current.get(placement.hostId);
        if (!client) throw new Error("The selected Portal is not connected.");
        if (
          !snapshots[placement.hostId]?.capabilities.includes(
            "context.remove",
          )
        ) {
          throw new Error(
            "The selected Portal must be updated before it can remove directories.",
          );
        }
        setBusy(true);
        setError(undefined);
        try {
          const draft = localThreadDraftRef.current;
          if (
            draft?.placement.hostId === placement.hostId &&
            draft.placement.executionContextId === placement.executionContextId
          ) {
            await discardLocalThreadDraft();
          }
          await client.removeWorkspace(placement.executionContextId);
          if (
            selected?.hostId === placement.hostId &&
            selected.executionContextId === placement.executionContextId
          ) {
            selectedThreadIdRef.current = undefined;
            setSelectedThreadId(undefined);
            setLoadingThreadId(undefined);
          }
          updateSnapshot(placement.hostId, await client.snapshot());
        } catch (cause) {
          reportActionError(cause);
        } finally {
          setBusy(false);
        }
      },
      createThreadInDirectory: async (hostId, path, workspaceId) => {
        const client = clientsRef.current.get(hostId);
        const connection = connections.find((connection) => connection.hostId === hostId);
        if (!client || !connection) return;
        try {
          const context = await client.addWorkspace(path);
          const snapshot = await client.snapshot();
          updateSnapshot(hostId, snapshot);
          const mapped = mapHostExecutionContexts(snapshot, connection).find((item) => item.executionContextId === context.executionContextId);
          if (!mapped) throw new Error('The execution directory is unavailable.');
          await createThread(mapped.id, undefined, workspaceId, { context: mapped, snapshot });
        } catch (cause) { reportActionError(cause); }
      },
      assignThread: async (id, workspaceId) => {
        const thread = allThreads.find((thread) => thread.id === id);
        const client = thread && clientsRef.current.get(thread.hostId);
        if (!client || !thread) return;
        try {
          const changed = await client.assignThread(thread.threadId, thread.hostId, workspaceId, thread.membershipRevision ?? 0);
          if (thread.draft) {
            const draft = localThreadDraftRef.current;
            if (draft?.thread.id === thread.id) {
              const next = { ...draft, prepared: changed, thread: { ...draft.thread, workspaceId: changed.workspaceId, membershipRevision: changed.membershipRevision } };
              localThreadDraftRef.current = next;
              setLocalThreadDraft(next);
            }
          }
          updateSnapshot(thread.hostId, await client.snapshot());
        } catch (cause) { updateSnapshot(thread.hostId, await client.snapshot()); reportActionError(cause); }
      },
      createThread,
      selectThread,
      setFocusedAgentThread: (id) => { if (threadReadState.focus(id)) refreshThreadReadState((value) => value + 1); },
      discardThreadDraft: async (id) => {
        if (localThreadDraftRef.current?.thread.id !== id || promotingThreadIdRef.current === id) return;
        if (selectedThreadIdRef.current === id) {
          selectedThreadIdRef.current = undefined; setSelectedThreadId(undefined); setLoadingThreadId(undefined);
        }
        for (const [hostId, activeId] of activeThreadIdsRef.current) if (activeId === id) activeThreadIdsRef.current.delete(hostId);
        await discardLocalThreadDraft();
      },
      archiveThread,
      restoreThread,
      showTerminals: terminalController.actions.show,
      hideTerminals: terminalController.actions.hide,
      createTerminal: terminalController.actions.create,
      selectTerminal: terminalController.actions.select,
      closeTerminal: terminalController.actions.close,
      retryTerminalControl: terminalController.actions.retryControl,
      inputTerminal: terminalController.actions.input,
      resizeTerminal: terminalController.actions.resize,
      sendPrompt: async (text) => {
        const selectedId = selectedThreadIdRef.current;
        const draft = localThreadDraftRef.current;
        const content = [{ type: "text" as const, text }];
        if (draft && selectedId === draft.thread.id) {
          if (creatingThreadRef.current) return;
          const client = clientsRef.current.get(draft.placement.hostId);
          const snapshot = snapshots[draft.placement.hostId];
          if (!client || !snapshot) return;
          const localPromptId = `local-${crypto.randomUUID()}`;
          if (draft.prepared) {
            creatingThreadRef.current = true;
            promotingThreadIdRef.current = draft.thread.id;
            setBusy(true);
            setError(undefined);
            setTranscripts((current) => {
              const transcript = current[draft.thread.id];
              return {
                ...current,
                [draft.thread.id]: transcript
                  ? queueOptimisticPrompt(transcript, localPromptId, content)
                  : transcript,
              };
            });
            updateSnapshot(draft.placement.hostId, {
              ...snapshot,
              threads: [
                draft.prepared,
                ...snapshot.threads.filter(
                  ({ threadId }) => threadId !== draft.prepared?.threadId,
                ),
              ],
            }, false);
            localThreadDraftRef.current = undefined;
            setLocalThreadDraft(undefined);
            try {
              await client.prompt(content);
              void refreshHost(draft.placement.hostId);
            } catch (cause) {
              if (selectedThreadIdRef.current !== draft.thread.id) return;
              setTranscripts((current) => ({
                ...current,
                [draft.thread.id]: current[draft.thread.id]
                  ? reduceAcpEvent(current[draft.thread.id]!, {
                      type: "turn/failed",
                      error:
                        cause instanceof Error ? cause.message : String(cause),
                    })
                  : current[draft.thread.id],
              }));
              reportActionError(cause);
              throw cause;
            } finally {
              if (promotingThreadIdRef.current === draft.thread.id) {
                promotingThreadIdRef.current = undefined;
                creatingThreadRef.current = false;
                setBusy(false);
              }
            }
            return;
          }
          const previousActiveThreadId = activeThreadIdsRef.current.get(
            draft.placement.hostId,
          );
          let remoteId: string | undefined;
          creatingThreadRef.current = true;
          setCreatingThreadExecutionContextId(draft.contextId);
          setBusy(true);
          setError(undefined);
          setTranscripts((current) => {
            const transcript = current[draft.thread.id];
            return {
              ...current,
              [draft.thread.id]: transcript
                ? queueOptimisticPrompt(transcript, localPromptId, content)
                : transcript,
            };
          });
          try {
            const created = await client.createThread(
              draft.placement.executionContextId,
              draft.agentId,
              undefined,
              draft.thread.workspaceId,
            );
            remoteId = resourceId(draft.placement.hostId, created.threadId);
            updateSnapshot(draft.placement.hostId, {
              ...snapshot,
              threads: [
                created,
                ...snapshot.threads.filter(
                  ({ threadId }) => threadId !== created.threadId,
                ),
              ],
            });
            localThreadDraftRef.current = undefined;
            setLocalThreadDraft(undefined);
            activeThreadIdsRef.current.set(draft.placement.hostId, remoteId);
            selectedThreadIdRef.current = remoteId;
            setSelectedThreadId(remoteId);
            setTranscripts((current) => {
              const next = { ...current };
              const draftTranscript =
                next[draft.thread.id] ?? createTranscript(created.acpSessionId);
              delete next[draft.thread.id];
              next[remoteId!] = {
                ...draftTranscript,
                sessionId: created.acpSessionId,
              };
              return next;
            });
            await client.attach(created.threadId);
            setTranscripts((current) => {
              const transcript =
                current[remoteId!] ?? createTranscript(created.acpSessionId);
              return transcript.entries.some(({ id }) => id === localPromptId)
                ? current
                : {
                    ...current,
                    [remoteId!]: queueOptimisticPrompt(
                      transcript,
                      localPromptId,
                      content,
                    ),
                  };
            });
            void refreshHost(draft.placement.hostId);
          } catch (cause) {
            if (!remoteId) {
              if (previousActiveThreadId) {
                activeThreadIdsRef.current.set(
                  draft.placement.hostId,
                  previousActiveThreadId,
                );
              } else activeThreadIdsRef.current.delete(draft.placement.hostId);
              setTranscripts((current) => ({
                ...current,
                [draft.thread.id]: createTranscript(draft.thread.id),
              }));
            } else {
              setTranscripts((current) => ({
                ...current,
                [remoteId!]: current[remoteId!]
                  ? reduceAcpEvent(current[remoteId!]!, {
                      type: "turn/failed",
                      error:
                        cause instanceof Error ? cause.message : String(cause),
                    })
                  : current[remoteId!],
              }));
            }
            reportActionError(cause);
            throw cause;
          } finally {
            creatingThreadRef.current = false;
            setCreatingThreadExecutionContextId(undefined);
            setBusy(false);
          }
          try {
            await client.prompt(content);
          } catch (cause) {
            setTranscripts((current) => ({
              ...current,
              [remoteId!]: current[remoteId!]
                ? reduceAcpEvent(current[remoteId!]!, {
                    type: "turn/failed",
                    error:
                      cause instanceof Error ? cause.message : String(cause),
                  })
                : current[remoteId!],
            }));
            reportActionError(cause);
            throw cause;
          }
          return;
        }
        if (!selectedId || !selected) return;
        const client = clientsRef.current.get(selected.hostId);
        if (!client || !transcripts[selectedId]) return;
        setTranscripts((current) => ({
          ...current,
          [selectedId]: current[selectedId]
            ? queueOptimisticPrompt(
                current[selectedId],
                `local-${crypto.randomUUID()}`,
                content,
              )
            : current[selectedId],
        }));
        await performAcpAction(async () => await client.prompt(content), true);
      },
      cancelPrompt: () =>
        performAcpAction(async () => {
          if (selected) {
            await clientsRef.current.get(selected.hostId)?.cancelPrompt();
          }
        }),
      respondToPermission: (requestId, optionId) =>
        selected
          ? clientsRef.current
              .get(selected.hostId)
              ?.respondToPermission(requestId, optionId)
          : undefined,
      respondToElicitation: (requestId, response) =>
        selected
          ? clientsRef.current
              .get(selected.hostId)
              ?.respondToElicitation(requestId, response)
          : undefined,
      setMode: (modeId) =>
        performAcpAction(async () => {
          if (selected) {
            await clientsRef.current.get(selected.hostId)?.setMode(modeId);
          }
        }),
      setConfigOption: (optionId, value) =>
        performAcpAction(async () => {
          if (selected) {
            await clientsRef.current
              .get(selected.hostId)
              ?.setConfigOption(optionId, value);
          }
        }),
    },
  };
}
