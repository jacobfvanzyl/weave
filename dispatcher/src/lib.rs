//! The Dispatcher (`weave dispatcher`, ADR 0027): the person's program, apart from their Hosts,
//! that keeps triggers and Bots and starts their work on the Hosts. It is a client of each Host,
//! paired with it as a service, never a peer and never a Host itself, and it runs no agents.
//! Hosts never connect to it and work on without it.
//!
//! - [`store`]: its state in SQLite: the Hosts it is paired with and the work written down for
//!   them ([`Delivery`]).
//! - [`link`]: a connection to each Host, kept up with backoff, that watches its threads and
//!   sends it the work written down for it.
//! - [`api`]: what the `weave dispatcher` CLI asks over its socket ([`socket`]).
//! - [`client`]: the CLI's end of that.
//!
//! Work reaches a Host once: it is written down before it's sent, under a request key, and
//! sent again on every connection until the Host takes it, which the Host's request keys make
//! safe after a dropped connection, a Host restart or the Dispatcher's own. The specification
//! is `docs/specs/wve-175-dispatcher.md`.

mod api;
pub mod client;
mod link;
pub mod paths;
pub mod socket;
mod store;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::time::Duration;

use agent_client_protocol::Error;
use tokio::net::UnixListener;
use tokio_util::sync::CancellationToken;
use weave_host_client::Credentials;
use weave_host_client::reach::reach;
use weave_host_client::reach::tailnet_name;
use weave_host_client::remote::DeviceKey;
use weave_host_protocol::dispatcher::AddHostRequest;
use weave_host_protocol::dispatcher::DispatcherHost;
use weave_host_protocol::dispatcher::DispatcherStatus;
use weave_host_protocol::errors;
use weave_host_protocol::hello::ClientInfo;
use weave_host_protocol::peers::PeerStatus;
use weave_host_protocol::sessions::SessionListing;

use crate::link::Link;
pub use crate::paths::DispatcherPaths;
pub use crate::store::Delivery;
pub use crate::store::DeliveryState;
use crate::store::Store;
use crate::store::StoredHost;
pub use crate::store::Work;

/// How long a Host has to answer a connection before the Dispatcher tries again later.
pub const DEFAULT_REACH_TIMEOUT: Duration = Duration::from_secs(10);

/// The client name the Dispatcher says hello to Hosts with.
const CLIENT_NAME: &str = "weave-dispatcher";

pub struct DispatcherConfig {
    pub paths: DispatcherPaths,
    /// What it pairs with Hosts as, which their `weave devices` lists: "Dispatcher on
    /// <computer>" by default.
    pub name: String,
    /// Keep its key in the Secure Enclave where there is one; tests keep it in the file.
    pub secure_enclave: bool,
    pub reach_timeout: Duration,
    /// How long it waits to try a Host again after the first failure; each failure after that
    /// doubles it, up to `retry_most`.
    pub retry: Duration,
    pub retry_most: Duration,
}

impl DispatcherConfig {
    pub fn new(paths: DispatcherPaths) -> Self {
        Self {
            paths,
            name: format!("Dispatcher on {}", computer_name()),
            secure_enclave: true,
            reach_timeout: DEFAULT_REACH_TIMEOUT,
            retry: Duration::from_secs(1),
            retry_most: Duration::from_secs(60),
        }
    }
}

/// A running Dispatcher. Clones share it.
#[derive(Clone)]
pub struct Dispatcher {
    shared: Arc<Shared>,
}

pub(crate) struct Shared {
    pub(crate) config: DispatcherConfig,
    pub(crate) store: Store,
    pub(crate) key: DeviceKey,
    started_at: u64,
    /// Cancelled when it stops: every link closes.
    stop: CancellationToken,
    links: Mutex<HashMap<String, Link>>,
}

