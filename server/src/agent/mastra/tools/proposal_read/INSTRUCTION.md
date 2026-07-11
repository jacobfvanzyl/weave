## Description

Read a file through the proposal workspace.

If the file has a proposed buffer, this returns the proposed content. Otherwise it reads the live Workspace file.

Use offset and limit for large files. This tool does not mutate source files or proposal files.

## Inputs

### proposalPath

Optional artifact path. Omit to use the thread's active draft proposal. Must be `.agents/proposals/<name>.md`.

### offset

Line number to start reading from, 1-indexed.

### limit

Maximum number of lines to return.
