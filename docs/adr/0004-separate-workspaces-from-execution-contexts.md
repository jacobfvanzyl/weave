---
status: accepted
date: 2026-09-10
---

# Separate Workspace organization from execution authority

Workspaces are named arrangements on one Host, with terminal panes and required Thread membership; their identity does not depend on filesystem paths. Execution contexts retain directory identity pins and permissions independently, so moving a running Thread changes its organization without moving its ACP session, working directory, or access scope. Protocol version 4 and separate layout and membership revisions make this distinction explicit, while migration promotes each former arrangement and recovers ambiguous Thread assignments into a dedicated directory Workspace instead of guessing between existing arrangements. The flatter hierarchy makes an unassigned category unnecessary; execution authority remains independent of membership.
