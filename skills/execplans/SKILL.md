---
name: execplans
description: Create and maintain durable, self-contained execution plans for explicit ExecPlan requests, multi-session or handoff work, complex cross-cutting changes, migrations, architecture work, production-sensitive changes, and research whose findings must guide later implementation. Do not use for routine fixes, small edits, mechanical changes, ordinary multi-step tasks, or pure Q&A.
---

# ExecPlans

Treat an ExecPlan as an advanced durability mechanism, not the default task checklist. Use `update_plan` alone for ordinary multi-step work.

## Establish the local standard

1. Inspect the repository and read the applicable `AGENTS.md` files.
2. Read `.agents/PLANS.md` or root `PLANS.md` when present and follow it exactly.
3. Otherwise use the default structure below.

## Create the plan

- Write plain Markdown with the normal `write` tool. Do not require YAML frontmatter.
- Use the repository's configured location. When none exists, write `.agents/plans/<title-derived-slug>.md`.
- Make the document self-contained for a reader who has only the working tree and this plan.
- Define unfamiliar terms, name repository-relative paths and symbols, and include exact commands with expected observations.
- Resolve material design choices in the plan instead of delegating them to the implementer.
- Phrase acceptance as observable behavior and include safe retry or recovery guidance.

Use this default section order:

1. Purpose / Big Picture
2. Progress
3. Surprises & Discoveries
4. Decision Log
5. Outcomes & Retrospective
6. Context and Orientation
7. Plan of Work
8. Concrete Steps
9. Validation and Acceptance
10. Idempotence and Recovery
11. Artifacts and Notes
12. Interfaces and Dependencies

Keep Progress as the checklist. Keep the other sections prose-first unless a short list is clearer.

## Maintain the plan

- Read the current file before changing it and use targeted `edit` operations.
- Update Progress at meaningful stopping points, including partial work and remaining work.
- Record unexpected behavior with concise evidence in Surprises & Discoveries.
- Record decisions with their rationale in Decision Log.
- Revise Context, Plan of Work, Concrete Steps, Validation, recovery guidance, and interfaces whenever discoveries change the executable approach.
- Summarize achieved behavior, remaining gaps, and lessons in Outcomes & Retrospective at major milestones or completion.
- Replace stale claims instead of preserving contradictory current truth. Keep historical rationale only when it helps a future reader understand the change.

After creating or materially updating the file, call `update_plan` with a concise projection of the current milestones and set `artifactPath` to the Markdown file.

## Continue or pause

- If the user asked to review or approve the plan first, stop after presenting it.
- Otherwise continue through the plan without asking for repeated approval.
- Ask for a new decision only when facts materially expand scope, risk production data, require an external side effect, or expose an unresolved product preference.
