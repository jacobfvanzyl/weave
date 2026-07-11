# rename_preview

## Description

Preview an LSP rename WorkspaceEdit. This never applies edits.

## Inputs

### path

File path relative to the current Workspace root.

### languageId

Optional LSP language id override.

### serverId

Optional language-server adapter id override.

### line

Zero-based line number.

### character

Zero-based UTF-16 character offset.

### newName

Replacement symbol name.
