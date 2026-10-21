# WVE-91: The weave app, a Host client for iPad and iPhone

Status: structure settled 2026-10-20 (WVE-99); connecting to Hosts 2026-10-20 (WVE-100); the
whole journal in the transcript (WVE-101) and prompting (WVE-102) 2026-10-21. The rest is
specified as WVE-103 to WVE-105 land.

Decision: [ADR 0015](../../../docs/adr/0015-bring-alpha-back-as-the-host-client-in-capacitor.md).
Glossary: [`tui/CONTEXT.md`](../../../tui/CONTEXT.md). Host protocol:
[`wve-85-host-protocol.md`](../../../tui/docs/specs/wve-85-host-protocol.md); remote clients:
[`wve-90-remote-clients.md`](../../../tui/docs/specs/wve-90-remote-clients.md).

## Purpose

The app is a remote client of the weave Host for the iPad and iPhone. It lists the sessions on
every paired Host, follows one session's transcript live, prompts and steers its agent, and
answers its pending requests. Sessions run in the Host, so they keep going whatever happens to
the app.

It is Alpha's React app in its Capacitor shell, brought back from commit `e30f6e93`. Alpha was
last terminal-first (WVE-65); the app is chat-first: sessions and their transcripts.

## Structure

### The session list

- **One list across Hosts.** Sessions from every paired Host show in one list. The app keeps a
  connection to each Host. A directory's heading names its Host only when more than one Host
  is paired.
- **Grouped by directory.** Sessions are grouped by the directory they run in, one group per
  Host and directory. Groups are ordered by their latest activity, and sessions in a group most
  recent first.
- **Needs you.** Sessions waiting on the person (activity `waiting`) also show in a "Needs you"
  group at the top, across Hosts and directories.
- **A row** shows the session's title, its agent, its activity (waiting, running or idle), when
  it was last active, and whether it is headless. A session whose turn ended since the person
  last looked at it is marked until they open it; the app keeps that per device.
- **Closed sessions** are hidden. A "Show closed" filter shows them in their directories,
  dimmed. Opening one opens it again in its agent.
