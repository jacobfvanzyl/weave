import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import {
  atomicMarkdownSyntax,
  imageBlocks,
  inlinePreview,
  tables,
  wikiLinks,
  type WikiLinkSuggestion,
} from "@atomic-editor/editor";
import "@atomic-editor/editor/styles.css";
import { syntaxHighlighting } from "@codemirror/language";
import { Compartment, type Extension } from "@codemirror/state";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";
import { languageServerExtensions, LSPClient } from "@codemirror/lsp-client";
import type { EditorTarget } from "../../lib/editor-types";
import type {
  LiveEditorCodeMirrorSnapshot,
  LiveEditorTextRange,
} from "../../stores/live-editor-context-store";
import { getCodeMirrorLanguageExtensions } from "../../lib/codemirror-languages";
import {
  createWeaveVimExtension,
  observeWeaveVimMode,
  relativeLineNumbers,
  type VimMode,
} from "../../lib/codemirror-editor-extensions";
import {
  editorBasicSetup,
  editorTheme,
  weaveHighlightStyle,
} from "../../lib/codemirror-theme";
import {
  createLspSession,
  createLspWebSocketTransport,
  detectEditorLanguageId,
} from "../../lib/language-intelligence";

export { editorCanvasBackgroundColor } from "../../lib/codemirror-theme";
export type { VimMode } from "../../lib/codemirror-editor-extensions";

type CodeMirrorEditorProps = {
  editorMode?: "code" | "notes";
  path?: string;
  languageIntelligenceTarget?: EditorTarget;
  value: string;
  readOnly?: boolean;
  initialViewState?: { anchor: number; head: number; topLine: number };
  wikiLinkSuggestions?: WikiLinkSuggestion[];
  onChange: (value: string) => void;
  onGutterWidthChange?: (width: number) => void;
  onOpenWikiLink?: (target: string) => void;
  onSave?: () => void;
  onVimModeChange?: (mode: VimMode) => void;
};

export type CodeMirrorEditorHandle = {
  focus: () => void;
  getSnapshot: () => LiveEditorCodeMirrorSnapshot | undefined;
  revealLine: (line: number, options?: { focus?: boolean }) => void;
};

const textRangePreviewMaxChars = 8_000;

const createTextRangeSnapshot = (
  view: EditorView,
  from: number,
  to: number,
): LiveEditorTextRange => {
  const safeFrom = Math.max(0, Math.min(view.state.doc.length, from));
  const safeTo = Math.max(safeFrom, Math.min(view.state.doc.length, to));
  const text = view.state.doc.sliceString(safeFrom, safeTo);
  const preview = text.length > textRangePreviewMaxChars
    ? text.slice(0, textRangePreviewMaxChars)
    : text;

  return {
    from: safeFrom,
    to: safeTo,
    fromLine: view.state.doc.lineAt(safeFrom).number,
    toLine: view.state.doc.lineAt(safeTo).number,
    text: preview,
    ...(preview.length < text.length ? { textTruncated: true } : {}),
  };
};

const getVisibleRangeSnapshot = (view: EditorView) => {
  const firstRange = view.visibleRanges[0];
  const lastRange = view.visibleRanges[view.visibleRanges.length - 1];
  if (!firstRange || !lastRange) return undefined;
  return createTextRangeSnapshot(view, firstRange.from, lastRange.to);
};

export const CodeMirrorEditor = forwardRef<
  CodeMirrorEditorHandle,
  CodeMirrorEditorProps
