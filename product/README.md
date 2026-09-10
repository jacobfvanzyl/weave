# Weave Product

This directory is the self-contained Weave product stack:

- `alpha/` is the Capacitor and React client.
- `portal/` is the directly connected host daemon.
- `protocol/` is their only shared wire-contract module.

The product must build and run without importing the repository's earlier applications or shared packages. Run `bun run check:boundary` from the repository root to enforce that rule mechanically.

## Development

Run these commands from the repository root.

```bash
bun install --frozen-lockfile
bun run check
```

The Host runs on Bun. Alpha, Host and protocol share the root Bun workspace.

### Alpha UI mocks

Alpha's product shell consumes a UI controller rather than Portal directly. During
development, append one of these scenarios to the Alpha URL to render the same
components without a running host:

```text
?mock=disconnected
?mock=connecting
?mock=empty
?mock=sidebar
?mock=busy
?mock=error
```

Mock mode is disabled in production builds. Actions such as search, Thread
selection, Thread creation, archiving, restoration, connection, and disconnection
remain interactive in the mocked shell.

### Desktop and iPad Alpha

Alpha exposes ACP conversations and native libghostty terminals in Electron and on iPad.
Desktop and iPad builds prepare the pinned native library automatically; no renderer flag is needed.
Browser previews show an explicit unavailable terminal surface. Filetree, Editor and
embedded Browser remain in `deferred/`, outside active builds.

From the repository root:

```bash
bun run dev:desktop
bun run build:desktop
bun run install:desktop
bun run run:desktop
```

Electron packages the renderer under `alpha/release/Weave Alpha-darwin-<arch>/`.
`install:desktop` copies it to `~/Applications/Weave Alpha.app`, retaining a
previous same-identity bundle privately. The desktop profile stays intact.
Its sandboxed renderer uses the secure `weave://app` origin and has no Node or
general-purpose IPC access. The small preload identifies the desktop platform.
Native menus provide standard editing, zoom, window and application commands.
Set `WEAVE_ALPHA_CODESIGN_IDENTITY` for a named local development signature.
Distribution signing/notarization requires the appropriate Apple credentials.

Capacitor targets iPad only. Run `bun run --cwd product/alpha cap:sync` before
building `alpha/ios/App/App.xcodeproj`. Native credential signing, safe-area,
keyboard and app-lifecycle integration remain in this shell. AppKit desktop,
iPhone and Mac Catalyst targets are retired.

The old WebKit private keys cannot be exported into Electron. The first-run
Connections dialog explains re-pairing. Keep the same Host config/state, create
a fresh Pairing Token, pair the desktop, verify existing projects/Threads and
terminals, then revoke the old desktop credential if it is no longer used.
Electron stores non-exportable keys and connection metadata in its own stable
`~/Library/Application Support/Weave Alpha` profile. Reinstalling/upgrading the
app preserves that profile. Neither first launch nor re-pairing deletes Host
state or the prior WebKit data. Add `weave://app` to each Host's exact allowed
origins, retaining `capacitor://localhost` for iPad.

## Module seams

- Alpha depends on `@weave/product-protocol` and browser or Capacitor primitives only.
- Portal depends on `@weave/product-protocol`, Bun and standard Node-compatible APIs.
- The protocol contains wire types, constants, and response validation. It contains no Portal or Alpha behavior.
- `scripts/check-boundary.ts` rejects imports that escape this directory and dependencies on the earlier Weave packages.

The current product supports concurrent authenticated connections to multiple Portal Hosts. Alpha groups physical
Workspaces that share a normalized Git remote into logical Projects, merges their active Threads by recency while
retaining Host-scoped identity and routing, keeps cached Host state visible through partial outages, and reconnects
Hosts independently. A Project can be registered from Alpha by choosing a connected Portal and an existing absolute
path on that Host. Hosts that advertise the Thread lifecycle capabilities also expose archive and restore controls;
older Hosts remain usable without a broken lifecycle action.

Hosts that advertise `thread.draft` can preflight one provisional ACP session for Alpha's empty Thread. Alpha attaches
to it immediately so Agent-owned model, reasoning, mode, and other config controls are available before the first
prompt. Portal keeps that runtime out of Thread listings and durable catalogs until the first prompt promotes the same
session; abandoning the empty Thread closes and removes the provisional runtime. Alpha retains its client-only draft
fallback for older Hosts.

Portal provides Workspace and Agent listing, durable Thread identity, explicit archive and restore, and ACP recovery,
plus Workspace-scoped filesystem browsing, UTF-8 reads, full content hashes, conditional writes, directory and file
mutations, bounded search, and connection-scoped change observation. Alpha no longer mounts or subscribes a file browser. Portal also exposes product-owned persistent user terminals behind the `terminal.*` protocol.
Its private tmux adapter keeps Workspace-scoped shells alive across client disconnects and Portal restarts, while the
public service enforces one controller, multiple observers, bounded output, typed conflicts, and explicit detach versus
close. Alpha renders those shells with native libghostty in Host-owned workspace arrangements.
The client retains independent open-workspace, focused-pane and selected-Thread state. Run
`bun run acceptance:terminal` from `product/portal` with `PORTAL_URL`, `PORTAL_PAIRING_TOKEN`, and
`PORTAL_WORKSPACE_ID` to exercise the two-client lifecycle against a configured Host.

See `portal/README.md` for local configuration and direct acceptance.
