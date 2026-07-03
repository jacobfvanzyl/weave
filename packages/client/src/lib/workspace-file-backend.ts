import type {
  WorkspaceFileBackend,
  EditorDiffPreviewResult,
  EditorFile,
  EditorHashResult,
  EditorListResult,
  EditorTarget,
  EditorWatchEvent,
  EditorWatchSubscription,
  EditorWriteResult,
  FileOperationResult,
} from './editor-types';
import { getAuthHeaders } from './mastra-client';
import { weaveRoutes } from './weave-routes';

type WorkspaceFileWatchStartResult = {
  subscriptionId: string;
  paths: string[];
};

type DesktopWorkspaceFileWatchEventEnvelope = {
  subscriptionId: string;
  event?: EditorWatchEvent;
  error?: string;
};

type DesktopWorkspaceFileBridge = {
  workspaceFileList: (target: EditorTarget, path?: string) => Promise<EditorListResult>;
  workspaceFileRead: (target: EditorTarget, path: string) => Promise<EditorFile>;
  workspaceFileHash: (target: EditorTarget, path: string) => Promise<EditorHashResult>;
  workspaceFileDiffPreview: (target: EditorTarget, path: string, diff: string) => Promise<EditorDiffPreviewResult>;
  workspaceFileWrite: (target: EditorTarget, path: string, content: string, version?: string) => Promise<EditorWriteResult>;
  workspaceFileMkdir: (target: EditorTarget, path: string) => Promise<FileOperationResult>;
  workspaceFileMove: (target: EditorTarget, fromPath: string, toPath: string, overwrite?: boolean) => Promise<FileOperationResult>;
  workspaceFileDelete: (target: EditorTarget, path: string, recursive?: boolean) => Promise<FileOperationResult>;
  workspaceFileIndex: (target: EditorTarget, path?: string) => Promise<WorkspaceFileIndexResult>;
  workspaceFileUpload: (target: EditorTarget, path: string, base64Content: string, contentType?: string) => Promise<FileOperationResult>;
  workspaceFileWatchStart?: (target: EditorTarget, paths: string[]) => Promise<WorkspaceFileWatchStartResult>;
  workspaceFileWatchUpdate?: (subscriptionId: string, paths: string[]) => Promise<WorkspaceFileWatchStartResult>;
  workspaceFileWatchStop?: (subscriptionId: string) => Promise<void>;
  onWorkspaceFileWatchEvent?: (listener: (event: DesktopWorkspaceFileWatchEventEnvelope) => void) => () => void;
};

type WindowWithDesktopWorkspaceFile = Window & {
  weaveDesktop?: Partial<DesktopWorkspaceFileBridge>;
};

const unavailableError = 'Workspace file backend unavailable in this client.';

const getDesktopBridge = () => {
  if (typeof window === 'undefined') return undefined;
  const bridge = (window as WindowWithDesktopWorkspaceFile).weaveDesktop;
  if (
    typeof bridge?.workspaceFileList !== 'function'
    || typeof bridge.workspaceFileRead !== 'function'
    || typeof bridge.workspaceFileHash !== 'function'
    || typeof bridge.workspaceFileDiffPreview !== 'function'
    || typeof bridge.workspaceFileWrite !== 'function'
    || typeof bridge.workspaceFileMkdir !== 'function'
    || typeof bridge.workspaceFileMove !== 'function'
    || typeof bridge.workspaceFileDelete !== 'function'
    || typeof bridge.workspaceFileIndex !== 'function'
    || typeof bridge.workspaceFileUpload !== 'function'
  ) {
    return undefined;
  }

  return bridge as DesktopWorkspaceFileBridge;
};

export const isDesktopWorkspaceFileBackendAvailable = () => Boolean(getDesktopBridge());

export const isWebWorkspaceFileBackendAvailable = () =>
  typeof window !== 'undefined' && typeof window.fetch === 'function';

export const isWorkspaceFileBackendAvailable = () => isDesktopWorkspaceFileBackendAvailable() || isWebWorkspaceFileBackendAvailable();

type CreateWorkspaceFileBackendOptions = {
  preferDesktopBridge?: boolean;
};

