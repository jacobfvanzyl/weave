# weave

A terminal client for [ACP](https://agentclientprotocol.com) agents such as Claude,
Codex and Gemini, built after Codex CLI's TUI: live content in an inline viewport,
finished history in your terminal's own scrollback.

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

Permission requests, agent questions (forms and links) and pickers take over the input
area with their own keys. Links open in your browser only after you choose to.

## Configure

`~/.config/weave/tui.toml` (or `--config`) defines agents, which client services each may
use, and MCP servers passed to every session:

```toml
default_agent = "claude"

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

Other flags: `--cwd`, `--add-dir`, `--no-fs`, `--no-terminal`, `--trace FILE` (ACP SDK
trace-viewer format) and `--log-file FILE` (diagnostics and agent stderr).
