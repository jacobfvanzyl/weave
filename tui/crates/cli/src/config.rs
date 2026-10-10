//! `~/.config/weave/tui.toml`: agent definitions, MCP servers and display settings.
//!
//! ```toml
//! default_agent = "claude"
//!
//! [tui]
//! alternate_screen = "never" # inline mode: history in the terminal's own scrollback
//! status_line = ["agent", "model", "mode", "context", "session", "cost"] # the default; [] for "? for shortcuts"
//! notifications = false        # no desktop notifications when a turn ends or needs you
//! terminal_title = false       # leave the window title alone
//! vim = true                   # a Vim composer for new threads and multi-line drafts
//!
//! [daemon]
//! enabled = false            # run agents inside each weave, not the shared daemon (`--no-daemon`)
//!
//! [agents.claude]            # adjust a preset…
//! terminal = false           # don't offer it client terminals
//! compaction = false         # no compaction updates (ACP Preview; on by default)
//! subagents = false          # no subagent sessions (ACP draft; on by default)
//!
//! [agents.opencode]         # …or a registry agent (`weave agents` lists them)…
//! terminal = false
//!
//! [agents.local]             # …or define an agent
//! command = "/usr/local/bin/my-agent"
//! args = ["--acp"]
//! env = { LOG = "debug" }
//!
//! [[mcp_servers]]            # stdio
//! name = "files"
//! command = "mcp-server-filesystem"
//! args = ["/tmp"]
//!
//! [[mcp_servers]]            # http or sse
//! name = "docs"
//! url = "https://mcp.example.com"
//! transport = "http"
//! headers = { Authorization = "Bearer …" }
//! ```

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;

use anyhow::Context;
use anyhow::bail;
use serde::Deserialize;
use weave_acp_core::AgentSpec;
use weave_acp_core::ClientOptions;
use weave_acp_core::schema::EnvVariable;
use weave_acp_core::schema::HttpHeader;
use weave_acp_core::schema::McpCapabilities;
use weave_acp_core::schema::McpServer;
use weave_acp_core::schema::McpServerHttp;
use weave_acp_core::schema::McpServerSse;
use weave_acp_core::schema::McpServerStdio;

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub default_agent: Option<String>,
    #[serde(default)]
    pub agents: BTreeMap<String, AgentConfig>,
    #[serde(default)]
    pub mcp_servers: Vec<McpServerConfig>,
    #[serde(default)]
    pub tui: TuiConfig,
    #[serde(default)]
    pub daemon: DaemonSettings,
}

