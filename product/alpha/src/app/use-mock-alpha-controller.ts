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
  AlphaWorkspace,
  AlphaWorkspaceFiles,
} from "./alpha-controller";

export const MOCK_SCENARIOS = [
  "disconnected",
  "connecting",
  "reconnecting",
  "empty",
  "sidebar",
  "chat",
  "busy",
  "error",
] as const;

export type MockScenario = typeof MOCK_SCENARIOS[number];

const WORKSPACES: AlphaWorkspace[] = [
  {
    id: "workspace-weave",
    workspaceId: "workspace-weave",
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
        workspaceId: "workspace-weave",
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
        workspaceId: "workspace-weave",
      },
    ],
  },
  {
    id: "workspace-odin",
    workspaceId: "workspace-odin",
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
        workspaceId: "workspace-odin",
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
        workspaceId: "workspace-odin",
      },
    ],
  },
];

const MOCK_WORKSPACE_ENTRIES: Record<
  string,
  AlphaWorkspaceFiles["directories"][string]["entries"]
> = {
  "": [
    { name: "src", path: "src", type: "directory" },
    { name: "README.md", path: "README.md", type: "file", size: 36 },
  ],
  src: [{ name: "main.ts", path: "src/main.ts", type: "file", size: 44 }],
};

const MOCK_FILE_CONTENT: Record<string, string> = {
  "README.md": "# Mock Workspace\n\nBrowse files locally.\n",
  "src/main.ts": "export const marker = 'WVE42_MOCK_WORKSPACE';\n",
};

const scenarioConnection = (scenario: MockScenario): AlphaConnectionStatus => {
  if (scenario === "disconnected") return "disconnected";
  if (scenario === "connecting") return "connecting";
  if (scenario === "reconnecting") return "reconnecting";
  return "connected";
};

