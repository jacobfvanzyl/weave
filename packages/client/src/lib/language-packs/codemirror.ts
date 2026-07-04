import { EditorState, type Extension } from "@codemirror/state";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { dart } from "../codemirror-dart";
import {
  findLanguagePack,
  type LanguageCommentTokens,
  type LanguagePack,
  matchesLanguagePack,
} from "./core";

export type CodeMirrorSyntaxProvider =
  | "codemirror-lezer"
  | "vendored-lezer"
  | "legacy"
  | "plain";

export type CodeMirrorLanguagePackDefinition = {
  id: string;
  syntaxProvider: CodeMirrorSyntaxProvider;
  support?: (filePath: string, pack: LanguagePack) => Extension[];
};

export type CodeMirrorLanguageEntry = {
  id: string;
  label: string;
  pack: LanguagePack;
  syntaxProvider: CodeMirrorSyntaxProvider;
  match: (lowerPath: string) => boolean;
  support: (filePath: string) => Extension[];
};

export const defineCodeMirrorLanguagePack = (
  definition: CodeMirrorLanguagePackDefinition,
) => definition;

const commentLanguageData = (commentTokens: LanguageCommentTokens) =>
  EditorState.languageData.of(() => [{ commentTokens }]);

const withPackCommentData = (
  pack: LanguagePack,
  extensions: Extension[] = [],
): Extension[] =>
  pack.comments
    ? [...extensions, commentLanguageData(pack.comments)]
    : extensions;

const codeMirrorLanguagePacks = [
  defineCodeMirrorLanguagePack({
    id: "typescriptreact",
    syntaxProvider: "codemirror-lezer",
    support: (_filePath, pack) =>
      withPackCommentData(pack, [javascript({ typescript: true, jsx: true })]),
  }),
  defineCodeMirrorLanguagePack({
    id: "typescript",
    syntaxProvider: "codemirror-lezer",
    support: (_filePath, pack) =>
      withPackCommentData(pack, [javascript({ typescript: true })]),
  }),
  defineCodeMirrorLanguagePack({
    id: "javascriptreact",
    syntaxProvider: "codemirror-lezer",
    support: (_filePath, pack) =>
      withPackCommentData(pack, [javascript({ jsx: true })]),
  }),
  defineCodeMirrorLanguagePack({
    id: "javascript",
    syntaxProvider: "codemirror-lezer",
    support: (_filePath, pack) => withPackCommentData(pack, [javascript()]),
  }),
  defineCodeMirrorLanguagePack({
    id: "jsonc",
    syntaxProvider: "codemirror-lezer",
    support: (_filePath, pack) => withPackCommentData(pack, [json()]),
  }),
  defineCodeMirrorLanguagePack({
    id: "json",
    syntaxProvider: "codemirror-lezer",
    support: () => [json()],
  }),
  defineCodeMirrorLanguagePack({
    id: "css",
    syntaxProvider: "codemirror-lezer",
    support: (_filePath, pack) => withPackCommentData(pack, [css()]),
  }),
  defineCodeMirrorLanguagePack({
    id: "scss",
    syntaxProvider: "codemirror-lezer",
    support: (_filePath, pack) => withPackCommentData(pack, [css()]),
  }),
  defineCodeMirrorLanguagePack({
    id: "sass",
    syntaxProvider: "codemirror-lezer",
    support: (_filePath, pack) => withPackCommentData(pack, [css()]),
  }),
  defineCodeMirrorLanguagePack({
    id: "less",
    syntaxProvider: "codemirror-lezer",
    support: (_filePath, pack) => withPackCommentData(pack, [css()]),
  }),
  defineCodeMirrorLanguagePack({
    id: "html",
    syntaxProvider: "codemirror-lezer",
    support: (_filePath, pack) => withPackCommentData(pack, [html()]),
  }),
  defineCodeMirrorLanguagePack({
    id: "xml",
    syntaxProvider: "codemirror-lezer",
    support: (_filePath, pack) => withPackCommentData(pack, [html()]),
  }),
  defineCodeMirrorLanguagePack({
    id: "svg",
    syntaxProvider: "codemirror-lezer",
    support: (_filePath, pack) => withPackCommentData(pack, [html()]),
  }),
  defineCodeMirrorLanguagePack({
    id: "markdown",
    syntaxProvider: "codemirror-lezer",
    support: (_filePath, pack) => withPackCommentData(pack, [markdown()]),
  }),
  defineCodeMirrorLanguagePack({
    id: "dart",
    syntaxProvider: "vendored-lezer",
    support: (_filePath, pack) => withPackCommentData(pack, [dart()]),
  }),
  defineCodeMirrorLanguagePack({
    id: "python",
    syntaxProvider: "codemirror-lezer",
    support: (_filePath, pack) => withPackCommentData(pack, [python()]),
  }),
  defineCodeMirrorLanguagePack({
    id: "yaml",
    syntaxProvider: "codemirror-lezer",
    support: (_filePath, pack) => withPackCommentData(pack, [yaml()]),
  }),
] as const;

const findCodeMirrorDefinition = (pack: LanguagePack) =>
  codeMirrorLanguagePacks.find((definition) => definition.id === pack.id);

const codeMirrorEntryForPack = (
  pack: LanguagePack,
): CodeMirrorLanguageEntry | undefined => {
  const definition = findCodeMirrorDefinition(pack);
  if (!definition && !pack.comments) return undefined;

  return {
    id: pack.id,
    label: pack.label,
    pack,
    syntaxProvider: definition?.syntaxProvider ?? "plain",
    match: (lowerPath: string) => matchesLanguagePack(pack, lowerPath),
    support: (filePath: string) =>
      definition?.support
        ? definition.support(filePath, pack)
        : withPackCommentData(pack),
  };
};

export const getCodeMirrorLanguageEntry = (filePath: string | undefined) => {
  const pack = findLanguagePack(filePath);
  return pack ? codeMirrorEntryForPack(pack) : undefined;
};

export const getCodeMirrorLanguageExtensions = (
  filePath: string | undefined,
): Extension[] =>
  getCodeMirrorLanguageEntry(filePath)?.support(filePath ?? "") ?? [];
