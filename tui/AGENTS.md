# tui

The interactive terminal client (`weave-tui`): fullscreen transcript or inline viewport, chat
state, composer. The `weave` binary in `../cli` runs it. Read the root `AGENTS.md` first.

The TUI shows one session at a time. Like Codex, it runs fullscreen by default: on the
alternate screen, `weave` owns the transcript (`transcript.rs`: retained cells that
reflow, scrolling, selection and copy, and Find, matched by `find.rs`). Inline mode
(`--no-alt-screen`, `[tui] alternate_screen = "never"`) keeps Codex's inline viewport,
with finished history in native terminal scrollback. Both modes must keep working.

In `tui`, rendering follows Codex's look: `tool_call` maps ACP tool kinds onto
Codex's cells (exec, explored, patch, MCP), `history_cell`, `markdown` and `streaming` the
rest, each with a compact and a detailed (Ctrl+T) form; `markdown` draws Mermaid fences as text
diagrams through `mermaid` (Codex's `codex-mermaid` crate, a bounded subset of five families) and
TeX math as Unicode through `math` (Codex's pre-pass, which finds `$`, `\(`, `$$` and `\[`
before CommonMark takes their backslashes), each falling back to its source and turned off by
`[tui] mermaid` and `math`; their rows copy as their source (`LineSource::drawn`), and in inline
mode `commit_boundary` holds a table, a Mermaid or math fence and an open display equation out of
scrollback until it is complete; `palette` probes the terminal's
colors (OSC 10/11) and `style` derives surfaces from them; `highlight` wraps syntect and
two-face; `footer` and `status` are the bottom pane; `composer` is the input, with `vim`
(after Codex's composer Vim mode) editing the same text in the opt-in Vim composer, and
`thumbnails` the draft's pasted images above it and, in the fullscreen transcript, each
message's under its text, drawn through `graphics` (the Kitty graphics protocol's Unicode
placeholders: each image is sent once, and its cells are text, so they diff, move and reflow
like any other; the startup probe asks only Ghostty and kitty, outside tmux and Zellij,
whether they draw them). An image's `Slot` (its id and thumbnail) is shared by the draft and
the transcript, so a sent image is neither decoded nor sent again; images from the journal
are decoded one at a time off the UI thread, and the transcript holds the newest 64;
during a turn Enter steers it when the Host and the agent can (`ChatWidget::can_steer`; not the
agent's slash commands) and queues otherwise, and Tab always queues, as in Codex; a Host that
lists `queue` holds the queue (WVE-107): queued messages go to `queue/add`, the queue shown is
the Host's, every client's prompts in it (`set_queue`, then `queued`/`unqueued` events, with the
state covering a replay), the Host starts them, and Esc takes this client's own back with
`queue/remove`, leaving the rest paused, which `/queue` resumes; messages sent while a session
opens are kept here and go to the Host once it's open (`send_kept_messages`);
`/new`, `/reload`, `/rename`, `/subagents` and `/update` are the TUI's own slash commands,
offered with the agent's and handled locally (`/reload` ends the TUI and the CLI execs its own
binary again with `--resume`; `/rename <title>`, offered when the Host lists `session/rename`,
sends that in place of the agent's own `/rename`, and the `renamed` event titles the session;
`/update`, in `updates.rs`, runs `agents/update` and then `session/reopen`, or opens a new
session in place of a blank one,
and `/update dismiss` hides a version's notice, kept in `$XDG_STATE_HOME/weave/updates.json`). The app follows the active session's journal position (`app.rs`): an attach's
answer arrives in order ahead of its replay, events up to the journal head it gave are
replayed history (no notifications, no turn state), and the TUI's own prompts are known by
their turn origin's `clientId`. When the Host goes away, the app reconnects through the
CLI's `Reconnector` (which never starts a Host) and attaches again after its position, so
only what it missed arrives, and `/reload`s itself if the new Host speaks another protocol
version; `subagents` shows ACP subagents as Codex shows its own, each child session in a chat of its
own that the parent routes updates to. `ChatWidget` stays free of I/O: it turns
Host events (`events.rs`), keys and mouse input into transcript cells and `AppCommand`s
(answers to pending requests included), so it is tested without a terminal, in both screen
modes. Terminal mechanics (`custom_terminal`, `insert_history`) are tested on a vt100
backend. Untrusted agent text reaches the terminal only after control characters are
stripped.

For live TUI checks inside cmux, split a pane
(`cmux new-split right`), drive it with `cmux send`/`cmux send-key`, and read it with
`cmux read-screen --scrollback`. `cmux send` splits escape sequences, so simulate mouse
input under a private tmux server instead (`tmux -L <name> send-keys -H <bytes>`), with
`SSH_CONNECTION` set so copying goes to OSC 52 rather than your clipboard.
