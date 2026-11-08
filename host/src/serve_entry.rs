//! The Tailscale Serve entry a Host made for remote clients before they reached it through the
//! Dispatcher (ADR 0016, retired by ADR 0030 and WVE-197).
//!
//! A Host whose `devices.json` shows it served remote clients
//! ([`crate::devices::Devices::serve_entry_left`]) removes, when it starts, the entry that
//! forwards to where it listened, and touches no other. A Host that never served them, as one in
//! a new directory, never runs `tailscale`. Where the Host can't remove it, as where only root
//! may change Serve, it logs why, and `host/status` gives the command for the person to run; a
//! local client asking for the status has it look again first, at most every
//! [`FormerServe::recheck_after`], so it's gone from there once the person has.

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

use weave_host_protocol::host::ServeEntryLeft;
use weave_remote::access::Serve;

use crate::devices::Devices;
use crate::thread::lock;

/// Where the entry a Host made forwarded to, and how to remove it.
pub struct FormerServe {
    /// The loopback address it forwarded to: `127.0.0.1:7341`, or the config's `[remote]
    /// listen`.
    pub listen: SocketAddr,
    /// Tailscale Serve, through the `tailscale` command, or a test's.
    pub serve: Arc<dyn Serve>,
    /// How long after trying a local client's `host/status` may have the Host try again, so one
    /// asking often, as `weave threads` does, doesn't run `tailscale` each time.
    pub recheck_after: Duration,
}

impl FormerServe {
    /// The entry that forwarded to `listen`, removed through `serve`.
    pub fn new(listen: SocketAddr, serve: Arc<dyn Serve>) -> Self {
        Self {
            listen,
            serve,
            recheck_after: Duration::from_secs(10),
        }
    }
}

pub(crate) struct ServeEntry {
    former: Option<FormerServe>,
    /// Held while removing, so two at once don't both run `tailscale`.
    removing: tokio::sync::Mutex<()>,
    /// The entry the Host couldn't remove, while it's there, and when it last tried.
    left: Mutex<Option<(ServeEntryLeft, Instant)>>,
}

impl ServeEntry {
    /// The entry `former` describes; none for a Host that made no entry or doesn't touch Serve,
    /// as one inside a client.
    pub(crate) fn new(former: Option<FormerServe>) -> Self {
        Self {
            former,
            removing: tokio::sync::Mutex::new(()),
            left: Mutex::new(None),
        }
    }

    /// Remove the entry, if `devices` shows the Host may have one left.
    pub(crate) async fn remove(&self, devices: &Devices) {
        self.try_removing(devices, false).await;
    }

    /// `quietly`: the Host tried before, and said why it couldn't then.
    async fn try_removing(&self, devices: &Devices, quietly: bool) {
        let Some(former) = &self.former else {
            return;
        };
        let _removing = self.removing.lock().await;
        if !devices.serve_entry_left() {
            *lock(&self.left) = None;
            return;
        }
        let port = former.listen.port();
        match former.serve.remove(former.listen).await {
            Ok(()) => {
                tracing::info!(
                    port,
                    "no Tailscale Serve entry is left of the one this Host made for remote clients, which reach it through the Dispatcher now"
                );
                devices.serve_entry_removed();
                *lock(&self.left) = None;
            }
            Err(why) => {
                let command = format!("sudo tailscale serve --https={port} off");
                if quietly {
                    tracing::debug!(%why, "the Tailscale Serve entry this Host made is still there");
                } else {
                    tracing::warn!(
                        %why,
                        %command,
                        "couldn't remove the Tailscale Serve entry this Host made for remote clients, which reach it through the Dispatcher now; run the command to"
                    );
                }
                let left = ServeEntryLeft { port, command, why };
                *lock(&self.left) = Some((left, Instant::now()));
            }
        }
    }

    /// Look again, if the Host couldn't remove the entry before and hasn't tried lately: the
    /// person may have.
    pub(crate) async fn recheck(&self, devices: &Devices) {
        let Some(former) = &self.former else {
            return;
        };
        let due = lock(&self.left)
            .as_ref()
            .is_some_and(|(_, tried)| tried.elapsed() >= former.recheck_after);
        if due {
            self.try_removing(devices, true).await;
        }
    }

    /// The entry the Host couldn't remove, for `host/status`.
    pub(crate) fn left(&self) -> Option<ServeEntryLeft> {
        lock(&self.left).as_ref().map(|(left, _)| left.clone())
    }
}
