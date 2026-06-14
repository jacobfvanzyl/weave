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

export type EditorBackend = {
  list: (target: EditorTarget, path?: string) => Promise<EditorListResult>;
  read: (target: EditorTarget, path: string) => Promise<EditorFile>;
  write: (target: EditorTarget, path: string, content: string, version?: string) => Promise<EditorWriteResult>;
  mkdir: (target: EditorTarget, path: string) => Promise<FileOperationResult>;
  move: (target: EditorTarget, fromPath: string, toPath: string, overwrite?: boolean) => Promise<FileOperationResult>;
  delete: (target: EditorTarget, path: string, recursive?: boolean) => Promise<FileOperationResult>;
};
