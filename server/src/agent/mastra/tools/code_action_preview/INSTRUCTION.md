# code_action_preview

## Description

Preview the WorkspaceEdit for an LSP code action. This never applies edits.

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

### action

A CodeAction object returned by code_actions.

### actionIndex

Index from code_actions to preview when action is omitted.
