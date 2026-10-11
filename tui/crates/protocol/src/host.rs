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
#[request(method = "host/status", response = HostStatus)]
pub struct StatusRequest {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcResponse)]
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
}

/// How the Host runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Service {
    /// As a launchd user agent, with no idle exit.
    Launchd,
    /// Started by a client, exiting once idle.
    OnDemand,
    /// Inside a client (`--no-daemon`).
    InProcess,
}

/// Where agents' environment comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EnvironmentSource {
    /// The user's login shell, over the Host's own.
    LoginShell,
    /// The Host's own only: capturing the login shell's failed.
    Process,
}

/// `host/shutdown`: suspend every open session and exit.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "host/shutdown", response = Empty)]
pub struct ShutdownRequest {}
