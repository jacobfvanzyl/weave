# The weave app

This directory owns the weave app: a client of the weave Host for the iPad and iPhone, which it
reaches through the Dispatcher it pairs with (ADR 0030, WVE-196), built with React in a Capacitor
shell (ADR 0015, `../docs/adr/0015-bring-alpha-back-as-the-host-client-in-capacitor.md`), and
the same React on the Mac in Tauri (ADR 0032, WVE-204; `src-tauri/`).
It is Alpha, brought back from commit `e30f6e93`, chat-first. Work is tracked under WVE-91; read
the live issue and the spec, `docs/specs/wve-91-host-client.md`, before implementation, and use
the repository's pinned Linear CLI and tracker conventions from `../docs/agents/issue-tracker.md`.

WVE-199 reworks it, and WVE-203 did the middle of that: the app lists the person's Sessions,
under their Projects, and shows one as tabs of Blocks, laid out from the document its Host keeps
(ADR 0031). The same React runs on the Mac in Tauri beside the Capacitor shell (ADR 0032,
WVE-204). Still to come: Bots and richer tiles in the list (WVE-192), terminals drawn on the Mac
(WVE-205), and Block types of the person's own (WVE-206).

## Boundaries

- The app is a remote client of the Host (ADR 0010). It speaks the Host protocol
  (`../docs/specs/wve-85-host-protocol.md`, `../docs/specs/wve-90-remote-clients.md`)
  and never ACP or MCP; ACP's content arrives as the Host protocol's payload.
- It pairs only with the Dispatcher, from `weave pair`'s QR code
  (`weave://pair-dispatcher?url=…&code=…`), lists the person's Hosts from it (`hosts/list`), and
  reaches each through a connection the Dispatcher carries, terminals' streams included (ADR 0030,
  `../docs/specs/wve-175-dispatcher.md`, "Devices reaching Hosts"). It never connects to a Host
  directly, and has no fallback while the Dispatcher is away: it says so and shows the Hosts it
  last listed. It keeps one pairing (`src/host/storage.ts`), and deletes the records and keys an
  earlier version kept per Host once it has.
- The Mac is the exception for its own Host (ADR 0032, WVE-204). Its app's Rust core reaches this
  Mac's Host over its Unix socket, as local clients do (ADR 0030), with or without the Dispatcher,
  and every other Host through the Dispatcher. The core opens every connection and proves the
  device itself, then relays it to the page, which speaks the Host protocol and the Dispatcher's
  API on it as anywhere else (`src/host/routes.ts` is the seam, `src/mac/routes.ts` the Mac's
  side). The page never holds the key nor asks for a signature. The Mac shares the pairing and
  Secure Enclave key the computer's CLI keeps (`weave dispatcher connect`,
  `~/.local/state/weave/client/`): it's one device to the Dispatcher, and forgetting the
  Dispatcher in the app forgets the CLI's pairing too.
- Use the glossary's terms (`../CONTEXT.md`): threads, Hosts, directories, turns, steers,
  pending requests. A Session is ADR 0031's, not a thread. The code says thread too (WVE-200),
  and keeps session for ACP's names and payloads. Alpha's Threads, Connections, Workspaces and
  archiving are gone.
- Portal, Workspaces, the Host Browser, the Client Browser and Electron stay in history. Bring
  something back only when an issue asks for it. Terminals came back in WVE-153 (ADR 0022), drawn
  natively on the iPad and iPhone, and since WVE-203 each is a Block in its Session's layout.
- A Session's layout is every device's (ADR 0031): what changes its tabs, panes and Blocks goes to
  the Host (`sessions/set`), under the revision it was made on, and is made again on what another
  device saved first. Which tab and Block are in front, focus and zoom are the device's own
  (`src/session/view.ts`) and never written to it. Closing a Block closes its thread, which can
  be shown again, or ends its terminal; nothing is placed for the person, so what a Session has
  that no Block shows is listed as not shown.
- Everything the person does to a layout is a command (`src/app/commands.ts`): keys, the Mac's
  menu bar, a Block's menu and the palette run the same ones. Add to the table there, and handle
  it with `useCommand` in the component that can do it.

## Layout

