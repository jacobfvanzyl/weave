import type {
  FileOperationResult,
  RpcRequestResult,
  WorkspaceFileDiffPreviewResult,
  WorkspaceFileEntry,
  WorkspaceFileHashResult,
  WorkspaceFileListResult,
  WorkspaceFileReadResult,
  WorkspaceFileTarget as ProtocolWorkspaceFileTarget,
  WorkspaceFileWatchEvent as ProtocolWorkspaceFileWatchEvent,
  WorkspaceFileWriteResult,
} from '@weave/protocol';

export type EditorTarget = ProtocolWorkspaceFileTarget;
export type EditorMode = 'code' | 'notes';
export type EditorEntry = WorkspaceFileEntry;
export type EditorListResult = WorkspaceFileListResult;
export type EditorFile = Extract<WorkspaceFileReadResult, { content: string }>;
export type EditorHashResult = WorkspaceFileHashResult;
export type EditorDiffPreviewResult = WorkspaceFileDiffPreviewResult;
export type EditorWriteResult = WorkspaceFileWriteResult;
export type { FileOperationResult } from '@weave/protocol';

export type OpenBuffer = {
  path: string;
  content: string;
  version: string;
  size?: number;
  mtimeMs?: number;
  mediaType?: string;
  dirty: boolean;
};

export type EditorWatchEvent = ProtocolWorkspaceFileWatchEvent;
export type EditorWatchSubscription = {
  update: (paths: string[]) => Promise<void>;
  close: () => void;
};

export type WorkspaceFileIndexResult = RpcRequestResult<'client', 'server', 'workspaceFile.index'>;
export type WorkspaceFileNote = WorkspaceFileIndexResult['notes'][number];
export type WorkspaceFileAttachment = WorkspaceFileIndexResult['attachments'][number];

export type EditorBackend = {
  list: (target: EditorTarget, path?: string) => Promise<EditorListResult>;
  read: (target: EditorTarget, path: string) => Promise<EditorFile>;
  hash: (target: EditorTarget, path: string) => Promise<EditorHashResult>;
  diffPreview: (target: EditorTarget, path: string, diff: string) => Promise<EditorDiffPreviewResult>;
  write: (target: EditorTarget, path: string, content: string, version?: string) => Promise<EditorWriteResult>;
  mkdir: (target: EditorTarget, path: string) => Promise<FileOperationResult>;
  move: (target: EditorTarget, fromPath: string, toPath: string, overwrite?: boolean) => Promise<FileOperationResult>;
  delete: (target: EditorTarget, path: string, recursive?: boolean) => Promise<FileOperationResult>;
  watch?: (
    target: EditorTarget,
    paths: string[],
    listener: (event: EditorWatchEvent) => void,
  ) => Promise<EditorWatchSubscription>;
};

export type WorkspaceFileTarget = EditorTarget;
export type WorkspaceFileWatchEvent = EditorWatchEvent;
export type WorkspaceFileWatchSubscription = EditorWatchSubscription;

export type WorkspaceFileBackend = EditorBackend & {
  index: (target: EditorTarget, path?: string) => Promise<WorkspaceFileIndexResult>;
  upload: (
    target: EditorTarget,
    path: string,
    base64Content: string,
    contentType?: string,
  ) => Promise<FileOperationResult>;
};
