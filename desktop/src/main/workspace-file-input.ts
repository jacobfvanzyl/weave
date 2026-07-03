import path from 'node:path';
import type {
  WorkspaceFileDeleteInput,
  WorkspaceFileDiffPreviewInput,
  WorkspaceFileHashInput,
  WorkspaceFileListInput,
  WorkspaceFileMkdirInput,
  WorkspaceFileMoveInput,
  WorkspaceFileReadInput,
  WorkspaceFileTarget,
  WorkspaceFileUploadInput,
  WorkspaceFileWatchStartInput,
  WorkspaceFileWriteInput,
} from '../shared/workspace-file';
import type { LspSessionInput } from '../shared/language-intelligence';

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object');

const parseIdentifier = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
};

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

export const parseWorkspaceFilePath = (value: unknown, name = 'path') => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  if (value.includes('\0')) throw new Error(`${name} cannot contain null bytes.`);

  const normalizedInput = value.trim().replace(/\\/g, '/');
  if (!normalizedInput || normalizedInput === '.') return '';
  if (path.posix.isAbsolute(normalizedInput) || /^[a-zA-Z]:\//.test(normalizedInput)) {
    throw new Error(`${name} must be relative to the workspace root.`);
  }

  const normalized = path.posix.normalize(normalizedInput);
  if (normalized === '.' || normalized === '') return '';
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${name} cannot escape the workspace root.`);
  }

  return normalized.replace(/^\.\//, '');
};

export const parseWorkspaceFileTarget = (value: unknown): WorkspaceFileTarget => {
  if (!isRecord(value)) throw new Error('target is required.');
  return {
    projectId: parseIdentifier(value.projectId, 'projectId'),
    workspaceId: parseIdentifier(value.workspaceId, 'workspaceId'),
    portalId: optionalString(value.portalId),
    rootId: optionalString(value.rootId),
    repoPath: optionalString(value.repoPath),
    workspacePath: optionalString(value.workspacePath),
  };
};

export const parseWorkspaceFileListInput = (input: unknown): WorkspaceFileListInput => {
  if (!isRecord(input)) throw new Error('workspace-file list input is required.');
  return {
    target: parseWorkspaceFileTarget(input.target),
    path: parseWorkspaceFilePath(input.path),
  };
};

export const parseWorkspaceFileReadInput = (input: unknown): WorkspaceFileReadInput => {
  if (!isRecord(input)) throw new Error('workspace-file read input is required.');
  return {
    target: parseWorkspaceFileTarget(input.target),
    path: parseWorkspaceFilePath(input.path),
  };
};

export const parseWorkspaceFileHashInput = (input: unknown): WorkspaceFileHashInput => {
  if (!isRecord(input)) throw new Error('workspace-file hash input is required.');
  return {
    target: parseWorkspaceFileTarget(input.target),
    path: parseWorkspaceFilePath(input.path),
  };
};

export const parseWorkspaceFileDiffPreviewInput = (input: unknown): WorkspaceFileDiffPreviewInput => {
  if (!isRecord(input)) throw new Error('workspace-file diff preview input is required.');
  if (typeof input.diff !== 'string') throw new Error('diff must be a string.');
  return {
    target: parseWorkspaceFileTarget(input.target),
    path: parseWorkspaceFilePath(input.path),
    diff: input.diff,
  };
};

export const parseWorkspaceFileWriteInput = (input: unknown): WorkspaceFileWriteInput => {
  if (!isRecord(input)) throw new Error('workspace-file write input is required.');
  if (typeof input.content !== 'string') throw new Error('content must be a string.');
  if (input.version !== undefined && typeof input.version !== 'string') throw new Error('version must be a string.');

  return {
    target: parseWorkspaceFileTarget(input.target),
    path: parseWorkspaceFilePath(input.path),
    content: input.content,
    version: input.version,
  };
};

export const parseWorkspaceFileMkdirInput = (input: unknown): WorkspaceFileMkdirInput => {
  if (!isRecord(input)) throw new Error('workspace-file mkdir input is required.');
  return {
    target: parseWorkspaceFileTarget(input.target),
    path: parseWorkspaceFilePath(input.path),
  };
};

export const parseWorkspaceFileMoveInput = (input: unknown): WorkspaceFileMoveInput => {
  if (!isRecord(input)) throw new Error('workspace-file move input is required.');
  if (input.overwrite !== undefined && typeof input.overwrite !== 'boolean') throw new Error('overwrite must be a boolean.');
  return {
    target: parseWorkspaceFileTarget(input.target),
    fromPath: parseWorkspaceFilePath(input.fromPath, 'fromPath'),
    toPath: parseWorkspaceFilePath(input.toPath, 'toPath'),
    overwrite: input.overwrite,
  };
};

export const parseWorkspaceFileDeleteInput = (input: unknown): WorkspaceFileDeleteInput => {
  if (!isRecord(input)) throw new Error('workspace-file delete input is required.');
  if (input.recursive !== undefined && typeof input.recursive !== 'boolean') throw new Error('recursive must be a boolean.');
  return {
    target: parseWorkspaceFileTarget(input.target),
    path: parseWorkspaceFilePath(input.path),
    recursive: input.recursive,
  };
};

export const parseWorkspaceFileIndexInput = (input: unknown): { target: WorkspaceFileTarget; path?: string } => {
  if (!isRecord(input)) throw new Error('workspace file index input is required.');
  return {
    target: parseWorkspaceFileTarget(input.target),
    path: parseWorkspaceFilePath(input.path),
  };
};

export const parseWorkspaceFileUploadInput = (input: unknown): WorkspaceFileUploadInput => {
  if (!isRecord(input)) throw new Error('workspace file upload input is required.');
  if (typeof input.base64Content !== 'string') throw new Error('base64Content must be a string.');
  return {
    target: parseWorkspaceFileTarget(input.target),
    path: parseWorkspaceFilePath(input.path),
    base64Content: input.base64Content,
    contentType: optionalString(input.contentType),
  };
};

export const parseWorkspaceFileWatchPaths = (value: unknown) => {
  const input = Array.isArray(value) ? value : [''];
  const paths = input.map((path, index) => parseWorkspaceFilePath(path, `paths[${index}]`));
  return [...new Set(paths.length ? paths : [''])];
};

export const parseWorkspaceFileWatchStartInput = (input: unknown): WorkspaceFileWatchStartInput => {
  if (!isRecord(input)) throw new Error('workspace-file watch input is required.');
  return {
    target: parseWorkspaceFileTarget(input.target),
    paths: parseWorkspaceFileWatchPaths(input.paths),
  };
};

export const parseWorkspaceFileWatchSubscriptionId = (value: unknown) => parseIdentifier(value, 'subscriptionId');

export const parseWorkspaceFileWatchStopInput = (input: unknown) => {
  if (typeof input === 'string') return parseWorkspaceFileWatchSubscriptionId(input);
  if (!isRecord(input)) throw new Error('workspace-file watch stop input is required.');
  return parseWorkspaceFileWatchSubscriptionId(input.subscriptionId);
};

export const parseLspSessionInput = (input: unknown): LspSessionInput => {
  if (!isRecord(input)) throw new Error('LSP session input is required.');
  return {
    target: parseWorkspaceFileTarget(input.target),
    path: parseWorkspaceFilePath(input.path),
    languageId: optionalString(input.languageId),
    serverId: optionalString(input.serverId),
  };
};
