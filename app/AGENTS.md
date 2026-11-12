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
WVE-204), where terminals are drawn in the page by libghostty-vt in WebAssembly (WVE-205). The
person's Bots are in the list above the Projects, each opening as the Session at its home
(WVE-178, ADR 0028 and ADR 0031 as it settled them). Still to come: Block types of the person's
own (WVE-206).

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
- A Session's layout is every device's (ADR 0031): what changes its tabs and Blocks goes to
  the Host (`sessions/set`), under the revision it was made on, and is made again on what another
  device saved first. Which tab is in front, focus and zoom are the device's own
  (`src/session/view.ts`) and never written to it. A Block is docked in its tab's tree, alone in
  its place, or floats over it, where it can be minimized: none is behind another. Closing a
  Block closes its thread, which can be shown again, or ends its terminal; nothing is placed for
  the person, so what a Session has that no Block shows is listed as not shown.
- A Session holds what was given a Block in it, and what its threads started (ADR 0031, WVE-203):
  its Host keeps that (`sessions/add`, `OpenSession.own`), and the app has it count whatever a
  Block shows (`session-view.tsx`). A thread started from the TUI or a schedule is in no Session,
  whatever its directory. The app offers it in New Block, under what's elsewhere in the
  directory, and says nothing else of it: banners, notifications, counts and `weave://thread`
  links go by `ownThreads` and `threadSessions` (`src/session/sessions.ts`), which count a Bot's
  current thread as the person's too. On a Host from before `sessions_add`, everything in a
  Session's directory still counts as its own.
- A Bot is a Session of its own kind (WVE-178): the one at its home on its Host
  (`botDirectory`, `botSessionKey`), which the Host keeps as any other and knows nothing of. The
  app lists it under Bots only (`sessionSummaries` leaves it out, `botSessionKeys`), and as an
  ordinary Session once the Bot is removed. On screen it has one tab and no tab bar, the Bot's
  name and state in its place (`bot-heading.tsx`), and the Bot's Thread Block locked at the top
  left (`lockedBlock`, the first docked Block of the first tab): not closed, dragged, floated,
  minimized or swapped, nothing dropped before it, to its left or above it (`botAllows`), its
  thread not deleted from its menu, and no second thread, new tab or tab commands offered. Other
  Blocks dock to its right or below it, or float. Whenever the Bot's current thread isn't the one
  there, as after a new thread or another device's write, the device showing the Bot writes the
  layout so again (`botLayout`, in `session-view.tsx`), the Block that leaves taking its thread
  with it, running. A device that hasn't the Bot open doesn't, so the document may lag until one
  does. The Bot's logic is in `src/session/bots.ts`, with no I/O, and its views in
  `src/components/bots/`: keep it there, and keep `SessionView`'s Bot branches to what its `bot`
  prop needs.
- Everything the person does to a layout is a command (`src/app/commands.ts`): keys, the Mac's
  menu bar, a Block's menu and the palette run the same ones. Add to the table there, and handle
  it with `useCommand` in the component that can do it.

## Layout

