---
name: execplan
description: Create and maintain a durable ExecPlan for complex coding work. Use when a user asks for an ExecPlan, execution plan, implementation plan, planning mode, multi-step feature work, significant refactor, migration, architectural change, risky change, or work that should be resumable by another agent. Do not use for trivial single-file edits, typo fixes, or purely conversational design discussion unless the user explicitly requests an ExecPlan.
metadata:
  short-description: Create and maintain durable ExecPlans for coding tasks
---

# ExecPlan Skill

## Goal

Create and maintain a durable execution plan for non-trivial coding work.

An ExecPlan is not a lightweight todo list. It is a self-contained, living implementation specification that a fresh agent or human contributor can use to complete the work with only the current repository and the ExecPlan file.

The plan must explain what will change, why it matters, where the relevant code lives, how to implement it safely, how to validate it, what decisions were made, and how to resume or recover if the work is interrupted.

## When to use this skill

Use this skill when the task is any of the following:

- A complex feature.
- A significant refactor.
- A database/schema/data migration.
- A cross-cutting change across multiple files or modules.
- An architectural change.
- A risky or production-sensitive change.
- A task with substantial unknowns requiring research or a spike.
- A task expected to take more than one focused implementation session.
- A task that should be reviewable, resumable, or handed off to another agent.
- The user explicitly asks for an ExecPlan, execution plan, planning mode, or durable plan.

Do not use this skill by default for:

- Typo fixes.
- Small single-file edits.
- Simple dependency bumps.
- Mechanical renames.
- Obvious bug fixes where the exact diff is clear.
- Pure Q&A where no implementation is being planned.

If unsure, use a compact ExecPlan rather than no plan.

## Operating modes

This skill has three modes.

### 1. Author mode

Use when creating a new ExecPlan.

In author mode:

- Inspect the repository before writing the plan.
- Read `AGENTS.md` if present.
- Read `.agent/PLANS.md` or `PLANS.md` if present.
- Read obvious project docs such as `README.md`, `CONTRIBUTING.md`, `docs/`, `ARCHITECTURE.md`, or equivalent.
- Search for relevant files, patterns, commands, tests, schemas, and conventions.
- Ask follow-up questions only if truly blocking.
- Resolve non-blocking ambiguity by making a clear assumption and recording it.
- Do not modify source files.
- Write or propose only the ExecPlan.

If a repository-local `PLANS.md` exists, follow it over this generic skill.

### 2. Implement mode

Use when executing an approved ExecPlan.

In implement mode:

- Read the entire ExecPlan before editing code.
- Keep the ExecPlan up to date as work proceeds.
- Update `Progress` at every meaningful stopping point.
- Update `Surprises & Discoveries` when the repository behaves differently than expected.
- Update `Decision Log` when making or changing a design decision.
- Update `Validation and Acceptance` when test commands or acceptance checks change.
- Do not ask the user for routine next steps. Proceed to the next milestone unless blocked.
- If blocked, record the blockage in the ExecPlan and ask a specific question.

### 3. Review mode

Use when reviewing or revising an existing ExecPlan.

In review mode:

- Check whether the plan is self-contained.
- Check whether it names concrete files, modules, commands, interfaces, and validation steps.
- Check whether the acceptance criteria are observable.
- Check whether risky steps include idempotence, retry, or rollback guidance.
- Check whether `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` are current.
- Revise the plan rather than merely commenting when the user asks you to improve it.

## File locations

Prefer these locations:

- `.agent/PLANS.md` for the house ExecPlan standard.
- `.agent/plans/<slug>.md` for individual ExecPlans.

If the repository already uses another convention, follow the existing convention.

Use a short, descriptive slug:

- `.agent/plans/add-google-oauth.md`
- `.agent/plans/refactor-sync-service.md`
- `.agent/plans/migrate-billing-schema.md`

## Required properties of every ExecPlan

Every ExecPlan must be:

### Self-contained

A reader must not need previous chat history, hidden memory, or unstated assumptions.

Include all required context directly in the plan. If referencing external docs, summarize the relevant facts inside the plan.

### Living

The plan must be updated as work proceeds.

The following sections must remain current:

- `Progress`
- `Surprises & Discoveries`
- `Decision Log`
- `Outcomes & Retrospective`

