# WVE-79 — Host-owned Profile implementation foundation

Implemented and validated 2026-09-13. This is the first product integration slice after the Browser Pane/Profile domain decisions. The selected display direction remains prebuilt CEF and lossless RFB; this slice does not yet switch the runtime launcher or native clients to it.

## What changed

The independent Browser Service now owns a persistent catalog of named Host Profiles. Profiles have generated stable identities and conditional rename revisions. The catalog uses private, atomic file replacement; profile data lives in separate private directories. Concurrent opens reuse one runtime per Profile. Different Profiles use separate browser processes and storage. Renaming, client disposal and reconnect do not replace the live runtime. Repeated open requests after runtime loss report unavailability instead of silently starting a replacement.

Portal and the shared protocol expose `browser.profiles.v1` with list/create/rename operations. Requests reject obsolete Workspace addressing and caller-provided storage paths. List results are filtered by authorization. A metadata manager may create/rename/list Profile records without thereby gaining access to their signed-in browser identity.

The credential authority now stores explicit `browserProfileIds` alongside Profile inspect/control actions. A Profile control grant also permits listing that Profile. Profile scope is independent of Workspace membership and does not expand filesystem access. Neither old Workspace grants nor a wildcard Profile ID grant access to Profiles. Existing credentials are not upgraded to the new permissions. The private service IPC advances to version 2 so stale owners/clients cannot silently treat the new contract as the old one.

Old Workspace-hashed profiles and the earlier Workspace/WebRTC code remain intact as transitional work. They are not automatically adopted into Host Profiles. The source README clearly identifies those older semantics as superseded.

## Validation

- `bun install --frozen-lockfile`: Bun 1.3.14; no dependency changes.
- `bun run check`: passed boundary checks, 32 protocol tests, 263 Alpha tests, 108 Portal tests, Alpha build and desktop/Portal type checks.
- Focused Profile, service, credential and authenticated-RPC tests passed. After the final scoped changes, the affected authorization/RPC tests and owner/service tests were rerun successfully, together with Portal type checking and `git diff --check`.
- Source-service acceptance on macOS: real Chrome 153.0.8010.36, passed.
- Compiled-service acceptance on macOS and Bazzite Linux x64: real Chrome 153.0.8010.36, passed on both.

Real-browser checks created two disposable Profiles and verified process and cookie isolation, runtime reuse under concurrent opens, stable identity across rename, continued page timer activity after caller disconnect, persisted catalog/cookies after service restart, and rejection of stale runtime handles. Mac timer samples advanced from 14 to 39; Linux from 12 to 37. These are unattended-execution observations, not FPS measurements.

The scripts owned temporary state and service/browser processes, shut those down cleanly and removed successful acceptance state. The installed Portal, existing personal browser profiles and iPad app were not changed. Linux compiled validation artifacts are isolated under `/var/home/admin/weave-profile-foundation`.

## Boundaries and next work

This slice uses the existing stock Chrome launcher to validate ownership independently of rendering. The CEF foundation experiment separately established sandboxed rendering and debugging; it is not yet wired into these Profile runtimes. The maintained MCP `new_page` compatibility issue remains open.

Still required:

1. Integrate Browser Panes into shared Workspace Composition with stable Pane/Profile identities, cross-Workspace moves and durable last-committed URLs.
2. Connect CEF-created pages and popup discovery to that composition, including inherited Profiles and splitting the originating Pane to the right.
3. Implement shared close, active-work confirmation and explicit Restore while retaining Profile data; add Profile selection suggestions and explicit Profile deletion.
4. Carry Profile grants through the actual ACP/MCP/CDP path and provide grant-management UI. Credential-scope tests do not establish end-to-end agent control.
5. Replace transitional WebRTC transport with authenticated RFB and native Alpha presentation, then validate complete input, 60 FPS, release packaging and Mac/iPad acceptance. Audio remains deferred.

No commits, installed-Host deployment, release publication or issue closure were performed. WVE-79 remains In Progress.

## Reproduce real-browser acceptance

```sh
CHROME_BINARY=/absolute/path/to/chromium bun product/portal/scripts/browser-profile-acceptance.ts
```

Set `BROWSER_SERVICE_BINARY` to a compiled `weave-browser-service` to exercise the packaged owner. The script uses disposable state and preserves it for diagnosis on failure. Build the owner with `bun product/portal/scripts/build-browser-service.ts`, adding `--linux` for the Linux x64 binary. This is a development packaging check, not signing/notarization acceptance.
