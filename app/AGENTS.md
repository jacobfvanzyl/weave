# The weave app

This directory owns the weave app: a client of the weave Host for the iPad and iPhone, which it
reaches through the Dispatcher it pairs with (ADR 0030, WVE-196), built with React in a Capacitor
shell (ADR 0015, `../docs/adr/0015-bring-alpha-back-as-the-host-client-in-capacitor.md`).
It is Alpha, brought back from commit `e30f6e93`, chat-first. Work is tracked under WVE-91; read
the live issue and the spec, `docs/specs/wve-91-host-client.md`, before implementation, and use
the repository's pinned Linear CLI and tracker conventions from `../docs/agents/issue-tracker.md`.

WVE-199 reworks it. Projects, and Sessions laying out Blocks of threads and terminals, replace
the thread list (ADR 0031). The same React runs on the Mac in Tauri beside the Capacitor shell
(ADR 0032). Until those issues land, the layout below is current.

## Boundaries

- The app is a remote client of the Host (ADR 0010). It speaks the Host protocol
  (`../docs/specs/wve-85-host-protocol.md`, `../docs/specs/wve-90-remote-clients.md`)
  and never ACP or MCP; ACP's content arrives as the Host protocol's payload.
- It pairs only with the Dispatcher, from `weave dispatcher pair`'s QR code
  (`weave://pair-dispatcher?url=…&code=…`), lists the person's Hosts from it (`hosts/list`), and
  reaches each through a connection the Dispatcher carries, terminals' streams included (ADR 0030,
  `../docs/specs/wve-175-dispatcher.md`, "Devices reaching Hosts"). It never connects to a Host
  directly, and has no fallback while the Dispatcher is away: it says so and shows the Hosts it
  last listed. It keeps one pairing (`src/host/storage.ts`), and deletes the records and keys an
  earlier version kept per Host once it has.
- Use the glossary's terms (`../CONTEXT.md`): threads, Hosts, directories, turns, steers,
  pending requests. A Session is ADR 0031's, not a thread. The code says thread too (WVE-200),
  and keeps session for ACP's names and payloads. Alpha's Threads, Connections, Workspaces and
  archiving are gone.
- Portal, Workspaces, the Host Browser, the Client Browser and Electron stay in history. Bring
  something back only when an issue asks for it. Terminals came back in WVE-153 (ADR 0022): a
  worktree's terminals in a panel beside a thread, drawn natively.

## Layout

| Path | Owns |
| --- | --- |
| `src/app` | The controller seam (`app-controller.ts`), the thread list's rules (`thread-list.ts`), read state (`thread-read-state.ts`), the mock and Host controllers, and hooks. |
| `src/host` | The Host protocol's and the Dispatcher's generated types (`protocol.ts`, never edited by hand), the Host connection (`connection.ts`), the Dispatcher's API and the connections it carries (`dispatcher.ts`), the pairing (`storage.ts`), device keys, journal following, and the store behind the Host controller (`host-store.ts`). |
| `src/chat` | The ACP transcript (`acp-transcript.ts`) and its views: the chat pane, tool calls and their terminals, plans, subagents, elicitations; the recorded journals its tests read (`fixtures/journals`). |
| `src/components` | The shell (`app-shell.tsx`), the thread list and view (`thread-list.tsx`, `thread-view.tsx`), the banner and dialogs, and the thread's status sheet (`thread-status-sheet.tsx`, WVE-160: its MCP servers, from the header's menu); `ui` and `ai-elements` are shadcn and AI Elements components. |
| `src/markdown` | What agent Markdown renders as beyond Streamdown's defaults (WVE-122), kept inert: no script, no fetch, no navigation without consent. `MessageResponse` (`src/components/ai-elements/message.tsx`) puts it together. |
| `src/surface` | A Surface (WVE-183): the messages and the projection the iPhone sends (`surface-messages.ts`), the link between the two web views (`surface-link.ts`, a BroadcastChannel between tabs in a browser), the iPhone's hook and scrubber, and the Surface's page (`surface-app.tsx`). |
| `src/terminal` | Terminals beside a thread (WVE-153): the native plugin's bridge, the hook that lays a surface out and keeps it attached, and the layout this device keeps for each thread (`terminal-layout.ts`). The panel is `src/components/terminal-panel.tsx`. |
| `ios` | The Capacitor shell: `SceneDelegate.swift` (device idiom, keyboard layout, the web view over the native terminals), `DeviceKeyPlugin.swift` (the device's Secure Enclave key for the Dispatcher, and `DeviceKeys`, which signs with it), `Surface.swift` (a Surface's scene, its web view and the plugin that relays to it), and the native terminal: `NativeTerminalPlugin.swift`, `TerminalStream.swift` (the stream's WebSocket, on which it says the Dispatcher's preamble itself), `TerminalView.swift` (keyboard, key bar, selection) and `WeaveTerminalRenderer.mm` (libghostty-vt and CoreText). `ios/App/Native/` is generated and ignored; `ios/App/Tests/` holds the renderer's tests. |
| `scripts/ios.ts` | Builds, installs and launches the iOS app. |
| `scripts/ghostty.ts` | Puts libghostty-vt for iOS, its headers and the terminal fonts in `ios/App/Native/`, built once per Ghostty pin (`../holder/ghostty.toml`); `ios.ts build` runs it first. |

The UI reads one `AppController`: `useHostController` from the Dispatcher and the Hosts it
lists, or `useMockController` from fixtures with `?mock=`. Keep components free of I/O: they take
the model and call actions. Until the app is paired with the Dispatcher, `AppShell` shows the
pairing screen (`pair-dispatcher.tsx`).

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
Markdown reply, and `terminals`, a thread with its worktree's terminals); `?surface` in another tab is a Surface for a phone tab at `?mock=…&idiom=phone`; `?idiom=phone` or `?idiom=pad`
stands in for the device in a browser, since the layout follows the device, not the window's width. A debug build takes the scenario as a launch argument
instead: `xcrun simctl launch <device> com.veezee.weave --mock running`.

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
