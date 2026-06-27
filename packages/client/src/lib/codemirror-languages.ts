import type { Extension } from "@codemirror/state";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { dart } from "./codemirror-dart";

export type CodeMirrorSyntaxProvider =
  | "codemirror-lezer"
  | "vendored-lezer"
  | "legacy"
  | "plain";

export type CodeMirrorLanguageEntry = {
  id: string;
  syntaxProvider: CodeMirrorSyntaxProvider;
  match: (lowerPath: string) => boolean;
  support: (lowerPath: string) => Extension[];
};

const codeMirrorLanguages: CodeMirrorLanguageEntry[] = [
  {
    id: "typescript",
    syntaxProvider: "codemirror-lezer",
    match: (lowerPath) => /\.(ts|tsx|mts|cts)$/.test(lowerPath),
    support: (lowerPath) => [
      javascript({ typescript: true, jsx: lowerPath.endsWith("x") }),
    ],
  },
  {
    id: "javascript",
    syntaxProvider: "codemirror-lezer",
    match: (lowerPath) => /\.(js|jsx|mjs|cjs)$/.test(lowerPath),
    support: (lowerPath) => [javascript({ jsx: lowerPath.endsWith("x") })],
  },
  {
    id: "json",
    syntaxProvider: "codemirror-lezer",
    match: (lowerPath) => /\.(json|jsonc)$/.test(lowerPath),
    support: () => [json()],
  },
  {
    id: "css",
    syntaxProvider: "codemirror-lezer",
    match: (lowerPath) => /\.(css|scss|sass|less)$/.test(lowerPath),
    support: () => [css()],
  },
  {
    id: "html",
    syntaxProvider: "codemirror-lezer",
    match: (lowerPath) => /\.(html|htm|xml|svg)$/.test(lowerPath),
    support: () => [html()],
  },
  {
    id: "markdown",
    syntaxProvider: "codemirror-lezer",
    match: (lowerPath) => /\.(md|mdx|markdown)$/.test(lowerPath),
    support: () => [markdown()],
  },
  {
    id: "dart",
    syntaxProvider: "vendored-lezer",
    match: (lowerPath) => /\.dart$/.test(lowerPath),
    support: () => [dart()],
  },
];

export const getCodeMirrorLanguageEntry = (filePath: string | undefined) => {
  const lowerPath = filePath?.toLowerCase() ?? "";
  return codeMirrorLanguages.find((entry) => entry.match(lowerPath));
};

export const getCodeMirrorLanguageExtensions = (
  filePath: string | undefined,
): Extension[] => {
  const lowerPath = filePath?.toLowerCase() ?? "";
  return getCodeMirrorLanguageEntry(filePath)?.support(lowerPath) ?? [];
};
