# exec_start

## Description

Start a command session in the current Workspace. Prefer this over bash for commands that may outlive one response,
need polling, or need stdin. The returned sessionId is the durable handle for later session calls.

## Inputs

### command

Bash command to start.

### cwd

Optional Workspace-relative working directory.

### timeout

Optional total timeout in seconds.

### yieldMs

How long to wait for initial output before returning, from 0 to 30000 milliseconds.

### validation

Classify validation commands as test, typecheck, lint, build, or other.

### pty

Set true only when the command requires a pseudo-terminal, such as an interactive CLI.
