export const WORKSPACE_FILE_WATCH_EVENT_METHOD = 'workspace.file.watch.event' as const;

export type WorkspaceFileEntry = {
  name: string;
  path: string;
  type: 'directory' | 'file' | 'other';
  hidden?: boolean;
  size?: number;
  mtimeMs?: number;
};

export type WorkspaceFileMetadata = {
  path: string;
  contentHash: string;
  size: number;
  mtimeMs?: number;
};

export type WorkspaceFileSearchMatch = {
  path: string;
  kind: 'path' | 'content';
  line?: number;
  preview?: string;
};

export type WorkspaceFileWatchEvent = {
  kind: 'any' | 'access' | 'create' | 'modify' | 'rename' | 'remove' | 'other';
  paths: string[];
  affectedDirectories: string[];
  rescan?: boolean;
};

export type WorkspaceFileWatchNotification = {
  subscriptionId: string;
  event: WorkspaceFileWatchEvent;
};

export const WORKSPACE_FILE_ERROR_CODES = [
  'INVALID_PATH',
  'WORKSPACE_UNAVAILABLE',
  'NOT_FOUND',
  'NOT_FILE',
  'NOT_DIRECTORY',
  'DIRECTORY_NOT_EMPTY',
  'ALREADY_EXISTS',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_CONTENT',
  'STALE_CONTENT',
  'SYMLINK_NOT_ALLOWED',
  'WATCH_NOT_FOUND',
] as const;

export type WorkspaceFileErrorCode = (typeof WORKSPACE_FILE_ERROR_CODES)[number];
export type WorkspaceFileErrorData = {
  domain: 'workspace-filesystem';
  code: WorkspaceFileErrorCode;
  path?: string;
  expectedContentHash?: string;
  actualContentHash?: string;
};

export type WorkspaceFileRpcContracts = {
  'workspace.file.list': {
    params: { workspaceId: string; path: string };
    result: { path: string; entries: WorkspaceFileEntry[]; truncated: boolean };
  };
  'workspace.file.read': {
    params: { workspaceId: string; path: string };
    result: WorkspaceFileMetadata & { content: string };
  };
  'workspace.file.hash': {
    params: { workspaceId: string; path: string };
    result: WorkspaceFileMetadata & { lineCount?: number };
  };
  'workspace.file.write': {
    params: { workspaceId: string; path: string; content: string; expectedContentHash: string | null };
    result: WorkspaceFileMetadata;
  };
  'workspace.directory.create': {
    params: { workspaceId: string; path: string };
    result: { ok: true; path: string };
  };
  'workspace.file.move': {
    params: { workspaceId: string; fromPath: string; toPath: string; overwrite?: boolean };
    result: { ok: true; path: string };
  };
  'workspace.file.delete': {
    params: { workspaceId: string; path: string; recursive?: boolean };
    result: { ok: true; path: string };
  };
  'workspace.file.search': {
    params: {
      workspaceId: string;
      path: string;
      query: string;
      scope: 'path' | 'content' | 'both';
      limit?: number;
    };
    result: { path: string; matches: WorkspaceFileSearchMatch[]; truncated: boolean };
  };
  'workspace.file.watch.start': {
    params: { workspaceId: string; paths: string[] };
    result: { subscriptionId: string; paths: string[] };
  };
  'workspace.file.watch.update': {
    params: { subscriptionId: string; paths: string[] };
    result: { subscriptionId: string; paths: string[] };
  };
  'workspace.file.watch.stop': {
    params: { subscriptionId: string };
    result: { ok: true };
  };
};

export type WorkspaceFileRpcMethod = keyof WorkspaceFileRpcContracts;
export const WORKSPACE_FILE_RPC_METHODS = [
  'workspace.file.list',
  'workspace.file.read',
  'workspace.file.hash',
  'workspace.file.write',
  'workspace.directory.create',
  'workspace.file.move',
  'workspace.file.delete',
  'workspace.file.search',
  'workspace.file.watch.start',
  'workspace.file.watch.update',
  'workspace.file.watch.stop',
] as const satisfies readonly WorkspaceFileRpcMethod[];

const object = (value: unknown, context: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${context} must be an object.`);
  return value as Record<string, unknown>;
};

const text = (value: unknown, context: string, allowEmpty = false) => {
  if (typeof value !== 'string' || (!allowEmpty && !value)) throw new Error(`${context} must be a string.`);
  return value;
};

const number = (value: unknown, context: string) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${context} must be a number.`);
  return value;
};

const nonNegativeInteger = (value: unknown, context: string) => {
  const parsed = number(value, context);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${context} must be a non-negative integer.`);
  return parsed;
};

const boolean = (value: unknown, context: string) => {
  if (typeof value !== 'boolean') throw new Error(`${context} must be a boolean.`);
  return value;
};

const stringArray = (value: unknown, context: string) => {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array.`);
  return value.map((item, index) => text(item, `${context}[${index}]`, true));
};

