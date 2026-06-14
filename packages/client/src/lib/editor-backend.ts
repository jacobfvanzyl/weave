import type { EditorBackend, EditorFile, EditorListResult, EditorTarget, EditorWriteResult, FileOperationResult } from './editor-types';
import { getAuthHeaders, getMastraUrl } from './mastra-client';

type DesktopEditorBridge = {
  editorList: (target: EditorTarget, path?: string) => Promise<EditorListResult>;
  editorRead: (target: EditorTarget, path: string) => Promise<EditorFile>;
  editorWrite: (target: EditorTarget, path: string, content: string, version?: string) => Promise<EditorWriteResult>;
  editorMkdir: (target: EditorTarget, path: string) => Promise<FileOperationResult>;
  editorMove: (target: EditorTarget, fromPath: string, toPath: string, overwrite?: boolean) => Promise<FileOperationResult>;
  editorDelete: (target: EditorTarget, path: string, recursive?: boolean) => Promise<FileOperationResult>;
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

export const createEditorBackend = (): EditorBackend => {
  const bridge = getDesktopBridge();
  if (!bridge && !isWebEditorBackendAvailable()) return createUnavailableEditorBackend();

  if (!bridge) {
    const request = async <T>(action: 'list' | 'read' | 'write' | 'mkdir' | 'move' | 'delete', body: unknown): Promise<T> => {
      const response = await fetch(`${getMastraUrl()}/editor/${action}`, {
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
      write: (target, path, content, version) => request<EditorWriteResult>('write', { target, path, content, version }),
      mkdir: (target, path) => request<FileOperationResult>('mkdir', { target, path }),
      move: (target, fromPath, toPath, overwrite) => request<FileOperationResult>('move', { target, fromPath, toPath, overwrite }),
      delete: (target, path, recursive) => request<FileOperationResult>('delete', { target, path, recursive }),
    };
  }

  return {
    list: (target, path) => bridge.editorList(target, path),
    read: (target, path) => bridge.editorRead(target, path),
    write: (target, path, content, version) => bridge.editorWrite(target, path, content, version),
    mkdir: (target, path) => bridge.editorMkdir(target, path),
    move: (target, fromPath, toPath, overwrite) => bridge.editorMove(target, fromPath, toPath, overwrite),
    delete: (target, path, recursive) => bridge.editorDelete(target, path, recursive),
  };
};
