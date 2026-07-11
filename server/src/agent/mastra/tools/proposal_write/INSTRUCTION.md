## Description

Write full proposed content for one file in the active draft proposal.

This creates or replaces only the proposal buffer. It never writes the source file.

## Inputs

### proposalPath

Optional artifact path. Omit to use the thread's active draft proposal. Must be `.agents/proposals/<name>.md`.

### content

Full proposed file content. This updates only the proposal buffer, not the source file.

### description

Optional human-readable description of this file proposal. Do not put proposed code here.
