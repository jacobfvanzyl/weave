# weave

A terminal client for [ACP](https://agentclientprotocol.com) agents such as Claude,
Codex and Gemini, built after Codex CLI's TUI. Like Codex it runs fullscreen: the
composer stays at the bottom while the transcript scrolls above it. `--no-alt-screen`
runs inline instead, with finished history in your terminal's own scrollback.

## Run

```bash
cargo build                                      # from tui/
./target/debug/weave --agent claude              # or codex, gemini
./target/debug/weave -- my-agent --acp           # any ACP command
./target/debug/weave --agent claude --resume     # pick a previous session
./target/debug/weave --agent claude --continue   # latest session in this directory
./target/debug/weave login --agent codex         # sign in; `logout` signs out
./target/debug/weave smoke --agent claude        # one headless turn, every event printed
```

Agents sign in with their own CLIs. When an agent reports that sign-in is required,
`weave` offers the agent's sign-in methods and retries.

## Keys

| Key | Does |
| --- | --- |
| Enter / Shift+Enter | Send / new line (messages sent mid-turn are queued) |
| Esc, Ctrl+C | Stop the running turn; Ctrl+C twice when idle quits |
| `/` | Complete the agent's slash commands |
| `@path` | Attach a file: embedded, as an image or audio, or as a link, as the agent allows |
| Shift+Tab | Next mode |
| Ctrl+O | Session settings (mode, model, and the agent's other options) |
| Ctrl+R | Switch to another session |
| PageUp / PageDown, wheel | Scroll the transcript (fullscreen) |
| Ctrl+Home / Ctrl+End (or Alt+< / Alt+>) | Jump to the start / back to the newest output |
| Esc while scrolled back | Return to the newest output (before it stops the turn) |
| Drag | Select transcript text; it is copied when you release |
| Ctrl+T | Full transcript: whole command output, diffs and thoughts (a pager inline) |
| `?` | Keyboard shortcuts (on an empty composer) |

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
# Footer status line: model, agent, mode, directory, session, context. [] shows "? for shortcuts".
status_line = ["model", "session"]  # the default; "mode" and "directory" are off

[agents.claude]
terminal = false          # don't let it run commands through weave

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
