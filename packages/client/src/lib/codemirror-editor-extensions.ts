import { type Extension } from "@codemirror/state";
import { EditorView, gutter, GutterMarker, gutters } from "@codemirror/view";
import { getCM, vim } from "@replit/codemirror-vim";
import { registerWeaveVimCommenting } from "./codemirror-vim-commenting";

export type VimMode =
  | "normal"
  | "insert"
  | "visual"
  | "visualLine"
  | "visualBlock"
  | "replace"
  | "command"
  | "terminal";

type VimModeChangeEvent = {
  mode?: string;
  subMode?: string;
};

class RelativeLineNumberMarker extends GutterMarker {
  constructor(public readonly label: string) {
    super();
  }

  eq(other: GutterMarker) {
    return other instanceof RelativeLineNumberMarker &&
      other.label === this.label;
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

export const relativeLineNumbers: Extension = [
  gutters(),
  gutter({
    class: "cm-lineNumbers cm-relativeLineNumbers",
    renderEmptyElements: false,
    lineMarker: (view, line) => {
      const lineNumber = view.state.doc.lineAt(line.from).number;
      const cursorLineNumber =
        view.state.doc.lineAt(view.state.selection.main.head).number;
      const label = lineNumber === cursorLineNumber
        ? String(lineNumber)
        : String(Math.abs(lineNumber - cursorLineNumber));
      return new RelativeLineNumberMarker(label);
    },
    lineMarkerChange: (update) =>
      update.docChanged || update.selectionSet || update.viewportChanged,
    initialSpacer: (view) =>
      new RelativeLineNumberMarker(getLineNumberSpacer(view.state.doc.lines)),
    updateSpacer: (spacer, update) => {
      const nextLabel = getLineNumberSpacer(update.view.state.doc.lines);
      return spacer instanceof RelativeLineNumberMarker &&
          spacer.label === nextLabel
        ? spacer
        : new RelativeLineNumberMarker(nextLabel);
    },
  }),
];

export const createWeaveVimExtension = () => {
  registerWeaveVimCommenting();
  return vim({ status: false });
};

export const toVimMode = (event: VimModeChangeEvent = {}): VimMode => {
  switch (event.mode) {
    case "insert":
      return "insert";
    case "visual":
      if (event.subMode === "linewise") return "visualLine";
      if (event.subMode === "blockwise") return "visualBlock";
      return "visual";
    case "replace":
      return "replace";
    case "command":
      return "command";
    case "terminal":
      return "terminal";
    case "normal":
    default:
      return "normal";
  }
};

export const observeWeaveVimMode = (
  view: EditorView,
  onChange: ((mode: VimMode) => void) | undefined,
) => {
  if (!onChange) return () => undefined;
  onChange("normal");
  const cm = getCM(view);
  const handleVimModeChange = (event: VimModeChangeEvent) => {
    onChange(toVimMode(event));
  };
  cm?.on("vim-mode-change", handleVimModeChange);
  return () => cm?.off("vim-mode-change", handleVimModeChange);
};