const scenarioTranscript = (scenario: MockScenario) => {
  if (
    scenario !== "sidebar" && scenario !== "chat" &&
    scenario !== "reconnecting" && scenario !== "busy" &&
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
  if (!import.meta.env.DEV) return undefined;
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
    scenario === "sidebar" || scenario === "chat" ||
      scenario === "reconnecting" || scenario === "busy" ||
      scenario === "error"
      ? "thread-wve-47"
      : undefined,
  );
  const [loadingThreadId, setLoadingThreadId] = useState<string>();
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [composerFocusThreadId, setComposerFocusThreadId] = useState<string>();
  const [transcript, setTranscript] = useState<AcpTranscript | undefined>(
    () => scenarioTranscript(scenario),
  );
  const [workspaceFiles, setWorkspaceFiles] = useState<
    AlphaWorkspaceFiles | undefined
  >(() =>
    selectedThreadId
      ? {
        workspaceId: "workspace-weave",
        workspaceName: "weave",
        openFiles: [],
        directories: {
          "": { entries: MOCK_WORKSPACE_ENTRIES[""], truncated: false },
        },
      }
      : undefined
  );
  const [workspaces, setWorkspaces] = useState<AlphaWorkspace[]>(
    scenario === "empty"
      ? WORKSPACES.map((workspace) => ({ ...workspace, threads: [] }))
      : WORKSPACES,
  );
  const [archivedThreads, setArchivedThreads] = useState<
    AlphaWorkspace["threads"]
  >([]);
  const [terminalTabs, setTerminalTabs] = useState([
    {
      terminalId: "mock-terminal-1",
      workspaceId: "workspace-weave",
      title: "zsh",
      status: "running" as const,
      cols: 100,
      rows: 30,
    },
  ]);
  const [activeTerminalId, setActiveTerminalId] = useState(
    "mock-terminal-1",
  );
  const [terminalData, setTerminalData] = useState(
    "Welcome to Weave\r\n$ ",
  );

  const model = useMemo<AlphaViewModel>(() => ({
    platform: "mock",
    connectionsLoaded: true,
    connectionsOpen,
    archivedThreadsOpen,
    connections: [{
      hostId: "mock-host",
      displayName: "bazzite",
      hostUrl,
      status: connectionStatus,
      selected: true,
      supportsProjectRegistration: true,
    }],
    connection: {
      status: connectionStatus,
      hostUrl,
      hostName: "bazzite",
    },
    searchQuery,
    workspaces,
    archivedThreads,
    showHostIdentity: false,
    selectedThreadId,
    loadingThreadId,
    composerFocusRequest,
    composerFocusThreadId,
    transcript,
    workspaceFiles,
    terminals: {
      hostId: "mock-host",
      workspaceId: selectedThreadId ? "workspace-weave" : undefined,
      supported: true,
      tabs: selectedThreadId ? terminalTabs : [],
      activeTerminalId: selectedThreadId ? activeTerminalId : undefined,
      attachmentId: selectedThreadId ? "mock-attachment" : undefined,
      attachmentMode: selectedThreadId ? "control" : undefined,
      data: selectedThreadId ? terminalData : "",
      dataEpoch: 1,
      dataOffset: 0,
      loading: false,
    },
    busy: scenario === "busy" || Boolean(loadingThreadId),
    error: scenario === "error"
      ? "Portal lost the connection to this host."
      : undefined,
  }), [
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
    workspaceFiles,
    workspaces,
    terminalTabs,
    activeTerminalId,
    terminalData,
  ]);

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
      addProject: async ({ hostId, path, name }) => {
        if (hostId !== "mock-host") throw new Error("Portal is unavailable.");
        if (!path.startsWith("/")) {
          throw new Error("Project path must be absolute.");
        }
        const workspaceName = name?.trim() ||
          path.split("/").filter(Boolean).at(-1);
        if (!workspaceName) {
          throw new Error("Project path must name a directory.");
        }
        const workspaceId = `mock-workspace-${
          workspaceName.toLocaleLowerCase().replaceAll(/[^a-z0-9]+/g, "-")
        }`;
        setWorkspaces((current) =>
          current.some((workspace) => workspace.id === workspaceId)
            ? current
            : [...current, {
              id: workspaceId,
              workspaceId,
              hostId,
              hostName: "bazzite",
              name: workspaceName,
              threads: [],
            }]
        );
      },
      createThread: (workspaceId) => {
        const targetId = workspaceId || workspaces[0]?.id;
        if (!targetId) return;
        const existingDraft = workspaces
          .find(({ id }) => id === targetId)
          ?.threads.find(({ draft }) => draft);
        if (existingDraft) {
          setSelectedThreadId(existingDraft.id);
          setComposerFocusThreadId(existingDraft.id);
          setComposerFocusRequest((current) => current + 1);
          return;
        }
        const id = `mock-thread-${Date.now()}`;
        setWorkspaces((current) =>
          current.map((workspace) =>
            workspace.id === targetId
              ? {
                ...workspace,
                threads: [{
                  id,
                  threadId: id,
                  hostId: "mock-host",
                  title: "New thread",
                  agentName: "weave-codex",
                  hostName: "bazzite",
                  supportsThreadLifecycle: false,
                  status: "active",
                  updatedAt: new Date().toISOString(),
                  workspaceId: workspace.id,
                  draft: true,
                }, ...workspace.threads],
              }
              : {
                ...workspace,
                threads: workspace.threads.filter(({ draft }) => !draft),
              }
          )
        );
        setSelectedThreadId(id);
        setTranscript(createTranscript(id));
        setComposerFocusThreadId(id);
        setComposerFocusRequest((current) => current + 1);
        const workspace = workspaces.find((candidate) =>
          candidate.id === targetId
        );
        if (workspace) {
          setWorkspaceFiles({
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            openFiles: [],
            directories: {
              "": { entries: MOCK_WORKSPACE_ENTRIES[""], truncated: false },
            },
          });
        }
      },
      selectThread: async (threadId) => {
        const thread = workspaces.flatMap((workspace) => workspace.threads)
          .find((candidate) => candidate.id === threadId);
        if (thread?.draft) {
          setSelectedThreadId(threadId);
          setComposerFocusThreadId(threadId);
          setComposerFocusRequest((current) => current + 1);
          return;
        }
        setWorkspaces((current) =>
          current.map((workspace) => ({
            ...workspace,
            threads: workspace.threads.filter(({ draft }) => !draft),
          }))
        );
        const workspace = workspaces.find((candidate) =>
          candidate.id === thread?.workspaceId
        );
        setSelectedThreadId(threadId);
        setLoadingThreadId(threadId);
        setTranscript(undefined);
        setWorkspaceFiles(undefined);
        await new Promise((resolve) => setTimeout(resolve, 600));
        setTranscript(createAcpShowcaseTranscript());
        setWorkspaceFiles(
          workspace
            ? {
              workspaceId: workspace.id,
              workspaceName: workspace.name,
              openFiles: [],
              directories: {
                "": { entries: MOCK_WORKSPACE_ENTRIES[""], truncated: false },
              },
            }
            : undefined,
        );
        setLoadingThreadId(undefined);
      },
      archiveThread: (threadId) => {
        const thread = workspaces.flatMap((workspace) => workspace.threads)
          .find((candidate) => candidate.id === threadId);
        if (!thread) return;
        setArchivedThreads((current) => [{
          ...thread,
          status: "archived",
          archivedAt: new Date().toISOString(),
        }, ...current]);
        setWorkspaces((current) =>
          current.map((workspace) => ({
            ...workspace,
            threads: workspace.threads.filter((candidate) =>
              candidate.id !== threadId
            ),
          }))
        );
        if (selectedThreadId === threadId) {
          setSelectedThreadId(undefined);
          setTranscript(undefined);
          setWorkspaceFiles(undefined);
        }
      },
      restoreThread: (threadId) => {
        const thread = archivedThreads.find((candidate) =>
          candidate.id === threadId
        );
        if (!thread) return;
        setArchivedThreads((current) =>
          current.filter((candidate) => candidate.id !== threadId)
        );
        setWorkspaces((current) =>
          current.map((workspace) =>
            workspace.workspaceId === thread.workspaceId
              ? {
                ...workspace,
                threads: [{
                  ...thread,
                  status: "active",
                  archivedAt: undefined,
                }, ...workspace.threads],
              }
              : workspace
          )
        );
      },
      openWorkspaceDirectory: (path) => {
        setWorkspaceFiles((current) =>
          current
            ? {
              ...current,
              directories: current.directories[path] ? current.directories : {
                ...current.directories,
                [path]: {
                  entries: MOCK_WORKSPACE_ENTRIES[path] ?? [],
                  truncated: false,
                },
              },
            }
            : current
        );
      },
      openWorkspaceFile: (path) => {
        const content = MOCK_FILE_CONTENT[path];
        if (content === undefined) return;
        setWorkspaceFiles((current) =>
          current
            ? {
              ...current,
              openFiles: current.openFiles.some((file) => file.path === path)
                ? current.openFiles
                : [...current.openFiles, {
                  kind: "text",
                  path,
                  content,
                  contentHash: "0".repeat(64),
                  size: new TextEncoder().encode(content).byteLength,
                  changed: false,
                }],
              activeFilePath: path,
            }
            : current
        );
      },
      activateWorkspaceFile: (path) => {
        setWorkspaceFiles((current) =>
          current?.openFiles.some((file) => file.path === path)
            ? { ...current, activeFilePath: path }
            : current
        );
      },
      closeWorkspaceFile: (path) => {
        setWorkspaceFiles((current) => {
          if (!current) return current;
          const closingIndex = current.openFiles.findIndex((file) =>
            file.path === path
          );
          if (closingIndex === -1) return current;
          return {
            ...current,
            openFiles: current.openFiles.filter((file) => file.path !== path),
            activeFilePath: current.activeFilePath === path
              ? current.openFiles[closingIndex + 1]?.path ??
                current.openFiles[closingIndex - 1]?.path
              : current.activeFilePath,
          };
        });
      },
      reloadWorkspaceFile: () => {
        setWorkspaceFiles((current) =>
          current
            ? {
              ...current,
              openFiles: current.openFiles.map((file) =>
                file.kind === "text" && file.path === current.activeFilePath
                  ? { ...file, changed: false }
                  : file
              ),
            }
            : current
        );
      },
      showTerminals: () => undefined,
      hideTerminals: () => undefined,
      createTerminal: () => {
        const terminalId = `mock-terminal-${terminalTabs.length + 1}`;
        setTerminalTabs((current) => [...current, {
          terminalId,
          workspaceId: "workspace-weave",
          title: "zsh",
          status: "running",
          cols: 100,
          rows: 30,
        }]);
        setActiveTerminalId(terminalId);
        setTerminalData("$ ");
      },
      selectTerminal: setActiveTerminalId,
      closeTerminal: (terminalId) => {
        setTerminalTabs((current) => {
          const next = current.filter((terminal) =>
            terminal.terminalId !== terminalId
          );
          setActiveTerminalId(next[0]?.terminalId ?? "");
          return next;
        });
      },
      retryTerminalControl: () => undefined,
      inputTerminal: (data) =>
        setTerminalData((current) => `${current}${data}`),
      resizeTerminal: () => undefined,
      sendPrompt: (text) => {
        setWorkspaces((current) =>
          current.map((workspace) => ({
            ...workspace,
            threads: workspace.threads.map((thread) =>
              thread.id === selectedThreadId
                ? {
                  ...thread,
                  draft: undefined,
                  supportsThreadLifecycle: true,
                }
                : thread
            ),
          }))
        );
        setTranscript((current) =>
          current
            ? reduceAcpEvent(
              queueOptimisticPrompt(
                current,
                `mock-local-${Date.now()}`,
                [{ type: "text", text }],
              ),
              { type: "turn/started" },
            )
            : current
        );
      },
      cancelPrompt: () =>
        setTranscript((current) =>
          current
            ? reduceAcpEvent(current, {
              type: "turn/stopped",
              stopReason: "cancelled",
            })
            : current
        ),
      respondToPermission: (requestId, optionId) =>
        setTranscript((current) =>
          current
            ? reduceAcpEvent(current, {
              type: "permission/resolved",
              requestId,
              optionId,
            })
            : current
        ),
      respondToElicitation: (requestId, response) =>
        setTranscript((current) =>
          current
            ? reduceAcpEvent(current, {
              type: "elicitation/resolved",
              requestId,
              response,
            })
            : current
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
            : current
        ),
      setConfigOption: (optionId, value) =>
        setTranscript((current) => {
          if (!current) return current;
          return {
            ...current,
            configOptions: current.configOptions.map((option) =>
              option.id === optionId
                ? { ...option, currentValue: value } as typeof option
                : option
            ),
          };
        }),
    },
  };
}
