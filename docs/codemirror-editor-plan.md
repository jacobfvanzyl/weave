# CodeMirror Editor Pane Plan

## Summary

Build a first-pass Weave editor pane using CodeMirror in the shared client, backed by a small `EditorBackend` adapter. Desktop uses direct Electron main-process filesystem access for Git Demiplanes first; web uses the same interface and can later swap to a Portal/server-backed implementation without changing the editor UI.

## Key Changes

- Add CodeMirror dependencies to the shared client and build `EditorPanel` in `packages/client` with file tree, single open file, dirty state, save, reload, and basic syntax highlighting.
- Add shared editor types:
  - `EditorTarget`: `{ planeId: string; demiplaneId: string }`
  - `EditorFile`: `{ path: string; content: string; version: string }`
  - `EditorBackend`: `list`, `read`, `write`, optional future `rename`, `delete`, `watch`
- Add `createEditorBackend()` factory:
  - use desktop bridge when `window.weaveDesktop.editorRead` and related methods exist
  - otherwise use a placeholder Portal/server backend that reports `Editor backend unavailable in this client` until remote support lands
- Integrate the editor into `ChatPage` beside the existing terminal pattern:
  - show an editor button only for active Git Plane + Demiplane
  - render the editor as a collapsible/expandable bottom or side panel, matching `TerminalPanel` behavior
  - keep chat, terminal, and editor independently hideable

## Desktop Backend

- Extend `WeaveDesktopBridge` with:
  - `editorList(target, path?)`
  - `editorRead(target, path)`
  - `editorWrite(target, path, content, version?)`
- Add Electron IPC handlers and preload bindings for those methods.
- Add `EditorManager` in desktop main:
  - reuse or extract the existing Demiplane resolver used by terminal startup
  - resolve Demiplane root from `/planes`
  - path-jail all operations under the Demiplane root
  - list directories, read UTF-8 text files, and write UTF-8 text files
  - return `version` from file metadata, such as `${mtimeMs}:${size}`
  - reject missing files, directories-as-files, binary-looking files, and stale writes when `version` no longer matches
- Do not add LSP, file watching, tabs, or Portal channels in this pass.

## Future Portal Backend

- Keep the client interface identical.
- Later implement `createPortalEditorBackend()` through server routes that call `requestPortalTool`.
- Later add long-lived channels for file watching and LSP:
  - `channel.open`
  - `channel.data`
  - `channel.close`
- Keep CodeMirror unaware of whether files are local desktop files or remote Portal files.

## Test Plan

- Shared client build passes.
- Desktop typecheck passes.
- Desktop smoke/manual test:
  - open a Git Demiplane thread
  - open editor panel
  - browse a small directory
  - open a text file
  - edit and save
  - confirm file changed on disk
  - confirm stale write is rejected after external modification
- Web/manual test:
  - editor button is hidden or disabled with a clear unavailable state until Portal backend exists
- Security checks:
  - `../` path escape is rejected
  - absolute paths outside Demiplane are rejected
  - binary/large files do not load into CodeMirror

## Assumptions

- First pass targets desktop direct filesystem access only.
- Editor appears only for Git/code Demiplanes with a real workspace path.
- Single-file editing is enough for v1; tabs and fuzzy open come next.
- CodeMirror is the chosen editor base; Vim mode and LSP are follow-up layers, not part of this implementation.
