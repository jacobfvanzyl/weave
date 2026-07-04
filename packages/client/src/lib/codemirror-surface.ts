import { syntaxHighlighting } from "@codemirror/language";
import { EditorState, type Extension, Prec } from "@codemirror/state";
import {
  EditorView,
  type KeyBinding,
  keymap,
  type ViewUpdate,
} from "@codemirror/view";
import {
  createWeaveVimExtension,
  observeWeaveVimMode,
  relativeLineNumbers,
  type VimMode,
} from "./codemirror-editor-extensions";
import { getCodeMirrorLanguageExtensions } from "./codemirror-languages";
import {
  editorBasicSetup,
  editorTheme,
  weaveHighlightStyle,
} from "./codemirror-theme";

export type CodeMirrorSurfaceTheme = "editor" | "inline";

export type CreateCodeMirrorSurfaceOptions = {
  parent: HTMLElement;
  value: string;
  path?: string;
  readOnly?: boolean;
  theme?: CodeMirrorSurfaceTheme;
  basicSetup?: boolean;
  lineWrapping?: boolean;
  highlight?: boolean;
  relativeLineNumbers?: boolean;
  vim?: boolean;
  keyBindings?: KeyBinding[];
  extensions?: Extension[];
  attributes?: Record<string, string>;
  contentAttributes?: Record<string, string>;
  onChange?: (value: string, update: ViewUpdate) => void;
  onVimModeChange?: (mode: VimMode) => void;
};

const inlineTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "inherit",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-code)",
    fontSize: "inherit",
    lineHeight: "inherit",
    overflow: "auto",
  },
  ".cm-content": {
    caretColor: "var(--weave-editor-caret)",
    minHeight: "0",
    padding: "0",
  },
  ".cm-line": {
    padding: "0",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--weave-editor-caret)",
  },
  ".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":
    {
      background: "var(--weave-editor-selection)",
    },
});

const readonlyInlineTheme = EditorView.theme({
  ".cm-cursor, .cm-dropCursor": {
    display: "none",
  },
  ".cm-content": {
    caretColor: "transparent",
  },
});

export const createCodeMirrorSurface = ({
  parent,
  value,
  path,
  readOnly,
  theme = "editor",
  basicSetup = true,
  lineWrapping = true,
  highlight = true,
  relativeLineNumbers: enableRelativeLineNumbers = false,
  vim: enableVim = false,
  keyBindings = [],
  extensions = [],
  attributes,
  contentAttributes,
  onChange,
  onVimModeChange,
}: CreateCodeMirrorSurfaceOptions) => {
  const languageExtensions = getCodeMirrorLanguageExtensions(path);
  const updateListener = EditorView.updateListener.of((update: ViewUpdate) => {
    if (!update.docChanged) return;
    onChange?.(update.state.doc.toString(), update);
  });

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: value,
      extensions: [
        ...(enableVim ? [createWeaveVimExtension()] : []),
        ...(enableRelativeLineNumbers ? [relativeLineNumbers] : []),
        ...(basicSetup ? [editorBasicSetup] : []),
        theme === "editor" ? editorTheme : inlineTheme,
        ...(readOnly && theme === "inline" ? [readonlyInlineTheme] : []),
        ...(highlight ? [syntaxHighlighting(weaveHighlightStyle)] : []),
        ...(lineWrapping ? [EditorView.lineWrapping] : []),
        EditorView.editable.of(!readOnly),
        EditorState.readOnly.of(Boolean(readOnly)),
        ...(keyBindings.length ? [Prec.highest(keymap.of(keyBindings))] : []),
        ...(attributes ? [EditorView.editorAttributes.of(attributes)] : []),
        ...(contentAttributes
          ? [EditorView.contentAttributes.of(contentAttributes)]
          : []),
        updateListener,
        ...languageExtensions,
        ...extensions,
      ],
    }),
  });
  const stopObservingVimMode = enableVim
    ? observeWeaveVimMode(view, onVimModeChange)
    : undefined;
  let destroyed = false;

  return {
    view,
    focus: () => view.focus(),
    getValue: () => view.state.doc.toString(),
    setValue: (nextValue: string) => {
      const currentValue = view.state.doc.toString();
      if (currentValue === nextValue) return;
      view.dispatch({
        changes: { from: 0, to: currentValue.length, insert: nextValue },
      });
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      stopObservingVimMode?.();
      view.destroy();
    },
  };
};
