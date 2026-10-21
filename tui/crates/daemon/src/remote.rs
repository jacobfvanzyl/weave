//! Remote access (ADR 0016): the loopback WebSocket the person's other devices use, and the
//! Tailscale Serve entry that brings the tailnet to it. Pairing turns both on: a `devices/offer`
//! starts them, and they stay on while any device is paired, across restarts. Revoking the
//! last device, or an offer expiring with none paired, turns them off and removes the entry.
//! A `[remote] url` means the person routes devices to the Host themselves, and the Host leaves
//! Serve alone.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::Error;
use futures::future::BoxFuture;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use weave_host_protocol::errors;

use crate::Shared;
use crate::devices::OFFER_LIFETIME_MS;
use crate::session::lock;
use crate::websocket;
use crate::websocket::RemoteConfig;

/// The loopback address remote access listens on when the config doesn't say.
pub const DEFAULT_LISTEN: &str = "127.0.0.1:7341";

/// How the Host makes and removes the Serve entry that forwards to its WebSocket.
pub trait Serve: Send + Sync {
    /// Make sure an entry forwards to `listen`, and give the URL devices connect to, as
    /// `wss://`. Fails, saying why, when Serve can't reach the Host.
    fn ensure(&self, listen: SocketAddr) -> BoxFuture<'_, Result<String, String>>;
    /// Remove the entry that forwards to `listen`, if there is one.
    fn remove(&self, listen: SocketAddr) -> BoxFuture<'_, Result<(), String>>;
}

/// How a Host serves remote clients, once pairing turns that on.
#[derive(Clone)]
pub struct RemoteSettings {
    /// A loopback address; port 0 picks one, as tests do.
    pub listen: SocketAddr,
    /// What devices connect to. With one, the Host leaves Tailscale Serve alone.
    pub url: Option<String>,
    pub websocket: RemoteConfig,
    pub serve: Arc<dyn Serve>,
    /// How long a pairing offer stays good.
    pub offer_lifetime: Duration,
    /// How long to wait before trying the Serve entry again, when it failed at startup.
    pub serve_retry: Duration,
}

impl RemoteSettings {
    /// The Host's defaults: loopback port 7341, and its own entry in Tailscale Serve.
    pub fn new(serve: Arc<dyn Serve>) -> Self {
        Self {
            #[allow(clippy::expect_used)]
            listen: DEFAULT_LISTEN.parse().expect("the default address parses"),
            url: None,
            websocket: RemoteConfig::default(),
            serve,
            offer_lifetime: Duration::from_millis(OFFER_LIFETIME_MS),
            serve_retry: Duration::from_secs(60),
        }
    }
}

/// Whether remote access is on, and where.
#[derive(Default)]
pub(crate) struct Remote {
    state: tokio::sync::Mutex<Option<Running>>,
    /// The listener's address while it's on, for `host/status` and the idle check.
    address: std::sync::Mutex<Option<String>>,
}

struct Running {
    listen: SocketAddr,
    /// What devices connect to, once Serve has an entry (or the config gave one).
    url: Option<String>,
    stop: CancellationToken,
    /// Trying the Serve entry again, after it failed at startup.
    retry: Option<JoinHandle<()>>,
}

impl Remote {
    /// The WebSocket's address while remote access is on.
    pub(crate) fn address(&self) -> Option<String> {
        lock(&self.address).clone()
    }

    /// Whether remote access is on, which keeps a Host from exiting when idle.
    pub(crate) fn is_on(&self) -> bool {
        lock(&self.address).is_some()
    }

    /// Record a WebSocket a caller serves itself ([`crate::Daemon::serve_remote`]).
    pub(crate) fn serving(&self, address: Option<String>) {
        *lock(&self.address) = address;
    }

    /// Turn remote access on if it isn't, and give the URL devices connect to. Fails, turning
    /// it off again when nothing else needs it, when Serve can't reach the Host.
    pub(crate) async fn start(&self, shared: &Arc<Shared>) -> Result<String, Error> {
        let Some(settings) = shared.config.remote.clone() else {
            return Err(errors::remote_unavailable(
                "this Host doesn't serve remote clients",
            ));
        };
        let mut state = self.state.lock().await;
        if state.is_none() {
            *state = Some(self.listen(shared, &settings).await?);
        }
        let Some(running) = state.as_mut() else {
            return Err(errors::remote_unavailable("remote access didn't start"));
        };
        if let Some(url) = &running.url {
            return Ok(url.clone());
        }
        match url(&settings, running.listen).await {
            Ok(url) => {
                if let Some(retry) = running.retry.take() {
                    retry.abort();
                }
                running.url = Some(url.clone());
                Ok(url)
            }
            Err(why) => {
                tracing::warn!(%why, "Tailscale Serve can't reach the Host");
                if !shared.devices.any_paired() {
                    self.turn_off(&mut state, &settings).await;
                }
                Err(errors::remote_unavailable(why))
            }
        }
    }

