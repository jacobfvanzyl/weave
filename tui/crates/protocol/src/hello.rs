//! `host/hello`: the first request on every connection. Until it succeeds, the Host answers
//! every other request with [`crate::errors::UNAUTHENTICATED`].

use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::JsonRpcResponse;
use serde::Deserialize;
use serde::Serialize;

use crate::Timestamp;
use crate::VersionRange;

/// The Host's name for a connection, in messages about who did what. It means nothing once
/// the connection ends.
pub type ClientId = String;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "host/hello", response = HelloResponse)]
#[serde(rename_all = "camelCase")]
pub struct HelloRequest {
    /// The major versions the client speaks.
    pub protocol: VersionRange,
    pub client: ClientInfo,
    pub auth: Auth,
    #[serde(default)]
    pub capabilities: ClientCapabilities,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    /// What the client is, such as `weave-tui`.
    pub name: String,
    pub version: String,
}

/// How a connection authenticates.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "camelCase")]
pub enum Auth {
    /// The socket's peer is the Host's own user. Only on the Unix socket and in-process.
    Local,
    /// A token the Host issued. Reserved for the WebSocket; refused until it exists.
    Token { token: String },
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCapabilities {
    /// The client can run an agent's sign-in command in a terminal on the Host's computer.
    /// Only local clients may say so.
    #[serde(default)]
    pub terminal_sign_in: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct HelloResponse {
    /// The version this connection speaks: the highest both ends do.
    pub protocol: u32,
    pub client_id: ClientId,
    pub host: HostInfo,
    /// Optional parts of the protocol this Host supports.
    #[serde(default)]
    pub features: Vec<String>,
    pub acp: AcpInfo,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub version: String,
    pub pid: u32,
    pub started_at: Timestamp,
}

/// Which ACP payloads to expect.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpInfo {
    /// The ACP protocol version the Host speaks to agents.
    pub protocol_version: u16,
    /// Unstable ACP features the Host may pass through, such as `subagents`.
    #[serde(default)]
    pub unstable: Vec<String>,
}