- **Filtering.** A field filters the list by title, directory and agent.
- **New sessions.** A directory's heading starts a session in that directory with a chosen
  agent. "New session" asks for the Host (with more than one), the directory (one of the
  directories the Host's sessions use, or typed) and the agent.
- **Hosts.** "Hosts" at the foot of the list opens the paired Hosts, with each one's connection
  state, pairing a Host, and forgetting one. While a Host is unreachable its sessions stay in the
  list, marked as such.

### A session

- **Header:** the title; the agent, directory and, with more than one Host, the Host; the
  activity; how many other clients are attached; and a menu with Close session (the Host stops
  it; opening it later takes it up in its agent again) and Delete session (confirmed; the agent
  and the Host forget it).
- **Transcript:** Alpha's ACP transcript and its views (`src/chat`), fed from the session's
  journal (see [The transcript](#the-transcript)).
- **Subagents** show as rows in their parent's transcript, as the TUI shows them (`• Spawned
  Robie`, `• Completed Robie` with its reply, the messages between them). Tapping a subagent's
  name shows its own transcript in place of the session's, under a bar naming it with a way back
  to Main; a subagent's transcript has no composer.
- **Agent updates.** When a newer version of the session's agent is out
  (`agents/updateAvailable`, or `SessionState.update` on attaching), a notice above the
  transcript names it and the version the session runs. Remote clients can't update agents, so
  while the Host's new sessions of the agent launch the version the session runs (`agents/list`'s
  `version`), the notice says to run `weave update <agent>` on the Host's computer, and offers
  nothing. The Host tells open sessions again once it has updated, and the app reads its agents
  again; when they launch another version, the notice offers Move to that version
  (`session/reopen`), which waits for a running turn.
- **Composer:** one Send button. With no turn running it starts one. While a turn runs it
  steers the turn when the Host lists `turn/steer` and the agent takes steering, and otherwise
  queues the message. Queued messages show above the composer, can be removed, and go in order
  as turns end. A Stop button beside Send cancels the turn. Modes and config options sit in the
  composer's footer, as in Alpha. A draft starting with `/` offers the agent's commands, and
  Attach photos (for an agent that takes images) picks photos from Photos or the camera.

### Layout

- **iPad and wider:** the session list as a sidebar, and one session beside it. The sidebar
  collapses. There are no Panes or docks; a second Pane for views and visuals may come with
  WVE-96 and WVE-95.
- **iPhone:** portrait only, and a navigation stack. The list is the first screen; opening a
  session pushes it, and Back (or a swipe from the left edge) returns to the list.
- Phone or not follows the device (`data-device-idiom`, set by the native shell), not the
  window's width, so a narrow iPad window keeps the sidebar.
- The layout scales to a desktop-sized window, but there is no Electron shell and no desktop
  chrome.

### Requests in other sessions

- A session waiting on the person shows under "Needs you". The iPhone's Back button, and the
  iPad's sidebar button while the sidebar is collapsed, show how many sessions other than the one
  on screen are waiting.
- When a session that isn't on screen starts waiting, a banner names the session and what it
  waits on. Tapping it opens the session.
- Pending requests are answered only inside their session (WVE-103).

### Names

The app uses the glossary's terms. Alpha's Threads are sessions, its Connections are Hosts, and
its execution contexts and Workspaces are directories. Alpha archived threads; the Host closes
and deletes sessions instead.

## The controller seam

The UI reads one `AppController`, a model and actions, as Alpha's `AlphaController` was. Until
WVE-100 a mock controller drives it from fixtures: two Hosts, several directories, sessions in
every activity, and Alpha's ACP showcase transcript. WVE-100 adds the controller backed by the
Host protocol; the mock stays for UI work and tests.

## Connecting to Hosts

### Types

The app's types for the Host protocol, and for the ACP content it carries, come from the Host's
Rust: `crates/protocol` keeps the protocol as one JSON Schema (`tests/schema.rs`), and
`scripts/protocol-types.ts` turns it into `src/host/protocol.ts`, with tables of which method
takes and gives which and the protocol's constants. A test fails when the file is stale. The
ACP types are the ones the Host's pinned crate defines, unstable features included, so the app
uses no ACP SDK.

### The connection

`src/host/connection.ts` speaks JSON-RPC over a transport: the web view's WebSocket, offering
the `weave-host` subprotocol. Requests flow one way. Everything the Host sends reaches one
ordered stream of events, and the answer to an attach comes ahead of the replay that follows it.

- **A paired device** asks `host/challenge`, checks the Host's id, signs
  `weave-host-auth/1 <hostId> <deviceId> <nonce>` with its key, and says hello.
- **Pairing** says hello with the code `weave pair` shows, the device's name and its public key
  as a JWK. The Host answers with the device's id, which the app keeps with the Host's id and
  URL (`src/host/storage.ts`, in the app's preferences). The key stays in the Keychain.
- **The pairing link.** The app registers the `weave` URL scheme, so the Camera opens
  `weave://pair?url=…&code=…` in it; the Hosts dialog then names the Host to confirm. The URL
  and code can be entered by hand too.
- **Origin.** The web view sends `Origin: capacitor://localhost`, which the Host accepts without
  configuration (ADR 0016).
- **Turning it on.** Nothing is configured on the Host's computer: `weave pair` turns remote
  access on, and the Host makes its own Tailscale Serve entry.

### Device keys

`DeviceKeyPlugin.swift` makes one P-256 key per paired Host, in the Secure Enclave where there
is one and otherwise a `ThisDeviceOnly` Keychain key, and gives the public key as a JWK and
signatures as DER, unpadded base64url. In a browser, during development, a WebCrypto key in
memory stands in; it is gone after a reload, and the browser pairs again.

### Following a session

`src/host/host-store.ts` keeps the paired Hosts, one connection each, and their sessions from
`sessions/list`, listed again when the app comes to the front and when the list is pulled down.
Opening a session attaches to it after the last journal position this device handled
(`JournalFollower`), so only what it missed arrives; events up to the journal's head at attach
are history. Journal events become the transcript's events (`transcriptEvents`), described next.

Changes reach the UI once a frame (`HostStoreOptions.schedule`), so a replay of thousands of
events renders a frame at a time rather than once an event.

### The transcript

Every `session/event` kind shows, the same whether it arrives live or replayed
(`src/host/journal.ts`, `src/chat/acp-transcript.ts`):

- `update`: every ACP session update. One for a subagent session (`notification.sessionId`)
  goes to that subagent's own transcript; kinds the app doesn't know change nothing.
- `turnStarted` and `turnSteered`: the prompt as the person's message, marked when it was a
  steer. One from another client or device says where it came from ("From Jaco's iPad", "From
  the TUI", "From a headless run"); this device's own (its connection, or its paired name)
  replaces the message it showed while sending.
- `turnEnded`: nothing for a turn that finished; otherwise why it didn't ("Turn cancelled",
  "Stopped: the agent reached its token limit", "Turn failed" with the error), as the TUI says.
- `terminalOutput` and `terminalExit`: the command's output as text in the tool call that
  embeds its terminal, escape sequences removed and carriage returns applied, and how it
  exited. A transcript keeps a terminal's last 256 KiB.
- `agentReopened`: what the session runs now, worded as the TUI words it; `closed` and `notice`
  as notes.
- Kinds the app doesn't know are skipped; the position still advances.

Replayed history changes no turn state: whether a turn runs comes from `SessionState.turns` on
attaching, then from live events. Images in prompts and messages show as thumbnails that open
whole. Agent text is untrusted: its Markdown renders raw HTML as text, and a link opens only
after a confirmation naming its host and the whole URL, with not opening the default.

Tests read journals recorded from a dev Host with the fake agent
(`scripts/record-journals.ts`, into `src/chat/fixtures/journals/`): each must give the same
transcript live and replayed, and an outline of each is a reviewed snapshot.

### Prompting

`HostStore` speaks for the session on screen (`src/host/host-store.ts`):

- **New sessions** (`session/create`) take a Host, a directory (one its sessions use, or typed)
  and an agent from `agents/list`, and open at once. A session nobody has prompted isn't listed
  by the Host, so the app lists it while it's open; leaving it detaches with `ifUnused`, which
  closes it, as the TUI does.
- **Send** starts a turn (`turn/start`) and shows the prompt at once. While a turn runs it
  steers (`turn/steer`) when the Host lists `turn/steer` and the session's agent advertises
  `_meta.steering.supported`; the steer shows as "Steering" above the composer until the agent
  takes it, and then where it joined the turn. `notRunning` sends it as a prompt instead, and a
  turn another client started meanwhile (`turn_running`) queues it. With an agent that can't
  steer, the message queues, and queued messages go one at a time as turns end, while the
  session is open in the app.
- **Photos** go only to an agent whose `promptCapabilities.image` allows them, scaled to 2048
  pixels on the longest edge and re-encoded as JPEG, up to 12 MiB a message, well under the
  WebSocket's 32 MiB.
- **Stop** is `turn/cancel`; modes and config options are `session/setMode` and
  `session/setConfigOption`, whose changes come back through the journal for every client.
- **Close and Delete** are `session/close` and `session/delete`.
- **Sign-in.** An agent that answers `auth_required` gets "… needs signing in. Run `weave login
  --agent <agent>` on the Host's computer, then try again": remote clients can't sign agents in.

Pending requests (permissions, elicitations, client tools) are WVE-103's; until then the
transcript shows none.

### Connections that end

A connection that drops is tried again after 1, 2, 5, 10 and then every 30 seconds, and the open
session catches up after its position. A device the Host revoked (4000) or refuses is not tried
again: the Hosts dialog says to pair again. WVE-105 does the rest.

## What came back

Kept from Alpha: the ACP transcript and its views (`src/chat`), the AI Elements and shadcn
components, the sidebar, the resume and keyboard hooks, read state, and the native shell with
its Secure Enclave key plugin (`DeviceKeyPlugin.swift`).

Left in history: Portal's client and protocol, terminals and libghostty, Workspaces and their
layouts, the Host Browser, the Client Browser, Electron, the desktop title bar, and Portal's
acceptance harness and UI tests.

## Build

- `app/` is a self-contained Bun project with its own `bun.lock`, not a root workspace.
- Bundle id `com.veezee.weave`, so the Alpha installed on devices (`com.veezee.alpha`) keeps its
  data until it is removed deliberately.
- Xcode builds use Xcode's configured DerivedData location. Scripts never pass
  `-derivedDataPath` or `-resultBundlePath` under `/tmp` or the home directory; an isolated build
  goes under `/Volumes/External/Build/xcodebuild.noindex/<name>` and is removed afterwards.

## Later

- WVE-103: pending requests and client tools.
- Queued messages for a session that isn't open in the app wait until it is opened again; a
  feed of every session's changes (WVE-104) could send them sooner.
- WVE-104: `sessions/watch`, for a live list.
- WVE-105: reconnecting, several Hosts, and acceptance on devices.
- WVE-96: views.