>(({
  editorMode = "code",
  path,
  languageIntelligenceTarget,
  value,
  readOnly,
      initialViewState,
  wikiLinkSuggestions = [],
  onChange,
  onGutterWidthChange,
  onOpenWikiLink,
  onSave,
  onVimModeChange,
}, ref,) => {
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
  const languageExtensions = useMemo(
    () => getCodeMirrorLanguageExtensions(path),
    [path],
  );
  const notesMarkdownExtensions = useMemo<Extension[]>(() => {
    const isNotesMarkdown = editorMode === "notes" &&
      /\.(md|mdx|markdown)$/i.test(path ?? "");
    if (!isNotesMarkdown) return [];

    const openExternalLink = (url: string) => {
      window.open(url, "_blank", "noopener,noreferrer");
    };
    const findSuggestion = (target: string) => {
      const normalizedTarget = target.replace(/\.(md|markdown)$/i, "")
        .toLowerCase();
      return wikiLinkSuggestionsRef.current.find((suggestion) => {
        const normalizedSuggestion = suggestion.target.replace(
          /\.(md|markdown)$/i,
          "",
        ).toLowerCase();
        return normalizedSuggestion === normalizedTarget ||
          suggestion.label.toLowerCase() === normalizedTarget;
      });
    };

    return [
      atomicMarkdownSyntax,
      inlinePreview({ onLinkClick: openExternalLink }),
      tables({ onLinkClick: openExternalLink }),
      imageBlocks(),
      wikiLinks({
        openOnClick: true,
        suggest: async (query) => {
          const lowerQuery = query.trim().toLowerCase();
          return wikiLinkSuggestionsRef.current
            .filter((suggestion) =>
              !lowerQuery ||
              suggestion.target.toLowerCase().includes(lowerQuery) ||
              suggestion.label.toLowerCase().includes(lowerQuery) ||
              suggestion.detail?.toLowerCase().includes(lowerQuery),
            )
            .slice(0, 50);
        },
        resolve: async (target) => {
          const suggestion = findSuggestion(target);
          if (!suggestion) { return { target, label: target, status: "missing" };
            }
          return {
            target: suggestion.target,
            label: suggestion.label,
            status: "resolved",
          };
        },
        onOpen: (target) => {
          const suggestion = findSuggestion(target);
          onOpenWikiLinkRef.current?.(suggestion?.target ?? target);
        },
      }),
    ];
  }, [editorMode, path]);

  useImperativeHandle(ref, () => ({
    focus: () => viewRef.current?.focus(),
    getSnapshot: () => {
      const view = viewRef.current;
      if (!view) return undefined;
      const selection = view.state.selection.main;
      return {
        selection: createTextRangeSnapshot(view, selection.from, selection.to,),
        visibleRange: getVisibleRangeSnapshot(view),
      };
    },
    revealLine: (line, options = {}) => {
      const view = viewRef.current;
      if (!view) return;
      const requestedLine = Number.isFinite(line) ? Math.floor(line) : 1;
      const lineNumber = Math.max(
        1,
        Math.min(view.state.doc.lines, requestedLine),
      );
      const targetLine = view.state.doc.line(lineNumber);
      view.dispatch({
        ...(options.focus ? { selection: { anchor: targetLine.from } } : {}),
        effects: EditorView.scrollIntoView(targetLine.from, { y: "center", }),
      });
      if (options.focus) view.focus();
    },
  }), [],);

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
      key: "Mod-s",
      run: () => {
        onSaveRef.current?.();
        return true;
      },
    },]);
    const updateListener = EditorView.updateListener.of(
      (update: ViewUpdate) => {
        if (!update.docChanged || isSyncingRef.current) return;
        onChangeRef.current(update.state.doc.toString());
      },
    );
    const view = new EditorView({
      doc: value,
        ...(initialViewState
          ? {
            selection: {
              anchor: Math.max(
                0,
                Math.min(value.length, initialViewState.anchor),
              ),
              head: Math.max(0, Math.min(value.length, initialViewState.head)),
            },
          }
          : {}),
      parent: container,
      extensions: [
        createWeaveVimExtension(),
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
      if (initialViewState) {
        const topLine = Math.max(
          1,
          Math.min(view.state.doc.lines, initialViewState.topLine),
        );
        view.dispatch({
          effects: EditorView.scrollIntoView(
            view.state.doc.line(topLine).from,
            {
              y: "start",
            },
          ),
        });
      }

    const gutter = view.dom.querySelector<HTMLElement>(".cm-gutters");
    const reportGutterWidth = () => {
      const width = gutter?.getBoundingClientRect().width ?? 0;
      if (width <= 0) return;
      const nextWidth = Math.ceil(width);
      document.documentElement.style.setProperty(
        "--weave-editor-gutter-width",
        `${nextWidth}px`,
      );
      onGutterWidthChangeRef.current?.(nextWidth);
    };
    reportGutterWidth();
    const animationFrame = window.requestAnimationFrame(reportGutterWidth);
    const resizeObserver = gutter
      ? new ResizeObserver(reportGutterWidth)
      : undefined;
    if (gutter) resizeObserver?.observe(gutter);

    const stopObservingVimMode = observeWeaveVimMode(
      view,
      (mode) => onVimModeChangeRef.current?.(mode),
    );

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      stopObservingVimMode();
      view.destroy();
      if (viewRef.current === view) viewRef.current = null;
    };
  }, [
    languageExtensions,
    lspCompartment,
    notesMarkdownExtensions,
    path,
    readOnly,
  ]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return undefined;

    view.dispatch({ effects: lspCompartment.reconfigure([]) });
    if (editorMode !== "code" || !path || !languageIntelligenceTarget) {
      return undefined;
    }

    const languageId = detectEditorLanguageId(path);
    if (!languageId) return undefined;

    let disposed = false;
    let cleanup: (() => void) | undefined;
    let pendingTransport:
      | ReturnType<typeof createLspWebSocketTransport>
      | undefined;

    void (async () => {
      try {
        const session = await createLspSession({
          target: languageIntelligenceTarget,
          path,
          languageId,
        });
        if (disposed) return;
        if (
          session.status !== "ready" || !session.documentUri || !session.rootUri
        ) {
          if (session.error) {
            console.info(
              `Language intelligence unavailable for ${path}: ${session.error}`,
            );
          }
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
          effects: lspCompartment.reconfigure(
            client.plugin(
              session.documentUri,
              session.languageId ?? languageId,
            ),
          ),
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
          console.info(
              `Language intelligence unavailable for ${path}: ${
                error instanceof Error ? error.message : String(error)
              }`,
          );
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

  return (
    <div
      ref={containerRef}
      className="h-full min-h-0"
      data-weave-text-surface="true"
    />
  );
},);

CodeMirrorEditor.displayName = "CodeMirrorEditor";
