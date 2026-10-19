//! `host/hello`: the first request on every connection. Until it succeeds, the Host answers
//! every other request with [`crate::errors::UNAUTHENTICATED`].

use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::JsonRpcResponse;
use serde::Deserialize;
use serde::Serialize;

use crate::Timestamp;
use crate::VersionRange;
use crate::devices::DeviceId;
use crate::devices::DeviceInfo;
use crate::devices::NewDevice;

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
    /// Reserved, and refused everywhere; the next major version removes it.
    Token { token: String },
    /// A paired device, on the WebSocket: its signature of the connection's challenge
    /// ([`ChallengeRequest`]), as [`crate::devices::auth_message`] spells it.
    #[serde(rename_all = "camelCase")]
    Device {
        device_id: DeviceId,
        /// The DER-encoded ECDSA P-256 SHA-256 signature, in unpadded base64url.
        signature: String,
    },
    /// A device pairing, on the WebSocket, with the code `weave pair` showed. The
    /// connection is that device's from then on.
    Pair { code: String, device: NewDevice },
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCapabilities {
    /// The client can run an agent's sign-in command in a terminal on the Host's computer.
    /// Only local clients may say so.
    #[serde(default)]
    pub terminal_sign_in: bool,
    /// The client tools ([`crate::tools`]) this client runs on its device.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub client_tools: Vec<String>,
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
    /// The paired device a remote client connected as; none for a local client.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<DeviceInfo>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    /// The Host's own id, which stays the same across restarts, so clients tell Hosts apart.
    #[serde(default)]
    pub id: String,
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

/// `host/challenge`: what a paired device signs in its `host/hello`. Only on the WebSocket,
/// before hello.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "host/challenge", response = ChallengeResponse)]
pub struct ChallengeRequest {}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct ChallengeResponse {
    /// The Host's id, which the device checks is the Host it paired with.
    pub host_id: String,
    /// 32 random bytes, in unpadded base64url, good for one hello on this connection.
    pub nonce: String,
    pub expires_at: Timestamp,
}
