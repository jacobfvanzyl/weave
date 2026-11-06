//! The server's end of remote access (ADR 0016), which the weave Host and the Dispatcher share:
//! what `weave-host-client` is for clients. The person's other devices reach a program through
//! a loopback WebSocket that Tailscale Serve brings the tailnet to, pair with a one-time code,
//! and prove themselves at every hello by signing the connection's challenge (WVE-90, WVE-176).
//!
//! - [`websocket`]: the WebSocket, its upgrade, pings, the backlog limit and the challenge.
//! - [`access`]: turning it on when a device pairs and off when none is left, with its Serve
//!   entry ([`access::Serve`], [`tailscale`]).
//! - [`pairing`]: pairing offers and their codes, and checking a device's signature.
//!
//! Each program keeps its own devices and answers its own hello; this crate holds no state of
//! theirs.

pub mod access;
pub mod pairing;
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
