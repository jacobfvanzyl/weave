//! Remote access (ADR 0016): the loopback WebSocket the person's other devices use, and the
//! Tailscale Serve entry that brings the tailnet to it. Pairing turns both on: an offer starts
//! them, and they stay on while any device is paired, across restarts. Revoking the last
//! device, or an offer expiring with none paired, turns them off and removes the entry. A
//! configured URL means the person routes devices to the program themselves, and it leaves
//! Serve alone.
//!
//! The program says what to do with the listener ([`Accept`]) and whether a device or an offer
//! needs remote access ([`Remote::stop_if_unused`]); [`Remote`] does the rest.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::Error;
use futures::future::BoxFuture;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use weave_host_protocol::errors;

use crate::lock;
use crate::pairing::OFFER_LIFETIME_MS;
use crate::websocket::RemoteConfig;

/// How the program makes and removes the Serve entry that forwards to its WebSocket.
pub trait Serve: Send + Sync {
    /// Make sure an entry forwards to `listen`, and give the URL devices connect to, as
    /// `wss://`. Fails, saying why, when Serve can't reach the program.
    fn ensure(&self, listen: SocketAddr) -> BoxFuture<'_, Result<String, String>>;
    /// Remove the entry that forwards to `listen`, if there is one.
    fn remove(&self, listen: SocketAddr) -> BoxFuture<'_, Result<(), String>>;
}

/// How a program serves remote clients, once pairing turns that on.
#[derive(Clone)]
pub struct RemoteSettings {
    /// A loopback address; port 0 picks one, as tests do.
    pub listen: SocketAddr,
    /// What devices connect to. With one, the program leaves Tailscale Serve alone.
    pub url: Option<String>,
    pub websocket: RemoteConfig,
    pub serve: Arc<dyn Serve>,
    /// How long a pairing offer stays good.
    pub offer_lifetime: Duration,
    /// How long to wait before trying the Serve entry again, when it failed at startup.
    pub serve_retry: Duration,
}

/// The loopback address the Host listens on for remote clients when its config doesn't say.
pub const HOST_LISTEN: &str = "127.0.0.1:7341";

impl RemoteSettings {
    /// The Host's defaults: loopback port 7341, and its own entry in Tailscale Serve. Another
    /// program sets its own `listen`.
    pub fn new(serve: Arc<dyn Serve>) -> Self {
        Self {
            #[allow(clippy::expect_used)]
            listen: HOST_LISTEN.parse().expect("the default address parses"),
            url: None,
            websocket: RemoteConfig::default(),
            serve,
            offer_lifetime: Duration::from_millis(OFFER_LIFETIME_MS),
            serve_retry: Duration::from_secs(60),
        }
    }
}

/// What the program does with the listener while remote access is on: accept its connections
/// until the token is cancelled.
pub type Accept = Arc<dyn Fn(TcpListener, CancellationToken) + Send + Sync>;

/// Whether remote access is on, and where.
pub struct Remote {
    /// What the program is, in messages: "Host" or "Dispatcher".
    what: &'static str,
    settings: Option<RemoteSettings>,
    state: Arc<tokio::sync::Mutex<Option<Running>>>,
    /// The listener's address while it's on, for status.
    address: std::sync::Mutex<Option<String>>,
}

struct Running {
    listen: SocketAddr,
    /// What devices connect to, once Serve has an entry (or the settings gave one).
    url: Option<String>,
    stop: CancellationToken,
    /// Trying the Serve entry again, after it failed at startup.
    retry: Option<JoinHandle<()>>,
}

impl Remote {
    /// Remote access for the program `what`, with `settings`, or none at all without them.
    pub fn new(what: &'static str, settings: Option<RemoteSettings>) -> Self {
        Self {
            what,
            settings,
            state: Arc::default(),
            address: std::sync::Mutex::default(),
        }
    }

    pub fn settings(&self) -> Option<&RemoteSettings> {
        self.settings.as_ref()
    }

    /// How long an offer stays good.
    pub fn offer_lifetime(&self) -> Duration {
        self.settings
            .as_ref()
            .map_or(Duration::from_millis(OFFER_LIFETIME_MS), |settings| {
                settings.offer_lifetime
            })
    }

