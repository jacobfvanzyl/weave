# edit

## Description

Edit a single file in the current Workspace using exact text replacement. Every edits[].oldText must match a unique,
non-overlapping region of the original file. Each edit is matched against the original file, not incrementally. If two
changes affect nearby or overlapping lines, merge them into one edit.

If a replacement misses, reread the current target region before retrying. Retry one corrected replacement only; never
repeat stale oldText or overlapping edits.

## Inputs

### path

Path to edit, relative to the Workspace root.

### edits[].oldText

Exact text for one targeted replacement. Must be unique in the original file and non-overlapping with other edits.

### edits[].newText

Replacement text for this targeted edit.
