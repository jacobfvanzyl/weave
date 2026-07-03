export type EditorTarget = {
  projectId: string;
  workspaceId: string;
  portalId?: string;
  rootId?: string;
  repoPath?: string;
  workspacePath?: string;
};

export type EditorMode = 'code' | 'notes';

export type EditorEntry = {
  name: string;
  path: string;
  type: 'directory' | 'file' | 'other';
  hidden?: boolean;
  size?: number;
  mtimeMs?: number;
};

export type EditorListResult = {
  path: string;
  entries: EditorEntry[];
};

export type EditorFile = {
  path: string;
  content: string;
  version: string;
  size?: number;
  mtimeMs?: number;
};

export type EditorHashResult = {
  path: string;
  contentHash: string;
  version: string;
  size?: number;
  mtimeMs?: number;
  lineCount?: number;
};

export type EditorDiffPreviewResult = {
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

export type EditorWriteResult = {
  path: string;
  version: string;
  size?: number;
  mtimeMs?: number;
};

export type OpenBuffer = {
  path: string;
  content: string;
  version: string;
  size?: number;
  mtimeMs?: number;
  mediaType?: string;
  dirty: boolean;
};

export type FileOperationResult = {
  ok: true;
  path?: string;
  version?: string;
};

export type EditorWatchEvent = {
  kind: 'any' | 'access' | 'create' | 'modify' | 'rename' | 'remove' | 'other';
  paths: string[];
  affectedDirectories: string[];
  rescan?: boolean;
};

export type EditorWatchSubscription = {
  update: (paths: string[]) => Promise<void>;
  close: () => void;
};

export type WorkspaceFileNote = {
  path: string;
  documentType?: 'markdown' | 'coppermind';
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

export type WorkspaceFileAttachment = {
  path: string;
  name: string;
  mediaType: 'image' | 'audio' | 'video' | 'pdf' | 'excalidraw' | 'other';
  size?: number;
  mtimeMs?: number;
};

export type WorkspaceFileIndexResult = {
  path: string;
  entries: EditorEntry[];
  notes: WorkspaceFileNote[];
  attachments: WorkspaceFileAttachment[];
  backlinks: Record<string, string[]>;
  checkedAt: string;
};

export type EditorBackend = {
  list: (target: EditorTarget, path?: string) => Promise<EditorListResult>;
  read: (target: EditorTarget, path: string) => Promise<EditorFile>;
  hash: (target: EditorTarget, path: string) => Promise<EditorHashResult>;
  diffPreview: (target: EditorTarget, path: string, diff: string) => Promise<EditorDiffPreviewResult>;
  write: (target: EditorTarget, path: string, content: string, version?: string) => Promise<EditorWriteResult>;
  mkdir: (target: EditorTarget, path: string) => Promise<FileOperationResult>;
  move: (target: EditorTarget, fromPath: string, toPath: string, overwrite?: boolean) => Promise<FileOperationResult>;
  delete: (target: EditorTarget, path: string, recursive?: boolean) => Promise<FileOperationResult>;
  watch?: (target: EditorTarget, paths: string[], listener: (event: EditorWatchEvent) => void) => Promise<EditorWatchSubscription>;
};

export type WorkspaceFileTarget = EditorTarget;
export type WorkspaceFileWatchEvent = EditorWatchEvent;
export type WorkspaceFileWatchSubscription = EditorWatchSubscription;

export type WorkspaceFileBackend = EditorBackend & {
  index: (target: EditorTarget, path?: string) => Promise<WorkspaceFileIndexResult>;
  upload: (target: EditorTarget, path: string, base64Content: string, contentType?: string) => Promise<FileOperationResult>;
};
