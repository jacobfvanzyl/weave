# Artifacts

## Target Package Layout

Use this layout for vendored language packages:

```text
packages/client/src/lib/codemirror-<language>/
  <language>.grammar
  tokens.ts
  highlight.ts
  index.ts
  parser.ts
  parser.terms.ts
  highlight-map.json
  test/
    parser.txt
    highlight-snapshots.json
    tokens.cjs
    fixtures/
      representative.<ext>
```

`tokens.ts` is optional when the grammar has no external tokenizers.
`test/tokens.cjs` is required when verification needs a CommonJS tokenizer for
temporary parser builds.

## Generated Files

Generate committed parser files with:

```bash
lezer-generator --typeScript --names <language>.grammar -o parser
```

Do not edit `parser.ts` or `parser.terms.ts` manually. Update the grammar or
tokenizer source and regenerate.

## Report Format

Harness reports must include:

- source language and target path
- parser generation status
- generated artifact freshness
- parser file-test status
- fixture parse status and error-node count
- highlight snapshot status
- missing highlight mappings
- next recommended repair group

Keep reports concise enough for an agent to act on without rereading raw logs.