impl Dispatcher {
    /// Open the database and key in `config.paths`, making them if there are none, and connect
    /// to every Host it is paired with.
    pub fn open(config: DispatcherConfig) -> Result<Self, String> {
        config
            .paths
            .prepare()
            .map_err(|error| format!("creating {}: {error}", config.paths.dir.display()))?;
        let store = Store::open(&config.paths.database())?;
        let key = DeviceKey::kept(&config.paths.key(), config.secure_enclave)?;
        let shared = Arc::new(Shared {
            config,
            store,
            key,
            started_at: now_ms(),
            stop: CancellationToken::new(),
            links: Mutex::new(HashMap::new()),
        });
        for host in shared.store.hosts()? {
            shared.link(host);
        }
        Ok(Self { shared })
    }

    /// Answer the CLI on `listener` until the Dispatcher stops.
    pub async fn serve(&self, listener: UnixListener) {
        api::serve(Arc::clone(&self.shared), listener).await;
    }

    /// Stop: close every Host's connection. Work written down stays for the next start.
    pub async fn stop(&self) {
        self.shared.stop.cancel();
        let links: Vec<Link> = lock(&self.shared.links)
            .drain()
            .map(|(_, link)| link)
            .collect();
        for link in links {
            link.stopped().await;
        }
    }

    pub fn status(&self) -> Result<DispatcherStatus, Error> {
        self.shared.status()
    }

    /// The Hosts it is paired with, and how it reaches each.
    pub fn hosts(&self) -> Result<Vec<DispatcherHost>, Error> {
        self.shared.hosts()
    }

    /// Pair with the Host at `request.url` as a service, with the code `weave pair` showed
    /// there, and keep a connection to it.
    pub async fn add_host(&self, request: AddHostRequest) -> Result<DispatcherHost, Error> {
        self.shared.add_host(request).await
    }

    /// Forget the Host `host` names, by id or name, and the work written down for it.
    pub async fn remove_host(&self, host: &str) -> Result<(), Error> {
        self.shared.remove_host(host).await
    }

    /// Write `work` down for `host_id` and send it as soon as the Host is connected.
    pub fn deliver(&self, host_id: &str, work: Work) -> Result<Delivery, Error> {
        let delivery = self
            .shared
            .store
            .add_delivery(host_id, work)
            .map_err(internal)?;
        if let Some(link) = lock(&self.shared.links).get(host_id) {
            link.wake();
        }
        Ok(delivery)
    }

    /// The delivery `id`, as it stands.
    pub fn delivery(&self, id: &str) -> Result<Option<Delivery>, Error> {
        self.shared.store.delivery(id).map_err(internal)
    }

    /// The threads on `host_id` as the Dispatcher last saw them, while it is connected there.
    pub fn threads(&self, host_id: &str) -> Vec<SessionListing> {
        lock(&self.shared.links)
            .get(host_id)
            .map(Link::threads)
            .unwrap_or_default()
    }
}

impl Shared {
    /// Start a connection to `host`, replacing the one there was.
    fn link(self: &Arc<Self>, host: StoredHost) {
        let host_id = host.host_id.clone();
        let link = Link::start(Arc::clone(self), host);
        if let Some(old) = lock(&self.links).insert(host_id, link) {
            old.stop();
        }
    }

    fn status(&self) -> Result<DispatcherStatus, Error> {
        Ok(DispatcherStatus {
            version: env!("CARGO_PKG_VERSION").to_owned(),
            pid: std::process::id(),
            started_at: self.started_at,
            name: self.config.name.clone(),
            database: self.config.paths.database().display().to_string(),
            pending: self.store.pending_count(None).map_err(internal)?,
        })
    }

