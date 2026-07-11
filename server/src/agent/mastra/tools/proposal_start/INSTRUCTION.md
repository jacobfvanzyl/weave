## Description

Start or reopen a git-scoped draft proposal workspace at `.agents/proposals/<name>.md`.

This creates a draft proposal artifact with no source-file changes. Use proposal_write, proposal_edit, and
proposal_delete to mutate one proposed file at a time.

Draft proposals are live-reviewable after file items exist, but they are not implementation-ready until
proposal_finalize succeeds.

## Inputs

### proposalPath

Optional artifact path. Must be `.agents/proposals/<name>.md`.

### planPath

Optional linked plan artifact path.
