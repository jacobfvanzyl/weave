# Tree-sitter Intake

## Source Files To Inspect

For a tree-sitter grammar, inspect:

- `grammar.js`: source rules, precedence, conflicts, externals, word token.
- `src/grammar.json`: generated grammar used by the Lezer importer.
- `src/node-types.json`: node taxonomy and named children.
- `src/scanner.c` or scanner sources: external-token behavior to port into
  `tokens.ts`.
- `queries/highlights.scm`: capture names and highlight intent.
- `queries/folds.scm`: possible fold regions.
- `test/corpus/*.txt`: representative parse fixtures.

## Seed Command

```bash
node .agents/skills/lezer-grammar-harness/scripts/seed.mjs --language <language> --source <package-or-path>
```

The seed output is only a starting point. The tree-sitter importer cannot fully
translate precedence, aliases, externals, or every conflict pattern.

## Porting Guidance

- Translate highlight captures into `highlight-map.json` and `styleTags(...)`.
- Convert corpus examples into smaller Lezer file tests only after the grammar
  shape is intentional.
- Use scanner code to guide external tokenizers, but rewrite it idiomatically
  for `@lezer/lr` `ExternalTokenizer`.
- Record source package/version/license in the seed report before retaining any
  derived material.
