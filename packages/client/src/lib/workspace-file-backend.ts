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
import { onRpcConnectionState, onRpcNotification, rpcRequest } from './mastra-client';
import { downloadBinaryTransfer, uploadBinaryTransfer } from './binary-transfers';

export const isDesktopWorkspaceFileBackendAvailable = () => false;
export const isWebWorkspaceFileBackendAvailable = () => true;
export const isWorkspaceFileBackendAvailable = () => true;

type CreateWorkspaceFileBackendOptions = {
  preferDesktopBridge?: boolean;
};

let watchCounter = 0;
const requestId = () => `workspace_watch_${++watchCounter}`;

const createRpcWorkspaceFileWatch = async (
  target: EditorTarget,
  paths: string[],
  listener: (event: EditorWatchEvent) => void,
): Promise<EditorWatchSubscription> => {
  const sessionId = `workspace_watch_${crypto.randomUUID()}`;
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  let closed = false;
  let currentPaths = [...paths];
  let disconnected = false;
  const detach = onRpcNotification('workspaceFile.watch.event', envelope => {
    if (envelope.sessionId !== sessionId) return;
    const event = envelope.event;
    if (event.type === 'workspace-file.watch.change') listener(event.event);
    if (event.type === 'workspace-file.watch.ready' && event.requestId) {
      pending.get(event.requestId)?.resolve();
      pending.delete(event.requestId);
    }
    if (event.type === 'workspace-file.watch.error') {
      if (event.requestId) pending.get(event.requestId)?.reject(new Error(event.error));
      pending.delete(event.requestId ?? '');
    }
  });

  const send = (method: 'start' | 'update' | 'stop', nextPaths?: string[]) => {
    const id = requestId();
    const result = new Promise<void>((resolve, reject) => pending.set(id, { resolve, reject }));
    void rpcRequest(`workspaceFile.watch.${method}`, {
      sessionId,
      target,
      requestId: id,
      ...(nextPaths ? { paths: nextPaths } : {}),
    }).catch(error => {
      pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error)));
      pending.delete(id);
    });
    return result;
  };

  await send('start', paths);
  const detachConnection = onRpcConnectionState(state => {
    if (state !== 'connected') {
      disconnected = true;
      return;
    }
    if (!disconnected || closed) return;
    disconnected = false;
    void send('start', currentPaths).then(() => listener({
      kind: 'any',
      paths: [...currentPaths],
      affectedDirectories: [...currentPaths],
    })).catch(() => undefined);
  });
  return {
    update: async nextPaths => {
      await send('update', nextPaths);
      currentPaths = [...nextPaths];
    },
    close: () => {
      if (closed) return;
      closed = true;
      detach();
      detachConnection();
      void rpcRequest('workspaceFile.watch.stop', { sessionId, target }).catch(() => undefined);
      for (const item of pending.values()) item.reject(new Error('Workspace file watch closed.'));
      pending.clear();
    },
  };
};

export const createWorkspaceFileBackend = (_options: CreateWorkspaceFileBackendOptions = {}): WorkspaceFileBackend => {
  return {
    list: (target, path) => rpcRequest('workspaceFile.list', { target, path }),
    read: async (target, path) => {
      const result = await rpcRequest(
        'workspaceFile.read',
        { target, path },
      );
      if (!result.contentTransfer) return result;
      const bytes = await downloadBinaryTransfer(result.contentTransfer);
      const { contentTransfer: _transfer, ...metadata } = result;
      return { ...metadata, content: new TextDecoder().decode(bytes) };
    },
    hash: (target, path) => rpcRequest('workspaceFile.hash', { target, path }),
    diffPreview: (target, path, diff) =>
      rpcRequest('workspaceFile.diffPreview', { target, path, diff }),
    write: async (target, path, content, version) => {
      const transfer = await uploadBinaryTransfer({
        bytes: new TextEncoder().encode(content),
        purpose: 'workspaceFile.write',
        mimeType: 'text/plain; charset=utf-8',
      });
      return await rpcRequest('workspaceFile.write', {
        target,
        path,
        transferId: transfer.transferId,
        version,
      });
    },
    mkdir: (target, path) => rpcRequest('workspaceFile.mkdir', { target, path }),
    move: (target, fromPath, toPath, overwrite) =>
      rpcRequest('workspaceFile.move', { target, fromPath, toPath, overwrite }),
    delete: (target, path, recursive) =>
      rpcRequest('workspaceFile.delete', { target, path, recursive }),
    index: (target, path) => rpcRequest('workspaceFile.index', { target, path }),
    upload: async (target, path, base64Content, contentType) => {
      const binary = atob(base64Content);
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      const transfer = await uploadBinaryTransfer({ bytes, purpose: 'workspaceFile.upload', mimeType: contentType });
      return await rpcRequest('workspaceFile.upload', {
        target,
        path,
        transferId: transfer.transferId,
        contentType,
      });
    },
    watch: createRpcWorkspaceFileWatch,
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
