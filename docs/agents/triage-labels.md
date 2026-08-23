# Triage Labels

The engineering skills use five canonical triage roles. Each role maps directly
to a team-scoped label in Linear team `WVE`.

| Label in mattpocock/skills | Label in Linear   | Meaning                                    |
| -------------------------- | ----------------- | ------------------------------------------ |
| `needs-triage`             | `needs-triage`    | Maintainer needs to evaluate this issue    |
| `needs-info`               | `needs-info`      | Waiting for more information               |
| `ready-for-agent`          | `ready-for-agent` | Fully specified and ready for an AFK agent |
| `ready-for-human`          | `ready-for-human` | Requires human implementation              |
| `wontfix`                  | `wontfix`         | Will not be actioned                       |

When a skill names a canonical triage role, use its mapped Linear label.
Preserve unrelated labels when changing an issue's triage label because the
CLI's label update replaces the complete label set.
