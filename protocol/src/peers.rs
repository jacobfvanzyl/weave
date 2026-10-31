//! Peer Hosts (ADR 0017, ADR 0024, WVE-109): the person's other Hosts this Host has paired with,
//! which its agents reach through the Host tools that name a peer. Pairing goes one way: this
//! Host pairs with a peer using the code `weave pair` shows there, and is a paired device of the
//! peer's from then on, proving its own key at hello. The peer reaching this Host is a pairing
//! of its own, which `weave hosts add` makes too unless told not to. Managing peers is for local
//! clients only, and a peer may ask only what the Host tools need.

use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::JsonRpcResponse;
use serde::Deserialize;
use serde::Serialize;

use crate::Empty;
use crate::Timestamp;

/// The [`crate::hello::HelloResponse::features`] entry of a Host that pairs with peer Hosts.
pub const PEERS_FEATURE: &str = "peers";

/// A peer Host, as `peers/list` shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    /// The peer's Host id, as its `host/hello` gives it.
    pub host_id: String,
    /// What the person calls it: the name pairing gave it, or its tailnet name.
    pub name: String,
    /// Its WebSocket, through Tailscale Serve.
    pub url: String,
    pub paired_at: Timestamp,
    /// When this Host last said hello to it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<Timestamp>,
    /// How the last attempt to reach it went.
    pub status: PeerStatus,
    /// Why the last attempt to reach it failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// How this Host's last attempt to reach a peer went.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum PeerStatus {
    /// It took this Host's key at hello; this Host may be connected to it now.
    Reachable,
    /// Not tried since this Host started.
    Unchecked,
    /// It refused this Host's key, as after it revoked this Host: pairing again is the way back.
    Refused,
    /// Its computer answered at the URL, but no weave Host did, as when the Host isn't running
    /// there.
    Down,
    /// Nothing answered at the URL, as when the computer is asleep or off the tailnet.
    Unreachable,
    /// Another weave Host answers at the URL.
    OtherHost,
}

/// `peers/add`: pair with the Host at `url`, using the code `weave pair` showed there.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "peers/add", response = AddPeerResponse)]
#[serde(rename_all = "camelCase")]
pub struct AddPeerRequest {
    /// The peer's URL, as `weave pair` showed it there.
    pub url: String,
    pub code: String,
    /// What to call the peer; its tailnet name when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct AddPeerResponse {
    pub peer: Peer,
}

/// `peers/list`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "peers/list", response = ListPeersResponse)]
#[serde(rename_all = "camelCase")]
pub struct ListPeersRequest {
    /// Try to reach each peer this Host isn't connected to, so `status` and `error` say
    /// whether it can be reached now.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub check: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ListPeersResponse {
    /// This Host's own id, which its peers know it by.
    pub host_id: String,
    pub peers: Vec<Peer>,
}

/// `peers/remove`: forget a peer and close the connection to it. The peer still lists this
/// Host among its paired devices until it's revoked there.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "peers/remove", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct RemovePeerRequest {
    pub host_id: String,
}
