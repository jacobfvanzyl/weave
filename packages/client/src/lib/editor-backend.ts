import type { EditorBackend, EditorFile, EditorListResult, EditorTarget, EditorWriteResult } from './editor-types';

type DesktopEditorBridge = {
  editorList: (target: EditorTarget, path?: string) => Promise<EditorListResult>;
  editorRead: (target: EditorTarget, path: string) => Promise<EditorFile>;
  editorWrite: (target: EditorTarget, path: string, content: string, version?: string) => Promise<EditorWriteResult>;
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
  ) {
    return undefined;
  }

  return bridge as DesktopEditorBridge;
};

export const isEditorBackendAvailable = () => Boolean(getDesktopBridge());

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
});

export const createEditorBackend = (): EditorBackend => {
  const bridge = getDesktopBridge();
  if (!bridge) return createUnavailableEditorBackend();

  return {
    list: (target, path) => bridge.editorList(target, path),
    read: (target, path) => bridge.editorRead(target, path),
    write: (target, path, content, version) => bridge.editorWrite(target, path, content, version),
  };
};
