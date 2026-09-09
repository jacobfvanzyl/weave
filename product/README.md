# Weave Product

This directory is the self-contained Weave product stack:

- `alpha/` is the Capacitor and React client.
- `portal/` is the directly connected host daemon.
- `protocol/` is their only shared wire-contract module.

The product must build and run without importing the repository's earlier applications or shared packages. Run `bun run check:boundary` from this directory to enforce that rule mechanically.

## Development

```bash
bun install --frozen-lockfile
bun run check
```

Portal remains a Deno executable and is checked from its own directory. Alpha and the protocol use the product-local Bun workspace.

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

### Apple native Alpha hosts

Alpha currently exposes ACP conversations and xterm.js terminals. Filetree, Editor, and embedded Browser are deferred; their reference snapshots live in `deferred/` outside active builds.

Build the production macOS AppKit application from `product/`:

```bash
bun run build:alpha:macos
bun run run:alpha:macos
```

The build embeds the production Alpha assets in `alpha/dist/Weave Alpha.app` and signs the bundle.
It uses ad-hoc signing by default for a local build; set `WEAVE_ALPHA_CODESIGN_IDENTITY` to a
codesigning identity for a named development signature. The AppKit shell is the supported
macOS host; Alpha does not enable Mac Catalyst and does not embed Electron or Chromium.

For iPadOS, synchronize the same production assets into the Capacitor project before building from
`alpha/ios/App/App.xcodeproj`:

```bash
cd alpha
bun run cap:sync
```

## Module seams

- Alpha depends on `@weave/product-protocol` and browser or Capacitor primitives only.
- Portal depends on `@weave/product-protocol` and Deno primitives only.
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
close. Alpha renders those shells with xterm in independently persisted Bottom and Right docks. Run
`deno task acceptance:terminal` from `product/portal` with `PORTAL_URL`, `PORTAL_PAIRING_TOKEN`, and
`PORTAL_WORKSPACE_ID` to exercise the two-client lifecycle against a configured Host.

See `portal/README.md` for local configuration and direct acceptance.
