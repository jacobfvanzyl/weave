import { HighlightStyle } from "@codemirror/language";
import { type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import {
  editorContentWidthCss,
  editorLineHorizontalPaddingPx,
  editorTextWidthCss,
} from "./editor-layout";

export const editorCanvasBackgroundColor = "#1e1e2e";

export const weaveHighlightStyle = HighlightStyle.define([
  {
    tag: [
      t.keyword,
      t.modifier,
      t.operatorKeyword,
      t.controlKeyword,
      t.moduleKeyword,
    ],
    color: "var(--weave-syntax-keyword)",
  },
  {
    tag: [t.name, t.deleted, t.character, t.macroName],
    color: "var(--weave-syntax-name)",
  },
  {
    tag: [t.propertyName, t.attributeName],
    color: "var(--weave-syntax-property)",
  },
  {
    tag: [t.variableName, t.definition(t.variableName)],
    color: "var(--weave-syntax-variable)",
  },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName],
    color: "var(--weave-syntax-function)",
  },
  {
    tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom],
    color: "var(--weave-syntax-constant)",
  },
  {
    tag: [t.string, t.special(t.string), t.regexp],
    color: "var(--weave-syntax-string)",
  },
  { tag: [t.escape, t.link], color: "var(--weave-syntax-link)" },
  {
    tag: [t.typeName, t.className, t.namespace],
    color: "var(--weave-syntax-type)",
  },
  {
    tag: [t.constant(t.variableName), t.standard(t.variableName)],
    color: "var(--weave-syntax-constant)",
  },
  { tag: [t.self], color: "var(--weave-syntax-self)" },
  {
    tag: [t.definitionKeyword, t.operator, t.derefOperator],
    color: "var(--weave-syntax-operator)",
  },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: "var(--weave-syntax-comment)",
    fontStyle: "italic",
  },
  {
    tag: [t.meta, t.processingInstruction, t.annotation],
    color: "var(--weave-syntax-meta)",
  },
  {
    tag: [t.special(t.variableName)],
    color: "var(--weave-syntax-parameter)",
  },
  {
    tag: [t.heading, t.strong],
    color: "var(--weave-syntax-heading)",
    fontWeight: "600",
  },
  {
    tag: [t.emphasis],
    color: "var(--weave-syntax-emphasis)",
    fontStyle: "italic",
  },
  { tag: [t.strikethrough], textDecoration: "line-through" },
  { tag: [t.inserted], color: "var(--weave-syntax-inserted)" },
  { tag: [t.invalid], color: "var(--weave-syntax-invalid)" },
]);

// basicSetup starts with an absolute line-number gutter; consumers can replace
// that with their own gutter or use this gutter-free baseline.
export const editorBasicSetup: Extension = Array.isArray(basicSetup)
  ? (basicSetup as readonly Extension[]).slice(1)
  : basicSetup;

export const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--weave-editor-background)",
    color: "var(--weave-editor-foreground)",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-code)",
    fontSize: "var(--weave-editor-font-size)",
    lineHeight: "var(--weave-chat-line-height)",
  },
  ".cm-content": {
    minHeight: "100%",
    padding: "12px 0",
    caretColor: "var(--weave-editor-caret)",
    width: editorContentWidthCss,
    maxWidth: "100%",
    minWidth: "0",
    flexGrow: "0",
    flexShrink: "1",
    position: "relative",
  },
  ".cm-content::after": {
    content: '""',
    position: "absolute",
    top: "0",
    bottom: "0",
    left: `calc(${editorLineHorizontalPaddingPx}px + ${editorTextWidthCss})`,
    borderLeft: "1px solid var(--weave-editor-column-guide)",
    pointerEvents: "none",
  },
  ".cm-line": {
    boxSizing: "border-box",
    padding: `0 ${editorLineHorizontalPaddingPx}px`,
  },
  ".cm-gutters": {
    backgroundColor: "var(--weave-editor-gutter-background)",
    borderRight: "1px solid var(--weave-editor-gutter-border)",
    color: "var(--weave-editor-gutter-foreground)",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 10px 0 8px",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--weave-editor-active-line)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--weave-editor-active-line)",
    color: "var(--weave-editor-active-gutter-foreground)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--weave-editor-caret)",
  },
  ".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    background: "var(--weave-editor-selection)",
  },
  ".cm-searchMatch": {
    backgroundColor: "var(--weave-editor-search-match)",
    outline: "1px solid var(--weave-editor-search-match-border)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "var(--weave-editor-search-match-selected)",
  },
  ".cm-matchingBracket, .cm-nonmatchingBracket": {
    backgroundColor: "var(--weave-editor-matching-bracket)",
    color: "var(--weave-editor-foreground)",
    outline: "1px solid var(--weave-editor-matching-bracket-border)",
  },
  ".cm-placeholder": {
    color: "var(--muted-foreground)",
  },
  ".cm-panels": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
  },
  ".cm-panels.cm-panels-top": {
    borderBottom: "1px solid var(--border)",
  },
  ".cm-panels.cm-panels-bottom": {
    borderTop: "1px solid var(--border)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    border: "1px solid var(--border)",
    color: "var(--popover-foreground)",
    boxShadow: "var(--shadow-sm)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-foreground)",
  },
  ".cm-diagnostic": {
    borderLeftColor: "var(--destructive)",
  },
  "&.cm-focused": {
    outline: "none",
  },
});
