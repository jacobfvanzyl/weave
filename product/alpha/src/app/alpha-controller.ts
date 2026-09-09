import type { CreateElicitationResponse } from "@agentclientprotocol/sdk";
import type {
  RepositoryIdentity,
  WorkspaceFileEntry,
  WorkspaceFileMetadata,
} from "@weave/product-protocol";
import type { AcpTranscript } from "@/chat/acp-transcript";
import type { WorkspaceCompositionActions, WorkspaceCompositionsModel } from "./use-workspace-compositions";
import type { AlphaTerminalClient } from "./use-alpha-terminals";
import type { AlphaTerminalsModel } from "./use-alpha-terminals";

export type AlphaConnectionStatus =
  "disconnected" | "connecting" | "reconnecting" | "connected";

export type AlphaThread = {
  id: string;
  threadId: string;
  hostId: string;
  title: string;
  agentName: string;
  hostName: string;
  supportsThreadLifecycle?: boolean;
  status: "active" | "archived" | "closed";
  updatedAt: string;
  archivedAt?: string;
  workspaceId: string;
  projectId?: string;
  worktreeId?: string;
  draft?: boolean;
};

export type AlphaWorkspacePlacement = {
  id: string;
  workspaceId: string;
  hostId: string;
  hostName: string;
};

export type AlphaWorkspace = {
  id: string;
  workspaceId: string;
  hostId: string;
  hostName: string;
  name: string;
  canonicalPath?: string;
  repositoryIdentity?: RepositoryIdentity;
  placements?: AlphaWorkspacePlacement[];
  threads: AlphaThread[];
};

export type AlphaHostConnection = {
  hostId: string;
  displayName: string;
  hostUrl: string;
  status: AlphaConnectionStatus;
  selected: boolean;
  error?: string;
  supportsProjectRegistration?: boolean;
};

export type AlphaWorkspaceFileTab =
  | (WorkspaceFileMetadata & {
      kind: "text";
      content: string;
      changed: boolean;
    })
  | {
      kind: "unavailable";
      path: string;
      reason: "unsupported" | "too-large";
    };

export type AlphaWorkspaceFiles = {
  workspaceId: string;
  workspaceName: string;
  workspaceRootName?: string;
  directories: Record<
    string,
    {
      entries: WorkspaceFileEntry[];
      truncated: boolean;
    }
  >;
  openFiles: AlphaWorkspaceFileTab[];
  activeFilePath?: string;
};

export type AlphaViewModel = {
  platform: string;
  connectionsLoaded: boolean;
  connectionsOpen: boolean;
  archivedThreadsOpen: boolean;
  connections: AlphaHostConnection[];
  connection: {
    status: AlphaConnectionStatus;
    hostUrl: string;
    hostName: string;
  };
  searchQuery: string;
  workspaces: AlphaWorkspace[];
  archivedThreads: AlphaThread[];
  showHostIdentity: boolean;
  selectedThreadId?: string;
  loadingThreadId?: string;
  creatingThreadWorkspaceId?: string;
  composerFocusRequest?: number;
  composerFocusThreadId?: string;
  transcript?: AcpTranscript;
  workspaceFiles?: AlphaWorkspaceFiles;
  terminals?: AlphaTerminalsModel;
  workspaceCompositions?: WorkspaceCompositionsModel;
  busy: boolean;
  error?: string;
};

export type AlphaActions = {
  setSearchQuery(value: string): void;
  openConnections(): void;
  closeConnections(): void;
  openArchivedThreads(): void;
  closeArchivedThreads(): void;
  pairHost(input: {
    pairingToken: string;
    hostUrl?: string;
    deviceLabel: string;
  }): Promise<void> | void;
  forgetHost(hostId: string): Promise<void> | void;
  reconnectHost(hostId: string): Promise<void> | void;
  refresh(): Promise<void> | void;
  addProject?(input: {
    hostId: string;
    path: string;
    name?: string;
  }): Promise<void> | void;
  removeProject?(
    workspaceId: string,
    placementId?: string,
  ): Promise<void> | void;
  createThread(
    workspaceId?: string,
    placementId?: string,
  ): Promise<void> | void;
  selectThread(threadId: string): Promise<void> | void;
  archiveThread(threadId: string): Promise<void> | void;
  restoreThread(threadId: string): Promise<void> | void;
  openWorkspaceDirectory?(path: string): Promise<void> | void;
  openWorkspaceFile?(path: string): Promise<void> | void;
  activateWorkspaceFile?(path: string): void;
  closeWorkspaceFile?(path: string): void;
  reloadWorkspaceFile?(): Promise<void> | void;
  showTerminals?(): Promise<void> | void;
  hideTerminals?(): Promise<void> | void;
  createTerminal?(): Promise<void> | void;
  selectTerminal?(terminalId: string): Promise<void> | void;
  closeTerminal?(terminalId: string): Promise<void> | void;
  retryTerminalControl?(): Promise<void> | void;
  inputTerminal?(data: string): Promise<void> | void;
  resizeTerminal?(cols: number, rows: number): Promise<void> | void;
  sendPrompt(text: string): Promise<void> | void;
  cancelPrompt(): Promise<void> | void;
  respondToPermission(requestId: string, optionId: string): void;
  respondToElicitation(
    requestId: string,
    response: CreateElicitationResponse,
  ): void;
  setMode(modeId: string): Promise<void> | void;
  setConfigOption(
    optionId: string,
    value: string | boolean,
  ): Promise<void> | void;
};

export type AlphaController = {
  model: AlphaViewModel;
  workspaceActions?: WorkspaceCompositionActions;
  terminalClient?(hostId: string): AlphaTerminalClient | undefined;
  actions: AlphaActions;
};

export const selectedThread = (model: AlphaViewModel) =>
  model.workspaces
    .flatMap((workspace) => workspace.threads)
    .find((thread) => thread.id === model.selectedThreadId);
