//! The agents the Host can run, signing in to them, and updating them. Clients name agents by
//! id; the Host resolves the id from its configuration, its presets and the ACP registry.

use std::collections::BTreeMap;

use agent_client_protocol::JsonRpcNotification;
use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::JsonRpcResponse;
use agent_client_protocol::schema::v1::AuthMethodId;
use agent_client_protocol::schema::v1::InitializeResponse;
use agent_client_protocol::schema::v1::SessionId;
use serde::Deserialize;
use serde::Serialize;

use crate::Empty;

/// An agent's id: a preset, a configured agent, or an ACP registry agent.
pub type AgentId = String;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    pub id: AgentId,
    /// The agent's title when known, else its id.
    pub name: String,
    pub source: AgentSource,
    /// The pinned preset or registry version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// False for a registry agent not downloaded yet.
    pub installed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum AgentSource {
    Preset,
    Config,
    Registry,
}

/// `agents/list`: presets and configured agents, and registry agents when asked.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "agents/list", response = ListAgentsResponse)]
#[serde(rename_all = "camelCase")]
pub struct ListAgentsRequest {
    #[serde(default)]
    pub include_registry: bool,
    /// Fetch the registry's catalog again.
    #[serde(default)]
    pub refresh: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ListAgentsResponse {
    pub agents: Vec<AgentSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_agent: Option<AgentId>,
}

/// `agents/get`: what the agent says about itself, starting it to ask if need be.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "agents/get", response = GetAgentResponse)]
#[serde(rename_all = "camelCase")]
pub struct GetAgentRequest {
    pub agent_id: AgentId,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct GetAgentResponse {
    pub agent: AgentSummary,
    pub initialize: InitializeResponse,
}

/// `agents/authenticate`: ACP `authenticate` with one of the agent's methods. A terminal
/// method fails with [`crate::errors::REQUIRES_TERMINAL`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "agents/authenticate", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticateAgentRequest {
    pub agent_id: AgentId,
    pub method_id: AuthMethodId,
}

/// `agents/terminalSignIn`: the command a local client runs in its own terminal for a
/// terminal sign-in method. The Host stops its idle processes for the agent, so the next
/// ones start signed in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "agents/terminalSignIn", response = TerminalSignInResponse)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSignInRequest {
    pub agent_id: AgentId,
    pub method_id: AuthMethodId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct TerminalSignInResponse {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Only the agent's configured variables and the method's own.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

/// `agents/logout`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "agents/logout", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct LogoutAgentRequest {
    pub agent_id: AgentId,
}

/// The `features` entry of a Host that looks for newer versions of its sessions' agents and
/// moves them over: `agents/updateAvailable`, `SessionState.update`, `agents/update` and
/// `session/reopen`.
pub const UPDATES_FEATURE: &str = "agents/updates";

/// A version of an agent the Host launches and can update: a preset's npm package, or an ACP
/// registry agent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct AgentRelease {
    /// As people know it: the preset's package, or the registry agent's name.
    pub name: String,
    pub version: String,
}

/// A newer version of a session's agent than the one it runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct AgentUpdate {
    pub agent_id: AgentId,
    /// The package or registry agent, as [`AgentRelease::name`].
    pub name: String,
    /// The version the session runs.
    pub running: String,
    pub latest: String,
}

/// `agents/updateAvailable`: a newer version of an attached session's agent is out. The Host
/// looks when a session opens, at most once an hour for each agent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcNotification)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[notification(method = "agents/updateAvailable")]
#[serde(rename_all = "camelCase")]
pub struct UpdateAvailableNotification {
    pub session_id: SessionId,
    #[serde(flatten)]
    pub update: AgentUpdate,
}

/// `agents/update`: what `weave update <agent>` does. The Host checks that the newest version
/// starts and answers `initialize`, then launches it for the agent's new sessions; open ones
/// move over with `session/reopen`. A version that doesn't start changes nothing. Local
/// clients only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "agents/update", response = UpdateAgentResponse)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAgentRequest {
    pub agent_id: AgentId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct UpdateAgentResponse {
    /// The version the agent's new sessions launch now: the newest, or the one already there.
    pub version: String,
}