| Path | Owns |
| --- | --- |
| `src/app` | The controller seam (`app-controller.ts`), the platform seam beside it (`platform.ts`: what differs between Capacitor, Tauri and a browser), the commands and their keys (`commands.ts`), what the app works out from the listed threads (`thread-list.ts`), read state (`thread-read-state.ts`), the mock and Host controllers, and hooks. |
| `src/session` | A Session's layout, with no I/O: the document's tree operations (`layout.ts`, `replaceBlock` among them), the Block types' names and props (`blocks.ts`), each device's own view of a layout (`view.ts`), the Sessions there are, under Projects or Hosts (`sessions.ts`, with the Dispatcher's rule for which Project a directory is in, and a Bot's Session at its home), and Bots (`bots.ts`, WVE-178: a row's state, most pressing first, away, needs you, working, unread, which is the device's own, or idle; the selection that names a Bot, `bot:<id>`, apart from a Session's key; the Bot's Thread Block and what may be dropped around it; its earlier threads; and the threads its threads started elsewhere, by Project or else by Host). The Sessions are the ones the Hosts keep (`sessions/watch`): the app makes none up from the threads listed, and a Host makes none itself, so a directory shows once a client starts a Session there, which its first Block does. Ending one (a tile's menu, or the End Session command) is its Host's to do, for good, and offered only on a Host that closes what's in it (`sessionsEnd`). |
| `src/host` | The Host protocol's and the Dispatcher's generated types (`protocol.ts`, never edited by hand), the Host connection (`connection.ts`), the Dispatcher's API and the connections it carries (`dispatcher.ts`), the pairing (`storage.ts`), device keys, journal following, the store behind the Host controller (`host-store.ts`), and the Sessions the Hosts keep, with the layout changes still to save (`sessions.ts`). The store keeps the Bots from a Dispatcher with `bots`: watched with `bots_watch` (`bots/watch`, its notifications through `DispatcherConnection`'s `onNotification`, those that come before the answer made again on it), else listed on each refresh; New Bot only with `bots_home` (`canAddBots`). It adds, changes, removes, sends to and starts a new thread for a Bot, and lists and changes its schedules, through the Dispatcher's API, its refusals in the Dispatcher's words; and shows an earlier thread to read beside what's on screen (`peekThread`), opening it in its agent if it was closed and closing it again once nothing needs it. |
| `src/chat` | The ACP transcript (`acp-transcript.ts`) and its views: the chat pane, tool calls and their terminals, plans, subagents, elicitations; the recorded journals its tests read (`fixtures/journals`). |
| `src/components` | The shell (`app-shell.tsx`), the list of Sessions (`session-list.tsx`: under their Projects, and under its Host each one no Project has; a Host with none of those is no heading), a Session on screen (`session/session-view.tsx`: the tab rail, where a tab is renamed in place and closed, with a + after the last that also takes a Block dragged onto it, New Block for what's not shown, closing, and the iPhone's one Block at a time; `session/tab-blocks.tsx`: a tab's docked Blocks, the rail every Block has whatever its type (split right, split down, float, zoom when its tab has more than one Block, its type's menu, close, and for a floating one dock and minimize; the whole rail drags the Block, onto another's edge to dock beside it or its middle to trade places, and a name clicked twice is typed over where the type's names are the person's to give), the edge around the Block with the keyboard when the tab shows others, edges to drag, floating Blocks, and the names of those minimized at the bottom right; `session/blocks.tsx`: how each Block type draws and what its menu offers, and the text floor for one the app doesn't have), the Bots (`bots/`, WVE-178: the group in the list, `bot-list.tsx`; a Bot on screen, `bot-view.tsx`, its Session through `SessionView` with `bot`, or before its first thread an empty conversation whose first prompt goes through `bots/send`; its heading; its page, `bot-page.tsx`, with what `bots/update` changes, its policy shown only, its schedules and wake-ups to pause, resume, run or remove and no form to add one, its earlier threads read in `thread-reader.tsx`, the threads it started elsewhere, each given a Block in its directory's Session when tapped, which `app-shell.tsx` makes if there's none (`bringIn`), New thread and Remove; and New Bot, `new-bot-dialog.tsx`: name, job, a connected Host and its agent), a thread (`thread-view.tsx`, which has no header in a Block: the rail renames it, and the rail's menu asks it for its status or deleting, `askThread`), the command palette, the banner and dialogs, and the thread's status sheet (`thread-status-sheet.tsx`, WVE-160: its MCP servers, from the thread's menu); `ui` and `ai-elements` are shadcn and AI Elements components. |
| `src/markdown` | What agent Markdown renders as beyond Streamdown's defaults (WVE-122), kept inert: no script, no fetch, no navigation without consent. `MessageResponse` (`src/components/ai-elements/message.tsx`) puts it together. |
| `src/surface` | A Surface (WVE-183): the messages and the projection the iPhone sends (`surface-messages.ts`), the link between the two web views (`surface-link.ts`, a BroadcastChannel between tabs in a browser), the iPhone's hook and scrubber, and the Surface's page (`surface-app.tsx`). |
| `src/terminal` | Terminals (WVE-153): the native plugin's bridge, the hook that lays a surface out under a Block and keeps it attached, and what the app shows of a terminal, with the font size this device keeps (`terminals.ts`). A terminal's name follows what's in it (its title, else the command running, else its directory), so the app renames none and shows no `label`. A terminal's Block is in `src/components/session/blocks.tsx`. |
| `src/terminal/web` | The Mac's terminal, drawn in the page (WVE-205): libghostty-vt in WebAssembly (`core.ts`, whose struct offsets are `wasm/terminal.c`'s), the stream as the page speaks it (`stream.ts`), the canvas with its keyboard, mouse, selection and links (`view.ts`, `keys.ts`, `links.ts`), the module and fonts every terminal shares (`runtime.ts`), and the hook that keeps a view attached (`use-web-terminal.ts`), with the states the native one has. `generated/` is built and ignored. A frame's arrays are views of the module's memory: read them before the next call on any terminal. |
| `wasm/terminal.c` | What sits between libghostty-vt and the page, in the same WebAssembly module: a screen restored, written and read back as rows of cells, and keys, the mouse and pastes encoded by the modes the screen is in. No libc and no imports. |
| `ios` | The Capacitor shell: `SceneDelegate.swift` (device idiom, keyboard layout, the web view over the native terminals), `DeviceKeyPlugin.swift` (the device's Secure Enclave key for the Dispatcher, and `DeviceKeys`, which signs with it), `Surface.swift` (a Surface's scene, its web view and the plugin that relays to it), and the native terminal: `NativeTerminalPlugin.swift`, `TerminalStream.swift` (the stream's WebSocket, on which it says the Dispatcher's preamble itself), `TerminalView.swift` (keyboard, key bar, selection) and `WeaveTerminalRenderer.mm` (libghostty-vt and CoreText). `ios/App/Native/` is generated and ignored; `ios/App/Tests/` holds the renderer's tests. |
| `scripts/ios.ts` | Builds, installs and launches the iOS app. |
| `src/mac` | The Mac's side (ADR 0032): the connections its core relays, its routes and the pairing it shares with the CLI (`routes.ts`), its shell's menu bar, which lists the app's commands, notifications and `weave://` links (`shell.ts`, `notices.ts`, and `notify.ts` for a terminal's program's), and the page the terminal check opens (`terminal-check.tsx`). |
| `src-tauri` | The Mac's Tauri shell: its Rust core (`src/core.rs`: this Mac's Host on its socket, the Dispatcher with `weave-host-client`, pairing), the relay to the page (`src/relay.rs`), terminals' streams, which the page opens as WebSockets on a loopback port and the core passes through to the Host's (`src/terminals.rs`), the menu bar, with the commands the page tells it (`src/menu.rs`), the window, links, notifications and the clipboard (`src/lib.rs`), and the terminal check's files (`src/check.rs`). A crate of its own, outside the repository's Cargo workspace, with its own lockfile and `target/`. `tests/relay.rs` runs the core against a dev Host and a dev Dispatcher, terminals' streams included when the holder is built. |
| `scripts/mac.ts` | Builds the Mac app in release, signs it, and installs it in `~/Applications`. |
| `scripts/mac-terminal-check.ts` | Runs the built Mac app on one terminal of a dev Host and checks what it draws and how fast. |
| `scripts/ghostty.ts` | Puts libghostty-vt for iOS, its headers and the terminal fonts in `ios/App/Native/`, built once per Ghostty pin (`../holder/ghostty.toml`); `ios.ts build` runs it first. With `web`, builds libghostty-vt for wasm32 at the same pin, links `wasm/terminal.c` with it, and puts the module and fonts in `src/terminal/web/generated/`; the Mac's builds run it first. |

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
bun run ghostty:web          # the Mac's terminal: libghostty-vt in WebAssembly, into src/terminal/web/generated
bun run mac:terminal-check   # the built app on a dev Host's terminal: what it draws, a flood, a key to its frame
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
`bots.host.test.ts` (WVE-178) adds Bots there, each Bot's home under the dev Host's directory,
never the person's `~/bots`. `src/host/bots-store.test.ts` runs the store's Bots against a
scripted Dispatcher, `src/session/bots.test.ts` the rules in `bots.ts`, and
`src/components/bots/bots.test.tsx` the list, a Bot's Session, its page and New Bot on the mock
controller, whose `list` scenario has a Bot for each way a row shows.