const createUnavailableWorkspaceFileBackend = (): WorkspaceFileBackend => ({
  list: async () => {
    throw new Error(unavailableError);
  },
  read: async () => {
    throw new Error(unavailableError);
  },
  hash: async () => {
    throw new Error(unavailableError);
  },
  diffPreview: async () => {
    throw new Error(unavailableError);
  },
  write: async () => {
    throw new Error(unavailableError);
  },
  mkdir: async () => {
    throw new Error(unavailableError);
  },
  move: async () => {
    throw new Error(unavailableError);
  },
  delete: async () => {
    throw new Error(unavailableError);
  },
  index: async () => {
    throw new Error(unavailableError);
  },
  upload: async () => {
    throw new Error(unavailableError);
  },
});

type WorkspaceFileWatchTokenResponse = {
  token: string;
  wsUrl: string;
};

type WorkspaceFileWatchHostEvent =
  | { type: 'workspace-file.watch.accepted'; clientId?: string; portalId?: string }
  | { type: 'workspace-file.watch.ready'; requestId?: string; paths: string[] }
  | { type: 'workspace-file.watch.change'; event: EditorWatchEvent }
  | { type: 'workspace-file.watch.error'; requestId?: string; error: string };

let workspaceFileWatchRequestCounter = 0;

const nextWorkspaceFileWatchRequestId = () => {
  workspaceFileWatchRequestCounter += 1;
  return `workspace-file-watch-${workspaceFileWatchRequestCounter.toString(36)}`;
};

const requestWorkspaceFileWatchToken = async (target: EditorTarget) => {
  const response = await fetch(weaveRoutes.workspaceFiles.watchToken(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ target }),
  });
  const text = await response.text();
  const parsed = text
    ? (() => {
        try {
          return JSON.parse(text) as { error?: string } & WorkspaceFileWatchTokenResponse;
        } catch {
          return undefined;
        }
      })()
    : undefined;
  if (!response.ok) throw new Error(parsed?.error || text || `Workspace file watch token request failed: HTTP ${response.status}`);
  if (!parsed?.token || !parsed.wsUrl) throw new Error('Workspace file watch token response was incomplete.');
  return parsed;
};

const createWebWorkspaceFileWatchSubscription = async (
  target: EditorTarget,
  paths: string[],
  listener: (event: EditorWatchEvent) => void,
): Promise<EditorWatchSubscription> => {
  const token = await requestWorkspaceFileWatchToken(target);
  const url = new URL(token.wsUrl, window.location.href);
  url.searchParams.set('token', token.token);

  const socket = new WebSocket(url);
  const pendingRequests = new Map<string, {
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  let closed = false;

  const send = (message: { type: 'watch.start' | 'watch.update' | 'watch.stop'; requestId?: string; paths?: string[] }) => {
    if (socket.readyState !== WebSocket.OPEN) throw new Error('Workspace file watch WebSocket is not open.');
    socket.send(JSON.stringify(message));
  };

  const request = (message: { type: 'watch.start' | 'watch.update' | 'watch.stop'; paths?: string[] }) =>
    new Promise<void>((resolve, reject) => {
      const requestId = nextWorkspaceFileWatchRequestId();
      pendingRequests.set(requestId, { resolve, reject });
      send({ ...message, requestId });
    });

  const opened = new Promise<void>((resolve, reject) => {
    socket.onopen = () => {
      request({ type: 'watch.start', paths }).then(resolve, reject);
    };
    socket.onerror = () => {
      reject(new Error('Workspace file watch WebSocket failed.'));
    };
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data)) as WorkspaceFileWatchHostEvent;
      if (message.type === 'workspace-file.watch.accepted') return;
      if (message.type === 'workspace-file.watch.ready' && message.requestId) {
        pendingRequests.get(message.requestId)?.resolve();
        pendingRequests.delete(message.requestId);
        return;
      }
      if (message.type === 'workspace-file.watch.error') {
        if (message.requestId) {
          pendingRequests.get(message.requestId)?.reject(new Error(message.error));
          pendingRequests.delete(message.requestId);
          return;
        }
        console.warn(message.error);
        return;
      }
      if (message.type === 'workspace-file.watch.change') listener(message.event);
    };
    socket.onclose = () => {
      closed = true;
      for (const pending of pendingRequests.values()) pending.reject(new Error('Workspace file watch WebSocket closed.'));
      pendingRequests.clear();
    };
  });

  await opened;

  return {
    update: nextPaths => request({ type: 'watch.update', paths: nextPaths }),
    close: () => {
      if (closed) return;
      closed = true;
      if (socket.readyState === WebSocket.OPEN) {
        try {
          send({ type: 'watch.stop' });
        } catch {
          // Closing the socket is enough if the stop message cannot be sent.
        }
      }
      socket.close();
    },
  };
};

