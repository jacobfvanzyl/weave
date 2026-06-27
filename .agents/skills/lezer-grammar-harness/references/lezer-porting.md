# Lezer Porting Notes

## Useful Official Patterns

- `@top` defines the full-document entry point.
- Capitalized rules appear as syntax tree nodes; lowercase helper rules do not.
- Use `@skip` for whitespace and comments. Skipped comment tokens may still be
  highlighted.
- Use `@specialize` to turn identifier text into keyword/literal terms.
- Use `@external tokens` for nested comments, heredocs, complex string scanning,
  or context-sensitive lexing.
- Use `styleTags(...)` in `highlight.ts` and pass it through
  `parser.configure({ props: [...] })`.
- Wrap the parser with `LRLanguage.define(...)` and export a `LanguageSupport`
  helper.

## Conflict Repair

Prefer these repairs before adding broad ambiguity:

- Remove optional branches that compete with a generic token-list fallback.
- Split lexical tokens so keywords/literals/types do not share duplicate
  specializations.
- Use explicit precedence for overlapping tokens such as `/`, `//`, and
  operators.
- Start with balanced regions and lexical highlighting, then add deeper grammar
  structure where it helps.
- Treat tree-sitter `conflicts` as clues, not as Lezer syntax.

## External Tokenizers

Use external tokenizers for:

- nested block comments
- raw/triple/interpolated string spans
- lexical constructs whose end depends on custom scanning

Keep tokenizer code deterministic and small. It should accept incomplete editor
text gracefully when possible.

## Highlighting

Map grammar nodes to standard `@lezer/highlight` tags. Prefer the tags already
consumed by Weave's `weaveHighlightStyle`: keywords, modifiers, variables,
functions, properties, types, constants, strings, comments, operators,
links/meta, and invalid tokens.