    fn hosts(&self) -> Result<Vec<DispatcherHost>, Error> {
        let stored = self.store.hosts().map_err(internal)?;
        let links = lock(&self.links);
        stored
            .into_iter()
            .map(|host| {
                let seen = links.get(&host.host_id).map(Link::seen).unwrap_or_default();
                let (status, why) = match (&host.refused, seen.status) {
                    (Some(why), _) => (PeerStatus::Refused, Some(why.clone())),
                    (None, status) => (status, seen.why),
                };
                Ok(DispatcherHost {
                    pending: self
                        .store
                        .pending_count(Some(&host.host_id))
                        .map_err(internal)?,
                    host_id: host.host_id,
                    name: host.name,
                    url: host.url,
                    device_id: host.device_id,
                    paired_at: host.paired_at,
                    connected: seen.connected,
                    status,
                    why,
                    connected_at: seen.connected_at,
                })
            })
            .collect()
    }

    async fn add_host(self: &Arc<Self>, request: AddHostRequest) -> Result<DispatcherHost, Error> {
        let url = request.url.trim().to_owned();
        let credentials = Credentials::Pair {
            code: request.code,
            name: self.config.name.clone(),
            key: self.key.clone(),
            host: None,
            service: true,
        };
        let (connection, _events, _closed) = reach(
            &url,
            client_info(),
            credentials,
            self.config.reach_timeout,
            "the Dispatcher",
        )
        .await
        .map_err(|unreached| {
            if unreached.refused() {
                unavailable(
                    "it refused the code, which may have expired or been used: show a new one \
                     with `weave pair` there",
                )
            } else {
                unavailable(unreached.why)
            }
        })?;
        let hello = connection.hello().clone();
        connection.shutdown().await;
        let device = hello
            .device
            .filter(|device| device.service)
            .ok_or_else(|| unavailable("it didn't take the Dispatcher as a service"))?;
        let host = StoredHost {
            host_id: hello.host.id.clone(),
            name: request.name.unwrap_or_else(|| tailnet_name(&url)),
            url,
            device_id: device.id,
            paired_at: now_ms(),
            refused: None,
        };
        self.store.put_host(&host).map_err(internal)?;
        tracing::info!(host = %host.host_id, name = %host.name, "paired with a Host");
        let host_id = host.host_id.clone();
        self.link(host);
        self.hosts()?
            .into_iter()
            .find(|listed| listed.host_id == host_id)
            .ok_or_else(|| Error::internal_error().data("the Host it paired with went missing"))
    }

    async fn remove_host(&self, host: &str) -> Result<(), Error> {
        let stored = self.store.hosts().map_err(internal)?;
        let found = stored
            .iter()
            .find(|stored| stored.host_id == host)
            .or_else(|| {
                stored
                    .iter()
                    .find(|stored| stored.name.eq_ignore_ascii_case(host))
            })
            .ok_or_else(|| {
                Error::invalid_params().data(format!("the Dispatcher isn't paired with {host}"))
            })?;
        self.store.remove_host(&found.host_id).map_err(internal)?;
        let link = lock(&self.links).remove(&found.host_id);
        if let Some(link) = link {
            link.stop();
            link.stopped().await;
        }
        tracing::info!(host = %found.host_id, name = %found.name, "forgot a Host");
        Ok(())
    }
}

/// What the Dispatcher says hello to Hosts as.
fn client_info() -> ClientInfo {
    ClientInfo {
        name: CLIENT_NAME.to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
    }
}

/// A Host couldn't be reached or refused, saying why.
fn unavailable(why: impl Into<String>) -> Error {
    Error::new(errors::PEER_UNAVAILABLE, why.into())
}

fn internal(why: String) -> Error {
    Error::internal_error().data(why)
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

/// This computer's name, without macOS's `.local`.
fn computer_name() -> String {
    #[cfg(unix)]
    {
        let mut buffer = [0u8; 256];
        // SAFETY: the buffer is ours and its length is given.
        let read = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
        if read == 0 {
            let end = buffer.iter().position(|byte| *byte == 0).unwrap_or(0);
            let name = String::from_utf8_lossy(&buffer[..end]);
            let name = name.strip_suffix(".local").unwrap_or(&name);
            if !name.is_empty() {
                return name.to_owned();
            }
        }
    }
    "this computer".to_owned()
}