The transcript's tests read journals recorded from a dev Host (`src/chat/fixtures/journals/`).
Record them again with `scripts/record-journals.ts` after the Host or fake agent changes what it
journals, and review the snapshot's diff.

`?mock=` picks a fixture scenario (`list`, `thread`, `running`, `unreachable`, a Host the
Dispatcher can't reach, `offline`, the Dispatcher itself out of reach, `banner`, `empty`, a
Dispatcher no Host has joined, `unpaired`, the pairing screen, `markdown`, the fake agent's rich
Markdown reply, `terminals`, a thread with its worktree's terminals to place, and `session`, a
Session someone arranged: two tabs, Blocks docked side by side and one above another, a floating
terminal, a minimized thread and a Block of a type the app doesn't have); `?surface` in another tab is a Surface for a phone tab at `?mock=…&idiom=phone`; `?idiom=phone` or `?idiom=pad`
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
after a build with another target, `cargo clean --release --manifest-path src-tauri/Cargo.toml`. Surfaces are the iPhone's.

Terminals on the Mac are drawn in the page (WVE-205): libghostty-vt in WebAssembly on a canvas,
from the holder's Ghostty pin, so it decodes the holder's snapshots. `bun run ghostty:web` builds
the module (`mac:dev` and `mac:install` run it first; its first run fetches Ghostty and the pinned
Zig, as the holder's build does), and a build of the page without it says a terminal has nothing
to draw with. Tests of the module and the stream skip without it. The page opens a WebSocket per
terminal at an address the core offers once (`terminal_stream`), and the core passes it through
to the Host's stream, on this Mac's `terminals.sock` or through the Dispatcher; the page never
reaches the Dispatcher's WebSocket itself. ⌘ keys are the app's; Option types the layout's
characters; ⌘-click opens a link; ⌘= ⌘- ⌘0 size the text. `bun run mac:terminal-check` runs the
built app (`bun run tauri build --bundles app`) on a dev Host's terminal, with the debug `weave`
and holder built, and puts pictures of the canvas and its measurements in
`/Volumes/External/Build/weave-mac-terminal-check`; its window comes to the front while it runs.
The module and fonts are in every build of the page that has them, the iPad's too, about 10 MB.
A browser alone draws no terminals. The menu bar's Session, Tab, Block and Go menus are
the app's commands, which the page tells the core when it starts (`set_menu`), with their keys
(`src/app/commands.ts`): ⌘D and ⌘⇧D split, ⌘W closes the Block with the keyboard, ⌘T a tab, ⌘⇧[
and ⌘⇧] the tabs, ⌘⌥ and an arrow the Block that way, ⌘⇧↩ zoom, ⌘N a thread, ⌘⇧N a terminal, ⌘K
the palette, ⌘= ⌘- ⌘0 the text size of terminals. On the Mac only the menu bar hears those keys; on the iPad and in a browser the
page does. Closing the window (its red button) hides it, so notifications of threads waiting on
the person or finishing keep coming, a Bot's current thread's among them, and a click shows the
thread in its Session, or a Bot's thread in the Bot.
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
