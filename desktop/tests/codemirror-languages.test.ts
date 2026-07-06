import { toggleComment } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import {
  getCodeMirrorLanguageEntry,
  getCodeMirrorLanguageExtensions,
} from "../../packages/client/src/lib/codemirror-languages";
import { registerWeaveVimCommenting } from "../../packages/client/src/lib/codemirror-vim-commenting";
import {
  detectLanguagePackLspId,
  findLanguagePack,
  type LanguageCommentTokens,
} from "../../packages/client/src/lib/language-packs/core";

const toggleCommentForPath = (path: string, doc: string) => {
  const initialState = EditorState.create({
    doc,
    extensions: getCodeMirrorLanguageExtensions(path),
  });
  let nextState = initialState;
  const handled = toggleComment({
    state: initialState,
    dispatch: (transaction) => {
      nextState = transaction.state;
    },
  });
  return { handled, doc: nextState.doc.toString() };
};

const commentTokensForPath = (path: string) => {
  const state = EditorState.create({
    doc: "SELECT 1;",
    extensions: getCodeMirrorLanguageExtensions(path),
  });
  return state.languageDataAt<LanguageCommentTokens>("commentTokens", 0);
};

describe("CodeMirror language registry", () => {
  it("selects the vendored Dart Lezer package for Dart files", () => {
    expect(getCodeMirrorLanguageEntry("lib/main.dart")).toMatchObject({
      id: "dart",
      syntaxProvider: "vendored-lezer",
    });
    expect(getCodeMirrorLanguageExtensions("lib/main.dart").length).toBeGreaterThan(0);
  });

  it("finds source-defined language packs by extension, filename, and pattern", () => {
    expect(findLanguagePack("src/main.tsx")).toMatchObject({
      id: "typescriptreact",
      lsp: { languageId: "typescriptreact" },
    });
    expect(findLanguagePack(".env")).toMatchObject({
      id: "env",
      comments: { line: "#" },
    });
    expect(findLanguagePack(".env.local")).toMatchObject({
      id: "env",
      comments: { line: "#" },
    });
    expect(findLanguagePack("config.yaml")).toMatchObject({
      id: "yaml",
      comments: { line: "#" },
    });
    expect(findLanguagePack("config.yml")).toMatchObject({
      id: "yaml",
      comments: { line: "#" },
    });
    expect(findLanguagePack("server/drizzle/0000_initial_weave.sql")).toMatchObject({
      id: "sql",
      comments: {
        line: "--",
        block: { open: "/*", close: "*/" },
      },
    });
  });

  it("detects LSP language IDs from the shared language pack registry", () => {
    expect(detectLanguagePackLspId("src/main.tsx")).toBe("typescriptreact");
    expect(detectLanguagePackLspId("src/index.ts")).toBe("typescript");
    expect(detectLanguagePackLspId("schema.graphql")).toBe("graphql");
    expect(detectLanguagePackLspId("server/drizzle/0000_initial_weave.sql")).toBeUndefined();
    expect(detectLanguagePackLspId("config.yaml")).toBeUndefined();
    expect(detectLanguagePackLspId(".env.local")).toBeUndefined();
  });

  it("projects language packs into CodeMirror language support", () => {
    expect(getCodeMirrorLanguageEntry("src/main.tsx")).toMatchObject({
      id: "typescriptreact",
    });
    expect(getCodeMirrorLanguageEntry("src/main.jsx")).toMatchObject({
      id: "javascriptreact",
    });
    expect(getCodeMirrorLanguageEntry("deno.json")).toMatchObject({
      id: "json",
    });
    expect(getCodeMirrorLanguageEntry("deno.jsonc")).toMatchObject({
      id: "jsonc",
    });
    expect(getCodeMirrorLanguageEntry("styles/app.css")).toMatchObject({
      id: "css",
    });
    expect(getCodeMirrorLanguageEntry("public/index.html")).toMatchObject({
      id: "html",
    });
    expect(getCodeMirrorLanguageEntry("README.md")).toMatchObject({
      id: "markdown",
    });
    expect(getCodeMirrorLanguageEntry("config.yaml")).toMatchObject({
      id: "yaml",
      syntaxProvider: "codemirror-lezer",
    });
    expect(getCodeMirrorLanguageEntry("query.sql")).toMatchObject({
      id: "sql",
      syntaxProvider: "codemirror-lezer",
    });
    expect(getCodeMirrorLanguageEntry(".env.local")).toMatchObject({
      id: "env",
      syntaxProvider: "plain",
    });
  });

  it("falls back to no language extension for unsupported files", () => {
    expect(getCodeMirrorLanguageEntry("archive.unknown")).toBeUndefined();
    expect(getCodeMirrorLanguageExtensions("archive.unknown")).toEqual([]);
  });

  it.each([
    ["src/main.ts", "const value = 1;", "// const value = 1;"],
    ["lib/main.dart", "void main() {}", "// void main() {}"],
    ["styles/app.css", "body {}", "/* body {} */"],
    ["public/index.html", "<div></div>", "<!-- <div></div> -->"],
    ["README.md", "Heading", "<!-- Heading -->"],
    ["deno.jsonc", "{}", "// {}"],
    ["config.yaml", "name: weave", "# name: weave"],
    ["config.yml", "name: weave", "# name: weave"],
    [".env", "WEAVE=1", "# WEAVE=1"],
    [".env.local", "WEAVE=1", "# WEAVE=1"],
    ["sample.env", "WEAVE=1", "# WEAVE=1"],
    ["schema.graphql", "type Query { id: ID }", "# type Query { id: ID }"],
    ["query.sql", "SELECT 1;", "-- SELECT 1;"],
  ])("toggles comments for %s", (path, source, expected) => {
    expect(toggleCommentForPath(path, source)).toEqual({
      handled: true,
      doc: expected,
    });
  });

  it("exposes SQL line and block comment metadata", () => {
    expect(commentTokensForPath("query.sql")).toEqual(
      expect.arrayContaining([
        { line: "--", block: { open: "/*", close: "*/" } },
      ]),
    );
  });

  it("keeps strict JSON without comment toggling", () => {
    expect(toggleCommentForPath("deno.json", "{}")).toEqual({
      handled: false,
      doc: "{}",
    });
  });

  it("registers the Vim gc comment operator once per Vim API", () => {
    const vimApi = {
      defineOperator: vi.fn(),
      mapCommand: vi.fn(),
    };

    registerWeaveVimCommenting(vimApi);
    registerWeaveVimCommenting(vimApi);

    expect(vimApi.defineOperator).toHaveBeenCalledTimes(1);
    expect(vimApi.defineOperator).toHaveBeenCalledWith(
      "weaveToggleComment",
      expect.any(Function),
    );
    expect(vimApi.mapCommand).toHaveBeenCalledTimes(1);
    expect(vimApi.mapCommand).toHaveBeenCalledWith(
      "gc",
      "operator",
      "weaveToggleComment",
      {},
      { isEdit: true },
    );
  });
});
