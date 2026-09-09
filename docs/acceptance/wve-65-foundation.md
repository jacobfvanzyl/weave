# WVE-65 foundation, 2026-09-09

This records the first implementation slice. WVE-65 remains In Progress; the
terminal-first shell and native renderer are not claimed complete.

## Host context summaries

Hosts advertise `workspace.context.v1` and include `canonicalPath` in authorized
Workspace summaries. The value comes from the owning Host's filesystem, retains
case, and preserves `/`. Older summaries remain valid without the field; clients
must not substitute a basename, repository remote, or guessed path.

Configured and dynamically registered directories now use the same canonical
resolution. Registering an alias reuses an existing Workspace. Loading a catalog
preserves existing opaque IDs even when two registrations resolve to the same
directory, because those IDs can already own grants, Threads or terminals. This
does not merge or recreate those resources. The filesystem service also retains
the root directory correctly and checks containment using path segments.

Tests cover canonical aliases, distinct working directories, concurrent alias
registration, root access, preservation across reopen, and authenticated grant
filtering across Host restart. Protocol tests cover malformed paths and older
summaries. The existing local ACP test now expects the canonical directory while
retaining its session-list/load/resume and journal recovery checks.

## Native library feasibility

Ghostty revision `4a70ee4718ba0967bcfd72f43adb715bf65a860d`, observed at upstream
HEAD on September 9, builds `libghostty-vt` with Zig 0.16.0 for macOS and iOS arm64.
`bun run probe:ghostty` executed the native Mac probe and linked the iOS probe.
The Mac probe passed fragmented UTF-8/escape input, alternate-screen restoration,
and render-state resize. This is an ABI/engine test, not a graphical terminal or
physical-device result. See `product/alpha/native/ghostty/README.md` for the
pinned upstream sources and reproduction command.

The full upstream renderer no longer supports iOS. The supported public library
exposes terminal state for a renderer to consume. Choosing and proving the native
view adapters remains the next integration task; no private rex/Superlogical
interface or unsupported upstream renderer is assumed available.

## Remaining delivery

The new sidebar, independent selections, durable Workspace Compositions and
client open sets, global attention subscriptions, unavailable-directory identity
retention, presentation migration and native rendering remain outstanding.
Canonical summaries currently reflect catalog registration/load; they are not
yet a durable record of a missing or rebound directory. This slice does not
change the installed apps or restart the user's real Hosts.

The full local check passed: 175 Alpha tests, 67 Host tests, 20 protocol tests,
2 boundary tests, the renderer build and all applicable TypeScript checks.

Evidence logs are `/tmp/wve65-foundation-check2.log`,
`/tmp/wve65-context-tests2.log`, `/tmp/wve65-native-probe.log`, and
`/tmp/wve65-native-probe-clean.log` (fresh source checkout through the root task). The native
probe manifest is under the documented cache directory.
