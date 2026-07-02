export type EditorTarget = {
  projectId: string;
  workspaceId: string;
  portalId?: string;
  rootId?: string;
  repoPath?: string;
  workspacePath?: string;
};

export type EditorEntry = {
  name: string;
  path: string;
  type: 'directory' | 'file' | 'other';
  hidden?: boolean;
  size?: number;
  mtimeMs?: number;
};

export type EditorListInput = {
  target: EditorTarget;
  path?: string;
};

export type EditorListResult = {
  path: string;
  entries: EditorEntry[];
};

export type EditorReadInput = {
  target: EditorTarget;
  path: string;
};

export type EditorFile = {
  path: string;
  content: string;
  version: string;
  size?: number;
  mtimeMs?: number;
};

export type EditorHashInput = {
  target: EditorTarget;
  path: string;
};

export type EditorHashResult = {
  path: string;
  contentHash: string;
  version: string;
  size?: number;
  mtimeMs?: number;
  lineCount?: number;
};

export type EditorDiffPreviewInput = {
  target: EditorTarget;
  path: string;
  diff: string;
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

export type EditorWriteInput = {
  target: EditorTarget;
  path: string;
  content: string;
  version?: string;
};

export type EditorWriteResult = {
  path: string;
  version: string;
  size?: number;
  mtimeMs?: number;
};

export type EditorMkdirInput = {
  target: EditorTarget;
  path: string;
};

export type EditorMoveInput = {
  target: EditorTarget;
  fromPath: string;
  toPath: string;
  overwrite?: boolean;
};

export type EditorDeleteInput = {
  target: EditorTarget;
  path: string;
  recursive?: boolean;
};

export type EditorOperationResult = {
  ok: true;
  path?: string;
};

export type EditorWatchEvent = {
  kind: 'any' | 'access' | 'create' | 'modify' | 'rename' | 'remove' | 'other';
  paths: string[];
  affectedDirectories: string[];
  rescan?: boolean;
};

export type EditorWatchStartInput = {
  target: EditorTarget;
  paths: string[];
};

export type EditorWatchStartResult = {
  subscriptionId: string;
  paths: string[];
};

export type EditorWatchEventEnvelope = {
  subscriptionId: string;
  event?: EditorWatchEvent;
  error?: string;
};
