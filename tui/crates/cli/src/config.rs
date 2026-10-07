//! `~/.config/weave/tui.toml`: agent definitions and MCP servers.
//!
//! ```toml
//! default_agent = "claude"
//!
//! [agents.claude]            # adjust a preset…
//! terminal = false           # don't offer it client terminals
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
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentConfig {
    /// Required unless the name is a preset.
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Offer fs/read_text_file and fs/write_text_file (default true).
    pub fs: Option<bool>,
    /// Offer client terminals (default true).
    pub terminal: Option<bool>,
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

    /// The launch command and client options for the agent named `id`.
    pub fn agent(&self, id: &str) -> anyhow::Result<(AgentSpec, ClientOptions)> {
        let configured = self.agents.get(id);
        let mut spec = match (
            configured.and_then(|agent| agent.command.as_ref()),
            AgentSpec::preset(id),
        ) {
            (Some(command), _) => AgentSpec::new(
                command,
                configured
                    .map(|agent| agent.args.clone())
                    .unwrap_or_default(),
            ),
            (None, Some(preset)) => preset,
            (None, None) => {
                let known = weave_acp_core::preset_ids()
                    .map(str::to_owned)
                    .chain(self.agents.keys().cloned())
                    .collect::<Vec<_>>()
                    .join(", ");
                bail!("unknown agent {id:?}; expected one of {known}, or a command after `--`");
            }
        };
        let mut options = ClientOptions::default();
        if let Some(agent) = configured {
            spec.env.extend(agent.env.clone());
            options.read_files = agent.fs.unwrap_or(true);
            options.write_files = agent.fs.unwrap_or(true);
            options.terminals = agent.terminal.unwrap_or(true);
        }
        Ok((spec, options))
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
        let (claude, options) = config.agent("claude").expect("preset");
        assert_eq!(claude.command, "npx");
        assert_eq!(claude.env.get("DEBUG").map(String::as_str), Some("1"));
        assert!(!options.terminals && options.read_files);

        let (local, _) = config.agent("local").expect("custom");
        assert_eq!(
            (local.command.as_str(), local.args.as_slice()),
            ("my-agent", &["--acp".to_owned()][..])
        );
        assert!(config.agent("missing").is_err());
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
    }
}
