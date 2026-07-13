# exec_poll

## Description

Read new output and status from a command session. Continue from nextOffset to avoid replaying output.

## Inputs

### sessionId

Command session identifier returned by exec_start.

### afterOffset

Optional output offset. Output is sliced from this exact ordered character offset.

### limit

Maximum output characters to retrieve. Use omitted range offsets from earlier results to retrieve a specific middle range.
