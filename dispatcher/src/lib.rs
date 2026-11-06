//! The Dispatcher (`weave dispatcher`, ADR 0027): the person's program, apart from their Hosts,
//! that keeps triggers and Bots and starts their work on the Hosts. It is a client of each Host,
//! paired with it as a service, never a peer and never a Host itself, and it runs no agents.
//! Hosts never connect to it and work on without it.
//!
//! - [`store`]: its state in SQLite: the Hosts it is paired with and the work written down for
//!   them ([`Delivery`]).
//! - [`link`]: a connection to each Host, kept up with backoff, that watches its threads and
//!   sends it the work written down for it.
//! - [`scheduler`]: schedules (WVE-145), whose occurrences start headless turns at their times.
//! - [`calls`] and [`follows`]: the calls Hosts' agents make to the person's other Hosts
//!   (ADR 0029), which the Dispatcher sends there, and the turns they began, which it follows
//!   and reports on to the calling thread.
//! - [`api`]: what the `weave` CLI asks over its socket ([`socket`]), and over its WebSocket
//!   from the person's other devices once one pairs ([`devices`], WVE-176), which
//!   `weave-remote` serves as it does the Host's.
//! - [`client`]: the CLI's end of that.
//!
//! Work reaches a Host once: it is written down before it's sent, under a request key, and
//! sent again on every connection until the Host takes it, which the Host's request keys make
//! safe after a dropped connection, a Host restart or the Dispatcher's own. The specification
//! is `docs/specs/wve-175-dispatcher.md`.

mod api;
mod calls;
pub mod client;
mod devices;
mod follows;
mod link;
pub mod paths;
mod scheduler;
pub mod socket;
mod store;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::time::Duration;

use agent_client_protocol::Error;
use agent_client_protocol::schema::v1::SessionId;
use tokio::net::UnixListener;
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use weave_host_client::Credentials;
use weave_host_client::HostHandle;
use weave_host_client::reach::reach;
use weave_host_client::reach::tailnet_name;
use weave_host_client::remote::DeviceKey;
use weave_host_protocol::dispatcher::AddHostRequest;
use weave_host_protocol::dispatcher::AddScheduleRequest;
use weave_host_protocol::dispatcher::DispatcherHost;
use weave_host_protocol::dispatcher::DispatcherStatus;
use weave_host_protocol::dispatcher::Occurrence;
use weave_host_protocol::dispatcher::Overlap;
use weave_host_protocol::dispatcher::Reachability;
use weave_host_protocol::dispatcher::Schedule;
use weave_host_protocol::errors;
use weave_host_protocol::hello::ClientInfo;
use weave_host_protocol::sessions::SessionListing;
use weave_remote::access::Remote;
use weave_remote::access::RemoteSettings;

use crate::link::Link;
use crate::link::Seen;
pub use crate::paths::DispatcherPaths;
pub use crate::scheduler::Clock;
use crate::scheduler::Plan;
pub use crate::scheduler::SystemClock;
pub use crate::store::Delivery;
pub use crate::store::DeliveryState;
use crate::store::Fired;
use crate::store::Store;
use crate::store::StoredHost;
use crate::store::StoredSchedule;
pub use crate::store::Work;

/// How long a Host has to answer a connection before the Dispatcher tries again later.
pub const DEFAULT_REACH_TIMEOUT: Duration = Duration::from_secs(10);

