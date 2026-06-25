export type NotesStorageMetadata = {
  kind: string;
  portalId?: string;
  rootId?: string;
  vaultPath?: string;
  workspacePath?: string;
  [key: string]: unknown;
};

export type NotesWorkspace = {
  id: string;
  projectId?: string;
  portalId?: string;
  path?: string;
};

export type NotesProject = {
  id: string;
  userId: string;
  projectKind: 'general' | 'git' | 'notes';
  portalId?: string;
  portalRootId?: string;
  repoPath?: string;
  vaultPath?: string;
  notesStorage?: NotesStorageMetadata;
  workspaces: NotesWorkspace[];
};

export type NotesVaultTarget = {
  projectId?: string;
  workspaceId?: string;
  portalId?: string;
  rootId?: string;
  repoPath?: string;
  workspacePath?: string;
};

export type NotesVaultEntry = {
  name: string;
  path: string;
  type: 'directory' | 'file' | 'other';
  hidden?: boolean;
  size?: number;
  mtimeMs?: number;
};

export type NotesVaultNote = {
  path: string;
  title: string;
  headings: string[];
  tags: string[];
  links: string[];
  embeds: string[];
  properties: Record<string, string>;
  mtimeMs?: number;
  size?: number;
  preview?: string;
};

export type NotesVaultAttachment = {
  path: string;
  name: string;
  mediaType: 'image' | 'audio' | 'video' | 'pdf' | 'excalidraw' | 'other';
  size?: number;
  mtimeMs?: number;
};

export type NotesVaultIndexInput = {
  path?: string;
};

export type NotesVaultIndexResult = {
  path: string;
  entries: NotesVaultEntry[];
  notes: NotesVaultNote[];
  attachments: NotesVaultAttachment[];
  backlinks: Record<string, string[]>;
  checkedAt: string;
  ok?: boolean;
};

export type NotesVaultReadInput = {
  path: string;
};

export type NotesVaultFile = {
  path: string;
  content: string;
  version: string;
  size?: number;
  mtimeMs?: number;
  ok?: boolean;
};

export type NotesVaultWriteInput = {
  path: string;
  content?: string;
  version?: string;
};

export type NotesVaultWriteResult = {
  path: string;
  version: string;
  size?: number;
  mtimeMs?: number;
  ok?: boolean;
};

export type NotesVaultMkdirInput = {
  path: string;
};

export type NotesVaultMoveInput = {
  fromPath: string;
  toPath: string;
  overwrite?: boolean;
};

export type NotesVaultDeleteInput = {
  path: string;
  recursive?: boolean;
};

export type NotesVaultUploadInput = {
  path: string;
  base64Content?: string;
  contentType?: string;
};

export type NotesVaultOperationResult = {
  ok?: boolean;
  path?: string;
};

export type NotesVaultBackendOptions = {
  timeoutMs?: number;
};

export type ResolvedNotesVaultBinding = {
  resourceId: string;
  projectId: string;
  workspaceId: string;
  storage: NotesStorageMetadata;
  project: NotesProject;
  workspace: NotesWorkspace;
};

export type NotesVaultBackend = {
  kind: string;
  index: (
    binding: ResolvedNotesVaultBinding,
    input: NotesVaultIndexInput,
    options?: NotesVaultBackendOptions,
  ) => Promise<NotesVaultIndexResult>;
  read: (
    binding: ResolvedNotesVaultBinding,
    input: NotesVaultReadInput,
    options?: NotesVaultBackendOptions,
  ) => Promise<NotesVaultFile>;
  write: (
    binding: ResolvedNotesVaultBinding,
    input: NotesVaultWriteInput,
    options?: NotesVaultBackendOptions,
  ) => Promise<NotesVaultWriteResult>;
  mkdir: (
    binding: ResolvedNotesVaultBinding,
    input: NotesVaultMkdirInput,
    options?: NotesVaultBackendOptions,
  ) => Promise<NotesVaultOperationResult>;
  move: (
    binding: ResolvedNotesVaultBinding,
    input: NotesVaultMoveInput,
    options?: NotesVaultBackendOptions,
  ) => Promise<NotesVaultOperationResult>;
  delete: (
    binding: ResolvedNotesVaultBinding,
    input: NotesVaultDeleteInput,
    options?: NotesVaultBackendOptions,
  ) => Promise<NotesVaultOperationResult>;
  upload: (
    binding: ResolvedNotesVaultBinding,
    input: NotesVaultUploadInput,
    options?: NotesVaultBackendOptions,
  ) => Promise<NotesVaultOperationResult>;
};

export type ResolvedNotesVault = {
  backend: NotesVaultBackend;
  binding: ResolvedNotesVaultBinding;
};
