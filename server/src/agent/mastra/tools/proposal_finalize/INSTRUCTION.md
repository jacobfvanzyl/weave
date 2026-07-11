## Description

Validate the active draft proposal against live disk state and publish it as implementation-ready review state.

Finalization blocks when source files drifted, create targets now exist, delete targets are missing, or item buffers are
incomplete.

## Inputs

### proposalPath

Optional artifact path. Omit to use the thread's active draft proposal. Must be `.agents/proposals/<name>.md`.
