//! `~/.config/weave/config.toml`, owned by section: the Host reads `default_agent`,
//! `[agents.*]` and `[[mcp_servers]]`, parsed here; clients read `[tui]` and `[daemon]`, which
//! this keeps as tables for them to parse.
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
//! enabled = false            # run agents inside each weave, not the shared Host (`--no-daemon`)
//!
//! [agents.claude]            # adjust a preset…
//! terminal = false           # don't offer it client terminals
//! compaction = false         # no compaction updates (ACP Preview; on by default)
//! subagents = false          # no subagent sessions (ACP draft; on by default)
//! mode = "bypassPermissions" # the mode new sessions start in, by the agent's id or name
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

/// The file's name in the config directory.
const FILE: &str = "config.toml";
/// Its name before the Host owned part of it, still read while it's the only one there.
const OLD_FILE: &str = "tui.toml";

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub default_agent: Option<String>,
    #[serde(default)]
    pub agents: BTreeMap<String, AgentConfig>,
    #[serde(default)]
    pub mcp_servers: Vec<McpServerConfig>,
    /// The TUI's section, for it to parse.
    #[serde(default)]
    pub tui: toml::Table,
    /// The daemon section clients read, for them to parse.
    #[serde(default)]
    pub daemon: toml::Table,
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
    /// The mode new sessions start in, by the agent's id or name for it, such as Codex's
    /// `agent-full-access`, set through ACP once the session is open. It isn't applied to
    /// sessions reopened by load or resume, which are in whatever mode the agent restores, or
    /// to headless `weave run` sessions. Codex's adapter restores no mode, so for those set
    /// its own `INITIAL_AGENT_MODE` in `env` too.
    pub mode: Option<String>,
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

/// The config, and anything worth telling the user about how it was found.
pub struct Loaded {
    pub config: Config,
    /// Set when the file read was `tui.toml`, which should be renamed.
    pub notice: Option<String>,
}

impl Config {
    /// The config directory, honoring `XDG_CONFIG_HOME`.
    pub fn directory() -> Option<PathBuf> {
        let base = std::env::var_os("XDG_CONFIG_HOME")
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))?;
        Some(base.join("weave"))
    }

    /// The file to read in `directory`: `config.toml`, or `tui.toml` while only it exists.
    pub fn file_in(directory: &Path) -> (PathBuf, Option<String>) {
        let path = directory.join(FILE);
        let old = directory.join(OLD_FILE);
        if !path.exists() && old.exists() {
            let notice = format!(
                "Read {}; rename it to {FILE}, which weave reads first",
                old.display()
            );
            return (old, Some(notice));
        }
        (path, None)
    }

    /// Load `path`, or the default location. A missing default file is an empty config.
    pub fn load(path: Option<&Path>) -> anyhow::Result<Loaded> {
        let (path, required, notice) = match path {
            Some(path) => (path.to_owned(), true, None),
            None => match Self::directory() {
                Some(directory) => {
                    let (path, notice) = Self::file_in(&directory);
                    (path, false, notice)
                }
                None => {
                    return Ok(Loaded {
                        config: Self::default(),
                        notice: None,
                    });
                }
            },
        };
        let config = match std::fs::read_to_string(&path) {
            Ok(text) => {
                toml::from_str(&text).with_context(|| format!("reading {}", path.display()))?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && !required => {
                Self::default()
            }
            Err(error) => {
                return Err(error).with_context(|| format!("reading {}", path.display()));
            }
        };
        Ok(Loaded { config, notice })
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

    /// The mode new sessions of the agent named `id` start in, if one is configured.
    pub fn mode(&self, id: &str) -> Option<&str> {
        self.agents.get(id)?.mode.as_deref()
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
            mode = "bypassPermissions"

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
        assert_eq!(config.mode("claude"), Some("bypassPermissions"));
        assert_eq!(config.mode("local"), None);

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
    fn unknown_keys_are_rejected_but_client_sections_are_theirs() {
        assert!(toml::from_str::<Config>("defualt_agent = \"x\"").is_err());
        assert!(toml::from_str::<Config>("[agents.x]\ncomand = \"y\"").is_err());
        let config = parse("[tui]\nalternate_screen = \"never\"\n[daemon]\nenabled = false");
        assert_eq!(
            config
                .tui
                .get("alternate_screen")
                .and_then(toml::Value::as_str),
            Some("never")
        );
    }

    #[test]
    fn the_old_file_is_read_until_the_new_one_exists() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(Config::file_in(dir.path()), (dir.path().join(FILE), None));
        std::fs::write(dir.path().join(OLD_FILE), "default_agent = \"codex\"").expect("old");
        let (path, notice) = Config::file_in(dir.path());
        assert_eq!(path, dir.path().join(OLD_FILE));
        assert!(notice.is_some_and(|notice| notice.contains("rename it to config.toml")));
        std::fs::write(dir.path().join(FILE), "").expect("new");
        assert_eq!(Config::file_in(dir.path()), (dir.path().join(FILE), None));
    }
}
