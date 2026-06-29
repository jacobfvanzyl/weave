---
weave_plan_version: 1
id: agent-native-guided-workflow
title: Agent-native Guided coding workflow
status: in_progress
scope: git
shared: true
thread_ids: []
path: .agents/plans/agent-native-guided-workflow.md
updated_at: 2026-06-28T02:00:00.000Z
checklist:
  - id: classify-workflow-types
    text: Collapse coding workflow types around Inline, Guided, Research, and Operational
    status: completed
  - id: define-guided-mode
    text: Define Guided as the main human-driven coding mode
    status: completed
  - id: define-proposal-artifacts
    text: Specify proposed change sets as first-class artifacts parsed directly by the UI
    status: completed
  - id: define-approval-loop
    text: Define inline approve, bulk approve, reject, and request-changes behavior
    status: pending
  - id: map-repo-surfaces
    text: Map the design onto existing plan parser, plan sidebar, tool activity, diff, and preview seams
    status: in_progress
---

# Agent-native Guided coding workflow

## Purpose / Big Picture

Design an agent-native but human-driven coding workflow for Weave. The workflow should route coding work broadly, use static-ish deterministic guidance such as AGENTS.md, Skills, profiles, and tool bundles, and keep humans in control through explicit preview and approval gates.

Guided is the main coding mode. ExecPlan is not a workflow type; it is a durable artifact used by Guided, Research, or Operational work when scope and continuity justify it.

## Progress

- [x] Collapse coding workflow types around Inline, Guided, Research, and Operational
- [x] Define Guided as the main human-driven coding mode
- [x] Specify proposed change sets as first-class artifacts parsed directly by the UI
- [ ] Define inline approve, bulk approve, reject, and request-changes behavior
- [ ] Map the design onto existing plan parser, plan sidebar, tool activity, diff, and preview seams (in progress)

- 2026-06-28: Initial workflow taxonomy settled on broad routing with depth classification.
- 2026-06-28: Guided and ExecPlan were collapsed. Guided is the workflow type; execplan is an artifact shape.
- 2026-06-28: Proposed change sets should live alongside execplans as real artifacts, and the UI should parse and use them directly.
- 2026-06-28: Proposal review should reuse the editor as a diff/review surface, with inline approval controls inspired by Codex review and GitHub PR review rather than a separate modal.
- 2026-06-28: The current top-right PlanSidebar should become a composer-adjacent Guided task card that floats just above the composer, collapses to the current task, and expands to the full checklist.

## Surprises & Discoveries

- Weave already has a parseable plan artifact frontmatter surface and PlanSidebar projection.
- Weave already has preview-only LSP operations for rename, formatting, and code actions.
- Existing git and edit tools already produce diffs, but there is not yet a first-class proposed change set artifact with approval state.

## Decision Log

- 2026-06-28: Use broad routing for coding-adjacent work, then downgrade to Inline when ceremony is not useful.
- 2026-06-28: Use four workflow types: Inline, Guided, Research, and Operational.
- 2026-06-28: Treat execplans as artifacts, not as workflow types.
- 2026-06-28: Store proposed change sets as sibling artifacts to execplans, not only in thread metadata.
- 2026-06-28: The UI should parse proposed change artifacts directly, similar to the current plan parser approach.
- 2026-06-28: The approval UX should be editor-native: a file tree plus focused diff canvas, inline hunk comments, viewed state, per-item approval, and bulk approval.
- 2026-06-28: Move the plan surface from a detached sidebar card to a compact task strip/card directly above the composer; this becomes the natural home for Guided status and later approval summaries.

## Outcomes & Retrospective

- None yet.

## Context and Orientation

Current relevant Weave surfaces:

- `server/src/agent/mastra/tools/plan-artifacts.ts` defines deterministic plan frontmatter parsing and plan snapshots.
- `server/src/agent/mastra/tools/update-plan-tool.ts` creates and updates durable plan artifacts.
- `packages/client/src/components/chat/PlanSidebar.tsx` renders the current thread plan snapshot.
- `packages/client/src/components/chat/tool-activity.ts` extracts plan side effects and diff text from tool calls.
- `portal/src/git.ts` and `server/src/agent/mastra/tools/git-tools.ts` expose git diff/status/log style evidence.
- `portal/src/lsp.ts` exposes preview-only code action, rename, and formatting edits.
- `packages/client/src/components/chat/ChatPane.tsx` currently renders `PlanSidebar` as an absolute card in the chat surface.
- `packages/client/src/components/chat/AssistantChat.tsx` already owns composer height measurement and has a `PlanPanelToggle` in the composer toolbar.
- `packages/client/src/stores/chat-store.ts` already persists `showPlanPanel` and thread plan snapshots.
- `packages/client/src/stores/workspace-surface-store.ts` currently models main panes as `chat`, `editor`, and `terminal`.
- `packages/client/src/components/app-shell/WeaveAppShell.tsx` currently orders panes as chat, editor, terminal and renders `EditorPane` when the editor pane is open.
- Proposal review should plug into that right-column pane model rather than becoming only an editor tab.

