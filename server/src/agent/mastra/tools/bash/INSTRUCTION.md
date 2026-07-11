# bash

## Description

Run a bash command in the current Workspace through a connected Portal. Prefer fd, rg, and ls for file discovery/search.

A nonzero exit code is a command or validation failure, not a Portal transport failure. Inspect exitCode, stdout, and
stderr. Do not claim success from missing grep output, and do not mask a validation command's exit code with `|| true`.

## Inputs

### command

Bash command to execute.

### timeout

Timeout in seconds.