/// The loopback address the Dispatcher's WebSocket listens on for the person's devices, beside
/// the Host's 7341; its Tailscale Serve entry is on HTTPS port 7342.
pub const DEFAULT_LISTEN: &str = "127.0.0.1:7342";

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
    /// The clock schedules run by.
    pub clock: Arc<dyn Clock>,
    /// How it serves the person's devices once one pairs ([`DEFAULT_LISTEN`] and its own
    /// Tailscale Serve entry, as `weave dispatcher run` gives it); none serves only the socket.
    pub remote: Option<RemoteSettings>,
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
            clock: Arc::new(SystemClock),
            remote: None,
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
    /// Its own id, which its paired devices know it by.
    pub(crate) id: String,
    /// The WebSocket the person's devices reach it on, while one is paired.
    pub(crate) remote: Remote,
    pub(crate) devices: devices::Devices,
    /// The next number for a connection to its API.
    pub(crate) next_connection: std::sync::atomic::AtomicU64,
    started_at: u64,
    /// Cancelled when it stops: every link closes, and schedules stop.
    stop: CancellationToken,
    links: Mutex<HashMap<String, Link>>,
    /// Rung when a schedule is added, changed or removed.
    schedules_changed: Notify,
    scheduler: Mutex<Option<JoinHandle<()>>>,
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
        let id = store.identity()?;
        let remote = Remote::new("Dispatcher", config.remote.clone());
        let shared = Arc::new(Shared {
            config,
            store,
            key,
            id,
            remote,
            devices: devices::Devices::default(),
            next_connection: std::sync::atomic::AtomicU64::new(1),
            started_at: now_ms(),
            stop: CancellationToken::new(),
            links: Mutex::new(HashMap::new()),
            schedules_changed: Notify::new(),
            scheduler: Mutex::new(None),
        });
        for host in shared.store.hosts()? {
            shared.link(host);
        }
        let scheduler = tokio::spawn(scheduler::run(Arc::clone(&shared)));
        *lock(&shared.scheduler) = Some(scheduler);
        Ok(Self { shared })
    }

    /// Answer the CLI on `listener` until the Dispatcher stops, and the person's devices on
    /// its WebSocket while one is paired.
    pub async fn serve(&self, listener: UnixListener) {
        api::resume_remote(&self.shared).await;
        api::serve(Arc::clone(&self.shared), listener).await;
    }

    /// Stop: close every Host's connection. Work written down stays for the next start.
    pub async fn stop(&self) {
        self.shared.stop.cancel();
        let scheduler = lock(&self.shared.scheduler).take();
        if let Some(scheduler) = scheduler {
            let _ = scheduler.await;
        }
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

    pub fn schedules(&self) -> Result<Vec<Schedule>, Error> {
        self.shared.schedules()
    }

    pub fn add_schedule(&self, request: AddScheduleRequest) -> Result<Schedule, Error> {
        self.shared.add_schedule(request)
    }

    /// Forget the schedule `by` names, by id or name, and its occurrences.
    pub fn remove_schedule(&self, by: &str) -> Result<(), Error> {
        self.shared.remove_schedule(by)
    }

    pub fn pause_schedule(&self, by: &str) -> Result<Schedule, Error> {
        self.shared.pause_schedule(by)
    }

    pub fn resume_schedule(&self, by: &str) -> Result<Schedule, Error> {
        self.shared.resume_schedule(by)
    }

    /// Run the schedule `by` names now, as an occurrence of its own.
    pub fn run_schedule(&self, by: &str) -> Result<Occurrence, Error> {
        self.shared.run_schedule(by)
    }

    /// The latest occurrences, of the schedule `by` names or of all, newest first.
    pub fn occurrences(
        &self,
        by: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Vec<Occurrence>, Error> {
        self.shared.occurrences(by, limit)
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
    /// Send `host_id` the work written down for it, if it's connected.
    pub(crate) fn wake(&self, host_id: &str) {
        if let Some(link) = lock(&self.links).get(host_id) {
            link.wake();
        }
    }

    /// The connection to `host_id`, while there's one.
    pub(crate) fn handle(&self, host_id: &str) -> Option<HostHandle> {
        lock(&self.links).get(host_id)?.seen().handle
    }

    /// How the link to `host_id` stands.
    pub(crate) fn seen(&self, host_id: &str) -> Seen {
        lock(&self.links)
            .get(host_id)
            .map(Link::seen)
            .unwrap_or_default()
    }

    /// The thread `session_id` on `host_id` as the Dispatcher last saw it.
    pub(crate) fn thread(&self, host_id: &str, session_id: &SessionId) -> Option<SessionListing> {
        lock(&self.links).get(host_id)?.listing(session_id)
    }

    /// The Hosts the Dispatcher is paired with, as `hosts/list` gives them.
    pub(crate) fn listed_hosts(&self) -> Result<Vec<DispatcherHost>, Error> {
        self.hosts()
    }

    /// The Host `by` names, by id or else by name.
    fn resolve_host(&self, by: &str) -> Result<StoredHost, Error> {
        let stored = self.store.hosts().map_err(internal)?;
        stored
            .iter()
            .find(|stored| stored.host_id == by)
            .or_else(|| {
                stored
                    .iter()
                    .find(|stored| stored.name.eq_ignore_ascii_case(by))
            })
            .cloned()
            .ok_or_else(|| invalid(format!("the Dispatcher isn't paired with {by}")))
    }

    fn resolve_schedule(&self, by: &str) -> Result<StoredSchedule, Error> {
        self.store
            .find_schedule(by)
            .map_err(internal)?
            .ok_or_else(|| invalid(format!("there's no schedule {by}")))
    }

    fn schedules(&self) -> Result<Vec<Schedule>, Error> {
        let schedules = self.store.schedules().map_err(internal)?;
        let hosts = self.store.hosts().map_err(internal)?;
        let now = self.config.clock.now();
        schedules
            .into_iter()
            .map(|schedule| self.listing(schedule, &hosts, now))
            .collect()
    }

    fn schedule(&self, id: &str) -> Result<Schedule, Error> {
        let schedule = self.resolve_schedule(id)?;
        let hosts = self.store.hosts().map_err(internal)?;
        self.listing(schedule, &hosts, self.config.clock.now())
    }

    fn listing(
        &self,
        schedule: StoredSchedule,
        hosts: &[StoredHost],
        now: u64,
    ) -> Result<Schedule, Error> {
        let next_at = match &schedule.paused {
            Some(_) => None,
            None => Plan::new(&schedule.cron, &schedule.zone)
                .ok()
                .and_then(|plan| plan.next_after(now).map(|at| (at, plan.describe(at)))),
        };
        let last = self
            .store
            .occurrences(Some(&schedule.id), 1)
            .map_err(internal)?
            .into_iter()
            .next();
        Ok(Schedule {
            host_name: hosts
                .iter()
                .find(|host| host.host_id == schedule.host_id)
                .map(|host| host.name.clone())
                .unwrap_or_default(),
            id: schedule.id,
            name: schedule.name,
            cron: schedule.cron,
            zone: schedule.zone,
            host_id: schedule.host_id,
            run: schedule.run,
            missed: schedule.missed,
            overlap: schedule.overlap,
            created_at: schedule.created_at,
            paused: schedule.paused,
            failures: schedule.failures,
            next_at: next_at.as_ref().map(|(at, _)| *at),
            next: next_at.map(|(_, words)| words),
            last,
        })
    }

    fn add_schedule(&self, request: AddScheduleRequest) -> Result<Schedule, Error> {
        let name = request.name.trim().to_owned();
        if name.is_empty() {
            return Err(invalid("a schedule needs a name".to_owned()));
        }
        if request.run.prompt.is_empty() {
            return Err(invalid("a schedule needs a prompt".to_owned()));
        }
        if request.run.thread.is_some() && request.overlap == Overlap::Allow {
            return Err(invalid(
                "a schedule that prompts one thread can't overlap its runs: they'd queue there"
                    .to_owned(),
            ));
        }
        let zone = request.zone.unwrap_or_else(scheduler::local_zone);
        let cron = request.cron.trim().to_owned();
        Plan::new(&cron, &zone).map_err(invalid)?;
        let host = self.resolve_host(&request.host)?;
        let now = self.config.clock.now();
        let schedule = StoredSchedule {
            id: StoredSchedule::new_id(),
            name,
            cron,
            zone,
            host_id: host.host_id,
            run: request.run,
            missed: request.missed,
            overlap: request.overlap,
            created_at: now,
            considered_until: now,
            paused: None,
            failures: 0,
        };
        self.store.add_schedule(&schedule).map_err(invalid)?;
        tracing::info!(schedule = %schedule.name, "added a schedule");
        self.schedules_changed.notify_one();
        self.schedule(&schedule.id)
    }

    fn remove_schedule(&self, by: &str) -> Result<(), Error> {
        let schedule = self.resolve_schedule(by)?;
        self.store.remove_schedule(&schedule.id).map_err(internal)?;
        tracing::info!(schedule = %schedule.name, "removed a schedule");
        self.schedules_changed.notify_one();
        Ok(())
    }

    fn pause_schedule(&self, by: &str) -> Result<Schedule, Error> {
        let schedule = self.resolve_schedule(by)?;
        self.store
            .pause(&schedule.id, "you paused it")
            .map_err(internal)?;
        self.schedules_changed.notify_one();
        self.schedule(&schedule.id)
    }

    fn resume_schedule(&self, by: &str) -> Result<Schedule, Error> {
        let schedule = self.resolve_schedule(by)?;
        self.store
            .resume(&schedule.id, self.config.clock.now())
            .map_err(internal)?;
        self.schedules_changed.notify_one();
        self.schedule(&schedule.id)
    }

    fn run_schedule(&self, by: &str) -> Result<Occurrence, Error> {
        let schedule = self.resolve_schedule(by)?;
        let plan = Plan::new(&schedule.cron, &schedule.zone).map_err(internal)?;
        let now = self.config.clock.now();
        match scheduler::fire(self, &schedule, &plan, now, false, true, now).map_err(internal)? {
            Fired::Started(occurrence, _) | Fired::Skipped(occurrence) => Ok(occurrence),
            Fired::Already => Err(invalid("it was run by hand a moment ago; try again")),
        }
    }

    fn occurrences(&self, by: Option<&str>, limit: Option<u32>) -> Result<Vec<Occurrence>, Error> {
        let schedule = by.map(|by| self.resolve_schedule(by)).transpose()?;
        self.store
            .occurrences(
                schedule.as_ref().map(|schedule| schedule.id.as_str()),
                limit.unwrap_or(50),
            )
            .map_err(internal)
    }

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
            id: self.id.clone(),
            remote: self.remote.address(),
            devices: u32::try_from(self.store.devices().map_err(internal)?.len())
                .unwrap_or(u32::MAX),
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
                    (Some(why), _) => (Reachability::Refused, Some(why.clone())),
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
            .ok_or_else(|| internal("the Host it paired with went missing".to_owned()))
    }

    async fn remove_host(&self, host: &str) -> Result<(), Error> {
        let found = self.resolve_host(host)?;
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
    Error::new(errors::HOST_UNAVAILABLE, why.into())
}

/// The request was wrong, saying how: in the message, which clients show.
fn invalid(why: impl Into<String>) -> Error {
    let mut error = Error::invalid_params();
    error.message = why.into();
    error
}

fn internal(why: String) -> Error {
    let mut error = Error::internal_error();
    error.message = why;
    error
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
pub fn computer_name() -> String {
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