The design should extend these seams without making Mastra a public module dependency. Public HTTP behavior should still be registered through server modules if and when this becomes implementation work.

The visual target is a hybrid of two proven review shapes:

- Codex-style focused review: a primary diff canvas with a narrow file tree, file filtering, changed-file status, and minimal controls.
- GitHub PR-style inline review: per-file viewed state, inline comments anchored to changed lines or hunks, and a review summary action.

## Requirements

- Route coding-adjacent work into the workflow broadly, but keep Inline work lightweight.
- Keep Guided as the main human-driven coding workflow.
- Use Skills and tool calls to make deterministic procedures static-ish and reusable.
- Stay language and stack agnostic.
- Preserve execplans as durable artifacts whose shape can scale with complexity.
- Add proposed change sets as durable artifacts that live alongside execplans.
- Let the UI parse proposal artifacts directly and render inline review controls.
- Let humans approve proposed changes individually or in bulk.
- Let humans request changes against the whole proposal or specific items.
- Apply only approved proposed changes.
- Reuse the existing editor shell for proposal review instead of creating a modal-only review flow.
- Add a diff viewer to the editor that can render proposal diffs and later normal git diffs.
- Rework the plan card into a composer-adjacent Guided task card with collapsed and expanded states.

## Non-goals

- Do not turn every coding request into a full durable plan.
- Do not make execplans the only source of proposal approval state.
- Do not make proposal approval depend on vague chat consent.
- Do not require a language-specific AST or stack-specific patch format for v1.

## Assumptions

- `.agents/plans/*.md` remains the durable plan artifact location.
- Proposal artifacts should use a similar deterministic frontmatter and Markdown body pattern.
- Thread metadata can cache parsed snapshots for responsiveness, but artifacts are the source of truth.
- Proposal artifacts can reference plan artifacts by path when a plan exists, but can also stand alone for smaller Guided tasks.

## Plan of Work

Use two sibling artifact families:

- ExecPlan artifacts describe intent, context, checklist, decisions, validation, recovery, and outcomes.
- Proposed change artifacts describe concrete changes waiting for human review, including previews, approval state, comments, and application status.

Guided mode should first classify whether it needs:

- no durable artifact,
- a plan artifact only,
- a proposal artifact only,
- or both a plan artifact and one or more proposal artifacts.

For non-trivial mutation, the agent should move through this loop:

1. Discover and classify.
2. Create or update the plan artifact when continuity is useful.
3. Create a proposed change artifact before mutation.
4. Let the UI render proposal previews and approval controls directly from the artifact.
5. Apply only approved proposal items.
6. Update proposal and plan artifacts with applied state, validation, surprises, and outcomes.

## Concrete Steps

Draft proposal artifact rules:

- Store proposed changes under a sibling directory such as `.agents/proposals/`.
- Give each proposal deterministic frontmatter with version, id, title, status, optional plan path, thread ids, updated timestamp, and item summaries.
- Keep item-level state in frontmatter so the UI can parse it without reading the full Markdown body.
- Keep full diff previews, rationale, risk notes, and reviewer comments in the Markdown body.
- Allow multiple proposals per plan, because a Guided task may progress through several review batches.
- Treat approval as item-level state, not just chat text.

Candidate proposal statuses:

- `draft`
- `ready`
- `partially_approved`
- `approved`
- `changes_requested`
- `applied`
- `rejected`

Candidate proposal item kinds:

- `file_edit`
- `file_create`
- `file_delete`
- `command`
- `migration`
- `dependency`
- `external_action`

Candidate item statuses:

- `pending`
- `approved`
- `changes_requested`
- `rejected`
- `applied`

Right-column proposal review pane:

- Add a full proposal review pane that can occupy the right column in place of the current editor pane when needed.
- The pane should be a peer surface to `EditorPane`, not just a tab inside `UnifiedEditorPanel`. It can reuse editor primitives and the diff viewer, but it owns proposal review layout and approval actions.
- Opening a proposal review from the Guided task card should switch the right-column slot from editor to proposal review, preserving the ability to return to the prior editor state.
- The proposal review pane should be addressable by artifact path, for example `.agents/proposals/<name>.md`, but render as a structured review UI rather than plain Markdown by default.
- The review pane should have a side file tree that is scoped to the proposal, with filter input, changed counts, status markers, and viewed state.
- The main canvas should render unified diffs initially. Split diff can be a later option, but unified diff is the better v1 because it matches current patch outputs and is easier to make responsive.
- Each file header should show path, additions/deletions, item status, viewed checkbox, and actions: approve file, request changes, reject, open source file.
- Each hunk should support inline comments and hunk-level actions. The hunk actions should update proposal artifact state, not rely on ephemeral UI state.
- The review footer or header should support bulk actions: approve all pending, approve all viewed, reject all, request changes on proposal, apply approved.
- The agent should never treat merely viewing a diff as approval. Approval is an explicit artifact state transition.

Approval granularity:

