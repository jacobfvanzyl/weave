---
status: accepted
date: 2026-11-01
---

# A Host opens the app's threads in the Rex on its computer, through a client of its own

At the desk the person works in Rex, where a TUI is a pane and its multiplexer is the management (ADR 0018). A thread started or resumed from the iPad or the iPhone wasn't there: to carry it on at the desk they found it with `weave --resume` in a tab of their own. Now a Host that opts in (`[rex] open_threads = true`) gives each thread opened or resumed from a paired device a tab in the Rex on its own computer, running the TUI on that thread, so the thread is in Rex's sidebar, with its status (OSC 7501), when the person sits down (WVE-167).

`weave daemon` runs a client of the Host beside it, in-process, that watches every thread (`sessions/watch`) and drives the `rex` CLI. The Host and its protocol know nothing of Rex. They gain two generic fields, which a multiplexer isn't needed to read: a listing's `openedBy` and `openedAt`, for who opened a thread last, and the `closed` event's `by`, for the client that closed it for everyone.

Only the Rex server on the Host's own computer, reached by its local socket and never started, gets tabs, because a TUI attaches only to its own computer's Host (ADR 0024 keeps peer Hosts to what the Host tools need). A thread on another computer reaches the desk when that computer's Host fills its own Rex, which the person's Rex app reaches through Rex's own hosts. With no Rex server running, nothing opens.

A thread's tab goes in the Rex session named for its repository, as the person's sessions already are, made if missing, and is labelled with the thread's title and renamed with it. Nothing takes focus or switches a Rex app to the session. A tab opens once per opening: openings already there when the client starts are left alone, a tab the person closed stays closed until a device opens the thread again, and one still in Rex isn't doubled. The client keeps which tab shows which thread beside the Host's journals and checks it against Rex.

Closing a thread from the app now quits every TUI attached to it, wherever it runs: the `closed` event names another client. A TUI quitting so hides the terminal panes it placed, their terminals still running, and closes its own pane when nothing else is in its tab, which closes the tab. A thread whose agent exited, or whose worktree went, leaves its TUI showing why, as before.

## Considered options

- **The Host drives Rex itself.** It knows its threads already, but Rex's CLI would be the Host's dependency, and ADR 0018 keeps everything for one multiplexer behind detecting it in clients.
- **A service of its own beside the Host**, started by launchd or systemd. It does what the in-process client does with another unit to install and keep in step with the Host, which restarts with every update.
- **Rex's own scripting**, a Lua script or a Rex action that asks the Host for threads. Rex's Lua runs in each Rex app as a client of Rex, not beside the Host, and would need a Host connection of its own.
- **Tabs for every open thread**, the TUI's and agents' included. A person at the desk has opened their own already, and agents' threads would fill Rex with tabs nobody asked for.
- **A session per worktree**, as worktrunk's tmux sessions are. The app's sidebar groups threads by repository (WVE-162), and the person's Rex sessions are one per project.

## Consequences

- The client runs beside the Host without counting as a connected client, so a Host started on demand still goes once it's idle. A Host with paired devices, the only one whose threads a device opens, stays up for them anyway.
- `[rex]` is the CLI's section of the config, which the Host's own parser keeps for it.
- A TUI on a Rex pane is a client of its thread like any other: the app's "Other clients attached" counts it, and closing the thread from the app quits it.
- WVE-110's OSC 7501 does the rest: the thread's status, waiting on the person included, shows in Rex's sidebar as the app's "Needs you" list shows it.
