//! The server's end of remote access (ADR 0016), which the weave Host and the Dispatcher share:
//! what `weave-host-client` is for clients. The person's devices reach the Dispatcher through a
//! loopback WebSocket that Tailscale Serve brings the tailnet to, pair with a one-time code, and
//! prove themselves at every hello by signing the connection's challenge (WVE-90, WVE-176); they
//! reach the person's Hosts through it (ADR 0030). A Host listens for nothing (WVE-197): it opens
//! connections to the Dispatcher it joined, and serves them with the same WebSocket code.
//!
//! - [`websocket`]: the WebSocket, its upgrade, pings, the backlog limit and the challenge, for
//!   connections a program accepts and those a Host opens to the Dispatcher alike.
//! - [`access`]: turning the Dispatcher's on when a device pairs and off when none is left, with
//!   its Serve entry ([`access::Serve`], [`tailscale`]); a Host uses [`access::Serve`] only to
//!   remove the entry it made before.
//! - [`pairing`]: pairing offers and their codes, and checking a signature.
//! - [`preamble`]: the requests on a WebSocket before the ACP SDK takes it, as a Host joining
//!   the Dispatcher sends them (WVE-194).
//!
//! Each program keeps its own devices and answers its own hello; this crate holds no state of
//! theirs.

pub mod access;
pub mod pairing;
pub mod preamble;
pub mod tailscale;
pub mod websocket;

use std::sync::Mutex;
use std::sync::MutexGuard;

use weave_host_protocol::Timestamp;

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> Timestamp {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            Timestamp::try_from(elapsed.as_millis()).unwrap_or(Timestamp::MAX)
        })
}

/// A lock that a panic elsewhere doesn't poison.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