- Proposal-level approval means every pending item moves to approved, except items already rejected or changes-requested.
- File-level approval means all pending hunks/items for that file move to approved.
- Hunk-level approval means only that hunk or item is approved.
- Commenting without approval leaves status unchanged unless the user chooses request changes.
- Request changes can be attached to the proposal, file, hunk, or line. It should move the relevant item to `changes_requested`.

Viewed state:

- `viewed` is separate from approval.
- Viewed state helps the human track review progress and enables `approve all viewed`.
- Viewed state may live in frontmatter for deterministic parseability, but it should not be considered permission to mutate.

Diff viewer scope:

- The diff viewer should be reusable beyond proposals. It should support proposal previews first, then git working tree diffs, staged diffs, commit diffs, and PR-like review surfaces later.
- The proposal review pane should use the same diff renderer as normal git diff views so visual behavior and keyboard navigation stay consistent.
- The diff renderer should accept parsed structured diff data rather than parsing arbitrary text at render time wherever possible.

Composer-adjacent Guided task card:

- Replace the floating top-right `PlanSidebar` surface with a card anchored just above the composer inside the chat column.
- The collapsed card should be a compact single-line strip. It should show the active/current task, plan status, progress count, busy/blocked state, and a disclosure control.
- The expanded card should show the full checklist, plan title, open-plan action, and status badges. It should remain visually connected to the composer rather than floating in the upper-right of the chat viewport.
- The card should not cover message content unpredictably. The message scroll area already accounts for composer height, so the card should be part of the composer/footer stack or measured together with it.
- The existing composer toolbar `Plan` toggle can become the card collapse/expand control, or be removed if the card itself has a clear disclosure affordance.
- Collapsed should be the default once a plan exists, unless a new plan/proposal appears or a blocking state requires attention.
- Expanded state should be per-thread UI state, not global-only, so switching threads does not leave unrelated plans expanded.
- The card should eventually include proposal approval summary: pending approvals, changes requested, approved count, viewed count, and an `Open review` action.
- The approval workflow itself should still live in proposal artifacts and the proposal review pane; the composer card is the status/action launcher, not the full diff review surface.
- `Open review` should open the proposal review pane in the right column, replacing the current editor pane when necessary.

## Validation and Acceptance

Design acceptance criteria:

- A human can inspect exact proposed changes before mutation.
- A human can approve one item, many selected items, all low-risk items, or all items.
- A human can request changes against an item or the whole proposal.
- The agent can tell which items are approved from artifact state, without relying on chat interpretation.
- The UI can render proposal state from artifact parsing directly.
- Applied work can be reconciled against actual git diff after mutation.
- Review controls are available inline inside the editor diff surface.
- File/hunk/proposal approval updates the proposal artifact and survives refresh or thread handoff.
- The proposal review surface distinguishes viewed, approved, changes requested, rejected, stale, and applied states.
- The Guided task card sits just above the composer and does not obscure message content.
- Collapsed card mode shows exactly one current task line plus compact status/progress.
- Expanded card mode shows the full checklist and later proposal approval summary/actions.

Future implementation validation:

- Parser tests for valid and invalid proposal artifacts.
- Client tests for proposal snapshot rendering and item state transitions.
- Client tests for proposal review file filtering, viewed state, and approve/request-changes actions.
- Client tests for collapsed/expanded Guided task card behavior and per-thread expansion state.
- Tool tests for creating, updating, and applying proposal artifacts.
- Integration test that creates a proposal, approves one item, applies only that item, and records applied state.

## Idempotence and Recovery

Proposal artifacts should be resumable. If a thread is interrupted, the next agent can parse the plan and proposal artifacts, determine approved and unapplied items, inspect the current git diff, and continue without relying on hidden model state.

Applying a proposal should verify that the preview still matches the current workspace state, or mark the item stale and request regeneration.

## Artifacts and Notes

- Current WIP artifact: `.agents/plans/agent-native-guided-workflow.md`
- Future sibling proposal artifact directory candidate: `.agents/proposals/`

## Interfaces and Dependencies

Possible future public concepts:

- `ProposalArtifact`
- `ProposalSnapshot`
- `ProposalItem`
- `ProposalReviewPane`
- `GuidedTaskCard`
- `DiffViewer`
- `DiffFile`
- `DiffHunk`
- `ReviewComment`
- `write_proposal`
- `update_proposal`
- `apply_proposal`

Possible pane concepts:

- Extend `MainPane` with `proposal_review`, or introduce an `editorSlotMode` that can switch between `editor` and `proposal_review`.
- Keep only one right-column content surface visible in v1: editor or proposal review, not both side by side.
- Preserve the prior editor pane state when entering proposal review so closing review returns the user to the same file/editor context.
- `ProposalReviewPane` source: proposal artifact path.
- `DiffViewer` source: proposal artifact, git diff, staged diff, or commit diff.

The exact tool names, route boundaries, and tab shape are not final. Any future server implementation should respect the existing boundary where product HTTP routes live under `server/src/modules`, while Mastra tools remain private under `server/src/agent/mastra`.
