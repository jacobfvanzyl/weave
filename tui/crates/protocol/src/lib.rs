//! The weave Host protocol: what clients and the Host say to each other.
//!
//! JSON-RPC 2.0, one message per line on the Host's Unix socket, one per text frame on its
//! WebSocket ([`websocket`]) and one per item in-process.
//! Clients send requests; the Host answers them and sends notifications, never requests.
//! Whatever an agent produced or consumes travels as ACP's own JSON, from
//! [`agent_client_protocol::schema::v1`]; the messages around it are this crate's. The
//! specification is `tui/docs/specs/wve-85-host-protocol.md`.
//!
//! - [`hello`]: the first request on every connection: version, authentication, client.
//! - [`devices`]: pairing the person's other devices, whose remote clients use the WebSocket.
//! - [`agents`]: the agents the Host can run, signing in to them, and updating them.
//! - [`sessions`]: listing, creating, attaching to, reopening and closing sessions.
//! - [`events`]: what attached clients are sent: journaled events and changes.
//! - [`turns`]: starting, steering and cancelling turns.
//! - [`pending`]: permission requests and elicitations waiting on a person, and client tool
//!   calls waiting on a client.
//! - [`tools`]: client tools, which an attached client runs for the agent.
//! - [`host`]: the Host's status, and stopping it.
//!
//! Remote clients follow `tui/docs/specs/wve-90-remote-clients.md`.

pub mod agents;
pub mod devices;
pub mod errors;
pub mod events;
pub mod hello;
pub mod host;
pub mod pending;
pub mod policy;
mod role;
pub mod sessions;
pub mod tools;
pub mod turns;

use agent_client_protocol::JsonRpcResponse;
use serde::Deserialize;
use serde::Serialize;

pub use crate::role::Host;
pub use crate::role::HostClient;

/// This protocol's major version. Version 1 was the `_weave/*` ACP extension the daemon
/// spoke before, which this protocol replaces.
pub const PROTOCOL_VERSION: u32 = 2;

/// The oldest major version this build still speaks: from version 3 on, the one before.
pub const OLDEST_SUPPORTED_VERSION: u32 = 2;

/// Milliseconds since the Unix epoch.
pub type Timestamp = u64;

/// The WebSocket remote clients connect over, through Tailscale Serve.
pub mod websocket {
    /// The subprotocol an upgrade must ask for.
    pub const SUBPROTOCOL: &str = "weave-host";
    /// The largest message either end sends: room for a prompt's screenshots.
    pub const MAX_MESSAGE: usize = 32 * 1024 * 1024;
    /// The device was revoked.
    pub const CLOSE_REVOKED: u16 = 4000;
    /// The client fell behind; it reconnects and attaches after its position.
    pub const CLOSE_BEHIND: u16 = 4001;
    /// `host/hello` failed, after its error.
    pub const CLOSE_UNAUTHENTICATED: u16 = 4002;
}

/// A response with nothing in it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
pub struct Empty {}

/// A range of major versions, both ends included.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VersionRange {
    pub min: u32,
    pub max: u32,
}

impl VersionRange {
    /// The versions this build speaks.
    pub const fn supported() -> Self {
        Self {
            min: OLDEST_SUPPORTED_VERSION,
            max: PROTOCOL_VERSION,
        }
    }

    /// The highest version in both ranges.
    pub fn highest_common(self, other: Self) -> Option<u32> {
        let highest = self.max.min(other.max);
        (highest >= self.min.max(other.min)).then_some(highest)
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn versions_meet_at_the_highest_both_speak() {
        let range = |min, max| VersionRange { min, max };
        assert_eq!(range(2, 2).highest_common(range(2, 2)), Some(2));
        assert_eq!(range(2, 4).highest_common(range(3, 5)), Some(4));
        assert_eq!(range(3, 3).highest_common(range(2, 4)), Some(3));
        assert_eq!(range(2, 2).highest_common(range(3, 3)), None);
        assert_eq!(range(5, 6).highest_common(range(2, 4)), None);
    }
}
