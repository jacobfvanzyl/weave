import { describe, expect, it } from "vitest";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { dartLanguage } from "../../packages/client/src/lib/codemirror-dart";

describe("vendored Dart Lezer grammar", () => {
  it("parses representative Dart syntax without error nodes", () => {
    const source = [
      "import 'package:flutter/material.dart';",
      "/// Widget docs",
      "@immutable",
      "class AccountCard extends StatelessWidget {",
      "  final int count = 1;",
      "  final text = 'value $count';",
      "  bool get ready => this.$2 > 0;",
      "}",
      "/* nested /* block */ comment */",
    ].join("\n");

    const tree = dartLanguage.parser.parse(source);
    expect(tree.toString().includes("⚠")).toBe(false);
    expect(tree.toString()).toContain("DocLineComment");
    expect(tree.toString()).toContain("Annotation");
    expect(tree.toString()).toContain("Keyword(class)");
    expect(tree.toString()).toContain("TypeIdentifier");
    expect(tree.toString()).toContain("RecordField");
    expect(tree.toString()).toContain("BlockComment");
    expect(tree.toString()).toContain("String");
  });

  it("tags specialized keyword tokens for CodeMirror highlighting", () => {
    const source = [
      "import 'dart:ui';",
      "class DragScrollBehavior extends MaterialScrollBehavior {",
      "  async function() {",
      "    await run();",
      "  }",
      "}",
    ].join("\n");
    const highlights: Array<{ text: string; className: string }> = [];

    highlightTree(
      dartLanguage.parser.parse(source),
      classHighlighter,
      (from, to, className) => {
        highlights.push({ text: source.slice(from, to), className });
      },
    );

    const keywordTexts = highlights
      .filter((highlight) => highlight.className.includes("tok-keyword"))
      .map((highlight) => highlight.text);
    expect(keywordTexts).toEqual([
      "import",
      "class",
      "extends",
      "async",
      "await",
    ]);
  });
});
