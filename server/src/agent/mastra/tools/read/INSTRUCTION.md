# read

## Description

Read the contents of a file from the current Workspace through a connected Portal. Text output is truncated to 2000 lines or 50KB. Use offset/limit for large files. When you need the full file, continue with offset until complete.

## Inputs

### path

Path to the file to read, relative to the Workspace root.

### offset

Line number to start reading from, 1-indexed.

### limit

Maximum number of lines to read.
