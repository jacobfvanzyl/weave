//! Paired devices: the person's other devices, whose remote clients reach the Host over the
//! WebSocket. A device pairs once, with a code `weave pair` shows on the Host's computer, and
//! proves itself on every connection after that by signing the connection's challenge with a
//! P-256 key that never leaves it. Managing devices is for local clients only.
//!
//! Another of the person's Hosts pairs the same way, as a peer Host (ADR 0017,
//! [`crate::peers`]): it is a paired device that names its Host id, which the turns its agents
//! begin carry in their origin.

use agent_client_protocol::JsonRpcNotification;
use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::JsonRpcResponse;
use serde::Deserialize;
use serde::Serialize;

use crate::Empty;
use crate::Timestamp;

/// The Host's name for a paired device, which stays the same until it's revoked.
pub type DeviceId = String;

/// The [`crate::hello::HelloResponse::features`] entry of a Host that pairs devices.
pub const DEVICES_FEATURE: &str = "devices";

/// What a device signs in `host/hello`: the UTF-8 bytes of this line.
pub fn auth_message(host_id: &str, device_id: &str, nonce: &str) -> String {
    format!("weave-host-auth/1 {host_id} {device_id} {nonce}")
}

/// A P-256 public key as a JWK: `x` and `y` are its coordinates, 32 bytes each, in unpadded
/// base64url.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct Jwk {
    /// `EC`.
    pub kty: String,
    /// `P-256`.
    pub crv: String,
    pub x: String,
    pub y: String,
}

/// A device pairing, as it introduces itself.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct NewDevice {
    /// What the person calls it, such as "Jaco's iPad". An offer made with a name uses that
    /// instead.
    pub name: String,
    pub public_key: Jwk,
    /// The Host id of a peer Host pairing, which is one of the person's Hosts rather than a
    /// device; absent for a device.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
}

/// Which device a connection is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct DeviceInfo {
    pub id: DeviceId,
    pub name: String,
    /// The peer Host's id, when the device is one of the person's Hosts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
}

/// A paired device, as `devices/list` shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: DeviceId,
    pub name: String,
    pub paired_at: Timestamp,
    /// When it last said hello, if it has since pairing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<Timestamp>,
    /// Its connections now.
    pub connections: u32,
    /// The peer Host's id, when the device is one of the person's Hosts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
}

/// `devices/offer`: a one-time code a device pairs with, good for five minutes.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "devices/offer", response = OfferDeviceResponse)]
#[serde(rename_all = "camelCase")]
pub struct OfferDeviceRequest {
    /// The name the device gets, instead of the one it gives.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct OfferDeviceResponse {
    /// 128 random bits in Crockford base32.
    pub code: String,
    pub expires_at: Timestamp,
    /// What devices connect to: the Host's Tailscale Serve URL, or `[remote] url`. Offering
    /// turns remote access on, so a Host gives one whenever it serves remote clients.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// `devices/paired`: a device took the offer this connection made.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcNotification)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[notification(method = "devices/paired")]
pub struct DevicePairedNotification {
    pub device: Device,
}

/// `devices/list`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "devices/list", response = ListDevicesResponse)]
pub struct ListDevicesRequest {}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ListDevicesResponse {
    pub devices: Vec<Device>,
}

/// `devices/revoke`: forget a device and close its connections. It has to pair again.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "devices/revoke", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct RevokeDeviceRequest {
    pub device_id: DeviceId,
}
