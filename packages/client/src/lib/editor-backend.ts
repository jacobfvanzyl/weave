import type {
  EditorBackend,
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

type EditorWatchStartResult = {
  subscriptionId: string;
  paths: string[];
};

type DesktopEditorWatchEventEnvelope = {
  subscriptionId: string;
  event?: EditorWatchEvent;
  error?: string;
};

type DesktopEditorBridge = {
  editorList: (target: EditorTarget, path?: string) => Promise<EditorListResult>;
  editorRead: (target: EditorTarget, path: string) => Promise<EditorFile>;
  editorHash: (target: EditorTarget, path: string) => Promise<EditorHashResult>;
  editorDiffPreview: (target: EditorTarget, path: string, diff: string) => Promise<EditorDiffPreviewResult>;
  editorWrite: (target: EditorTarget, path: string, content: string, version?: string) => Promise<EditorWriteResult>;
  editorMkdir: (target: EditorTarget, path: string) => Promise<FileOperationResult>;
  editorMove: (target: EditorTarget, fromPath: string, toPath: string, overwrite?: boolean) => Promise<FileOperationResult>;
  editorDelete: (target: EditorTarget, path: string, recursive?: boolean) => Promise<FileOperationResult>;
  editorWatchStart?: (target: EditorTarget, paths: string[]) => Promise<EditorWatchStartResult>;
  editorWatchUpdate?: (subscriptionId: string, paths: string[]) => Promise<EditorWatchStartResult>;
  editorWatchStop?: (subscriptionId: string) => Promise<void>;
  onEditorWatchEvent?: (listener: (event: DesktopEditorWatchEventEnvelope) => void) => () => void;
};

type WindowWithDesktopEditor = Window & {
  weaveDesktop?: Partial<DesktopEditorBridge>;
};

const unavailableError = 'Editor backend unavailable in this client.';

const getDesktopBridge = () => {
  if (typeof window === 'undefined') return undefined;
  const bridge = (window as WindowWithDesktopEditor).weaveDesktop;
  if (
    typeof bridge?.editorList !== 'function'
    || typeof bridge.editorRead !== 'function'
    || typeof bridge.editorHash !== 'function'
    || typeof bridge.editorDiffPreview !== 'function'
    || typeof bridge.editorWrite !== 'function'
    || typeof bridge.editorMkdir !== 'function'
    || typeof bridge.editorMove !== 'function'
    || typeof bridge.editorDelete !== 'function'
  ) {
    return undefined;
  }

  return bridge as DesktopEditorBridge;
};

export const isDesktopEditorBackendAvailable = () => Boolean(getDesktopBridge());

export const isWebEditorBackendAvailable = () =>
  typeof window !== 'undefined' && typeof window.fetch === 'function';

export const isEditorBackendAvailable = () => isDesktopEditorBackendAvailable() || isWebEditorBackendAvailable();

const createUnavailableEditorBackend = (): EditorBackend => ({
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
});

type EditorWatchTokenResponse = {
  token: string;
  wsUrl: string;
};

type EditorWatchHostEvent =
  | { type: 'editor.watch.accepted'; clientId?: string; portalId?: string }
  | { type: 'editor.watch.ready'; requestId?: string; paths: string[] }
  | { type: 'editor.watch.change'; event: EditorWatchEvent }
  | { type: 'editor.watch.error'; requestId?: string; error: string };

let editorWatchRequestCounter = 0;

const nextEditorWatchRequestId = () => {
  editorWatchRequestCounter += 1;
  return `editor-watch-${editorWatchRequestCounter.toString(36)}`;
};

const requestEditorWatchToken = async (target: EditorTarget) => {
  const response = await fetch(weaveRoutes.code.editorWatchToken(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ target }),
  });
  const text = await response.text();
  const parsed = text
    ? (() => {
        try {
          return JSON.parse(text) as { error?: string } & EditorWatchTokenResponse;
        } catch {
          return undefined;
        }
      })()
    : undefined;
  if (!response.ok) throw new Error(parsed?.error || text || `Editor watch token request failed: HTTP ${response.status}`);
  if (!parsed?.token || !parsed.wsUrl) throw new Error('Editor watch token response was incomplete.');
  return parsed;
};

