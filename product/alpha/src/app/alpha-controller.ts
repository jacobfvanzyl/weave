import type { CreateElicitationResponse } from '@agentclientprotocol/sdk';
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
  projectId: string;
};

export type AlphaProject = {
  id: string;
  name: string;
  threads: AlphaThread[];
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
  projects: AlphaProject[];
  selectedThreadId?: string;
  transcript?: AcpTranscript;
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
  createThread(projectId?: string): Promise<void> | void;
  selectThread(threadId: string): Promise<void> | void;
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
  model.projects
    .flatMap((project) => project.threads)
    .find((thread) => thread.id === model.selectedThreadId);
