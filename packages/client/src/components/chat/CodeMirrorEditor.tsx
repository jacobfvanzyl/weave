import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView, GutterMarker, gutter, gutters, keymap, type ViewUpdate } from '@codemirror/view';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { tags as t } from '@lezer/highlight';
import { getCM, vim } from '@replit/codemirror-vim';
import { basicSetup } from 'codemirror';

export type VimMode =
  | 'normal'
  | 'insert'
  | 'visual'
  | 'visualLine'
  | 'visualBlock'
  | 'replace'
  | 'command'
  | 'terminal';

type CodeMirrorEditorProps = {
  path?: string;
  value: string;
  readOnly?: boolean;
  onChange: (value: string) => void;
  onSave?: () => void;
  onVimModeChange?: (mode: VimMode) => void;
};

export type CodeMirrorEditorHandle = {
  focus: () => void;
};

type VimModeChangeEvent = {
  mode?: string;
  subMode?: string;
};

const catppuccinMocha = {
  rosewater: '#f5e0dc',
  flamingo: '#f2cdcd',
  pink: '#f5c2e7',
  mauve: '#cba6f7',
  red: '#f38ba8',
  maroon: '#eba0ac',
  peach: '#fab387',
  yellow: '#f9e2af',
  green: '#a6e3a1',
  teal: '#94e2d5',
  sky: '#89dceb',
  sapphire: '#74c7ec',
  blue: '#89b4fa',
  lavender: '#b4befe',
  text: '#cdd6f4',
  subtext1: '#bac2de',
  subtext0: '#a6adc8',
  overlay2: '#9399b2',
  overlay1: '#7f849c',
  overlay0: '#6c7086',
  surface2: '#585b70',
  surface1: '#45475a',
  surface0: '#313244',
  base: '#1e1e2e',
  mantle: '#181825',
  crust: '#11111b',
};

const catppuccinMochaHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.moduleKeyword], color: catppuccinMocha.mauve },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: catppuccinMocha.red },
  { tag: [t.propertyName, t.attributeName], color: catppuccinMocha.blue },
  { tag: [t.variableName, t.definition(t.variableName)], color: catppuccinMocha.text },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: catppuccinMocha.blue },
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom], color: catppuccinMocha.peach },
  { tag: [t.string, t.special(t.string), t.regexp], color: catppuccinMocha.green },
  { tag: [t.escape, t.link], color: catppuccinMocha.teal },
  { tag: [t.typeName, t.className, t.namespace], color: catppuccinMocha.yellow },
  { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: catppuccinMocha.peach },
  { tag: [t.definitionKeyword, t.self, t.operator, t.derefOperator], color: catppuccinMocha.sky },
  { tag: [t.comment, t.lineComment, t.blockComment], color: catppuccinMocha.overlay1, fontStyle: 'italic' },
  { tag: [t.meta, t.processingInstruction, t.annotation], color: catppuccinMocha.flamingo },
  { tag: [t.heading, t.strong], color: catppuccinMocha.mauve, fontWeight: '600' },
  { tag: [t.emphasis], color: catppuccinMocha.pink, fontStyle: 'italic' },
  { tag: [t.strikethrough], textDecoration: 'line-through' },
  { tag: [t.inserted], color: catppuccinMocha.green },
  { tag: [t.invalid], color: catppuccinMocha.red },
]);

class RelativeLineNumberMarker extends GutterMarker {
  constructor(public readonly label: string) {
    super();
  }

  eq(other: GutterMarker) {
    return other instanceof RelativeLineNumberMarker && other.label === this.label;
  }

  toDOM() {
    return document.createTextNode(this.label);
  }
}

const getLineNumberSpacer = (lineCount: number) => {
  let last = 9;
  while (last < lineCount) last = last * 10 + 9;
  return String(last);
};

const relativeLineNumbers: Extension = [
  gutters(),
  gutter({
    class: 'cm-lineNumbers cm-relativeLineNumbers',
    renderEmptyElements: false,
    lineMarker: (view, line) => {
      const lineNumber = view.state.doc.lineAt(line.from).number;
      const cursorLineNumber = view.state.doc.lineAt(view.state.selection.main.head).number;
      const label = lineNumber === cursorLineNumber ? String(lineNumber) : String(Math.abs(lineNumber - cursorLineNumber));
      return new RelativeLineNumberMarker(label);
    },
    lineMarkerChange: update => update.docChanged || update.selectionSet || update.viewportChanged,
    initialSpacer: view => new RelativeLineNumberMarker(getLineNumberSpacer(view.state.doc.lines)),
    updateSpacer: (spacer, update) => {
      const nextLabel = getLineNumberSpacer(update.view.state.doc.lines);
      return spacer instanceof RelativeLineNumberMarker && spacer.label === nextLabel
        ? spacer
        : new RelativeLineNumberMarker(nextLabel);
    },
  }),
];

