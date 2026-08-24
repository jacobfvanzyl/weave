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
};

export type AlphaController = {
  model: AlphaViewModel;
  actions: AlphaActions;
};

export const selectedThread = (model: AlphaViewModel) =>
  model.projects
    .flatMap((project) => project.threads)
    .find((thread) => thread.id === model.selectedThreadId);
