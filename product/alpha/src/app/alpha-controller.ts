import type { CreateElicitationResponse } from '@agentclientprotocol/sdk';
import type { WorkspaceFileEntry, WorkspaceFileMetadata } from '@weave/product-protocol';
import type { AcpTranscript } from '@/chat/acp-transcript';

export type AlphaConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected';

export type AlphaThread = {
  id: string;
  threadId: string;
  hostId: string;
  title: string;
  agentName: string;
  hostName: string;
  status: 'active' | 'closed';
  updatedAt: string;
  workspaceId: string;
};

export type AlphaWorkspace = {
  id: string;
  workspaceId: string;
  hostId: string;
  name: string;
  threads: AlphaThread[];
};

export type AlphaHostConnection = {
  hostId: string;
  displayName: string;
  hostUrl: string;
  status: AlphaConnectionStatus;
  selected: boolean;
};

export type AlphaWorkspaceFileTab =
  | (WorkspaceFileMetadata & {
    kind: 'text';
    content: string;
    changed: boolean;
  })
  | {
    kind: 'unavailable';
    path: string;
    reason: 'unsupported' | 'too-large';
  };

export type AlphaWorkspaceFiles = {
  workspaceId: string;
  workspaceName: string;
  directories: Record<string, {
    entries: WorkspaceFileEntry[];
    truncated: boolean;
  }>;
  openFiles: AlphaWorkspaceFileTab[];
  activeFilePath?: string;
};

export type AlphaViewModel = {
  platform: string;
  connectionsLoaded: boolean;
  connectionsOpen: boolean;
  connections: AlphaHostConnection[];
  connection: {
    status: AlphaConnectionStatus;
    hostUrl: string;
    hostName: string;
  };
  searchQuery: string;
  workspaces: AlphaWorkspace[];
  selectedThreadId?: string;
  transcript?: AcpTranscript;
  workspaceFiles?: AlphaWorkspaceFiles;
  busy: boolean;
  error?: string;
};

export type AlphaActions = {
  setSearchQuery(value: string): void;
  openConnections(): void;
  closeConnections(): void;
  pairHost(input: { pairingCode: string; hostUrl?: string; deviceLabel: string }): Promise<void> | void;
  selectHost(hostId: string): Promise<void> | void;
  forgetHost(hostId: string): Promise<void> | void;
  connect(): Promise<void> | void;
  disconnect(): void;
  refresh(): Promise<void> | void;
  createThread(workspaceId?: string): Promise<void> | void;
  selectThread(threadId: string): Promise<void> | void;
  openWorkspaceDirectory(path: string): Promise<void> | void;
  openWorkspaceFile(path: string): Promise<void> | void;
  activateWorkspaceFile(path: string): void;
  closeWorkspaceFile(path: string): void;
  reloadWorkspaceFile(): Promise<void> | void;
  sendPrompt(text: string): Promise<void> | void;
  cancelPrompt(): Promise<void> | void;
  respondToPermission(requestId: string, optionId: string): void;
  respondToElicitation(requestId: string, response: CreateElicitationResponse): void;
  setMode(modeId: string): Promise<void> | void;
  setConfigOption(optionId: string, value: string | boolean): Promise<void> | void;
};

export type AlphaController = {
  model: AlphaViewModel;
  actions: AlphaActions;
};

export const selectedThread = (model: AlphaViewModel) =>
  model.workspaces
    .flatMap((workspace) => workspace.threads)
    .find((thread) => thread.id === model.selectedThreadId);
