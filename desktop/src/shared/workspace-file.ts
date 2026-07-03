export type WorkspaceFileTarget = {
  projectId: string;
  workspaceId: string;
  portalId?: string;
  rootId?: string;
  repoPath?: string;
  workspacePath?: string;
};

export type WorkspaceFileEntry = {
  name: string;
  path: string;
  type: 'directory' | 'file' | 'other';
  hidden?: boolean;
  size?: number;
  mtimeMs?: number;
};

export type WorkspaceFileListInput = {
  target: WorkspaceFileTarget;
  path?: string;
};

export type WorkspaceFileListResult = {
  path: string;
  entries: WorkspaceFileEntry[];
};

export type WorkspaceFileReadInput = {
  target: WorkspaceFileTarget;
  path: string;
};

export type WorkspaceFileFile = {
  path: string;
  content: string;
  version: string;
  size?: number;
  mtimeMs?: number;
};

export type WorkspaceFileHashInput = {
  target: WorkspaceFileTarget;
  path: string;
};

export type WorkspaceFileHashResult = {
  path: string;
  contentHash: string;
  version: string;
  size?: number;
  mtimeMs?: number;
  lineCount?: number;
};

export type WorkspaceFileDiffPreviewInput = {
  target: WorkspaceFileTarget;
  path: string;
  diff: string;
};

export type WorkspaceFileDiffPreviewResult = {
  path: string;
  currentHash: string;
  proposedHash: string;
  currentContent: string;
  proposedContent: string;
  additions: number;
  deletions: number;
  version: string;
  size?: number;
  mtimeMs?: number;
};

export type WorkspaceFileWriteInput = {
  target: WorkspaceFileTarget;
  path: string;
  content: string;
  version?: string;
};

export type WorkspaceFileWriteResult = {
  path: string;
  version: string;
  size?: number;
  mtimeMs?: number;
};

export type WorkspaceFileMkdirInput = {
  target: WorkspaceFileTarget;
  path: string;
};

export type WorkspaceFileMoveInput = {
  target: WorkspaceFileTarget;
  fromPath: string;
  toPath: string;
  overwrite?: boolean;
};

export type WorkspaceFileDeleteInput = {
  target: WorkspaceFileTarget;
  path: string;
  recursive?: boolean;
};

export type WorkspaceFileUploadInput = {
  target: WorkspaceFileTarget;
  path: string;
  base64Content: string;
  contentType?: string;
};

export type WorkspaceFileOperationResult = {
  ok: true;
  path?: string;
};

export type WorkspaceFileIndexResult = {
  path: string;
  entries: WorkspaceFileEntry[];
  notes: unknown[];
  attachments: unknown[];
  backlinks: Record<string, string[]>;
  checkedAt: string;
};

export type WorkspaceFileWatchEvent = {
  kind: 'any' | 'access' | 'create' | 'modify' | 'rename' | 'remove' | 'other';
  paths: string[];
  affectedDirectories: string[];
  rescan?: boolean;
};

export type WorkspaceFileWatchStartInput = {
  target: WorkspaceFileTarget;
  paths: string[];
};

export type WorkspaceFileWatchStartResult = {
  subscriptionId: string;
  paths: string[];
};

export type WorkspaceFileWatchEventEnvelope = {
  subscriptionId: string;
  event?: WorkspaceFileWatchEvent;
  error?: string;
};
