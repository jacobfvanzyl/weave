# Workflow

## End-to-End Procedure

1. **Orient**
   - Confirm the target language id and extension list.
   - Check whether a vendored target already exists under
     `packages/client/src/lib/codemirror-<language>`.
   - Inspect official CodeMirror/Lezer packages before third-party grammars.

2. **Seed**
   - For tree-sitter sources, run `seed.mjs` against a package or checkout.
   - Read `HARNESS_REPORT.md`, generated grammar draft, converted corpus files,
     highlight captures, and source metadata.
   - Do not apply generated artifacts directly to the app without review.

3. **Build**
   - Create or repair `<language>.grammar`.
   - Add `tokens.ts` only for lexical behavior Lezer grammar syntax cannot
     express cleanly.
   - Add `highlight.ts` with `styleTags(...)`.
   - Add `index.ts` with `LRLanguage.define(...)` and `LanguageSupport`.

4. **Verify**
   - Run `verify.mjs` for generator freshness, file tests, fixture parsing, and
     highlight snapshots.
   - Fix the first failure group before broadening the grammar.
   - Regenerate parser artifacts after every grammar/tokenizer change.

5. **Integrate**
   - Register the language in the client language registry.
   - Keep notes mode and LSP attachment independent.
   - Add focused tests for language detection, parser shape, and editor
     extension selection.

6. **Report**
   - Run `report.mjs`.
   - Summarize pass/fail status, remaining gaps, and next recommended repair
     group.

## Prompt Contract

When the user says "use the lezer harness to build a grammar for Lua", the agent
should:

- Read this skill and the references.
- Find source grammar candidates for Lua.
- Seed from the best source grammar.
- Create `packages/client/src/lib/codemirror-lua`.
- Iterate until the harness passes or report the exact blocker.
