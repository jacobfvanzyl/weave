# WVE-67: Automation retirement

Removed Automation, Automation Execution, Automation Graph, Automation Revision, and the Automation-only Agent Turn Result from the active glossary. Kept Agent Turn, which describes existing ACP work independently of Automation.

Replaced the untracked OpenWorkflow ADR with a deprecated decision record pointing to canceled WVE-64. Removed the Automation engine/runtime comparison note; retained only independent ACP, Host recovery, tool, security, and licensing findings from the mixed OpenHands research. Original untracked drafts were backed up outside the repository before editing.

The supported `product/` code and its package/lock graph contain no OpenWorkflow, Weft, Reflow, or Automation module to remove. Existing generic references to third-party automation and attended Browser control are not the retired product concept. Root and old Portal lockfile changes predate this work and contain no Automation dependency; leave them for the separately scoped legacy cleanup.

Validation: scoped glossary and dependency searches; `git diff --check`. This is a documentation-only retirement, so ACP runtime behavior and tests are unchanged. WVE-64 is canceled; WVE-65 no longer requires Automation preservation.
