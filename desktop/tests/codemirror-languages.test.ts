import { describe, expect, it } from "vitest";
import {
  getCodeMirrorLanguageEntry,
  getCodeMirrorLanguageExtensions,
} from "../../packages/client/src/lib/codemirror-languages";

describe("CodeMirror language registry", () => {
  it("selects the vendored Dart Lezer package for Dart files", () => {
    expect(getCodeMirrorLanguageEntry("lib/main.dart")).toMatchObject({
      id: "dart",
      syntaxProvider: "vendored-lezer",
    });
    expect(getCodeMirrorLanguageExtensions("lib/main.dart")).toHaveLength(1);
  });

  it("preserves existing CodeMirror language mappings", () => {
    expect(getCodeMirrorLanguageEntry("src/main.tsx")).toMatchObject({
      id: "typescript",
    });
    expect(getCodeMirrorLanguageEntry("src/main.jsx")).toMatchObject({
      id: "javascript",
    });
    expect(getCodeMirrorLanguageEntry("deno.jsonc")).toMatchObject({
      id: "json",
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
  });

  it("falls back to no language extension for unsupported files", () => {
    expect(getCodeMirrorLanguageEntry("archive.unknown")).toBeUndefined();
    expect(getCodeMirrorLanguageExtensions("archive.unknown")).toEqual([]);
  });
});
