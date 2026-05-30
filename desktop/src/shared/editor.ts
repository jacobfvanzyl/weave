export type EditorTarget = {
  planeId: string;
  demiplaneId: string;
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
};
