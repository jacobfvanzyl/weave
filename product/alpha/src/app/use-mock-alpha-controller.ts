import { useMemo, useState } from "react";
import { createAcpShowcaseTranscript } from "@/chat/acp-showcase";
import {
  type AcpTranscript,
  createTranscript,
  queueOptimisticPrompt,
  reduceAcpEvent,
} from "@/chat/acp-transcript";
import type {
  AlphaConnectionStatus,
  AlphaController,
  AlphaViewModel,
  AlphaExecutionContext,
} from "./alpha-controller";

export const MOCK_SCENARIOS = [
  "disconnected",
  "connecting",
  "reconnecting",
  "empty",
  "multi-host",
  "sidebar",
  "chat",
  "busy",
  "error",
] as const;

export type MockScenario = (typeof MOCK_SCENARIOS)[number];

const WORKSPACES: AlphaExecutionContext[] = [
  {
    id: "workspace-weave",
    executionContextId: "workspace-weave",
    hostId: "mock-host",
    hostName: "bazzite",
    name: "weave",
    threads: [
      {
        id: "thread-wve-47",
        threadId: "thread-wve-47",
        hostId: "mock-host",
        title: "Rework Weave interface",
        agentName: "weave-codex",
        hostName: "bazzite",
        supportsThreadLifecycle: true,
        status: "active",
        updatedAt: "2026-08-24T08:54:00.000Z",
        executionContextId: "workspace-weave",
      },
      {
        id: "thread-acp-host",
        threadId: "thread-acp-host",
        hostId: "mock-host",
        title: "Direct ACP host acceptance",
        agentName: "weave-codex",
        hostName: "macbook",
        supportsThreadLifecycle: true,
        status: "active",
        updatedAt: "2026-08-23T17:22:00.000Z",
        executionContextId: "workspace-weave",
      },
    ],
  },
  {
    id: "workspace-odin",
    executionContextId: "workspace-odin",
    hostId: "mock-host",
    hostName: "bazzite",
    name: "odin",
    threads: [
      {
        id: "thread-spray-upload",
        threadId: "thread-spray-upload",
        hostId: "mock-host",
        title: "Diagnose Spray Instruction upload",
        agentName: "weave-codex",
        hostName: "bazzite",
        supportsThreadLifecycle: true,
        status: "active",
        updatedAt: "2026-08-23T11:05:00.000Z",
        executionContextId: "workspace-odin",
      },
      {
        id: "thread-release",
        threadId: "thread-release",
        hostId: "mock-host",
        title: "Upcoming release changes",
        agentName: "weave-codex",
        hostName: "macbook",
        supportsThreadLifecycle: true,
        status: "active",
        updatedAt: "2026-08-22T14:30:00.000Z",
        executionContextId: "workspace-odin",
      },
    ],
  },
];

const scenarioConnection = (scenario: MockScenario): AlphaConnectionStatus => {
  if (scenario === "disconnected") return "disconnected";
  if (scenario === "connecting") return "connecting";
  if (scenario === "reconnecting") return "reconnecting";
  return "connected";
};

const scenarioTranscript = (scenario: MockScenario) => {
  if (
    scenario !== "sidebar" &&
    scenario !== "chat" &&
    scenario !== "reconnecting" &&
    scenario !== "busy" &&
    scenario !== "error"
  ) {
    return undefined;
  }
  const transcript = createAcpShowcaseTranscript();
  return scenario === "busy"
    ? reduceAcpEvent(transcript, { type: "turn/started" })
    : transcript;
};

export const mockScenarioFromLocation = (): MockScenario | undefined => {
  if (!import.meta.env.DEV && import.meta.env.VITE_ALPHA_ACCEPTANCE !== "1") {
    return undefined;
  }
  const requested = new URLSearchParams(window.location.search).get("mock");
  return MOCK_SCENARIOS.find((scenario) => scenario === requested);
};

