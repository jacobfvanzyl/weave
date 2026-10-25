//! The Host itself: what it's running, and stopping it.

use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::JsonRpcResponse;
use serde::Deserialize;
use serde::Serialize;

use crate::Empty;
use crate::Timestamp;
use crate::sessions::SessionListing;

/// `host/status`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "host/status", response = HostStatus)]
pub struct StatusRequest {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub protocol: u32,
    pub version: String,
    pub pid: u32,
    pub started_at: Timestamp,
    pub service: Service,
    pub environment: EnvironmentSource,
    /// The open sessions.
    pub sessions: Vec<SessionListing>,
    /// The loopback address of the WebSocket remote clients reach, when the Host serves one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
}

/// How the Host runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum Service {
    /// As a launchd user agent, with no idle exit.
    Launchd,
    /// As a systemd user service, with no idle exit.
    Systemd,
    /// Started by a client, exiting once idle.
    OnDemand,
    /// Inside a client (`--no-daemon`).
    InProcess,
}

/// Where agents' environment comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum EnvironmentSource {
    /// The user's login shell, over the Host's own.
    LoginShell,
    /// The Host's own only: capturing the login shell's failed.
    Process,
}

/// The `features` entry for `host/drain`.
pub const DRAIN_FEATURE: &str = "drain";

/// `host/drain`: get ready to stop. From now on the Host starts no new turns (`turn/start`
/// and `session/run` answer `host_stopping`, and queued prompts wait), and with `wait` it
/// answers once no turn runs but `except`'s, or when its drain timeout passes. The stop that
/// follows doesn't wait again. If the asking client goes before the Host stops, the drain
/// ends. Local clients only.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
#[request(method = "host/drain", response = DrainResponse)]
pub struct DrainRequest {
    /// Wait for running turns before answering.
    #[serde(default)]
    pub wait: bool,
    /// The agent process whose turn isn't waited for, from the `WEAVE_AGENT_PROCESS` the
    /// Host gives each agent: the one asking, when an agent stops the Host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub except: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct DrainResponse {
    /// Turns still running, but for `except`'s, which stopping cuts off.
    pub running: u32,
}

/// `host/shutdown`: suspend every open session and exit.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "host/shutdown", response = Empty)]
pub struct ShutdownRequest {}