### Outcome-focused

Describe observable behavior, not just internal implementation.

Bad:

- “Add an AuthService.”

Good:

- “After this change, a user can sign in, refresh the page, and remain authenticated. This is verified by running the auth integration test and manually exercising the login flow.”

### Repository-specific

Name concrete files, modules, commands, tests, schemas, routes, interfaces, and conventions.

Avoid generic statements such as “update the backend” or “handle the UI.”

### Validatable

Include exact commands and expected observations.

Examples:

- `npm test`
- `pnpm typecheck`
- `flutter test`
- `dart run build_runner build --delete-conflicting-outputs`
- `cargo test`
- `go test ./...`
- `docker compose up`
- HTTP request/response examples
- UI flows
- Database migration checks

### Safe and recoverable

If the work includes migrations, destructive changes, filesystem changes, generated code, or external services, include retry, rollback, or cleanup guidance.

## ExecPlan template

Use this template unless the repository provides its own `PLANS.md`.

```md
# <Short, action-oriented title>

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This plan follows `.agent/PLANS.md` if that file exists in the repository. If no repository-local `PLANS.md` exists, this plan follows the generic ExecPlan skill instructions.

## Purpose / Big Picture

Explain what someone gains after this change.

Describe the observable behavior or system capability that will exist when the work is complete. State how a human can see that it works.

## Progress

Use checkboxes with timestamps. This section must always reflect the actual state of the work.

- [ ] Initial repository inspection completed.
- [ ] Relevant files and commands identified.
- [ ] Implementation approach decided.
- [ ] First implementation milestone completed.
- [ ] Tests and validation completed.
- [ ] Outcomes and retrospective updated.

## Surprises & Discoveries

Record unexpected repository behavior, hidden constraints, bugs, performance issues, dependency limitations, or useful insights discovered while working.

- Observation:
  Evidence:

## Decision Log

Record decisions and rationale. Include rejected alternatives when relevant.

- Decision:
  Rationale:
  Date/Author:

## Outcomes & Retrospective

Update this at major milestones and at completion.

Summarize what changed, what works, what was validated, what remains, and what should be done next.

## Context and Orientation

Describe the current repository state relevant to this task.

Name repository-relative files and directories. Define non-obvious terms. Explain how the relevant components fit together. Assume the reader is new to this repository.

Include:

- Relevant files and modules.
- Existing patterns to follow.
- Build/test/lint commands.
- Generated-code steps, if any.
- Database/schema/migration conventions, if any.
- Runtime or deployment assumptions, if relevant.

## Requirements

State what must be true when the work is complete.

Prefer behavior and constraints over implementation wishes.

## Non-goals

State what is explicitly out of scope.

This prevents scope creep and helps future agents avoid inventing extra work.

## Assumptions

List assumptions made during planning.

If an assumption is risky, say how it will be verified.

## Plan of Work

Describe the sequence of implementation work in prose.

For each major edit, name the file or module, the location within it, and the intended change.

Keep this concrete but not over-specified. The plan should guide implementation without forcing brittle line-by-line edits unless necessary.

## Concrete Steps

List exact commands and operational steps.

Include working directories.

When commands produce important output, describe the expected output or success signal.

Example:

- From the repository root, run `pnpm install` if dependencies are missing.
- Run `pnpm typecheck` and expect no TypeScript errors.
- Run `pnpm test -- auth` and expect the new auth tests to pass.

## Validation and Acceptance

Describe how to prove the change works.

Acceptance criteria must be observable.

Include:

- Automated tests.
- Manual checks, if applicable.
- Expected command results.
- Expected UI/API behavior.
- Regression checks for existing behavior.

## Idempotence and Recovery

Explain how to rerun the steps safely.

Include rollback or recovery instructions for migrations, generated files, partial changes, failed commands, or external side effects.

## Artifacts and Notes

Include concise evidence that helps future work:

- Important command transcripts.
- Small diffs or snippets.
- Links to generated files or logs.
- Notes from prototypes or spikes.

Do not paste large unrelated logs.

## Interfaces and Dependencies

Name the important interfaces, types, functions, services, libraries, schemas, routes, or external dependencies that must exist or be changed.

Be specific about signatures, contracts, and integration points when they matter.