export const createWorkspaceFileBackend = (options: CreateWorkspaceFileBackendOptions = {}): WorkspaceFileBackend => {
  const bridge = options.preferDesktopBridge === false ? undefined : getDesktopBridge();
  if (!bridge && !isWebWorkspaceFileBackendAvailable()) return createUnavailableWorkspaceFileBackend();

  const request = async <T>(
    action: 'list' | 'read' | 'hash' | 'diffPreview' | 'write' | 'mkdir' | 'move' | 'delete' | 'index' | 'upload',
    body: unknown,
  ): Promise<T> => {
    const response = await fetch(weaveRoutes.workspaceFiles.action(action), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = text
      ? (() => {
          try {
            return JSON.parse(text) as { error?: string } & T;
          } catch {
            return undefined;
          }
        })()
      : undefined;
    if (!response.ok) throw new Error(parsed?.error || text || `Workspace file request failed: HTTP ${response.status}`);
    if (!parsed) throw new Error('Workspace file response was empty.');
    return parsed;
  };

  if (!bridge) {
    return {
      list: (target, path) => request<EditorListResult>('list', { target, path }),
      read: (target, path) => request<EditorFile>('read', { target, path }),
      hash: (target, path) => request<EditorHashResult>('hash', { target, path }),
      diffPreview: (target, path, diff) => request<EditorDiffPreviewResult>('diffPreview', { target, path, diff }),
      write: (target, path, content, version) => request<EditorWriteResult>('write', { target, path, content, version }),
      mkdir: (target, path) => request<FileOperationResult>('mkdir', { target, path }),
      move: (target, fromPath, toPath, overwrite) => request<FileOperationResult>('move', { target, fromPath, toPath, overwrite }),
      delete: (target, path, recursive) => request<FileOperationResult>('delete', { target, path, recursive }),
      index: (target, path) => request<WorkspaceFileIndexResult>('index', { target, path }),
      upload: (target, path, base64Content, contentType) =>
        request<FileOperationResult>('upload', { target, path, base64Content, contentType }),
      watch: createWebWorkspaceFileWatchSubscription,
    };
  }

  const canWatch = typeof bridge.workspaceFileWatchStart === 'function' &&
    typeof bridge.workspaceFileWatchUpdate === 'function' &&
    typeof bridge.workspaceFileWatchStop === 'function' &&
    typeof bridge.onWorkspaceFileWatchEvent === 'function';

  return {
    list: (target, path) => bridge.workspaceFileList(target, path),
    read: (target, path) => bridge.workspaceFileRead(target, path),
    hash: (target, path) => bridge.workspaceFileHash(target, path),
    diffPreview: (target, path, diff) => bridge.workspaceFileDiffPreview(target, path, diff),
    write: (target, path, content, version) => bridge.workspaceFileWrite(target, path, content, version),
    mkdir: (target, path) => bridge.workspaceFileMkdir(target, path),
    move: (target, fromPath, toPath, overwrite) => bridge.workspaceFileMove(target, fromPath, toPath, overwrite),
    delete: (target, path, recursive) => bridge.workspaceFileDelete(target, path, recursive),
    index: (target, path) => bridge.workspaceFileIndex(target, path),
    upload: (target, path, base64Content, contentType) => bridge.workspaceFileUpload(target, path, base64Content, contentType),
    ...(canWatch
      ? {
          watch: async (target, paths, listener) => {
            const started = await bridge.workspaceFileWatchStart!(target, paths);
            const unsubscribe = bridge.onWorkspaceFileWatchEvent!(event => {
              if (event.subscriptionId !== started.subscriptionId) return;
              if (event.error) {
                console.warn(event.error);
                return;
              }
              if (event.event) listener(event.event);
            });
            return {
              update: async nextPaths => {
                await bridge.workspaceFileWatchUpdate!(started.subscriptionId, nextPaths);
              },
              close: () => {
                unsubscribe();
                void bridge.workspaceFileWatchStop!(started.subscriptionId).catch(() => undefined);
              },
            };
          },
        } satisfies Pick<WorkspaceFileBackend, 'watch'>
      : {}),
  };
};

export type WorkspaceFileTarget = EditorTarget;

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
  entries: EditorListResult['entries'];
  notes: WorkspaceFileNote[];
  attachments: WorkspaceFileAttachment[];
  backlinks: Record<string, string[]>;
  checkedAt: string;
};
