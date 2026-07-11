# update_plan

## Description

Replace the current thread plan and refresh the Guided task card.

Use this for non-trivial multi-step work. Keep the plan concise and current, normally three to seven stable steps, with at most one item in progress. Submit the complete current plan on every call. Use `blocked` only for a real blocker. When a durable ExecPlan exists, set `artifactPath` so the user can open it; create and maintain that Markdown file with the normal write and edit tools.

## Inputs

### title

Short human-readable name for the current plan.

### explanation

Optional concise reason for changing the plan. This is not persisted in the plan snapshot.

### artifactPath

Optional workspace-relative Markdown path for a durable ExecPlan. Omit it to clear a previous artifact association.

### plan

Complete replacement list of current plan steps. Use one to twelve items and normally keep it to three to seven.

### plan[].step

Concrete step phrased as an observable unit of work.

### plan[].status

One of pending, in_progress, completed, or blocked. At most one item may be in_progress.
