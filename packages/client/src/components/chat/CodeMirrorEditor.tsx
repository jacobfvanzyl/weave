import { useEffect, useMemo, useRef } from 'react';
import type { Extension } from '@codemirror/state';
import { EditorView, keymap, type ViewUpdate } from '@codemirror/view';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { basicSetup } from 'codemirror';

type CodeMirrorEditorProps = {
  path?: string;
  value: string;
  readOnly?: boolean;
  onChange: (value: string) => void;
  onSave?: () => void;
};

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--background)',
    color: 'var(--foreground)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-code)',
    fontSize: '12px',
    lineHeight: '1.55',
  },
  '.cm-content': {
    minHeight: '100%',
    padding: '12px 0',
    caretColor: 'var(--primary)',
  },
  '.cm-line': {
    padding: '0 12px',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--card)',
    borderRight: '1px solid var(--border)',
    color: 'var(--muted-foreground)',
  },
  '.cm-activeLine': {
    backgroundColor: 'var(--accent)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--accent)',
    color: 'var(--foreground)',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, var(--primary) 32%, transparent)',
  },
  '&.cm-focused': {
    outline: 'none',
  },
});

const getLanguageExtension = (filePath: string | undefined): Extension[] => {
  const lowerPath = filePath?.toLowerCase() ?? '';
  if (/\.(ts|tsx|mts|cts)$/.test(lowerPath)) {
    return [javascript({ typescript: true, jsx: lowerPath.endsWith('x') })];
  }
  if (/\.(js|jsx|mjs|cjs)$/.test(lowerPath)) {
    return [javascript({ jsx: lowerPath.endsWith('x') })];
  }
  if (/\.(json|jsonc)$/.test(lowerPath)) return [json()];
  if (/\.(css|scss|sass|less)$/.test(lowerPath)) return [css()];
  if (/\.(html|htm|xml|svg)$/.test(lowerPath)) return [html()];
  if (/\.(md|mdx|markdown)$/.test(lowerPath)) return [markdown()];
  return [];
};

export const CodeMirrorEditor = ({ path, value, readOnly, onChange, onSave }: CodeMirrorEditorProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const isSyncingRef = useRef(false);
  const languageExtensions = useMemo(() => getLanguageExtension(path), [path]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const saveKeymap = keymap.of([{
      key: 'Mod-s',
      run: () => {
        onSaveRef.current?.();
        return true;
      },
    }]);
    const updateListener = EditorView.updateListener.of((update: ViewUpdate) => {
      if (!update.docChanged || isSyncingRef.current) return;
      onChangeRef.current(update.state.doc.toString());
    });
    const view = new EditorView({
      doc: value,
      parent: container,
      extensions: [
        basicSetup,
        editorTheme,
        EditorView.lineWrapping,
        EditorView.editable.of(!readOnly),
        saveKeymap,
        updateListener,
        ...languageExtensions,
      ],
    });

    viewRef.current = view;
    return () => {
      view.destroy();
      if (viewRef.current === view) viewRef.current = null;
    };
  }, [languageExtensions, path, readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const currentValue = view.state.doc.toString();
    if (currentValue === value) return;

    isSyncingRef.current = true;
    view.dispatch({
      changes: { from: 0, to: currentValue.length, insert: value },
    });
    isSyncingRef.current = false;
  }, [value]);

  return <div ref={containerRef} className="h-full min-h-0" />;
};
