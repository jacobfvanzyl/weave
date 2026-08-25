import type { CreateElicitationResponse } from '@agentclientprotocol/sdk';
import type { WorkspaceFileEntry, WorkspaceFileMetadata } from '@weave/product-protocol';
import type { AcpTranscript } from '@/chat/acp-transcript';

export type AlphaConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected';

export type AlphaThread = {
  id: string;
  title: string;
  agentName: string;
  hostName: string;
  status: 'active' | 'closed';
  updatedAt: string;
  workspaceId: string;
};

export type AlphaWorkspace = {
  id: string;
  name: string;
  threads: AlphaThread[];
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
  connection: {
    status: AlphaConnectionStatus;
    hostUrl: string;
    hostName: string;
  };
  accessToken: string;
  searchQuery: string;
  workspaces: AlphaWorkspace[];
  selectedThreadId?: string;
  transcript?: AcpTranscript;
  workspaceFiles?: AlphaWorkspaceFiles;
  busy: boolean;
  error?: string;
};

export type AlphaActions = {
  setHostUrl(value: string): void;
  setAccessToken(value: string): void;
  setSearchQuery(value: string): void;
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