export function useMockAlphaController(
  scenario: MockScenario,
): AlphaController {
  const [connectionStatus, setConnectionStatus] = useState(
    scenarioConnection(scenario),
  );
  const hostUrl = "bazzite";
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [archivedThreadsOpen, setArchivedThreadsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState(
    scenario === "sidebar" ||
      scenario === "chat" ||
      scenario === "reconnecting" ||
      scenario === "busy" ||
      scenario === "error"
      ? "thread-wve-47"
      : undefined,
  );
  const [loadingThreadId, setLoadingThreadId] = useState<string>();
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [composerFocusThreadId, setComposerFocusThreadId] = useState<string>();
  const [transcript, setTranscript] = useState<AcpTranscript | undefined>(() =>
    scenarioTranscript(scenario),
  );
  const [executionContexts, setExecutionContexts] = useState<AlphaExecutionContext[]>(
    scenario === "empty"
      ? WORKSPACES.map((workspace) => ({ ...workspace, threads: [] }))
      : scenario === "multi-host"
        ? WORKSPACES.map((workspace, index) =>
            index === 0
              ? {
                  ...workspace,
                  id: "repository:github.com/veezee/weave",
                  placements: [
                    {
                      id: "mock-host:workspace-weave",
                      executionContextId: "workspace-weave",
                      hostId: "mock-host",
                      hostName: "Bazzite",
                    },
                    {
                      id: "mock-macbook:workspace-weave",
                      executionContextId: "workspace-weave",
                      hostId: "mock-macbook",
                      hostName: "Jaco’s MacBook Air",
                    },
                  ],
                }
              : workspace,
          )
        : WORKSPACES,
  );
  const [archivedThreads, setArchivedThreads] = useState<
    AlphaExecutionContext["threads"]
  >([]);
  const [terminalTabs, setTerminalTabs] = useState([
    {
      terminalId: "mock-terminal-1",
      executionContextId: "workspace-weave",
      title: "zsh",
      status: "running" as const,
      cols: 100,
      rows: 30,
    },
  ]);
  const [activeTerminalId, setActiveTerminalId] = useState("mock-terminal-1");
  const terminalExecutionContext = executionContexts.find((workspace) =>
    workspace.threads.some(({ id }) => id === selectedThreadId),
  );
  const terminalThread = terminalExecutionContext?.threads.find(
    ({ id }) => id === selectedThreadId,
  );

  const model = useMemo<AlphaViewModel>(
    () => ({
      platform: "mock",
      connectionsLoaded: true,
      connectionsOpen,
      archivedThreadsOpen,
      connections: [
        {
          hostId: "mock-host",
          displayName: "Bazzite",
          hostUrl,
          status: connectionStatus,
          selected: true,
          supportsExecutionContextRegistration: true,
        },
        ...(scenario === "multi-host"
          ? [
              {
                hostId: "mock-macbook",
                displayName: "Jaco’s MacBook Air",
                hostUrl: "macbook",
                status: "connected" as const,
                selected: false,
                supportsExecutionContextRegistration: true,
              },
            ]
          : []),
      ],
      connection: {
        status: connectionStatus,
        hostUrl,
        hostName: "bazzite",
      },
      searchQuery,
      executionContexts,
      archivedThreads,
      showHostIdentity: scenario === "multi-host",
      selectedThreadId,
      loadingThreadId,
      composerFocusRequest,
      composerFocusThreadId,
      transcript,
      terminals: {
        scope:
          terminalExecutionContext && terminalThread
            ? {
                hostId: terminalThread.hostId,
                contextId: terminalThread.contextId ?? terminalExecutionContext.id,
                executionContextId: terminalThread.executionContextId,
              }
            : undefined,
        supported: true,
        tabs: selectedThreadId ? terminalTabs : [],
        activeTerminalId: selectedThreadId ? activeTerminalId : undefined,
        attachmentId: selectedThreadId ? "mock-attachment" : undefined,
        attachmentMode: selectedThreadId ? "shared" : undefined,
        loading: false,
      },
      busy: scenario === "busy" || Boolean(loadingThreadId),
      error:
        scenario === "error"
          ? "Portal lost the connection to this host."
          : undefined,
    }),
    [
      connectionStatus,
      archivedThreads,
      archivedThreadsOpen,
      connectionsOpen,
      hostUrl,
      scenario,
      searchQuery,
      loadingThreadId,
      composerFocusRequest,
      composerFocusThreadId,
      selectedThreadId,
      transcript,
      executionContexts,
      terminalTabs,
      activeTerminalId,
      terminalExecutionContext,
      terminalThread,
    ],
  );

  return {
    model,
    actions: {
      setSearchQuery,
      openConnections: () => setConnectionsOpen(true),
      closeConnections: () => setConnectionsOpen(false),
      openArchivedThreads: () => setArchivedThreadsOpen(true),
      closeArchivedThreads: () => setArchivedThreadsOpen(false),
      pairHost: () => undefined,
      forgetHost: () => undefined,
      reconnectHost: () => setConnectionStatus("connected"),
      refresh: () => undefined,
      addExecutionContext: async ({ hostId, path, name }) => {
        if (hostId !== "mock-host") throw new Error("Portal is unavailable.");
        if (!path.startsWith("/")) {
          throw new Error("ExecutionContext path must be absolute.");
        }
        const workspaceName =
          name?.trim() || path.split("/").filter(Boolean).at(-1);
        if (!workspaceName) {
          throw new Error("ExecutionContext path must name a directory.");
        }
        const executionContextId = `mock-workspace-${workspaceName
          .toLocaleLowerCase()
          .replaceAll(/[^a-z0-9]+/g, "-")}`;
        setExecutionContexts((current) =>
          current.some((workspace) => workspace.id === executionContextId)
            ? current
            : [
                ...current,
                {
                  id: executionContextId,
                  executionContextId,
                  hostId,
                  hostName: "bazzite",
                  name: workspaceName,
                  threads: [],
                },
              ],
        );
      },
      removeExecutionContext: (executionContextId, placementId) => {
        setExecutionContexts((current) =>
          current.flatMap((workspace) => {
            if (workspace.id !== executionContextId) return [workspace];
            const placements = workspace.placements ?? [
              {
                id: `${workspace.hostId}:${workspace.executionContextId}`,
                executionContextId: workspace.executionContextId,
                hostId: workspace.hostId,
                hostName: workspace.hostName,
              },
            ];
            const removed = placementId
              ? placements.find(({ id }) => id === placementId)
              : placements[0];
            if (!removed) return [workspace];
            const remaining = placements.filter(({ id }) => id !== removed.id);
            if (!remaining.length) return [];
            return [
              {
                ...workspace,
                placements: remaining,
                threads: workspace.threads.filter(
                  ({ hostId }) => hostId !== removed.hostId,
                ),
              },
            ];
          }),
        );
      },
      createThread: (executionContextId, placementId) => {
        const targetId = executionContextId || executionContexts[0]?.id;
        if (!targetId) return;
        const targetWorkspace = executionContexts.find(({ id }) => id === targetId);
        const placement = placementId
          ? targetWorkspace?.placements?.find(({ id }) => id === placementId)
          : undefined;
        const existingDraft = executionContexts
          .find(({ id }) => id === targetId)
          ?.threads.find(({ draft }) => draft);
        if (existingDraft) {
          setSelectedThreadId(existingDraft.id);
          setComposerFocusThreadId(existingDraft.id);
          setComposerFocusRequest((current) => current + 1);
          return;
        }
        const id = `mock-thread-${Date.now()}`;
        setExecutionContexts((current) =>
          current.map((workspace) =>
            workspace.id === targetId
              ? {
                  ...workspace,
                  threads: [
                    {
                      id,
                      threadId: id,
                      hostId: placement?.hostId ?? workspace.hostId,
                      title: "New thread",
                      agentName: "weave-codex",
                      hostName: placement?.hostName ?? workspace.hostName,
                      supportsThreadLifecycle: false,
                      status: "active",
                      updatedAt: new Date().toISOString(),
                      executionContextId:
                        placement?.executionContextId ?? workspace.executionContextId,
                      draft: true,
                    },
                    ...workspace.threads,
                  ],
                }
              : {
                  ...workspace,
                  threads: workspace.threads.filter(({ draft }) => !draft),
                },
          ),
        );
        setSelectedThreadId(id);
        setTranscript(createTranscript(id));
        setComposerFocusThreadId(id);
        setComposerFocusRequest((current) => current + 1);
        const workspace = executionContexts.find(
          (candidate) => candidate.id === targetId,
        );
        if (workspace) {
        }
      },
      selectThread: async (threadId) => {
        const thread = executionContexts
          .flatMap((workspace) => workspace.threads)
          .find((candidate) => candidate.id === threadId);
        if (thread?.draft) {
          setSelectedThreadId(threadId);
          setComposerFocusThreadId(threadId);
          setComposerFocusRequest((current) => current + 1);
          return;
        }
        setExecutionContexts((current) =>
          current.map((workspace) => ({
            ...workspace,
            threads: workspace.threads.filter(({ draft }) => !draft),
          })),
        );
        const workspace = executionContexts.find(
          (candidate) => candidate.id === thread?.executionContextId,
        );
        setSelectedThreadId(threadId);
        setLoadingThreadId(threadId);
        setTranscript(undefined);
        await new Promise((resolve) => setTimeout(resolve, 600));
        setTranscript(createAcpShowcaseTranscript());
        setLoadingThreadId(undefined);
      },
      archiveThread: (threadId) => {
        const thread = executionContexts
          .flatMap((workspace) => workspace.threads)
          .find((candidate) => candidate.id === threadId);
        if (!thread) return;
        setArchivedThreads((current) => [
          {
            ...thread,
            status: "archived",
            archivedAt: new Date().toISOString(),
          },
          ...current,
        ]);
        setExecutionContexts((current) =>
          current.map((workspace) => ({
            ...workspace,
            threads: workspace.threads.filter(
              (candidate) => candidate.id !== threadId,
            ),
          })),
        );
        if (selectedThreadId === threadId) {
          setSelectedThreadId(undefined);
          setTranscript(undefined);
        }
      },
      restoreThread: (threadId) => {
        const thread = archivedThreads.find(
          (candidate) => candidate.id === threadId,
        );
        if (!thread) return;
        setArchivedThreads((current) =>
          current.filter((candidate) => candidate.id !== threadId),
        );
        setExecutionContexts((current) =>
          current.map((workspace) =>
            workspace.executionContextId === thread.executionContextId
              ? {
                  ...workspace,
                  threads: [
                    {
                      ...thread,
                      status: "active",
                      archivedAt: undefined,
                    },
                    ...workspace.threads,
                  ],
                }
              : workspace,
          ),
        );
      },
      showTerminals: () => undefined,
      hideTerminals: () => undefined,
      createTerminal: () => {
        const terminalId = `mock-terminal-${terminalTabs.length + 1}`;
        setTerminalTabs((current) => [
          ...current,
          {
            terminalId,
            executionContextId: "workspace-weave",
            title: "zsh",
            status: "running",
            cols: 100,
            rows: 30,
          },
        ]);
        setActiveTerminalId(terminalId);
      },
      selectTerminal: setActiveTerminalId,
      closeTerminal: (terminalId) => {
        setTerminalTabs((current) => {
          const next = current.filter(
            (terminal) => terminal.terminalId !== terminalId,
          );
          setActiveTerminalId(next[0]?.terminalId ?? "");
          return next;
        });
      },
      retryTerminalControl: () => undefined,
      inputTerminal: () => undefined,
      resizeTerminal: () => undefined,
      sendPrompt: (text) => {
        setExecutionContexts((current) =>
          current.map((workspace) => ({
            ...workspace,
            threads: workspace.threads.map((thread) =>
              thread.id === selectedThreadId
                ? {
                    ...thread,
                    draft: undefined,
                    supportsThreadLifecycle: true,
                  }
                : thread,
            ),
          })),
        );
        setTranscript((current) =>
          current
            ? reduceAcpEvent(
                queueOptimisticPrompt(current, `mock-local-${Date.now()}`, [
                  { type: "text", text },
                ]),
                { type: "turn/started" },
              )
            : current,
        );
      },
      cancelPrompt: () =>
        setTranscript((current) =>
          current
            ? reduceAcpEvent(current, {
                type: "turn/stopped",
                stopReason: "cancelled",
              })
            : current,
        ),
      respondToPermission: (requestId, optionId) =>
        setTranscript((current) =>
          current
            ? reduceAcpEvent(current, {
                type: "permission/resolved",
                requestId,
                optionId,
              })
            : current,
        ),
      respondToElicitation: (requestId, response) =>
        setTranscript((current) =>
          current
            ? reduceAcpEvent(current, {
                type: "elicitation/resolved",
                requestId,
                response,
              })
            : current,
        ),
      setMode: (modeId) =>
        setTranscript((current) =>
          current
            ? reduceAcpEvent(current, {
                type: "session/update",
                update: {
                  sessionUpdate: "current_mode_update",
                  currentModeId: modeId,
                },
              })
            : current,
        ),
      setConfigOption: (optionId, value) =>
        setTranscript((current) => {
          if (!current) return current;
          return {
            ...current,
            configOptions: current.configOptions.map((option) =>
              option.id === optionId
                ? ({ ...option, currentValue: value } as typeof option)
                : option,
            ),
          };
        }),
    },
  };
}