    /// The WebSocket's address while remote access is on.
    pub fn address(&self) -> Option<String> {
        lock(&self.address).clone()
    }

    /// Whether remote access is on.
    pub fn is_on(&self) -> bool {
        lock(&self.address).is_some()
    }

    /// Record a WebSocket a caller serves itself, as tests do.
    pub fn serving(&self, address: Option<String>) {
        *lock(&self.address) = address;
    }

    /// Turn remote access on if it isn't, and give the URL devices connect to. Fails, turning
    /// it off again unless `paired` says a device is, when Serve can't reach the program.
    pub async fn start(&self, accept: &Accept, paired: impl Fn() -> bool) -> Result<String, Error> {
        let Some(settings) = self.settings.clone() else {
            return Err(errors::remote_unavailable(format!(
                "this {} doesn't serve remote clients",
                self.what
            )));
        };
        let mut state = self.state.lock().await;
        if state.is_none() {
            *state = Some(self.listen(&settings, accept).await?);
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
                tracing::warn!(%why, "Tailscale Serve can't reach the {}", self.what);
                if !paired() {
                    self.turn_off(&mut state, &settings).await;
                }
                Err(errors::remote_unavailable(why))
            }
        }
    }

    /// At startup: turn remote access on when `paired`. A Serve entry that can't be made yet,
    /// as when Tailscale starts after the program, is tried again in the background.
    pub async fn resume(&self, accept: &Accept, paired: bool) {
        let Some(settings) = self.settings.clone() else {
            return;
        };
        if !paired {
            return;
        }
        let mut state = self.state.lock().await;
        if state.is_some() {
            return;
        }
        let mut running = match self.listen(&settings, accept).await {
            Ok(running) => running,
            Err(error) => {
                tracing::error!(error = %error.message, "no remote clients");
                return;
            }
        };
        match url(&settings, running.listen).await {
            Ok(url) => running.url = Some(url),
            Err(why) => {
                tracing::warn!(%why, "Tailscale Serve can't reach the {} yet; trying again", self.what);
                running.retry = Some(retry_serve(Arc::clone(&self.state), settings, self.what));
            }
        }
        *state = Some(running);
    }

    /// Turn remote access off unless `in_use`: a device paired or an offer good. It's asked
    /// with the state held, so a device pairing meanwhile keeps it on.
    pub async fn stop_if_unused(&self, in_use: impl Fn() -> bool) {
        let Some(settings) = self.settings.clone() else {
            return;
        };
        let mut state = self.state.lock().await;
        if in_use() {
            return;
        }
        self.turn_off(&mut state, &settings).await;
    }

    async fn listen(&self, settings: &RemoteSettings, accept: &Accept) -> Result<Running, Error> {
        let listener = TcpListener::bind(settings.listen).await.map_err(|error| {
            errors::remote_unavailable(format!(
                "can't listen on {} for remote clients: {error}",
                settings.listen
            ))
        })?;
        let listen = listener.local_addr().unwrap_or(settings.listen);
        let stop = CancellationToken::new();
        accept(listener, stop.clone());
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

/// The URL devices connect to: the settings', or the Serve entry's, made if need be.
async fn url(settings: &RemoteSettings, listen: SocketAddr) -> Result<String, String> {
    match &settings.url {
        Some(url) => Ok(url.clone()),
        None => settings.serve.ensure(listen).await,
    }
}

/// Try the Serve entry again until it's there or remote access turns off.
fn retry_serve(
    state: Arc<tokio::sync::Mutex<Option<Running>>>,
    settings: RemoteSettings,
    what: &'static str,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(settings.serve_retry).await;
            let mut state = state.lock().await;
            let Some(running) = state.as_mut() else {
                return;
            };
            match url(&settings, running.listen).await {
                Ok(url) => {
                    tracing::info!(%url, "Tailscale Serve reaches the {what}");
                    running.url = Some(url);
                    running.retry = None;
                    return;
                }
                Err(why) => tracing::debug!(%why, "Tailscale Serve still can't reach the {what}"),
            }
        }
    })
}
