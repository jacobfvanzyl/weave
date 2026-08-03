# Domain Docs

How engineering skills should consume Weave's domain documentation.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repository root, when present. Use it to find the
  context-specific `CONTEXT.md` files relevant to the task.
- **`docs/adr/`** for system-wide architectural decisions.
- The relevant context's `docs/adr/` directory for context-specific decisions.

If these files do not exist yet, proceed silently. Do not suggest creating them
upfront. The `/domain-modeling` skill creates them lazily when terminology or
architectural decisions are resolved.

## Multi-context layout

The intended layout is:

```text
/
├── CONTEXT-MAP.md
├── docs/adr/
├── server/
│   ├── CONTEXT.md
│   └── docs/adr/
├── packages/
│   ├── client/
│   │   ├── CONTEXT.md
│   │   └── docs/adr/
│   └── protocol/
│       ├── CONTEXT.md
│       └── docs/adr/
├── portal/
│   ├── CONTEXT.md
│   └── docs/adr/
├── desktop/
│   ├── CONTEXT.md
│   └── docs/adr/
├── web/
│   ├── CONTEXT.md
│   └── docs/adr/
├── mobile/
│   ├── CONTEXT.md
│   └── docs/adr/
└── tui/
    ├── CONTEXT.md
    └── docs/adr/
```

`CONTEXT-MAP.md` is a routing document. It should identify context boundaries
and point to the relevant context documents without duplicating their
glossaries.

## Use the glossary's vocabulary

When output names a domain concept—in an issue title, proposal, hypothesis, or
test name—use the term defined by the relevant `CONTEXT.md`. Do not drift to
synonyms that the glossary explicitly avoids.

If a needed concept is absent, reconsider whether the project already uses
different language or note the gap for `/domain-modeling`.

## Flag ADR conflicts

If proposed work contradicts an existing ADR, surface the conflict explicitly
rather than silently overriding the decision.
