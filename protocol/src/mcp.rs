//! The MCP servers a session's agent was given, and how each one is (WVE-160): the Host MCP
//! server, `weave`, and the servers the Host's config names (`[[mcp_servers]]`). The Host keeps
//! them with the session, so every attached client sees the same: in
//! [`crate::sessions::SessionState::mcp_servers`] when it attaches, and in `session/changed`
//! whenever they change. Servers from the agent's own configuration are the agent's alone, and
//! aren't listed.

use serde::Deserialize;
use serde::Serialize;

/// The [`crate::hello::HelloResponse::features`] entry of a Host that reports its sessions' MCP
/// servers.
pub const FEATURE: &str = "mcpServers";

/// One MCP server a session's agent was given, or left without.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    /// As the agent knows it: `weave` for the Host's own.
    pub name: String,
    pub source: McpServerSource,
    /// How the agent reaches it; absent for a server left out before it had one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<McpTransport>,
    pub state: McpServerState,
    /// Why it was skipped or is unavailable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Where a server comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum McpServerSource {
    /// The Host MCP server, `weave` (ADR 0009).
    Host,
    /// The Host's config, `[[mcp_servers]]`.
    Config,
    #[serde(other)]
    Other,
}

/// How the agent reaches a server.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum McpTransport {
    /// Over ACP itself, for agents that advertise `mcpCapabilities.acp`.
    Acp,
    Stdio,
    Http,
    Sse,
    #[serde(other)]
    Other,
}

/// How a server is, as far as the Host knows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum McpServerState {
    /// The Host's own server was declared to the agent, which hasn't spoken to it yet.
    Declared,
    /// The agent has spoken to the Host's own server.
    Connected,
    /// A configured server passed on to the agent, which alone knows whether it connected.
    Passed,
    /// A configured server left out of the session, `reason` saying why.
    Skipped,
    /// The Host's own server can't serve this agent, `reason` saying why.
    Unavailable,
    /// A state this client doesn't know.
    #[serde(other)]
    Other,
}
