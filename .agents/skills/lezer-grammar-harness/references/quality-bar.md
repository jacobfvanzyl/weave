# Quality Bar

## Highlighting-Grade Means

- Parser generation succeeds with no conflicts.
- Representative real files parse without crashes.
- Error-node counts are low and explained when not zero.
- Comments, strings, numbers, keywords, types, annotations, operators, and
  common delimiters highlight.
- Fixture and highlight snapshots are stable.
- The editor shows syntax highlighting before LSP initializes.

## Out Of Scope By Default

- Analyzer-equivalent parse trees.
- Full language specification coverage.
- Semantic classification that belongs to LSP.
- Perfect indentation/folding for every construct.
- Automatic source grammar conversion without manual repair.
- User-installable grammar marketplace behavior.

## Completion Checklist

- `verify.mjs` passes for the target.
- `report.mjs` has no unresolved build/test blockers.
- Client language registry selects the vendored package.
- `deno task desktop:typecheck` passes.
- Existing editor behavior remains intact.
