import { describe, expect, it } from 'vitest';
import {
  getEditorDocumentLabel,
  getEditorDocumentMediaType,
  isEditorPathOpenable,
  resolveEditorDocumentKind,
} from '../../packages/client/src/lib/editor-document-kind';

describe('editor document kind resolver', () => {
  it('resolves code mode paths to code documents', () => {
    expect(resolveEditorDocumentKind({ mode: 'code', path: 'src/app.ts' })).toBe('code');
    expect(getEditorDocumentMediaType(resolveEditorDocumentKind({ mode: 'code', path: 'src/app.ts' }))).toBeUndefined();
  });

  it('resolves notes document types by extension', () => {
    expect(resolveEditorDocumentKind({ mode: 'notes', path: 'Research.md' })).toBe('markdown');
    expect(resolveEditorDocumentKind({ mode: 'notes', path: 'Sketch.excalidraw' })).toBe('excalidraw');
    expect(resolveEditorDocumentKind({ mode: 'notes', path: 'Notebook.cpr' })).toBe('coppermind');
  });

  it('keeps unknown notes files closed to the editor host', () => {
    expect(resolveEditorDocumentKind({ mode: 'notes', path: 'archive.zip' })).toBeUndefined();
    expect(isEditorPathOpenable('notes', 'archive.zip')).toBe(false);
  });

  it('provides display labels for note document types', () => {
    expect(getEditorDocumentLabel('Research.md', 'notes')).toBe('Research');
    expect(getEditorDocumentLabel('Sketch.excalidraw', 'notes')).toBe('Sketch');
    expect(getEditorDocumentLabel('Notebook.cpr', 'notes')).toBe('Notebook');
  });
});

