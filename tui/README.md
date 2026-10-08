# weave

A terminal client for [ACP](https://agentclientprotocol.com) agents such as Claude,
Codex and Gemini, built after Codex CLI's TUI. Like Codex it runs fullscreen: the
composer stays at the bottom while the transcript scrolls above it. `--no-alt-screen`
runs inline instead, with finished history in your terminal's own scrollback.

## Run

```bash
cargo build                                      # from tui/
./target/debug/weave --agent claude              # or codex, gemini
./target/debug/weave --agent opencode            # any agent in the ACP registry
./target/debug/weave agents                      # list presets, config and registry agents
./target/debug/weave -- my-agent --acp           # any ACP command
./target/debug/weave --agent claude --resume     # pick a previous session
./target/debug/weave --agent claude --continue   # latest session in this directory
./target/debug/weave login --agent codex         # sign in; `logout` signs out
./target/debug/weave smoke --agent claude        # one headless turn, every event printed
```

`--agent` takes a preset, an agent from the config, or the id of an agent in the
[ACP registry](https://agentclientprotocol.com/get-started/registry), in that order. The
registry is fetched once a day (`weave agents --refresh` fetches it now) and cached under
`~/.cache/weave` (`$XDG_CACHE_HOME/weave`). A registry agent runs from its own build for
this platform when it has one: downloaded on first use, checked against the registry's
sha256 when given, and unpacked into the cache. Otherwise it runs through `npx` or `uvx`,
which must be installed.

Agents sign in with their own CLIs. When an agent reports that sign-in is required,
`weave` offers the agent's sign-in methods and retries.

## Keys

| Key | Does |
| --- | --- |
| Enter / Shift+Enter | Send / new line (messages sent mid-turn are queued) |
| Esc, Ctrl+C | Stop the running turn; Ctrl+C twice when idle quits |
| `/` | Complete the agent's slash commands |
| `@` | Fuzzy-find a file to attach (tab completes; respects .gitignore): embedded, as an image or audio, or as a link, as the agent allows. Quote paths with spaces: `@"my notes.md"` |
| Shift+Tab | Next mode |
| Ctrl+O | Session settings (mode, model, and the agent's other options) |
| Ctrl+R | Switch to another session |
| PageUp / PageDown, wheel | Scroll the transcript (fullscreen) |
| Ctrl+Home / Ctrl+End (or Alt+< / Alt+>) | Jump to the start / back to the newest output |
| Esc while scrolled back | Return to the newest output (before it stops the turn) |
| Drag | Select transcript text; it is copied when you release |
| Ctrl+T | Full transcript: whole command output, diffs, thoughts and compaction summaries (a pager inline) |
| Alt+← / Alt+→ | Watch the previous / next agent's transcript when the agent runs subagents (Alt+B / Alt+F on an empty draft); Esc goes back |
| `/subagents` | Pick a subagent to watch, with what each is doing (once there are any) |
| F3 | Find text in the full transcript: newest match first, ↑/↓ (or Ctrl+P/Ctrl+N) between matches, Enter to keep reading, Esc to close. In the inline pager, `/` then `n`/`N` |
| `?` | Keyboard shortcuts (on an empty composer) |
| Ctrl+G | Switch between the basic and Vim composers, keeping the draft (with `vim = true`) |
| Ctrl+V | Paste an image from the clipboard as `[image N]` (dragging an image file in works too) |
| `!` | Shell mode: run a command in the session directory (shown here, not sent to the agent) |

### Vim composer

With `[tui] vim = true`, longer drafts get a Vim composer: new blank threads open in it,
Shift+Enter in the basic composer moves the draft there, and Ctrl+G switches either way.
Replies start in the basic composer again. It has relative line numbers (the cursor's line
numbered from the top), grows to 12 rows or 40% of the screen and then scrolls, and the
footer shows the mode.

- **Modes:** Normal, Insert (`i a I A o O`, `s S C`), Replace (`R`), Visual (`v`, `V`).
- **Motions:** `h j k l`, `w b e ge` and `W B E`, `0 ^ $`, `gg G`, `f F t T ; ,`, `%`,
  `{ }`, Enter, `+ -`, with counts.
- **Editing:** `d c y` with motions or text objects (`iw aw iW aW`, brackets, quotes),
  `dd cc yy D C Y x X r J ~ p P`, `u` and Ctrl+R, and `.`.
- **Search:** `/` and `?` within the draft, then `n` and `N`.
- **Keys that differ:** Ctrl+Enter sends from any mode (Cmd+Enter too, where the terminal
  reports it), and Enter starts a new line. Esc only changes mode, so it never interrupts the
  agent; Ctrl+C does. In Normal mode, `k` on the first line and `j` on the last step through
  earlier prompts, and `/` on an empty draft starts a slash command.

### Subagents

When an agent delegates to subagents (ACP's draft Subagent Sessions; Claude and Codex both
do), weave shows them as Codex shows its own. The main transcript gets a row as each one is
spawned, sent input, and finished (`• Completed Robie └ <its reply>`), and the status shows
how many are running. Alt+←/→ or `/subagents` switch to a subagent's own transcript; Esc
comes back, Ctrl+C stops one the agent lets you stop, and its permission requests show here,
named. Messages always go to the main session.

Permission requests, agent questions (forms and links) and pickers take over the input
area with their own keys: approvals take `y` (allow), `a` (always), `esc` (reject) or a
number. Links open in your browser only after you choose to.

The transcript looks like Codex's: commands as `• Ran cmd` with their first lines of
output, reads and searches grouped as `• Explored`, edits as numbered, tinted diffs, and
code highlighted with Catppuccin themes. Colors adapt to your terminal's background, which
weave asks the terminal for at startup.

Fullscreen leaves your screen as it was when you quit, then prints how to reopen the
session (`weave … --resume <id>`). Selections are copied with `pbcopy` on a local Mac,
otherwise through the terminal (OSC 52, also over SSH and in tmux with passthrough on).
Your terminal's own selection still works with its mouse-reporting override, usually
Shift-drag (Option-drag in iTerm2).

## Configure

`~/.config/weave/tui.toml` (or `--config`) defines agents, which client services each may
use, and MCP servers passed to every session:

```toml
default_agent = "claude"

[tui]
alternate_screen = "never"  # always run inline; "auto" (default) and "always" run fullscreen
# Footer status line: model, agent, mode, directory, session, context (% used), and cost
# (at the right; Claude's adapter reports an API-price estimate even under a subscription).
# [] shows "? for shortcuts".
status_line = ["agent", "model", "context", "session", "cost"]  # the default; "mode" and "directory" are off
notifications = true   # desktop notification when a turn ends or needs you, while unfocused
terminal_title = true  # window title: activity spinner, session title, project
vim = true             # the Vim composer for new threads and multi-line drafts (off by default)

[agents.claude]
terminal = false          # don't let it run commands through weave
compaction = false        # no compaction updates (an ACP Preview feature; on by default)
subagents = false         # no subagent sessions (an ACP draft feature; on by default)

[agents.opencode]         # a registry agent, with settings of its own
terminal = false

[agents.local]
command = "/usr/local/bin/my-agent"
args = ["--acp"]

[[mcp_servers]]
name = "files"
command = "mcp-server-filesystem"
args = ["/tmp"]

[[mcp_servers]]
name = "docs"
url = "https://mcp.example.com"
```

Other flags: `--no-alt-screen` (inline for this run), `--cwd`, `--add-dir`, `--no-fs`, `--no-terminal`, `--trace FILE` (ACP SDK
trace-viewer format) and `--log-file FILE` (diagnostics and agent stderr).