const hash = (value: unknown, context: string) => {
  const parsed = text(value, context);
  if (!/^[a-f0-9]{64}$/i.test(parsed)) throw new Error(`${context} must be a SHA-256 hash.`);
  return parsed.toLowerCase();
};

const workspaceParams = (value: unknown, method: string) => {
  const input = object(value, `${method} params`);
  return { input, workspaceId: text(input.workspaceId, 'workspaceId') };
};

const operationResult = (value: unknown, context: string) => {
  const result = object(value, context);
  if (result.ok !== true) throw new Error(`${context}.ok must be true.`);
  return { ok: true as const, path: text(result.path, `${context}.path`) };
};

const metadata = (value: unknown, context: string): WorkspaceFileMetadata => {
  const result = object(value, context);
  return {
    path: text(result.path, `${context}.path`, true),
    contentHash: hash(result.contentHash, `${context}.contentHash`),
    size: nonNegativeInteger(result.size, `${context}.size`),
    ...(result.mtimeMs === undefined ? {} : { mtimeMs: number(result.mtimeMs, `${context}.mtimeMs`) }),
  };
};

const entry = (value: unknown, index: number): WorkspaceFileEntry => {
  const result = object(value, `entries[${index}]`);
  const type = text(result.type, `entries[${index}].type`);
  if (type !== 'directory' && type !== 'file' && type !== 'other') {
    throw new Error(`entries[${index}].type is invalid.`);
  }
  return {
    name: text(result.name, `entries[${index}].name`),
    path: text(result.path, `entries[${index}].path`),
    type,
    ...(result.hidden === undefined ? {} : { hidden: boolean(result.hidden, `entries[${index}].hidden`) }),
    ...(result.size === undefined ? {} : { size: nonNegativeInteger(result.size, `entries[${index}].size`) }),
    ...(result.mtimeMs === undefined ? {} : { mtimeMs: number(result.mtimeMs, `entries[${index}].mtimeMs`) }),
  };
};

export const parseWorkspaceFileRpcParams = <Method extends WorkspaceFileRpcMethod>(
  method: Method,
  value: unknown,
): WorkspaceFileRpcContracts[Method]['params'] => {
  if (method === 'workspace.file.watch.update') {
    const input = object(value, `${method} params`);
    return {
      subscriptionId: text(input.subscriptionId, 'subscriptionId'),
      paths: stringArray(input.paths, 'paths'),
    } as WorkspaceFileRpcContracts[Method]['params'];
  }
  if (method === 'workspace.file.watch.stop') {
    const input = object(value, `${method} params`);
    return {
      subscriptionId: text(input.subscriptionId, 'subscriptionId'),
    } as WorkspaceFileRpcContracts[Method]['params'];
  }

  const { input, workspaceId } = workspaceParams(value, method);
  switch (method) {
    case 'workspace.file.list':
    case 'workspace.file.read':
    case 'workspace.file.hash':
    case 'workspace.directory.create':
      return {
        workspaceId,
        path: text(input.path, 'path', method === 'workspace.file.list'),
      } as WorkspaceFileRpcContracts[Method]['params'];
    case 'workspace.file.write':
      if (input.expectedContentHash !== null && input.expectedContentHash === undefined) {
        throw new Error('expectedContentHash is required.');
      }
      return {
        workspaceId,
        path: text(input.path, 'path'),
        content: text(input.content, 'content', true),
        expectedContentHash: input.expectedContentHash === null
          ? null
          : hash(input.expectedContentHash, 'expectedContentHash'),
      } as WorkspaceFileRpcContracts[Method]['params'];
    case 'workspace.file.move':
      return {
        workspaceId,
        fromPath: text(input.fromPath, 'fromPath'),
        toPath: text(input.toPath, 'toPath'),
        ...(input.overwrite === undefined ? {} : { overwrite: boolean(input.overwrite, 'overwrite') }),
      } as WorkspaceFileRpcContracts[Method]['params'];
    case 'workspace.file.delete':
      return {
        workspaceId,
        path: text(input.path, 'path'),
        ...(input.recursive === undefined ? {} : { recursive: boolean(input.recursive, 'recursive') }),
      } as WorkspaceFileRpcContracts[Method]['params'];
    case 'workspace.file.search': {
      const scope = input.scope ?? 'both';
      if (scope !== 'path' && scope !== 'content' && scope !== 'both') throw new Error('scope is invalid.');
      const limit = input.limit === undefined ? undefined : nonNegativeInteger(input.limit, 'limit');
      if (limit !== undefined && (limit < 1 || limit > 200)) throw new Error('limit must be between 1 and 200.');
      const query = text(input.query, 'query');
      if (query.length > 256) throw new Error('query must be at most 256 characters.');
      return {
        workspaceId,
        path: text(input.path ?? '', 'path', true),
        query,
        scope,
        ...(limit === undefined ? {} : { limit }),
      } as WorkspaceFileRpcContracts[Method]['params'];
    }
    case 'workspace.file.watch.start':
      return { workspaceId, paths: stringArray(input.paths, 'paths') } as WorkspaceFileRpcContracts[Method]['params'];
    default:
      throw new Error(`Unknown Workspace file method: ${method}`);
  }
};