const createWebEditorWatchSubscription = async (
  target: EditorTarget,
  paths: string[],
  listener: (event: EditorWatchEvent) => void,
): Promise<EditorWatchSubscription> => {
  const token = await requestEditorWatchToken(target);
  const url = new URL(token.wsUrl, window.location.href);
  url.searchParams.set('token', token.token);

  const socket = new WebSocket(url);
  const pendingRequests = new Map<string, {
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  let closed = false;

  const send = (message: { type: 'watch.start' | 'watch.update' | 'watch.stop'; requestId?: string; paths?: string[] }) => {
    if (socket.readyState !== WebSocket.OPEN) throw new Error('Editor watch WebSocket is not open.');
    socket.send(JSON.stringify(message));
  };

  const request = (message: { type: 'watch.start' | 'watch.update' | 'watch.stop'; paths?: string[] }) =>
    new Promise<void>((resolve, reject) => {
      const requestId = nextEditorWatchRequestId();
      pendingRequests.set(requestId, { resolve, reject });
      send({ ...message, requestId });
    });

  const opened = new Promise<void>((resolve, reject) => {
    socket.onopen = () => {
      request({ type: 'watch.start', paths }).then(resolve, reject);
    };
    socket.onerror = () => {
      reject(new Error('Editor watch WebSocket failed.'));
    };
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data)) as EditorWatchHostEvent;
      if (message.type === 'editor.watch.accepted') return;
      if (message.type === 'editor.watch.ready' && message.requestId) {
        pendingRequests.get(message.requestId)?.resolve();
        pendingRequests.delete(message.requestId);
        return;
      }
      if (message.type === 'editor.watch.error') {
        if (message.requestId) {
          pendingRequests.get(message.requestId)?.reject(new Error(message.error));
          pendingRequests.delete(message.requestId);
          return;
        }
        console.warn(message.error);
        return;
      }
      if (message.type === 'editor.watch.change') listener(message.event);
    };
    socket.onclose = () => {
      closed = true;
      for (const pending of pendingRequests.values()) pending.reject(new Error('Editor watch WebSocket closed.'));
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

export const createEditorBackend = (): EditorBackend => {
  const bridge = getDesktopBridge();
  if (!bridge && !isWebEditorBackendAvailable()) return createUnavailableEditorBackend();

  if (!bridge) {
    const request = async <T>(action: 'list' | 'read' | 'hash' | 'diffPreview' | 'write' | 'mkdir' | 'move' | 'delete', body: unknown): Promise<T> => {
      const response = await fetch(weaveRoutes.code.editor(action), {
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
      if (!response.ok) throw new Error(parsed?.error || text || `Editor request failed: HTTP ${response.status}`);
      if (!parsed) throw new Error('Editor response was empty.');
      return parsed;
    };

    return {
      list: (target, path) => request<EditorListResult>('list', { target, path }),
      read: (target, path) => request<EditorFile>('read', { target, path }),
      hash: (target, path) => request<EditorHashResult>('hash', { target, path }),
      diffPreview: (target, path, diff) => request<EditorDiffPreviewResult>('diffPreview', { target, path, diff }),
      write: (target, path, content, version) => request<EditorWriteResult>('write', { target, path, content, version }),
      mkdir: (target, path) => request<FileOperationResult>('mkdir', { target, path }),
      move: (target, fromPath, toPath, overwrite) => request<FileOperationResult>('move', { target, fromPath, toPath, overwrite }),
      delete: (target, path, recursive) => request<FileOperationResult>('delete', { target, path, recursive }),
      watch: createWebEditorWatchSubscription,
    };
  }

  const canWatch = typeof bridge.editorWatchStart === 'function' &&
    typeof bridge.editorWatchUpdate === 'function' &&
    typeof bridge.editorWatchStop === 'function' &&
    typeof bridge.onEditorWatchEvent === 'function';

  return {
    list: (target, path) => bridge.editorList(target, path),
    read: (target, path) => bridge.editorRead(target, path),
    hash: (target, path) => bridge.editorHash(target, path),
    diffPreview: (target, path, diff) => bridge.editorDiffPreview(target, path, diff),
    write: (target, path, content, version) => bridge.editorWrite(target, path, content, version),
    mkdir: (target, path) => bridge.editorMkdir(target, path),
    move: (target, fromPath, toPath, overwrite) => bridge.editorMove(target, fromPath, toPath, overwrite),
    delete: (target, path, recursive) => bridge.editorDelete(target, path, recursive),
    ...(canWatch
      ? {
          watch: async (target, paths, listener) => {
            const started = await bridge.editorWatchStart!(target, paths);
            const unsubscribe = bridge.onEditorWatchEvent!(event => {
              if (event.subscriptionId !== started.subscriptionId) return;
              if (event.error) {
                console.warn(event.error);
                return;
              }
              if (event.event) listener(event.event);
            });
            return {
              update: async nextPaths => {
                await bridge.editorWatchUpdate!(started.subscriptionId, nextPaths);
              },
              close: () => {
                unsubscribe();
                void bridge.editorWatchStop!(started.subscriptionId).catch(() => undefined);
              },
            };
          },
        } satisfies Pick<EditorBackend, 'watch'>
      : {}),
  };
};
