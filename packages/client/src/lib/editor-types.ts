export type EditorTarget = {
  planeId: string;
  demiplaneId: string;
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

export type EditorListResult = {
  path: string;
  entries: EditorEntry[];
};

export type EditorFile = {
  path: string;
  content: string;
  version: string;
};

export type EditorWriteResult = {
  path: string;
  version: string;
};

export type EditorBackend = {
  list: (target: EditorTarget, path?: string) => Promise<EditorListResult>;
  read: (target: EditorTarget, path: string) => Promise<EditorFile>;
  write: (target: EditorTarget, path: string, content: string, version?: string) => Promise<EditorWriteResult>;
};