// basicSetup starts with an absolute line-number gutter; replace that one with our relative gutter.
const editorBasicSetup: Extension = Array.isArray(basicSetup)
  ? (basicSetup as readonly Extension[]).slice(1)
  : basicSetup;

const toVimMode = (event: VimModeChangeEvent = {}): VimMode => {
  switch (event.mode) {
    case 'insert':
      return 'insert';
    case 'visual':
      if (event.subMode === 'linewise') return 'visualLine';
      if (event.subMode === 'blockwise') return 'visualBlock';
      return 'visual';
    case 'replace':
      return 'replace';
    case 'command':
      return 'command';
    case 'terminal':
      return 'terminal';
    case 'normal':
    default:
      return 'normal';
  }
};

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: catppuccinMocha.base,
    color: catppuccinMocha.text,
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-code)',
    fontSize: 'var(--weave-chat-text-size)',
    lineHeight: 'var(--weave-chat-line-height)',
  },
  '.cm-content': {
    minHeight: '100%',
    padding: '12px 0',
    caretColor: catppuccinMocha.rosewater,
  },
  '.cm-line': {
    padding: '0 12px',
  },
  '.cm-gutters': {
    backgroundColor: catppuccinMocha.mantle,
    borderRight: `1px solid ${catppuccinMocha.surface0}`,
    color: catppuccinMocha.overlay1,
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 10px 0 8px',
  },
  '.cm-activeLine': {
    backgroundColor: catppuccinMocha.surface0,
  },
  '.cm-activeLineGutter': {
    backgroundColor: catppuccinMocha.surface0,
    color: catppuccinMocha.subtext1,
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: catppuccinMocha.rosewater,
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: `${catppuccinMocha.surface2}99`,
  },
  '.cm-searchMatch': {
    backgroundColor: `${catppuccinMocha.yellow}33`,
    outline: `1px solid ${catppuccinMocha.yellow}66`,
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: `${catppuccinMocha.peach}4d`,
  },
  '.cm-matchingBracket, .cm-nonmatchingBracket': {
    backgroundColor: catppuccinMocha.surface1,
    color: catppuccinMocha.text,
    outline: `1px solid ${catppuccinMocha.surface2}`,
  },
  '.cm-placeholder': {
    color: catppuccinMocha.overlay0,
  },
  '.cm-panels': {
    backgroundColor: catppuccinMocha.mantle,
    color: catppuccinMocha.text,
  },
  '.cm-panels.cm-panels-top': {
    borderBottom: `1px solid ${catppuccinMocha.surface0}`,
  },
  '.cm-panels.cm-panels-bottom': {
    borderTop: `1px solid ${catppuccinMocha.surface0}`,
  },
  '.cm-tooltip': {
    backgroundColor: catppuccinMocha.surface0,
    border: `1px solid ${catppuccinMocha.surface1}`,
    color: catppuccinMocha.text,
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: catppuccinMocha.surface1,
    color: catppuccinMocha.text,
  },
  '.cm-diagnostic': {
    borderLeftColor: catppuccinMocha.red,
  },
  '&.cm-focused': {
    outline: 'none',
  },
}, { dark: true });

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

export const CodeMirrorEditor = forwardRef<CodeMirrorEditorHandle, CodeMirrorEditorProps>(({
  path,
  value,
  readOnly,
  onChange,
  onSave,
  onVimModeChange,
}, ref) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onVimModeChangeRef = useRef(onVimModeChange);
  const isSyncingRef = useRef(false);
  const languageExtensions = useMemo(() => getLanguageExtension(path), [path]);

  useImperativeHandle(ref, () => ({
    focus: () => viewRef.current?.focus(),
  }), []);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    onVimModeChangeRef.current = onVimModeChange;
  }, [onVimModeChange]);

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
        vim({ status: false }),
        relativeLineNumbers,
        editorBasicSetup,
        editorTheme,
        syntaxHighlighting(catppuccinMochaHighlightStyle),
        EditorView.lineWrapping,
        EditorView.editable.of(!readOnly),
        saveKeymap,
        updateListener,
        ...languageExtensions,
      ],
    });

    viewRef.current = view;
    onVimModeChangeRef.current?.('normal');

    const cm = getCM(view);
    const handleVimModeChange = (event: VimModeChangeEvent) => {
      onVimModeChangeRef.current?.(toVimMode(event));
    };
    cm?.on('vim-mode-change', handleVimModeChange);

    return () => {
      cm?.off('vim-mode-change', handleVimModeChange);
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
});

CodeMirrorEditor.displayName = 'CodeMirrorEditor';
