import { describe, expect, it } from "vitest";
import {
  classHighlighter,
  highlightTree,
  tagHighlighter,
  tags as t,
} from "@lezer/highlight";
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
      "    if (ready) {",
      "    await run();",
      "    }",
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
      "if",
      "await",
    ]);
  });

  it("tags Dart call names, parameters, self references, and decorators", () => {
    const source = [
      "@Riverpod(keepAlive: true)",
      "Future<void> appStartup(Ref ref) async {",
      "  ref.watch(sharedPrefsProvider);",
      "  ref.onDispose(() {",
      "    ref.invalidate(sharedPrefsProvider);",
      "  });",
      "}",
      "class AppStartupWidget {",
      "  const AppStartupWidget({required this.onLoaded, super.key});",
      "  Widget build(BuildContext context, WidgetRef ref) {",
      "    return appStartupState.when(",
      "      primary: palette.primary,",
      "      onSurface: flavor.text,",
      "      fontFamily: GoogleFonts.comfortaa().fontFamily,",
      "      loading: () => onLoaded(context),",
      "      error: (e, st) => e.toString(),",
      "    );",
      "  }",
      "}",
    ].join("\n");
    const semanticHighlighter = tagHighlighter([
      { tag: t.atom, class: "constant" },
      { tag: t.function(t.variableName), class: "function" },
      { tag: t.propertyName, class: "property" },
      { tag: t.special(t.variableName), class: "parameter" },
      { tag: t.self, class: "self" },
      { tag: t.keyword, class: "keyword" },
    ]);
    const highlights: Array<{ text: string; className: string }> = [];

    highlightTree(
      dartLanguage.parser.parse(source),
      semanticHighlighter,
      (from, to, className) => {
        highlights.push({ text: source.slice(from, to), className });
      },
    );

    const textsForClass = (className: string) =>
      highlights
        .filter((highlight) => highlight.className.includes(className))
        .map((highlight) => highlight.text);

    expect(textsForClass("constant")).toContain("@Riverpod");
    expect(textsForClass("function")).toEqual(
      expect.arrayContaining([
        "appStartup",
        "watch",
        "onDispose",
        "invalidate",
        "build",
        "when",
        "comfortaa",
        "onLoaded",
        "toString",
      ]),
    );
    expect(textsForClass("parameter")).toEqual(
      expect.arrayContaining([
        "keepAlive",
        "ref",
        "context",
        "loading",
        "error",
      ]),
    );
    expect(textsForClass("self")).toEqual(
      expect.arrayContaining(["this", "super"]),
    );
    expect(textsForClass("property")).toEqual(
      expect.arrayContaining([
        "primary",
        "text",
        "fontFamily",
      ]),
    );
  });
});
