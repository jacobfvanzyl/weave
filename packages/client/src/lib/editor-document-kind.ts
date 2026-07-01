import { getCoppermindDocumentDisplayName, isCoppermindDocumentPath } from './coppermind-document';
import type { EditorMode } from './editor-types';
import { getNoteFileDisplayName } from './note-display';

export type EditorDocumentKind = 'code' | 'markdown' | 'excalidraw' | 'coppermind';

const getBasename = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

export const isMarkdownDocumentPath = (path: string | undefined) => Boolean(path && /\.(md|markdown)$/i.test(path));
export const isExcalidrawDocumentPath = (path: string | undefined) => Boolean(path && /\.excalidraw$/i.test(path));

export const resolveEditorDocumentKind = ({
  mode,
  path,
}: {
  mode: EditorMode;
  path: string;
}): EditorDocumentKind | undefined => {
  if (mode === 'code') return 'code';
  if (isMarkdownDocumentPath(path)) return 'markdown';
  if (isExcalidrawDocumentPath(path)) return 'excalidraw';
  if (isCoppermindDocumentPath(path)) return 'coppermind';
  return undefined;
};

export const isEditorPathOpenable = (mode: EditorMode, path: string | undefined) => {
  if (!path) return false;
  return Boolean(resolveEditorDocumentKind({ mode, path }));
};

export const getEditorDocumentMediaType = (kind: EditorDocumentKind | undefined) => (
  kind === 'markdown' || kind === 'excalidraw' || kind === 'coppermind' ? kind : undefined
);

export const getEditorDocumentLabel = (path: string, mode: EditorMode) => {
  const kind = resolveEditorDocumentKind({ mode, path });
  if (kind === 'markdown') return getNoteFileDisplayName(path);
  if (kind === 'excalidraw') return getBasename(path).replace(/\.excalidraw$/i, '');
  if (kind === 'coppermind') return getCoppermindDocumentDisplayName(path);
  return getBasename(path);
};

export const getDefaultDocumentExtension = (kind: EditorDocumentKind) => {
  if (kind === 'coppermind') return '.cpr';
  if (kind === 'excalidraw') return '.excalidraw';
  if (kind === 'markdown') return '.md';
  return '';
};

