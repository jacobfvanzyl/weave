---
name: lezer-grammar-harness
description: Build, port, repair, and verify vendored CodeMirror/Lezer grammars in this repo. Use when asked to "use the lezer harness", create a grammar for a language, port a tree-sitter grammar to Lezer, add CodeMirror syntax highlighting for a language, or improve/verify packages under packages/client/src/lib/codemirror-*.
---

# Lezer Grammar Harness

Use this skill to build vendored CodeMirror 6 language packages for Weave. The
goal is a highlighting-grade Lezer grammar first: reliable syntax color,
comment/string handling, balanced regions, and enough structure for
folding/indentation. Do not attempt analyzer-equivalent parsing unless the user
explicitly asks.

## Required Reading

Read the references needed for the task before editing grammar files:

- `references/workflow.md`: end-to-end workflow.
- `references/artifacts.md`: required target layout and reports.
- `references/lezer-porting.md`: Lezer grammar repair patterns.
- `references/tree-sitter-intake.md`: source grammar intake and conversion.
- `references/quality-bar.md`: acceptance criteria and exclusions.

Use official docs as primary references when resolving grammar/tool questions:

- Lezer guide: `https://lezer.codemirror.net/docs/guide/`
- Lezer reference: `https://lezer.codemirror.net/docs/ref/`
- CodeMirror language package guide:
  `https://codemirror.net/examples/lang-package/`

## Workflow

1. Identify the language target and target package path. Use
   `packages/client/src/lib/codemirror-<language>` unless the user specifies
   another path.
2. Find source grammars in this order: official CodeMirror/Lezer package,
   tree-sitter grammar, language specification, editor syntax grammar.
3. Run `scripts/seed.mjs` when a source grammar exists. Keep seed output in
   `/tmp` unless the user asks to apply artifacts.
4. Implement or repair the vendored Lezer grammar by subsystem: lexical tokens,
   comments/strings, declarations, types, expressions, highlights, wrapper
   integration.
5. Run `scripts/verify.mjs` after each meaningful repair. Do not call the
   grammar done until generation, parser tests, fixture parsing, highlight
   snapshots, and generated-file freshness pass.
6. Run `scripts/report.mjs` before handing off so the user or next agent gets an
   actionable status report.

## Commands

```bash
node .agents/skills/lezer-grammar-harness/scripts/seed.mjs --language dart --source tree-sitter-dart --out /tmp/weave-dart-seed
node .agents/skills/lezer-grammar-harness/scripts/verify.mjs --language dart --target packages/client/src/lib/codemirror-dart
node .agents/skills/lezer-grammar-harness/scripts/report.mjs --language dart --target packages/client/src/lib/codemirror-dart
```

Root task aliases are also available:

```bash
deno task grammar:seed -- --language dart --source tree-sitter-dart
deno task grammar:verify -- --language dart --target packages/client/src/lib/codemirror-dart
deno task grammar:report -- --language dart --target packages/client/src/lib/codemirror-dart
```

## Rules

- Keep generated parser artifacts committed and current.
- Keep tree-sitter output as seed/reference material, not unquestioned source of
  truth.
- Prefer small, passing grammar improvements over broad speculative rewrites.
- Keep LSP separate from syntax highlighting; LSP is not the baseline
  highlighter.
- If verification fails, include the failure group and next repair target in the
  final answer.
