//! The Dispatcher (`weave dispatcher`, ADR 0027): the person's program, apart from their Hosts,
//! that keeps triggers and Bots and starts their work on the Hosts. Hosts join it and keep a
//! connection open to it (ADR 0030), over which it is a client of each Host with the `service`
//! role, never a peer and never a Host itself; it runs no agents. Hosts work on without it.
//!
//! - [`store`]: its state in SQLite: the Hosts that joined it and the work written down for
//!   them ([`Delivery`]).
//! - [`joins`]: Hosts joining with a code, and proving their keys on each connection after.
//! - [`link`]: each Host's connection, once it has proved itself, over which the Dispatcher
//!   watches its threads and sends it the work written down for it.
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
mod carry;
pub mod client;
mod devices;
mod follows;
mod joins;
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
use tokio::net::UnixListener;
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use weave_host_client::HostHandle;
use weave_host_client::remote::DeviceKey;
use weave_host_protocol::dispatcher::AddScheduleRequest;
use weave_host_protocol::dispatcher::DispatcherHost;
use weave_host_protocol::dispatcher::DispatcherStatus;
use weave_host_protocol::dispatcher::Occurrence;
use weave_host_protocol::dispatcher::OfferHostResponse;
use weave_host_protocol::dispatcher::Overlap;
use weave_host_protocol::dispatcher::Reachability;
use weave_host_protocol::dispatcher::Schedule;
use weave_host_protocol::hello::ClientInfo;
use weave_host_protocol::threads::ThreadId;
use weave_host_protocol::threads::ThreadListing;
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

/// How long a Host has to answer the Dispatcher's hello on the connection it opened.
pub const DEFAULT_REACH_TIMEOUT: Duration = Duration::from_secs(10);

/// The loopback address the Dispatcher's WebSocket listens on for the person's devices, beside
/// the Host's 7341; its Tailscale Serve entry is on HTTPS port 7342.
pub const DEFAULT_LISTEN: &str = "127.0.0.1:7342";

/// The client name the Dispatcher says hello to Hosts with.
const CLIENT_NAME: &str = "weave-dispatcher";

pub struct DispatcherConfig {
    pub paths: DispatcherPaths,
    /// What it calls itself to the Hosts that join it: "Dispatcher on <computer>" by default.
    pub name: String,
    /// Keep its key in the Secure Enclave where there is one; tests keep it in the file.
    pub secure_enclave: bool,
    pub reach_timeout: Duration,
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
    /// The codes Hosts join with.
    pub(crate) joins: joins::Joins,
    /// The person's devices' connections carried to their Hosts (WVE-195).
    pub(crate) carries: carry::Carries,
    /// The next number for a connection to its API.
    pub(crate) next_connection: std::sync::atomic::AtomicU64,
    started_at: u64,
    /// Cancelled when it stops: every link closes, and schedules stop.
    pub(crate) stop: CancellationToken,
    /// Each Host's connection, once it has connected since the Dispatcher started.
    pub(crate) links: Mutex<HashMap<String, Link>>,
    /// Rung when a schedule is added, changed or removed.
    schedules_changed: Notify,
    scheduler: Mutex<Option<JoinHandle<()>>>,
}

impl Dispatcher {
    /// Open the database and key in `config.paths`, making them if there are none. Hosts that
    /// joined it connect to it once it serves.
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
            joins: joins::Joins::default(),
            carries: carry::Carries::default(),
            next_connection: std::sync::atomic::AtomicU64::new(1),
            started_at: now_ms(),
            stop: CancellationToken::new(),
            links: Mutex::new(HashMap::new()),
            schedules_changed: Notify::new(),
            scheduler: Mutex::new(None),
        });
        let scheduler = tokio::spawn(scheduler::run(Arc::clone(&shared)));
        *lock(&shared.scheduler) = Some(scheduler);
        Ok(Self { shared })
    }

    /// Answer the CLI on `listener` until the Dispatcher stops, Hosts on this computer on the
    /// socket beside it, and the person's devices and other Hosts on its WebSocket while one is
    /// paired or joined.
    pub async fn serve(&self, listener: UnixListener) {
        match socket::listen_hosts(&self.shared.config.paths) {
            Ok(hosts) => {
                tokio::spawn(joins::serve_socket(Arc::clone(&self.shared), hosts));
            }
            Err(error) => {
                tracing::error!(%error, "Hosts on this computer can't connect to the Dispatcher");
            }
        }
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

    /// The Hosts that joined it, and how each stands.
    pub fn hosts(&self) -> Result<Vec<DispatcherHost>, Error> {
        self.shared.hosts()
    }

    /// A code a Host joins with, and where it connects: the WebSocket, turned on if it isn't,
    /// or for a Host on this computer (`here`) the socket beside the Dispatcher's own.
    pub async fn offer_host(&self, here: bool) -> Result<OfferHostResponse, Error> {
        api::offer_host(&self.shared, here).await
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
    pub fn threads(&self, host_id: &str) -> Vec<ThreadListing> {
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

    /// The thread `thread_id` on `host_id` as the Dispatcher last saw it.
    pub(crate) fn thread(&self, host_id: &str, thread_id: &ThreadId) -> Option<ThreadListing> {
        lock(&self.links).get(host_id)?.listing(thread_id)
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
            .ok_or_else(|| invalid(format!("no Host called {by} has joined the Dispatcher")))
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
                let (status, why) = match (&host.refused, &host.public_key) {
                    (Some(why), _) => (Reachability::Refused, Some(why.clone())),
                    (None, None) => (
                        Reachability::Unjoined,
                        Some(
                            "it was paired before Hosts joined the Dispatcher: `weave hosts add` \
                             there joins it"
                                .to_owned(),
                        ),
                    ),
                    (None, Some(_)) => match (seen.status, seen.why) {
                        (Reachability::Unchecked, None) => (
                            Reachability::Unchecked,
                            Some("it hasn't connected since the Dispatcher started".to_owned()),
                        ),
                        (status, why) => (status, why),
                    },
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
                    joined_at: host.joined_at,
                    here: host.here,
                    connected: seen.connected,
                    status,
                    why,
                    connected_at: seen.connected_at,
                })
            })
            .collect()
    }

    async fn remove_host(self: &Arc<Self>, host: &str) -> Result<(), Error> {
        let found = self.resolve_host(host)?;
        self.store.remove_host(&found.host_id).map_err(internal)?;
        let link = lock(&self.links).remove(&found.host_id);
        self.carries.close_host(&found.host_id);
        if let Some(link) = link {
            link.revoke();
            link.stopped().await;
        }
        tracing::info!(host = %found.host_id, name = %found.name, "forgot a Host");
        api::stop_if_unused(self).await;
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

/// The request was wrong, saying how: in the message, which clients show.
pub(crate) fn invalid(why: impl Into<String>) -> Error {
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