    /// At startup: turn remote access on when a device is paired. A Serve entry that can't be
    /// made yet, as when Tailscale starts after the Host, is tried again in the background.
    pub(crate) async fn resume(&self, shared: &Arc<Shared>) {
        let Some(settings) = shared.config.remote.clone() else {
            return;
        };
        if !shared.devices.any_paired() {
            return;
        }
        let mut state = self.state.lock().await;
        if state.is_some() {
            return;
        }
        let mut running = match self.listen(shared, &settings).await {
            Ok(running) => running,
            Err(error) => {
                tracing::error!(error = %error.message, "no remote clients");
                return;
            }
        };
        match url(&settings, running.listen).await {
            Ok(url) => running.url = Some(url),
            Err(why) => {
                tracing::warn!(%why, "Tailscale Serve can't reach the Host yet; trying again");
                running.retry = Some(retry_serve(Arc::clone(shared), settings));
            }
        }
        *state = Some(running);
    }

    /// Turn remote access off when nothing needs it: no device paired and no offer good.
    pub(crate) async fn stop_if_unused(&self, shared: &Arc<Shared>) {
        let Some(settings) = shared.config.remote.clone() else {
            return;
        };
        let mut state = self.state.lock().await;
        if shared.devices.any_paired() || shared.devices.offering() {
            return;
        }
        self.turn_off(&mut state, &settings).await;
    }

    async fn listen(
        &self,
        shared: &Arc<Shared>,
        settings: &RemoteSettings,
    ) -> Result<Running, Error> {
        let listener = tokio::net::TcpListener::bind(settings.listen)
            .await
            .map_err(|error| {
                errors::remote_unavailable(format!(
                    "can't listen on {} for remote clients: {error}",
                    settings.listen
                ))
            })?;
        let listen = listener.local_addr().unwrap_or(settings.listen);
        let stop = CancellationToken::new();
        let serving = stop.clone();
        let config = settings.websocket.clone();
        let shared = Arc::clone(shared);
        tokio::spawn(async move { websocket::serve(shared, listener, config, serving).await });
        *lock(&self.address) = Some(listen.to_string());
        tracing::info!(address = %listen, "serving remote clients");
        Ok(Running {
            listen,
            url: settings.url.clone(),
            stop,
            retry: None,
        })
    }

    async fn turn_off(&self, state: &mut Option<Running>, settings: &RemoteSettings) {
        let Some(running) = state.take() else {
            return;
        };
        running.stop.cancel();
        if let Some(retry) = running.retry {
            retry.abort();
        }
        *lock(&self.address) = None;
        if settings.url.is_none()
            && let Err(why) = settings.serve.remove(running.listen).await
        {
            tracing::warn!(%why, "couldn't remove the Tailscale Serve entry");
        }
        tracing::info!("stopped serving remote clients: no device is paired");
    }
}

/// The URL devices connect to: the config's, or the Serve entry's, made if need be.
async fn url(settings: &RemoteSettings, listen: SocketAddr) -> Result<String, String> {
    match &settings.url {
        Some(url) => Ok(url.clone()),
        None => settings.serve.ensure(listen).await,
    }
}

/// Try the Serve entry again until it's there or remote access turns off.
fn retry_serve(shared: Arc<Shared>, settings: RemoteSettings) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(settings.serve_retry).await;
            let remote = &shared.remote;
            let mut state = remote.state.lock().await;
            let Some(running) = state.as_mut() else {
                return;
            };
            match url(&settings, running.listen).await {
                Ok(url) => {
                    tracing::info!(%url, "Tailscale Serve reaches the Host");
                    running.url = Some(url);
                    running.retry = None;
                    return;
                }
                Err(why) => tracing::debug!(%why, "Tailscale Serve still can't reach the Host"),
            }
        }
    })
}