| Path | Owns |
| --- | --- |
| `src/app` | The controller seam (`app-controller.ts`), the platform seam beside it (`platform.ts`: what differs between Capacitor, Tauri and a browser), the commands and their keys (`commands.ts`), what the app works out from the listed threads (`thread-list.ts`), read state (`thread-read-state.ts`), the mock and Host controllers, and hooks. |
| `src/session` | A Session's layout, with no I/O: the document's tree operations (`layout.ts`), the Block types' names and props (`blocks.ts`), each device's own view of a layout (`view.ts`), and the Sessions there are, under Projects or Hosts (`sessions.ts`, with the Dispatcher's rule for which Project a directory is in). The Sessions are the ones the Hosts keep (`sessions/watch`): the app makes none up from the threads listed, so a directory shows once something is prompted or started in it. Ending one (a tile's menu, or the End Session command) is its Host's to do, for good, and offered only on a Host that closes what's in it (`sessionsEnd`). |
| `src/host` | The Host protocol's and the Dispatcher's generated types (`protocol.ts`, never edited by hand), the Host connection (`connection.ts`), the Dispatcher's API and the connections it carries (`dispatcher.ts`), the pairing (`storage.ts`), device keys, journal following, the store behind the Host controller (`host-store.ts`), and the Sessions the Hosts keep, with the layout changes still to save (`sessions.ts`). |
| `src/chat` | The ACP transcript (`acp-transcript.ts`) and its views: the chat pane, tool calls and their terminals, plans, subagents, elicitations; the recorded journals its tests read (`fixtures/journals`). |
| `src/components` | The shell (`app-shell.tsx`), the list of Sessions (`session-list.tsx`: under their Projects, and under its Host each one no Project has; a Host with none of those is no heading), a Session on screen (`session/session-view.tsx`: the tab rail, where a tab is renamed in place and closed, with a + after the last that also takes a Block dragged onto it, New Block for what's not shown, closing, and the iPhone's one Block at a time; `session/panes.tsx`: panes, the rail every Block has whatever its type (split right, split down, float, zoom when its tab has more than one Block, its type's menu, close; the whole rail drags the Block), edges to drag, and floating Blocks; `session/blocks.tsx`: how each Block type draws and what its menu offers, and the text floor for one the app doesn't have), a thread (`thread-view.tsx`, which has no header in a Block: the rail's menu asks it for its status, a new name or deleting, `askThread`), the command palette, the banner and dialogs, and the thread's status sheet (`thread-status-sheet.tsx`, WVE-160: its MCP servers, from the thread's menu); `ui` and `ai-elements` are shadcn and AI Elements components. |
| `src/markdown` | What agent Markdown renders as beyond Streamdown's defaults (WVE-122), kept inert: no script, no fetch, no navigation without consent. `MessageResponse` (`src/components/ai-elements/message.tsx`) puts it together. |
| `src/surface` | A Surface (WVE-183): the messages and the projection the iPhone sends (`surface-messages.ts`), the link between the two web views (`surface-link.ts`, a BroadcastChannel between tabs in a browser), the iPhone's hook and scrubber, and the Surface's page (`surface-app.tsx`). |
| `src/terminal` | Terminals (WVE-153): the native plugin's bridge, the hook that lays a surface out under a Block and keeps it attached, and what the app shows of a terminal, with the font size this device keeps (`terminals.ts`). A terminal's Block is in `src/components/session/blocks.tsx`. |
| `ios` | The Capacitor shell: `SceneDelegate.swift` (device idiom, keyboard layout, the web view over the native terminals), `DeviceKeyPlugin.swift` (the device's Secure Enclave key for the Dispatcher, and `DeviceKeys`, which signs with it), `Surface.swift` (a Surface's scene, its web view and the plugin that relays to it), and the native terminal: `NativeTerminalPlugin.swift`, `TerminalStream.swift` (the stream's WebSocket, on which it says the Dispatcher's preamble itself), `TerminalView.swift` (keyboard, key bar, selection) and `WeaveTerminalRenderer.mm` (libghostty-vt and CoreText). `ios/App/Native/` is generated and ignored; `ios/App/Tests/` holds the renderer's tests. |
| `scripts/ios.ts` | Builds, installs and launches the iOS app. |
| `src/mac` | The Mac's side (ADR 0032): the connections its core relays, its routes and the pairing it shares with the CLI (`routes.ts`), and its shell's menu bar, which lists the app's commands, notifications and `weave://` links (`shell.ts`, `notices.ts`). |
| `src-tauri` | The Mac's Tauri shell: its Rust core (`src/core.rs`: this Mac's Host on its socket, the Dispatcher with `weave-host-client`, pairing), the relay to the page (`src/relay.rs`), the menu bar, with the commands the page tells it (`src/menu.rs`), and the window, links and notifications (`src/lib.rs`). A crate of its own, outside the repository's Cargo workspace, with its own lockfile and `target/`. `tests/relay.rs` runs the core against a dev Host and a dev Dispatcher. |
| `scripts/mac.ts` | Builds the Mac app in release, signs it, and installs it in `~/Applications`. |
| `scripts/ghostty.ts` | Puts libghostty-vt for iOS, its headers and the terminal fonts in `ios/App/Native/`, built once per Ghostty pin (`../holder/ghostty.toml`); `ios.ts build` runs it first. |

The UI reads one `AppController`: `useHostController` from the Dispatcher and the Hosts it
lists, or `useMockController` from fixtures with `?mock=`. Keep components free of I/O: they take
the model and call actions. Until the app is paired with the Dispatcher, `AppShell` shows the
pairing screen (`pair-dispatcher.tsx`). Several threads are on screen at once: the Session's view
says which (`showThreads`), the model has each (`open`), and what's done in one names it
(`forThread`, or `threadController` for a component that reads one thread).

The Host protocol's types, and the Dispatcher's API beside them, come from the Rust
(`../protocol/tests/schema.rs`). After a protocol change there, regenerate them, and never edit
`src/host/protocol.ts` by hand.

## Commands

Run from `app/`, with Bun 1.4.3:

```bash
bun install
bun run check                # tests, type check and build
bun run dev                  # http://localhost:5174/?mock=thread&idiom=phone
bun run cap:sync             # build and copy into the iOS project
bun run ios:build            # signed build for any iOS device; --unsigned to only compile
bun run ios:install -- --device <udid>   # install and launch it (`xcrun devicectl list devices`)
bun run native:test          # the native terminal's renderer, built for macOS, and its codec against the holder's
bun scripts/terminal-check.ts            # the native terminal in a simulator, through a dev Dispatcher to a dev Host, with screenshots
bun scripts/protocol-types.ts            # regenerate src/host/protocol.ts from the Host's schema
bun run mac:dev              # the Mac app around Vite's dev server, reloading as you edit
bun run mac:test             # the core's tests (a dev Host and Dispatcher) and clippy
bun run mac:install          # release build, signed, in ~/Applications; -- --open to open it
bun scripts/record-journals.ts [name…]   # record the transcript tests' journals from a dev Host
```

The `*.host.test.ts` files run the client against a dev Dispatcher and dev Hosts that joined it
(`src/host/testing/dev-dispatcher.ts`, `dev-host.ts`): the debug `weave` and fake agent in
directories of their own, never the installed Host or the person's Dispatcher, with the fake agent
as `fake`, as `fake-minimal` (no steering, no images) and as `fake-auth` (needs signing in). The
store pairs with the dev Dispatcher and reaches the Hosts through it, as the app does. The dev
Dispatcher runs `weave dispatcher run --listen 127.0.0.1:<free port> --url ws://…`, so turning its
WebSocket on makes no Tailscale Serve entry: keep it that way, and check `tailscale serve status`
is unchanged after a run. They skip unless the binaries are built: `(cd .. && cargo build -p
weave-cli -p weave-fake-agent -p weave-holder)`; the holder gives the dev Host terminals. They run
in Vitest's `node` environment, since happy-dom's WebSocket fails the upgrade.

The transcript's tests read journals recorded from a dev Host (`src/chat/fixtures/journals/`).
Record them again with `scripts/record-journals.ts` after the Host or fake agent changes what it
journals, and review the snapshot's diff.

`?mock=` picks a fixture scenario (`list`, `thread`, `running`, `unreachable`, a Host the
Dispatcher can't reach, `offline`, the Dispatcher itself out of reach, `banner`, `empty`, a
Dispatcher no Host has joined, `unpaired`, the pairing screen, `markdown`, the fake agent's rich
Markdown reply, `terminals`, a thread with its worktree's terminals to place, and `session`, a
Session someone arranged: two tabs, panes split and stacked, a floating terminal and a Block of a
type the app doesn't have); `?surface` in another tab is a Surface for a phone tab at `?mock=…&idiom=phone`; `?idiom=phone` or `?idiom=pad`
stands in for the device in a browser, since the layout follows the device, not the window's width. A debug build takes the scenario as a launch argument
instead: `xcrun simctl launch <device> com.veezee.weave --mock running`.

### The Mac

The Mac app is `src-tauri/` around the same page. `bun run mac:dev` starts Vite (`bun run dev`)
and opens the app on it, rebuilding the core when its Rust changes; the page reloads as you edit,
and the core closes the page's connections when it does. It reaches the installed Host on this
Mac (`~/.local/state/weave/daemon/daemon.sock`, or `$WEAVE_DAEMON_DIR`'s) and the Dispatcher the
computer is paired with: the person's own, so be careful what a dev build does there. Until the
computer is paired, it shows the pairing screen, which takes the link or URL and code from `weave
pair`, as `weave dispatcher connect` does. `bun run mac:test` needs `(cd .. && cargo build -p
weave-cli)` first, or its relay test skips. Its build goes beside the workspace's, never in it:
its own `src-tauri/target/` and `Cargo.lock`, the toolchain and `clippy.toml` from the repository
root.

`bun run mac:install` signs with the Apple Development identity of the iOS app's team, or ad hoc
(`WEAVE_SIGNING_IDENTITY` names another), and isn't notarized; the app doesn't update itself, so
install again after pulling. Keep `bundle.macOS.minimumSystemVersion` at 11.0: `tauri build` sets
`MACOSX_DEPLOYMENT_TARGET` from it, and on macOS 27.2 (2026-11-10) proc-macro libraries linked
for 12.0 or later come out corrupt (`mis-aligned LINKEDIT string pool`), so the build fails
finding `serde_derive` and the like. Cargo doesn't rebuild them when only that variable changes:
after a build with another target, `cargo clean --release --manifest-path src-tauri/Cargo.toml`. A terminal's Block on the Mac says what the terminal is and what runs in it, until WVE-205
draws them, and Surfaces are the iPhone's. The menu bar's Session, Tab, Block and Go menus are
the app's commands, which the page tells the core when it starts (`set_menu`), with their keys
(`src/app/commands.ts`): ⌘D and ⌘⇧D split, ⌘W closes the Block with the keyboard, ⌘T a tab, ⌘⇧[
and ⌘⇧] the tabs, ⌘⌥ and an arrow the Block that way, ⌘⇧↩ zoom, ⌘N a thread, ⌘⇧N a terminal, ⌘K
the palette. On the Mac only the menu bar hears those keys; on the iPad and in a browser the
page does. Closing the window (its red button) hides it, so notifications of threads waiting on
the person or finishing keep coming, and a click shows the thread in its Session.
`weave://thread/<host>/<thread>` does the same and `weave://pair-dispatcher?…` offers a pairing,
once the app is installed.

## Conventions

- Tests run in Vitest with happy-dom and Testing Library; query by role and accessible name.
- Agent text fetches nothing without consent. Markdown images become links that ask first, and the
  built app runs under a Content Security Policy (`src/content-security-policy.ts`, added to the
  page at build time only) that loads nothing from another address but the Dispatcher's
  WebSockets.
- Xcode builds use Xcode's configured DerivedData location. Never pass `-derivedDataPath` or
  `-resultBundlePath` under `/tmp` or the home directory; an isolated build goes under
  `/Volumes/External/Build/xcodebuild.noindex/<name>` and is removed afterwards.
- The bundle id is `com.veezee.weave`. Leave the Alpha installed on devices
  (`com.veezee.alpha`) and its Portal pairings alone; removing it is a deliberate step.
- Keep device acceptance separate from unit tests and simulator runs, and record devices and OS
  versions with it.
- Never commit signing assets, provisioning profiles, device keys or Xcode user data.
