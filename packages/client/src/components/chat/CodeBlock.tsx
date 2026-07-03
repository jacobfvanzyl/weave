import { syntaxHighlighting } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useMemo, useRef } from "react";
import { getCodeMirrorLanguageExtensions } from "../../lib/codemirror-languages";
import { weaveHighlightStyle } from "../../lib/codemirror-theme";

const codeFenceLanguagePaths: Record<string, string> = {
  cjs: "snippet.cjs",
  css: "snippet.css",
  cts: "snippet.cts",
  dart: "snippet.dart",
  htm: "snippet.htm",
  html: "snippet.html",
  javascript: "snippet.js",
  javascriptreact: "snippet.jsx",
  js: "snippet.js",
  json: "snippet.json",
  jsonc: "snippet.jsonc",
  jsx: "snippet.jsx",
  less: "snippet.less",
  markdown: "snippet.md",
  md: "snippet.md",
  mdx: "snippet.mdx",
  mjs: "snippet.mjs",
  mts: "snippet.mts",
  sass: "snippet.sass",
  scss: "snippet.scss",
  svg: "snippet.svg",
  ts: "snippet.ts",
  tsx: "snippet.tsx",
  typescript: "snippet.ts",
  typescriptreact: "snippet.tsx",
  xml: "snippet.xml",
  yaml: "snippet.yaml",
  yml: "snippet.yml",
};

const normalizeLanguage = (className?: string) =>
  className
    ?.split(/\s+/)
    .find((name) => name.startsWith("language-"))
    ?.slice("language-".length)
    .trim()
    .toLowerCase();

export const getCodeMirrorFencePath = (className?: string) => {
  const language = normalizeLanguage(className);
  return language ? codeFenceLanguagePaths[language] : undefined;
};

export const canHighlightCodeFence = (
  className?: string,
  deferHighlight = false,
) => {
  if (deferHighlight) return false;
  const path = getCodeMirrorFencePath(className);
  return Boolean(path && getCodeMirrorLanguageExtensions(path).length > 0);
};

export const canRenderCodeMirrorFence = (className?: string) =>
  Boolean(getCodeMirrorFencePath(className));

type MarkdownSourcePosition = {
  start?: { offset?: number };
  end?: { offset?: number };
};

export const isCompleteMarkdownCodeFence = (
  source: string,
  position: MarkdownSourcePosition | undefined,
) => {
  const start = position?.start?.offset;
  const end = position?.end?.offset;
  if (
    start === undefined ||
    end === undefined ||
    start < 0 ||
    end <= start ||
    end > source.length
  ) {
    return false;
  }

  const blockSource = source.slice(start, end);
  const openingLine = blockSource.match(/^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/);
  const openingFence = openingLine?.[1];
  if (!openingFence) return false;

  const fenceCharacter = openingFence[0];
  const fenceLength = openingFence.length;
  const escapedFenceCharacter = fenceCharacter === "`" ? "`" : "\\~";
  const closingFencePattern = new RegExp(
    `(?:^|\\r?\\n) {0,3}${escapedFenceCharacter}{${fenceLength},}[ \\t]*$`,
  );
  return closingFencePattern.test(blockSource);
};

export const shouldDeferCodeFenceHighlight = (
  source: string,
  position: MarkdownSourcePosition | undefined,
  deferHighlight: boolean,
) => deferHighlight && !isCompleteMarkdownCodeFence(source, position);

const chatCodeBlockTheme = EditorView.theme({
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
    caretColor: "transparent",
    minHeight: "0",
    padding: "0",
  },
  ".cm-line": {
    padding: "0",
  },
  ".cm-cursor, .cm-dropCursor": {
    display: "none",
  },
  ".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    background: "var(--weave-editor-selection)",
  },
});

const createReadOnlyExtensions = (
  languageExtensions: Extension[],
  highlight: boolean,
) => [
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  EditorView.editorAttributes.of({
    "data-weave-chat-code-block": "true",
  }),
  EditorView.contentAttributes.of({
    "aria-label": "Code block",
    tabindex: "-1",
  }),
  chatCodeBlockTheme,
  ...(highlight ? [syntaxHighlighting(weaveHighlightStyle)] : []),
  ...languageExtensions,
];

export const CodeBlock = ({
  children,
  className,
  deferHighlight = false,
}: {
  children: string;
  className?: string;
  deferHighlight?: boolean;
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const code = String(children).replace(/\n$/, "");
  const fencePath = getCodeMirrorFencePath(className);
  const languageExtensions = useMemo(
    () =>
      fencePath && !deferHighlight
        ? getCodeMirrorLanguageExtensions(fencePath)
        : [],
    [deferHighlight, fencePath],
  );
  const shouldHighlight = !deferHighlight && languageExtensions.length > 0;
  const shouldRenderCodeMirror = Boolean(fencePath);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !shouldRenderCodeMirror) return undefined;

    const view = new EditorView({
      doc: code,
      parent: container,
      extensions: createReadOnlyExtensions(languageExtensions, shouldHighlight),
    });

    return () => view.destroy();
  }, [code, languageExtensions, shouldHighlight, shouldRenderCodeMirror]);

  if (!shouldRenderCodeMirror) {
    return <code className={className}>{children}</code>;
  }

  return <div ref={containerRef} />;
};
