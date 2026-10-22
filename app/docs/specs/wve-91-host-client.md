# WVE-91: The weave app, a Host client for iPad and iPhone

Status: structure settled 2026-10-20 (WVE-99); connecting to Hosts 2026-10-20 (WVE-100); the
whole journal in the transcript (WVE-101), prompting (WVE-102), pending requests and client
tools (WVE-103), the live session list (WVE-104), and browsing for a session's directory
(WVE-112) 2026-10-21; reconnecting and several Hosts (WVE-105) 2026-10-22.

Decision: [ADR 0015](../../../docs/adr/0015-bring-alpha-back-as-the-host-client-in-capacitor.md).
Glossary: [`CONTEXT.md`](../../../CONTEXT.md). Host protocol:
[`wve-85-host-protocol.md`](../../../docs/specs/wve-85-host-protocol.md); remote clients:
[`wve-90-remote-clients.md`](../../../docs/specs/wve-90-remote-clients.md).

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
  directories the Host's sessions use, typed, or picked by browsing the Host's computer) and
  the agent.
- **Hosts.** "Hosts" at the foot of the list opens the paired Hosts, with each one's connection
  state, pairing a Host, and forgetting one, which deletes its key. Hosts are told apart by
  `host.id`, and each has its own connection and device id. While a Host is unreachable its
  sessions stay in the list, marked as such. A revoked one offers Pair again (see
  [Connections that end](#connections-that-end)).

### A session

- **Header:** the title; the agent, directory and, with more than one Host, the Host; the
  activity; and how many other clients are attached. Its menu has:
  - Rename session, for an open session on a Host that lists `session/rename`. The new title
    shows on every client, and the agent's own later titles don't replace it.
  - Close session: the Host stops it, and opening it later takes it up in its agent again.
  - Delete session, confirmed: the agent and the Host forget it.
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
- When a session that isn't on screen starts waiting, a banner names the session. The Host's
  list doesn't say what a session waits on, so the banner says its agent is waiting. Tapping it
  opens the session.
- Pending requests are answered only inside their session (see [Pending requests](#pending-requests)).

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
Rust: `protocol/` keeps the protocol as one JSON Schema (`tests/schema.rs`), and
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

`src/host/host-store.ts` keeps the paired Hosts, one connection each, and their sessions. A Host
that lists the `sessions/watch` feature keeps the list live: `sessions/watch` gives the sessions,
then `sessions/updated` and `sessions/removed` say what changed, in sessions the app isn't
attached to too, so "Needs you", the waiting count and the banner follow sessions another client
drives. A watched session closed keeps the title the app last had for it, since the Host lists a
closed session without one. A Host without the feature is listed once with `sessions/list`.
Either way the list is asked for again when the app comes to the front and when it's pulled down.
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
- `renamed`: the new title, and a note saying who renamed it: "You", "The TUI", "Jaco's iPhone",
  or "The agent" for the agent's own `rename_session` Host tool.
- Kinds the app doesn't know are skipped; the position still advances.

Replayed history changes no turn state: whether a turn runs comes from `SessionState.turns` on
attaching, then from live events. Images in prompts and messages show as thumbnails that open
whole. Agent text is untrusted: its Markdown renders raw HTML as text, and a link opens only
after a confirmation naming its host and the whole URL, with not opening the default. Tables read
as part of the text, as the TUI draws them, with no frame or buttons.

How the work shows (`src/chat/transcript-runs.ts`):

- **Tool calls** start closed, whatever their status, and open when tapped. The agent's raw input
  and output aren't shown.
- **Runs of work.** Two or more tool calls in a row, with the thinking between them, fold into
  one closed row: "Worked for 2m 17s · 9 commands, 2 edits", and "1 failed" when one did.
  Anything else the agent says ends a run. A tool call waiting on the person shows below the row
  while it's closed.
- **While a turn runs,** its latest run is its activity, however short: "Working", how long so
  far, and the step it's on. So is a prompt the agent hasn't answered yet.
- **Times** come from the journal: each entry keeps when the events that made it and last changed
  it happened. A run starts with the prompt or message before it, and ends with its last update.
- **Every entry is laid out,** on screen or not, so nothing above changes height as the person
  scrolls back; iOS would move what's on screen with it.

Tests read journals recorded from a dev Host with the fake agent
(`scripts/record-journals.ts`, into `src/chat/fixtures/journals/`): each must give the same
transcript live and replayed, and an outline of each is a reviewed snapshot.

### Prompting

`HostStore` speaks for the session on screen (`src/host/host-store.ts`):

- **New sessions** (`session/create`) take a Host, a directory (one its sessions use, typed, or
  browsed for) and an agent from `agents/list`, and open at once. Browse…, for a Host that lists
  `files/list` (WVE-112), opens a folder picker in the dialog. It starts at the directory chosen
  so far, or at home when that can't be listed, and shows paths under home as `~/…`. You can go
  into a directory, up, or home, with hidden directories on request. "Use this directory" fills in
  the dialog. A session nobody has prompted isn't listed
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
- **Rename, Close and Delete** are `session/rename` (WVE-114), `session/close` and
  `session/delete`.
- **Sign-in.** An agent that answers `auth_required` gets "… needs signing in. Run `weave login
  --agent <agent>` on the Host's computer, then try again": remote clients can't sign agents in.

### Pending requests

What an agent waits on comes from `SessionState.pending` on attaching and `pending/added` after,
and stops waiting with `pending/resolved` (`src/host/host-store.ts`). Requests aren't journaled,
so one shows once the attach's replay is in, after the history before it; one shown before that
no longer waits on attaching says "No longer waiting".

- **Permissions** show on their tool call, with the agent's options as buttons
  (`pending/answer {permission}`).
- **Form elicitations** render from their requested schema, with Submit, Decline and Cancel;
  once answered the form stays, read-only.
- **URL elicitations** follow the rule the TUI does: the card shows the whole URL and its host,
  and warns of a page that isn't encrypted, a Punycode or bare IP host, or credentials in the
  URL. Nothing opens until the person taps Open in browser, which hands the URL to iOS (the app
  never fetches it) and accepts; only `http` and `https` URLs open. Decline and Cancel answer
  without opening. `session/elicitationCompleted` marks an accepted one finished.
- **A subagent's request** shows in the subagent's own transcript. While another transcript is
  on screen, a notice above it says "Robie is waiting for you" (or Main), with Show.
- **Answering** shows the answer at once. Each card then says how its request ended, as the
  Host says: "You chose Allow", "Answered on another client", "The agent withdrew its request",
  or "The turn ended before it was answered". An answer that fails with `already_resolved` isn't
  tried again; any other failure shows the request again with the error.
- **Client tools.** The app lists `clipboard_write` in `capabilities.clientTools` and runs calls
  aimed at its connection: the text goes on the device's clipboard through Capacitor's Clipboard
  plugin, which needs no tap first, and the agent gets "Copied to the clipboard.", as from the TUI.
  The agent's own tool call shows the call. One aimed at another client shows as "Waiting for the
  TUI to run clipboard_write", with nothing to answer, until that client has.

### Connections that end

Sessions keep going in the Host whatever happens to the app (WVE-105). Each paired Host has its
own connection, and every connection proves the device again and then attaches after the last
position of the session on screen, so only what the app missed arrives, once and in order.

- **Dropped.** A connection that closes is tried again after 1, 2, 5, 10 and then every 30
  seconds. A try that hasn't connected and said hello within 15 seconds counts as failed; one
  still under way when another starts is abandoned.
- **To the front, or another network.** When the app comes to the front (`appStateChange`), when
  the network comes back or changes, as from Wi-Fi to cellular (Capacitor's Network plugin), and
  when the list is pulled down, each connection lists its sessions again. One that doesn't answer
  within 5 seconds is taken for dead, as over a network that's gone, and replaced. A Host waiting
  to be tried again is tried at once.
- **A restarted Host** keeps a session's journal: it resumes the session when the app attaches,
  with the turn the restart interrupted ended as cancelled, and the app catches up after its
  position.
- **Close codes.** 4000, revoked: the app deletes the Host's key and pairing, and lists the Host
  as revoked, with Pair again, until the person pairs again or removes it. 4001, fell behind: it
  reconnects at once and catches up. 4002, hello failed: it shows the Host's error and doesn't try
  again until the person asks. A close during hello with any other code is the network's, and is
  tried again.
- **Protocol versions.** A Host that answers `incompatible_protocol` is listed as incompatible,
  with its range and what to change: a newer Host needs a newer app ("This Host needs a newer
  version of the app: it speaks protocol versions 3 to 4; this app speaks version 2"), and an
  older one an older app or a newer weave on its computer. It isn't tried again until the person
  asks.
- **While away.** A session whose Host isn't connected says so under its header ("Reconnecting to
  mac…", or why it stopped trying), and its rows in the list say the Host is unreachable.
- **Drafts** are kept per session in the web view's storage as they're typed, so they survive
  reconnecting, and iOS discarding the web view in the background. Photos attached to a draft
  don't.

Alerts while the app is closed need APNs from the Host, and get their own ADR and issue.

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

- Queued messages for a session that isn't open in the app wait until it is opened again; the
  Host's queue (WVE-107) would send them as turns end.
- WVE-96: views.
