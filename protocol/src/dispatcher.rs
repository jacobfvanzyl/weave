//! The Dispatcher's API (ADR 0027, WVE-175): what the `weave dispatcher` CLI asks the Dispatcher
//! over its Unix socket. The Dispatcher is a client of the person's Hosts, paired with each as a
//! service; these are the Hosts it is paired with and how it reaches them. The specification is
//! `docs/specs/wve-175-dispatcher.md`.

use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::JsonRpcResponse;
use serde::Deserialize;
use serde::Serialize;

use crate::Empty;
use crate::Timestamp;
use crate::hello::ClientInfo;
use crate::peers::PeerStatus;

/// The Dispatcher API's version, which a client and the Dispatcher must share.
pub const DISPATCHER_PROTOCOL: u32 = 1;

/// `dispatcher/hello`: the first request on a connection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "dispatcher/hello", response = DispatcherHello)]
pub struct DispatcherHelloRequest {
    /// [`DISPATCHER_PROTOCOL`] as the client speaks it.
    pub protocol: u32,
    pub client: ClientInfo,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct DispatcherHello {
    pub protocol: u32,
    /// The weave release the Dispatcher runs.
    pub version: String,
}

/// `dispatcher/status`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "dispatcher/status", response = DispatcherStatus)]
pub struct DispatcherStatusRequest {}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct DispatcherStatus {
    pub version: String,
    pub pid: u32,
    pub started_at: Timestamp,
    /// The name it pairs with Hosts as.
    pub name: String,
    /// Its database.
    pub database: String,
    /// Work written down for a Host that the Host hasn't taken yet.
    pub pending: u32,
}

/// A Host the Dispatcher is paired with, as a service.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct DispatcherHost {
    pub host_id: String,
    /// What the Dispatcher calls it.
    pub name: String,
    pub url: String,
    /// The device the Host knows the Dispatcher as, which `weave devices revoke` there takes.
    pub device_id: String,
    pub paired_at: Timestamp,
    /// Connected now.
    pub connected: bool,
    /// How the last attempt to connect went.
    pub status: PeerStatus,
    /// Why it failed, when it did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    /// When it last connected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connected_at: Option<Timestamp>,
    /// Work written down for it that it hasn't taken yet.
    pub pending: u32,
}

/// `hosts/list`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "hosts/list", response = ListHostsResponse)]
pub struct ListHostsRequest {}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ListHostsResponse {
    pub hosts: Vec<DispatcherHost>,
}

/// `hosts/add`: pair with the Host at `url` as a service, with the code `weave pair` showed
/// there.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "hosts/add", response = AddHostResponse)]
pub struct AddHostRequest {
    pub url: String,
    pub code: String,
    /// What to call it; its tailnet name when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct AddHostResponse {
    pub host: DispatcherHost,
}

/// `hosts/remove`: forget a Host, by id or name, and close the connection to it. Work still
/// written down for it is dropped. The Host keeps the Dispatcher as a device until it's
/// revoked there.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "hosts/remove", response = Empty)]
pub struct RemoveHostRequest {
    pub host: String,
}
