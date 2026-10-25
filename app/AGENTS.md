# The weave app

This directory owns the weave app: a client of the weave Host for the iPad and iPhone, built
with React in a Capacitor shell (ADR 0015, `../docs/adr/0015-bring-alpha-back-as-the-host-client-in-capacitor.md`).
It is Alpha, brought back from commit `e30f6e93`, chat-first. Work is tracked under WVE-91; read
the live issue and the spec, `docs/specs/wve-91-host-client.md`, before implementation, and use
the repository's pinned Linear CLI and tracker conventions from `../docs/agents/issue-tracker.md`.

## Boundaries

- The app is a remote client of the Host (ADR 0010). It speaks the Host protocol
  (`../docs/specs/wve-85-host-protocol.md`, `../docs/specs/wve-90-remote-clients.md`)
  and never ACP or MCP; ACP's content arrives as the Host protocol's payload.
- Use the glossary's terms (`../CONTEXT.md`): sessions, Hosts, directories, turns, steers,
  pending requests. Alpha's Threads, Connections, Workspaces and archiving are gone.
- Portal, terminals, Workspaces, the Host Browser, the Client Browser and Electron stay in
  history. Bring something back only when an issue asks for it.

## Layout

| Path | Owns |
| --- | --- |
| `src/app` | The controller seam (`app-controller.ts`), the session list's rules (`session-list.ts`), read state, the mock and Host controllers, and hooks. |
| `src/host` | The Host protocol's generated types (`protocol.ts`, never edited by hand), the connection, device keys, journal following, and the store behind the Host controller (`host-store.ts`). |
| `src/chat` | The ACP transcript (`acp-transcript.ts`) and its views: the chat pane, tool calls and their terminals, plans, subagents, elicitations; the recorded journals its tests read (`fixtures/journals`). |
| `src/components` | The shell (`app-shell.tsx`), the session list and view, the banner and dialogs; `ui` and `ai-elements` are shadcn and AI Elements components. |
| `src/markdown` | What agent Markdown renders as beyond Streamdown's defaults (WVE-122), kept inert: no script, no fetch, no navigation without consent. `MessageResponse` (`src/components/ai-elements/message.tsx`) puts it together. |
| `ios` | The Capacitor shell: `SceneDelegate.swift` (device idiom, keyboard layout) and `DeviceKeyPlugin.swift` (Secure Enclave keys). |
| `scripts/ios.ts` | Builds, installs and launches the iOS app. |

The UI reads one `AppController`: `useHostController` from the paired Hosts, or
`useMockController` from fixtures with `?mock=`. Keep components free of I/O: they take the
model and call actions.

The Host protocol's types come from the Host's Rust (`../protocol/tests/schema.rs`).
After a protocol change there, regenerate them, and never edit `src/host/protocol.ts` by hand.

## Commands

Run from `app/`, with Bun 1.4.3:

```bash
bun install
bun run check                # tests, type check and build
bun run dev                  # http://localhost:5174/?mock=session&idiom=phone
bun run cap:sync             # build and copy into the iOS project
bun run ios:build            # signed build for any iOS device; --unsigned to only compile
bun run ios:install -- --device <udid>   # install and launch it (`xcrun devicectl list devices`)
bun scripts/protocol-types.ts            # regenerate src/host/protocol.ts from the Host's schema
bun scripts/record-journals.ts [name…]   # record the transcript tests' journals from a dev Host
```

The `*.host.test.ts` files run the client against a dev Host (`src/host/testing/dev-host.ts`):
the debug `weave` and fake agent in a directory of their own, never the installed Host, with the
fake agent as `fake`, as `fake-minimal` (no steering, no images) and as `fake-auth` (needs
signing in). They skip unless those binaries are built: `(cd .. && cargo build -p weave-cli
-p weave-fake-agent)`. They run in Vitest's `node` environment, since happy-dom's WebSocket fails
the Host's upgrade.

The transcript's tests read journals recorded from a dev Host (`src/chat/fixtures/journals/`).
Record them again with `scripts/record-journals.ts` after the Host or fake agent changes what it
journals, and review the snapshot's diff.

`?mock=` picks a fixture scenario (`list`, `session`, `running`, `unreachable`, `banner`,
`empty`); `?idiom=phone` or `?idiom=pad` stands in for the device in a browser, since the layout
follows the device, not the window's width. A debug build takes the scenario as a launch argument
instead: `xcrun simctl launch <device> com.veezee.weave --mock running`.

## Conventions

- Tests run in Vitest with happy-dom and Testing Library; query by role and accessible name.
- Agent text fetches nothing without consent. Markdown images become links that ask first, and the
  built app runs under a Content Security Policy (`src/content-security-policy.ts`, added to the
  page at build time only) that loads nothing from another address but the Hosts' WebSockets.
- Xcode builds use Xcode's configured DerivedData location. Never pass `-derivedDataPath` or
  `-resultBundlePath` under `/tmp` or the home directory; an isolated build goes under
  `/Volumes/External/Build/xcodebuild.noindex/<name>` and is removed afterwards.
- The bundle id is `com.veezee.weave`. Leave the Alpha installed on devices
  (`com.veezee.alpha`) and its Portal pairings alone; removing it is a deliberate step.
- Keep device acceptance separate from unit tests and simulator runs, and record devices and OS
  versions with it.
- Never commit signing assets, provisioning profiles, device keys or Xcode user data.
