export type ProductId = 'code' | 'notes' | 'chat';

export type NotesStorageMetadata = {
  kind: string;
  portalId?: string;
  rootId?: string;
  vaultPath?: string;
  workspacePath?: string;
  [key: string]: unknown;
};

export type Workspace = {
  id: string;
  projectId: string;
  portalId?: string;
  mountId?: string;
  workspaceKind: 'primary' | 'worktree';
  source?: 'primary' | 'git' | 'notes' | 'adopted' | 'legacy';
  name: string;
  path?: string;
  branch?: string;
  head?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  detached?: boolean;
  baseBranch?: string;
  locked?: boolean;
  sortOrder?: number;
  status: 'ready' | 'offline' | 'creating' | 'dirty' | 'missing' | 'virtual' | 'error';
  lastError?: string;
  hidden?: boolean;
  systemKind?: 'adHoc';
  createdAt: string;
  updatedAt: string;
};

export type Project = {
  id: string;
  userId: string;
  name: string;
  projectKind: 'general' | 'git' | 'notes';
  description?: string;
  portalId?: string;
  portalRootId?: string;
  repoPath?: string;
  vaultPath?: string;
  notesStorage?: NotesStorageMetadata;
  gitRemote?: string;
  defaultBranch?: string;
  rootPathHint?: string;
  defaultProfileId?: string;
  sortOrder?: number;
  agentInstructions?: {
    path: string;
    content: string;
    size?: number;
    updatedAt?: string;
    checkedAt?: string;
  };
  hidden?: boolean;
  systemKind?: 'adHoc';
  workspaces: Workspace[];
  createdAt: string;
  updatedAt: string;
};

export const productForProject = (project: Pick<Project, 'projectKind' | 'systemKind'>): ProductId => {
  if (project.systemKind === 'adHoc') return 'code';
  if (project.projectKind === 'git') return 'code';
  if (project.projectKind === 'notes') return 'notes';
  return 'chat';
};