/// The per-user daemon that runs agents (`weave daemon`).
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DaemonSettings {
    /// Run agents in the daemon, so sessions outlive the TUI (default true). Without it each
    /// `weave` runs its own, as `--no-daemon` does.
    pub enabled: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TuiConfig {
    #[serde(default)]
    pub alternate_screen: AlternateScreen,
    /// Footer status line items, as Codex's `tui.status_line`: model, agent, mode,
    /// directory, session, context (the percentage used), and cost (at the right). Defaults
    /// to agent, model, mode, context, session and cost.
    pub status_line: Option<Vec<String>>,
    /// Desktop notifications when a turn ends or the agent needs you (default true).
    pub notifications: Option<bool>,
    /// Keep the window title on the session and activity (default true).
    pub terminal_title: Option<bool>,
    /// The Vim composer, with relative line numbers, for new blank threads and multi-line
    /// drafts; Ctrl+G switches to and from it (default false).
    pub vim: Option<bool>,
}

/// Whether to run fullscreen on the alternate screen, as Codex's `tui.alternate_screen`.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AlternateScreen {
    /// Fullscreen; reserved for exceptions where it works badly, as Codex makes for
    /// Terminal.app over SSH.
    #[default]
    Auto,
    Always,
    /// Inline: a viewport below the prompt, with history in the terminal's scrollback.
    Never,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentConfig {
    /// Required unless the name is a preset or an ACP registry agent.
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Offer fs/read_text_file and fs/write_text_file (default true).
    pub fs: Option<bool>,
    /// Offer client terminals (default true).
    pub terminal: Option<bool>,
    /// Ask for context compaction updates, an ACP Preview feature (default true).
    pub compaction: Option<bool>,
    /// Ask for subagent sessions, from ACP's draft Subagent Sessions RFD (default true).
    pub subagents: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpServerConfig {
    pub name: String,
    /// A stdio server's executable; resolved through PATH when not absolute.
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// An HTTP or SSE server's endpoint.
    pub url: Option<String>,
    /// `http` (default for URLs) or `sse`.
    pub transport: Option<String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
}

impl Config {
    /// The default location, honoring `XDG_CONFIG_HOME`.
    pub fn default_path() -> Option<PathBuf> {
        let base = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))?;
        Some(base.join("weave").join("tui.toml"))
    }

    /// Load `path`, or the default location. A missing default file is an empty config.
    pub fn load(path: Option<&Path>) -> anyhow::Result<Self> {
        let (path, required) = match path {
            Some(path) => (path.to_owned(), true),
            None => match Self::default_path() {
                Some(path) => (path, false),
                None => return Ok(Self::default()),
            },
        };
        match std::fs::read_to_string(&path) {
            Ok(text) => {
                toml::from_str(&text).with_context(|| format!("reading {}", path.display()))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && !required => {
                Ok(Self::default())
            }
            Err(error) => Err(error).with_context(|| format!("reading {}", path.display())),
        }
    }

    /// How to launch the agent named `id` when the config or a preset defines it. Registry
    /// agents are the caller's to resolve.
    pub fn local_agent(&self, id: &str) -> Option<AgentSpec> {
        let configured = self.agents.get(id);
        match configured.and_then(|agent| agent.command.as_ref()) {
            Some(command) => Some(AgentSpec::new(
                command,
                configured
                    .map(|agent| agent.args.clone())
                    .unwrap_or_default(),
            )),
            None => AgentSpec::preset(id),
        }
    }

    /// The config's settings for the agent named `id` applied to `spec`, however it was
    /// found, with the client options they choose.
    pub fn configure(&self, id: &str, mut spec: AgentSpec) -> (AgentSpec, ClientOptions) {
        let mut options = ClientOptions::default();
        if let Some(agent) = self.agents.get(id) {
            spec.env.extend(agent.env.clone());
            options.read_files = agent.fs.unwrap_or(true);
            options.write_files = agent.fs.unwrap_or(true);
            options.terminals = agent.terminal.unwrap_or(true);
            options.compaction = agent.compaction.unwrap_or(true);
            options.subagents = agent.subagents.unwrap_or(true);
        }
        (spec, options)
    }

    /// The agent names the config and presets know, for error messages.
    pub fn known_agents(&self) -> Vec<String> {
        weave_acp_core::preset_ids()
            .map(str::to_owned)
            .chain(
                self.agents
                    .iter()
                    .filter(|(_, agent)| agent.command.is_some())
                    .map(|(id, _)| id.clone()),
            )
            .collect()
    }

    /// The configured MCP servers this agent can accept, plus a warning for each it can't.
    pub fn mcp_servers(&self, capabilities: &McpCapabilities) -> (Vec<McpServer>, Vec<String>) {
        let mut servers = Vec::new();
        let mut warnings = Vec::new();
        for server in &self.mcp_servers {
            match server.to_protocol(capabilities) {
                Ok(server) => servers.push(server),
                Err(error) => warnings.push(format!("MCP server {} skipped: {error}", server.name)),
            }
        }
        (servers, warnings)
    }
}

impl McpServerConfig {
    fn to_protocol(&self, capabilities: &McpCapabilities) -> anyhow::Result<McpServer> {
        match (&self.command, &self.url) {
            (Some(command), None) => {
                // The protocol requires an absolute executable path.
                let command = resolve_executable(command)
                    .with_context(|| format!("{command} not found on PATH"))?;
                let env = self
                    .env
                    .iter()
                    .map(|(name, value)| EnvVariable::new(name, value))
                    .collect();
                Ok(McpServer::Stdio(
                    McpServerStdio::new(&self.name, command)
                        .args(self.args.clone())
                        .env(env),
                ))
            }
            (None, Some(url)) => {
                let headers = self
                    .headers
                    .iter()
                    .map(|(name, value)| HttpHeader::new(name, value))
                    .collect();
                match self.transport.as_deref().unwrap_or("http") {
                    "http" if capabilities.http => Ok(McpServer::Http(
                        McpServerHttp::new(&self.name, url).headers(headers),
                    )),
                    "sse" if capabilities.sse => Ok(McpServer::Sse(
                        McpServerSse::new(&self.name, url).headers(headers),
                    )),
                    "http" | "sse" => bail!(
                        "the agent does not support the {} transport",
                        self.transport.as_deref().unwrap_or("http")
                    ),
                    other => bail!("unknown transport {other:?}"),
                }
            }
            _ => bail!("give exactly one of `command` (stdio) or `url` (http/sse)"),
        }
    }
}

fn resolve_executable(command: &str) -> Option<PathBuf> {
    let path = Path::new(command);
    if path.is_absolute() {
        return path.is_file().then(|| path.to_owned());
    }
    if command.contains(std::path::MAIN_SEPARATOR) {
        return std::fs::canonicalize(path).ok();
    }
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(command))
        .find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn parse(text: &str) -> Config {
        toml::from_str(text).expect("valid config")
    }

    #[test]
    fn presets_take_overrides_and_custom_agents_need_a_command() {
        let config = parse(
            r#"
            [agents.claude]
            terminal = false
            env = { DEBUG = "1" }

            [agents.local]
            command = "my-agent"
            args = ["--acp"]
            "#,
        );
        let claude = config.local_agent("claude").expect("preset");
        let (claude, options) = config.configure("claude", claude);
        assert_eq!(claude.command, "npx");
        assert_eq!(claude.env.get("DEBUG").map(String::as_str), Some("1"));
        assert!(!options.terminals && options.read_files);

        let local = config.local_agent("local").expect("custom");
        assert_eq!(
            (local.command.as_str(), local.args.as_slice()),
            ("my-agent", &["--acp".to_owned()][..])
        );
        assert_eq!(config.local_agent("missing"), None);
        assert_eq!(
            config.known_agents(),
            ["claude", "codex", "gemini", "local"]
        );
    }

    #[test]
    fn mcp_servers_are_filtered_by_what_the_agent_supports() {
        let config = parse(
            r#"
            [[mcp_servers]]
            name = "shell"
            command = "sh"

            [[mcp_servers]]
            name = "docs"
            url = "https://mcp.example.com"

            [[mcp_servers]]
            name = "legacy"
            url = "https://sse.example.com"
            transport = "sse"
            "#,
        );
        let (servers, warnings) = config.mcp_servers(&McpCapabilities::new().http(true));
        assert_eq!(servers.len(), 2);
        assert!(matches!(&servers[0], McpServer::Stdio(server) if server.command.is_absolute()));
        assert_eq!(
            warnings,
            ["MCP server legacy skipped: the agent does not support the sse transport"]
        );
    }

    #[test]
    fn unknown_keys_are_rejected() {
        assert!(toml::from_str::<Config>("defualt_agent = \"x\"").is_err());
        assert!(toml::from_str::<Config>("[tui]\nalternate_screen = \"sometimes\"").is_err());
    }
}
