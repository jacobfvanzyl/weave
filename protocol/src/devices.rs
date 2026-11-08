//! Paired devices: the person's devices, which pair with the Dispatcher and reach every Host
//! through it (ADR 0030, WVE-196). A device pairs once, with a code `weave pair` shows on the
//! Dispatcher's computer, and proves itself on every connection after that by signing the
//! connection's challenge with a P-256 key that never leaves it. Managing devices is for the
//! Dispatcher's own computer only. Hosts pair with nothing since WVE-197: a Host joins the
//! Dispatcher (`crate::dispatcher`), and takes the Dispatcher's word for the device each
//! connection it carries is for.

use agent_client_protocol::JsonRpcNotification;
use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::JsonRpcResponse;
use serde::Deserialize;
use serde::Serialize;

use crate::Empty;
use crate::Timestamp;

/// The Dispatcher's name for a paired device, which stays the same until it's revoked.
pub type DeviceId = String;

/// What the Dispatcher signs in `host/hello` on the connection a Host opened to it: the UTF-8
/// bytes of this line, with its id as the device's.
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
    /// A service pairing, which may do only what it needs (ADR 0027).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub service: bool,
}

/// Which device a connection is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct DeviceInfo {
    pub id: DeviceId,
    pub name: String,
    /// Whether the device is a service.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub service: bool,
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
    /// Whether the device is a service.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub service: bool,
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
    /// What devices connect to: the Dispatcher's Tailscale Serve URL, or the one its `--url`
    /// gives. Offering turns its WebSocket on, so it gives one whenever it takes devices.
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
