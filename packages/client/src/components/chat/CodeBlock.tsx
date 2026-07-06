import { useEffect, useRef } from "react";
import { createCodeMirrorSurface } from "../../lib/codemirror-surface";
import { getCodeMirrorLanguageExtensions } from "../../lib/codemirror-languages";

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
  pgsql: "snippet.sql",
  postgres: "snippet.sql",
  postgresql: "snippet.sql",
  py: "snippet.py",
  python: "snippet.py",
  sass: "snippet.sass",
  scss: "snippet.scss",
  sql: "snippet.sql",
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

export type ChatCodeBlockRenderMode = "plain" | "codemirror" | "code";

const plainTextFenceLanguages = new Set(["plain", "plaintext", "text", "txt"]);

export const getCodeMirrorFencePath = (className?: string) => {
  const language = normalizeLanguage(className);
  return language ? codeFenceLanguagePaths[language] : undefined;
};

export const getChatCodeBlockRenderMode = (
  className?: string,
): ChatCodeBlockRenderMode => {
  const language = normalizeLanguage(className);
  if (!language) return "plain";
  if (plainTextFenceLanguages.has(language)) return "plain";
  return getCodeMirrorFencePath(className) ? "codemirror" : "code";
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
  const shouldHighlight = canHighlightCodeFence(className, deferHighlight);
  const shouldRenderCodeMirror = Boolean(fencePath);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !shouldRenderCodeMirror) return undefined;

    const surface = createCodeMirrorSurface({
      value: code,
      parent: container,
      path: fencePath,
      readOnly: true,
      theme: "inline",
      basicSetup: false,
      lineWrapping: false,
      highlight: shouldHighlight,
      attributes: {
        "data-weave-chat-code-block": "true",
      },
      contentAttributes: {
        "aria-label": "Code block",
        tabindex: "-1",
      },
    });

    return () => surface.destroy();
  }, [code, fencePath, shouldHighlight, shouldRenderCodeMirror]);

  if (!shouldRenderCodeMirror) {
    return <code className={`${className ?? ""} block whitespace-pre font-mono`.trim()}>{children}</code>;
  }

  return <div ref={containerRef} />;
};