export const parseWorkspaceFileRpcResult = <Method extends WorkspaceFileRpcMethod>(
  method: Method,
  value: unknown,
): WorkspaceFileRpcContracts[Method]['result'] => {
  const result = object(value, `${method} result`);
  switch (method) {
    case 'workspace.file.list':
      if (!Array.isArray(result.entries)) throw new Error('entries must be an array.');
      return {
        path: text(result.path, 'path', true),
        entries: result.entries.map(entry),
        truncated: boolean(result.truncated, 'truncated'),
      } as WorkspaceFileRpcContracts[Method]['result'];
    case 'workspace.file.read':
      return {
        ...metadata(result, 'file'),
        content: text(result.content, 'content', true),
      } as WorkspaceFileRpcContracts[Method]['result'];
    case 'workspace.file.hash':
      return {
        ...metadata(result, 'file'),
        ...(result.lineCount === undefined ? {} : { lineCount: nonNegativeInteger(result.lineCount, 'lineCount') }),
      } as WorkspaceFileRpcContracts[Method]['result'];
    case 'workspace.file.write':
      return metadata(result, 'file') as WorkspaceFileRpcContracts[Method]['result'];
    case 'workspace.directory.create':
    case 'workspace.file.move':
    case 'workspace.file.delete':
      return operationResult(result, method) as WorkspaceFileRpcContracts[Method]['result'];
    case 'workspace.file.search': {
      if (!Array.isArray(result.matches)) throw new Error('matches must be an array.');
      return {
        path: text(result.path, 'path', true),
        matches: result.matches.map((value, index) => {
          const match = object(value, `matches[${index}]`);
          const kind = text(match.kind, `matches[${index}].kind`);
          if (kind !== 'path' && kind !== 'content') throw new Error(`matches[${index}].kind is invalid.`);
          return {
            path: text(match.path, `matches[${index}].path`),
            kind,
            ...(match.line === undefined ? {} : { line: nonNegativeInteger(match.line, `matches[${index}].line`) }),
            ...(match.preview === undefined ? {} : { preview: text(match.preview, `matches[${index}].preview`, true) }),
          };
        }),
        truncated: boolean(result.truncated, 'truncated'),
      } as WorkspaceFileRpcContracts[Method]['result'];
    }
    case 'workspace.file.watch.start':
    case 'workspace.file.watch.update':
      return {
        subscriptionId: text(result.subscriptionId, 'subscriptionId'),
        paths: stringArray(result.paths, 'paths'),
      } as WorkspaceFileRpcContracts[Method]['result'];
    case 'workspace.file.watch.stop':
      if (result.ok !== true) throw new Error('ok must be true.');
      return { ok: true } as WorkspaceFileRpcContracts[Method]['result'];
  }
};

const watchEvent = (value: unknown): WorkspaceFileWatchEvent => {
  const event = object(value, 'event');
  const kind = text(event.kind, 'event.kind');
  if (!['any', 'access', 'create', 'modify', 'rename', 'remove', 'other'].includes(kind)) {
    throw new Error('event.kind is invalid.');
  }
  return {
    kind: kind as WorkspaceFileWatchEvent['kind'],
    paths: stringArray(event.paths, 'event.paths'),
    affectedDirectories: stringArray(event.affectedDirectories, 'event.affectedDirectories'),
    ...(event.rescan === undefined ? {} : { rescan: boolean(event.rescan, 'event.rescan') }),
  };
};

export const parseWorkspaceFileWatchNotification = (
  method: string,
  value: unknown,
): WorkspaceFileWatchNotification => {
  if (method !== WORKSPACE_FILE_WATCH_EVENT_METHOD) throw new Error(`Unknown Workspace file notification: ${method}`);
  const notification = object(value, `${method} notification`);
  return {
    subscriptionId: text(notification.subscriptionId, 'subscriptionId'),
    event: watchEvent(notification.event),
  };
};

export const parseWorkspaceFileErrorData = (value: unknown): WorkspaceFileErrorData => {
  const error = object(value, 'Workspace file error');
  if (error.domain !== 'workspace-filesystem') throw new Error('Workspace file error domain is invalid.');
  if (!WORKSPACE_FILE_ERROR_CODES.includes(error.code as WorkspaceFileErrorCode)) {
    throw new Error('Workspace file error code is invalid.');
  }
  return {
    domain: 'workspace-filesystem',
    code: error.code as WorkspaceFileErrorCode,
    ...(error.path === undefined ? {} : { path: text(error.path, 'path', true) }),
    ...(error.expectedContentHash === undefined
      ? {}
      : { expectedContentHash: hash(error.expectedContentHash, 'expectedContentHash') }),
    ...(error.actualContentHash === undefined
      ? {}
      : { actualContentHash: hash(error.actualContentHash, 'actualContentHash') }),
  };
};
