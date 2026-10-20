# WVE-91: The weave app, a Host client for iPad and iPhone

Status: structure settled 2026-10-20 (WVE-99). The connection to a Host is specified as
WVE-100 to WVE-105 land.

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
  journal (WVE-100, WVE-101).
- **Composer:** one Send button. With no turn running it starts one. While a turn runs it
  steers the turn when the Host lists `turn/steer` and the agent takes steering, and otherwise
  queues the message. Queued messages show above the composer, can be removed, and go in order
  as turns end. A Stop button beside Send cancels the turn. Modes and config options sit in the
  composer's footer, as in Alpha. Photos come with WVE-102.

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

## What came back

Kept from Alpha: the ACP transcript and its views (`src/chat`), the AI Elements and shadcn
components, the sidebar, the resume and keyboard hooks, read state, and the native shell with
its Secure Enclave key plugin (`DeviceKeyPlugin.swift`). The plugin still answers in Portal's
formats, a raw signature and a raw public key; WVE-100 moves it to DER signatures and JWK keys.

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

- WVE-100: pairing, device authentication, the session list from `sessions/list`, and a
  read-only transcript.
- WVE-101: every journal event in the transcript.
- WVE-102: prompting, steering, queueing, new sessions, photos.
- WVE-103: pending requests and client tools.
- WVE-104: `sessions/watch`, for a live list.
- WVE-105: reconnecting, several Hosts, and acceptance on devices.
- WVE-96: views.
