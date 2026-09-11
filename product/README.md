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
a fresh Pairing Token, pair the desktop, verify existing Workspaces/Threads and
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

Alpha connects to multiple Hosts independently. A Workspace is a named arrangement on exactly one Host,
with terminal pane tiles followed by agent Threads. Workspaces never merge by directory
or repository. Their directory summaries follow terminal metadata, while agent execution contexts remain fixed
when Threads are moved. Hiding a Workspace is device-local and leaves membership and processes intact.

Protocol version 4 separates `context.*` execution and file access from `workspace.composition.*` organization.
Every execution/file request names an `executionContextId`; Thread `workspaceId` is required and is never an
access grant. `thread.assign` requires the owning Host and expected membership revision. Runtime snapshots
cannot overwrite membership. New agents use the focused terminal directory, with an explicit directory choice
when no focused/default candidate exists. Alpha always selects a Workspace before creating an agent. Local ACP
and creation requests without a destination reuse an unambiguous same-directory Workspace or create a directory Workspace.
Null destinations are rejected, including for drafts and archived Threads. New terminal panes provision their own shells; splits use the source's
current directory only within an authorized execution context.

The Host migrates the existing directory registrations and pins in `workspaces.json` to execution-context records,
retains credential identities and grants in security schema 2, and promotes old composition tabs to Host Workspaces
in composition schema 2. Thread catalog schema 3 requires membership independently of execution context. Previously unassigned Threads
join a unique same-directory Workspace or a dedicated recovery Workspace when the destination is ambiguous; provider sessions, transcripts and terminal processes retain their identities. Legacy
composition files remain read-only migration inputs. Atomic saves make restart after a partial migration repeatable.
Older protocol clients cannot write the new contracts, and older Host binaries reject the migrated catalog/security
versions. Downgrading requires restoring a coordinated pre-migration backup, not running an older binary against new state.

Connection names appear only when Workspaces span more than one configured Host. Every Workspace appears on every connected device; empty Workspaces are removed by the Host. Closing a Workspace confirms dirty work, stops its terminals and agent runtimes, archives its conversations, and removes the shared arrangement.
New recovery Workspaces are revealed once per device without reopening a Workspace the user subsequently hides.

Device presentation migrates from `weave.workspace-presentation.v1` to `.v2`, preserving open/active Workspace,
focused/maximized pane references and separate pane-size preferences. Local ACP accepts `--context <id>`;
`--workspace` remains an input compatibility alias for old connector configurations. New terminal environments use
`WEAVE_EXECUTION_CONTEXT_ID` and `WEAVE_EXECUTION_DIRECTORY`; existing shells keep their original environment.

Portal provides execution-context and Agent listing, durable Thread identity, explicit archive and restore, and ACP recovery,
plus execution-context-scoped filesystem browsing, UTF-8 reads, full content hashes, conditional writes, directory and file
mutations, bounded search, and connection-scoped change observation. Alpha no longer mounts or subscribes a file browser. Portal also exposes product-owned persistent user terminals behind the `terminal.*` protocol.
Its independent Terminal Service keeps execution-context-scoped shells alive across client disconnects and Host Daemon restarts, while the
Alpha uses shared input attachments: either device can type, and the Host applies the last input device's viewport before its input. Passive devices retain their own viewport sizes without resizing the shell. Read-only observers and legacy exclusive-control attachments remain available to protocol clients. The service enforces bounded output, attachment ownership, and explicit detach versus
close. Alpha renders those shells with native libghostty in Host-owned workspace arrangements.
The client retains independent open-workspace, focused-pane and selected-Thread state. Run
`bun run acceptance:terminal` from `product/portal` with `PORTAL_URL`, `PORTAL_PAIRING_TOKEN`, and
`PORTAL_WORKSPACE_ID` to exercise the two-client lifecycle against a configured Host.

See `portal/README.md` for local configuration and direct acceptance.

Hosts advertising `workspace.composition.terminal-create` create a fresh shell for each new pane as part of the revision-checked composition write. Null terminal references are creation requests or legacy data, never a normal empty-pane UI. Alpha provisions legacy null references on refresh; stale writers cannot create duplicate shells, and retries after a failed save reuse the creation identity. Removing a pane reference does not terminate its shell.

Each terminal can be placed once across all Workspaces on its Host. The Host rejects duplicate placements and repairs older arrangements by retaining the first reference and clearing duplicates without changing pane identities or stopping terminals.
