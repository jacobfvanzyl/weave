import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import {
  atomicMarkdownSyntax,
  imageBlocks,
  inlinePreview,
  tables,
  wikiLinks,
  type WikiLinkSuggestion,
} from '@atomic-editor/editor';
import '@atomic-editor/editor/styles.css';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Compartment, type Extension } from '@codemirror/state';
import { EditorView, GutterMarker, gutter, gutters, keymap, type ViewUpdate } from '@codemirror/view';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { LSPClient, languageServerExtensions } from '@codemirror/lsp-client';
import { tags as t } from '@lezer/highlight';
import { getCM, vim } from '@replit/codemirror-vim';
import { basicSetup } from 'codemirror';
import type { EditorTarget } from '../../lib/editor-types';
import { createLspSession, createLspWebSocketTransport, detectEditorLanguageId } from '../../lib/language-intelligence';

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
  editorMode?: 'code' | 'notes';
  path?: string;
  languageIntelligenceTarget?: EditorTarget;
  value: string;
  readOnly?: boolean;
  wikiLinkSuggestions?: WikiLinkSuggestion[];
  onChange: (value: string) => void;
  onGutterWidthChange?: (width: number) => void;
  onOpenWikiLink?: (target: string) => void;
  onSave?: () => void;
  onVimModeChange?: (mode: VimMode) => void;
};

export type CodeMirrorEditorHandle = {
  focus: () => void;
  revealLine: (line: number, options?: { focus?: boolean }) => void;
};

type VimModeChangeEvent = {
  mode?: string;
  subMode?: string;
};

export const editorCanvasBackgroundColor = '#1e1e2e';

const weaveHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.moduleKeyword], color: 'var(--weave-syntax-keyword)' },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: 'var(--weave-syntax-name)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--weave-syntax-property)' },
  { tag: [t.variableName, t.definition(t.variableName)], color: 'var(--weave-syntax-variable)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: 'var(--weave-syntax-function)' },
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom], color: 'var(--weave-syntax-constant)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--weave-syntax-string)' },
  { tag: [t.escape, t.link], color: 'var(--weave-syntax-link)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--weave-syntax-type)' },
  { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: 'var(--weave-syntax-constant)' },
  { tag: [t.definitionKeyword, t.self, t.operator, t.derefOperator], color: 'var(--weave-syntax-operator)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--weave-syntax-comment)', fontStyle: 'italic' },
  { tag: [t.meta, t.processingInstruction, t.annotation], color: 'var(--weave-syntax-meta)' },
  { tag: [t.heading, t.strong], color: 'var(--weave-syntax-heading)', fontWeight: '600' },
  { tag: [t.emphasis], color: 'var(--weave-syntax-emphasis)', fontStyle: 'italic' },
  { tag: [t.strikethrough], textDecoration: 'line-through' },
  { tag: [t.inserted], color: 'var(--weave-syntax-inserted)' },
  { tag: [t.invalid], color: 'var(--weave-syntax-invalid)' },
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
    backgroundColor: 'var(--weave-editor-background)',
    color: 'var(--weave-editor-foreground)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-code)',
    fontSize: 'var(--weave-chat-text-size)',
    lineHeight: 'var(--weave-chat-line-height)',
  },
  '.cm-content': {
    minHeight: '100%',
    padding: '12px 0',
    caretColor: 'var(--weave-editor-caret)',
  },
  '.cm-line': {
    padding: '0 12px',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--weave-editor-gutter-background)',
    borderRight: '1px solid var(--weave-editor-gutter-border)',
    color: 'var(--weave-editor-gutter-foreground)',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 10px 0 8px',
  },
  '.cm-activeLine': {
    backgroundColor: 'var(--weave-editor-active-line)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--weave-editor-active-line)',
    color: 'var(--weave-editor-active-gutter-foreground)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--weave-editor-caret)',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--weave-editor-selection)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'var(--weave-editor-search-match)',
    outline: '1px solid var(--weave-editor-search-match-border)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--weave-editor-search-match-selected)',
  },
  '.cm-matchingBracket, .cm-nonmatchingBracket': {
    backgroundColor: 'var(--weave-editor-matching-bracket)',
    color: 'var(--weave-editor-foreground)',
    outline: '1px solid var(--weave-editor-matching-bracket-border)',
  },
  '.cm-placeholder': {
    color: 'var(--muted-foreground)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--popover)',
    color: 'var(--popover-foreground)',
  },
  '.cm-panels.cm-panels-top': {
    borderBottom: '1px solid var(--border)',
  },
  '.cm-panels.cm-panels-bottom': {
    borderTop: '1px solid var(--border)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--popover)',
    border: '1px solid var(--border)',
    color: 'var(--popover-foreground)',
    boxShadow: 'var(--shadow-sm)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--accent)',
    color: 'var(--accent-foreground)',
  },
  '.cm-diagnostic': {
    borderLeftColor: 'var(--destructive)',
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

export const CodeMirrorEditor = forwardRef<CodeMirrorEditorHandle, CodeMirrorEditorProps>(({
  editorMode = 'code',
  path,
  languageIntelligenceTarget,
  value,
  readOnly,
  wikiLinkSuggestions = [],
  onChange,
  onGutterWidthChange,
  onOpenWikiLink,
  onSave,
  onVimModeChange,
}, ref) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onGutterWidthChangeRef = useRef(onGutterWidthChange);
  const onOpenWikiLinkRef = useRef(onOpenWikiLink);
  const onSaveRef = useRef(onSave);
  const onVimModeChangeRef = useRef(onVimModeChange);
  const wikiLinkSuggestionsRef = useRef(wikiLinkSuggestions);
  const isSyncingRef = useRef(false);
  const lspCompartment = useMemo(() => new Compartment(), []);
  const languageExtensions = useMemo(() => getLanguageExtension(path), [path]);
  const notesMarkdownExtensions = useMemo<Extension[]>(() => {
    const isNotesMarkdown = editorMode === 'notes' && /\.(md|mdx|markdown)$/i.test(path ?? '');
    if (!isNotesMarkdown) return [];

    const openExternalLink = (url: string) => {
      window.open(url, '_blank', 'noopener,noreferrer');
    };
    const findSuggestion = (target: string) => {
      const normalizedTarget = target.replace(/\.(md|markdown)$/i, '').toLowerCase();
      return wikiLinkSuggestionsRef.current.find(suggestion => {
        const normalizedSuggestion = suggestion.target.replace(/\.(md|markdown)$/i, '').toLowerCase();
        return normalizedSuggestion === normalizedTarget || suggestion.label.toLowerCase() === normalizedTarget;
      });
    };

    return [
      atomicMarkdownSyntax,
      inlinePreview({ onLinkClick: openExternalLink }),
      tables({ onLinkClick: openExternalLink }),
      imageBlocks(),
      wikiLinks({
        openOnClick: true,
        suggest: async query => {
          const lowerQuery = query.trim().toLowerCase();
          return wikiLinkSuggestionsRef.current
            .filter(suggestion =>
              !lowerQuery
              || suggestion.target.toLowerCase().includes(lowerQuery)
              || suggestion.label.toLowerCase().includes(lowerQuery)
              || suggestion.detail?.toLowerCase().includes(lowerQuery),
            )
            .slice(0, 50);
        },
        resolve: async target => {
          const suggestion = findSuggestion(target);
          if (!suggestion) return { target, label: target, status: 'missing' };
          return { target: suggestion.target, label: suggestion.label, status: 'resolved' };
        },
        onOpen: target => {
          const suggestion = findSuggestion(target);
          onOpenWikiLinkRef.current?.(suggestion?.target ?? target);
        },
      }),
    ];
  }, [editorMode, path]);

  useImperativeHandle(ref, () => ({
    focus: () => viewRef.current?.focus(),
    revealLine: (line, options = {}) => {
      const view = viewRef.current;
      if (!view) return;
      const requestedLine = Number.isFinite(line) ? Math.floor(line) : 1;
      const lineNumber = Math.max(1, Math.min(view.state.doc.lines, requestedLine));
      const targetLine = view.state.doc.line(lineNumber);
      view.dispatch({
        ...(options.focus ? { selection: { anchor: targetLine.from } } : {}),
        effects: EditorView.scrollIntoView(targetLine.from, { y: 'center' }),
      });
      if (options.focus) view.focus();
    },
  }), []);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onGutterWidthChangeRef.current = onGutterWidthChange;
  }, [onGutterWidthChange]);

  useEffect(() => {
    onOpenWikiLinkRef.current = onOpenWikiLink;
  }, [onOpenWikiLink]);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    onVimModeChangeRef.current = onVimModeChange;
  }, [onVimModeChange]);

  useEffect(() => {
    wikiLinkSuggestionsRef.current = wikiLinkSuggestions;
  }, [wikiLinkSuggestions]);

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
        syntaxHighlighting(weaveHighlightStyle),
        EditorView.lineWrapping,
        EditorView.editable.of(!readOnly),
        saveKeymap,
        updateListener,
        lspCompartment.of([]),
        ...languageExtensions,
        ...notesMarkdownExtensions,
      ],
    });

    viewRef.current = view;
    onVimModeChangeRef.current?.('normal');

    const gutter = view.dom.querySelector<HTMLElement>('.cm-gutters');
    const reportGutterWidth = () => {
      const width = gutter?.getBoundingClientRect().width ?? 0;
      if (width <= 0) return;
      const nextWidth = Math.ceil(width);
      document.documentElement.style.setProperty('--weave-editor-gutter-width', `${nextWidth}px`);
      onGutterWidthChangeRef.current?.(nextWidth);
    };
    reportGutterWidth();
    const animationFrame = window.requestAnimationFrame(reportGutterWidth);
    const resizeObserver = gutter ? new ResizeObserver(reportGutterWidth) : undefined;
    if (gutter) resizeObserver?.observe(gutter);

    const cm = getCM(view);
    const handleVimModeChange = (event: VimModeChangeEvent) => {
      onVimModeChangeRef.current?.(toVimMode(event));
    };
    cm?.on('vim-mode-change', handleVimModeChange);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      cm?.off('vim-mode-change', handleVimModeChange);
      view.destroy();
      if (viewRef.current === view) viewRef.current = null;
    };
  }, [languageExtensions, lspCompartment, notesMarkdownExtensions, path, readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return undefined;

    view.dispatch({ effects: lspCompartment.reconfigure([]) });
    if (editorMode !== 'code' || !path || !languageIntelligenceTarget) return undefined;

    const languageId = detectEditorLanguageId(path);
    if (!languageId) return undefined;

    let disposed = false;
    let cleanup: (() => void) | undefined;
    let pendingTransport: ReturnType<typeof createLspWebSocketTransport> | undefined;

    void (async () => {
      try {
        const session = await createLspSession({ target: languageIntelligenceTarget, path, languageId });
        if (disposed) return;
        if (session.status !== 'ready' || !session.documentUri || !session.rootUri) {
          if (session.error) console.info(`Language intelligence unavailable for ${path}: ${session.error}`);
          return;
        }

        const socketTransport = createLspWebSocketTransport(session);
        pendingTransport = socketTransport;
        await socketTransport.ready;
        if (disposed) {
          socketTransport.close();
          return;
        }

        const client = new LSPClient({
          rootUri: session.rootUri,
          timeout: 8_000,
          extensions: languageServerExtensions(),
          unhandledNotification: () => undefined,
        });
        client.connect(socketTransport.transport);
        view.dispatch({
          effects: lspCompartment.reconfigure(client.plugin(session.documentUri, session.languageId ?? languageId)),
        });
        cleanup = () => {
          if (viewRef.current === view) {
            view.dispatch({ effects: lspCompartment.reconfigure([]) });
          }
          client.disconnect();
          window.setTimeout(() => socketTransport.close(), 0);
        };
      } catch (error) {
        pendingTransport?.close();
        if (!disposed) {
          console.info(`Language intelligence unavailable for ${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })();

    return () => {
      disposed = true;
      if (cleanup) cleanup();
      else pendingTransport?.close();
    };
  }, [editorMode, languageIntelligenceTarget, lspCompartment, path]);

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

  return <div ref={containerRef} className="h-full min-h-0" data-weave-text-surface="true" />;
});

CodeMirrorEditor.displayName = 'CodeMirrorEditor';
