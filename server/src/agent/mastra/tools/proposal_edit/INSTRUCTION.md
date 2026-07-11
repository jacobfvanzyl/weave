## Description

Edit one proposed file buffer using exact text replacement.

Every edits[].oldText must match a unique, non-overlapping region of the original proposed buffer. Each edit is matched
against the original buffer, not incrementally.

This updates only the proposal buffer and never writes the source file.

## Inputs

### proposalPath

Optional artifact path. Omit to use the thread's active draft proposal. Must be `.agents/proposals/<name>.md`.

### edits[].oldText

Exact text for one targeted replacement. Must be unique in the proposed buffer and non-overlapping with other edits.

### edits[].newText

Replacement text for this targeted edit.
