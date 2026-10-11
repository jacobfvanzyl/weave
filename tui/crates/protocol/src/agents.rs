//! The agents the Host can run, and signing in to them. Clients name agents by id; the Host
//! resolves the id from its configuration, its presets and the ACP registry.

use std::collections::BTreeMap;

use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::JsonRpcResponse;
use agent_client_protocol::schema::v1::AuthMethodId;
use agent_client_protocol::schema::v1::InitializeResponse;
use serde::Deserialize;
use serde::Serialize;

use crate::Empty;

/// An agent's id: a preset, a configured agent, or an ACP registry agent.
pub type AgentId = String;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
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
#[serde(rename_all = "camelCase")]
pub enum AgentSource {
    Preset,
    Config,
    Registry,
}

/// `agents/list`: presets and configured agents, and registry agents when asked.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
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
#[serde(rename_all = "camelCase")]
pub struct ListAgentsResponse {
    pub agents: Vec<AgentSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_agent: Option<AgentId>,
}

/// `agents/get`: what the agent says about itself, starting it to ask if need be.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "agents/get", response = GetAgentResponse)]
#[serde(rename_all = "camelCase")]
pub struct GetAgentRequest {
    pub agent_id: AgentId,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct GetAgentResponse {
    pub agent: AgentSummary,
    pub initialize: InitializeResponse,
}

/// `agents/authenticate`: ACP `authenticate` with one of the agent's methods. A terminal
/// method fails with [`crate::errors::REQUIRES_TERMINAL`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
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
#[request(method = "agents/terminalSignIn", response = TerminalSignInResponse)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSignInRequest {
    pub agent_id: AgentId,
    pub method_id: AuthMethodId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
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
#[request(method = "agents/logout", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct LogoutAgentRequest {
    pub agent_id: AgentId,
}
