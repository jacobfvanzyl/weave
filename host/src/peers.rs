//! Peer Hosts (ADRs 0017 and 0024, WVE-109): the person's other Hosts this Host has paired with,
//! and what its agents do there through the Host tools that name one.
//!
//! - **The key.** This Host proves itself to its peers with a P-256 key of its own, the first
//!   secret it keeps: in the Secure Enclave on a Mac that has one, so it can't be copied off the
//!   computer, and otherwise in a file only the Host's user reads. `host-key.json` holds it, or
//!   the Secure Enclave's wrapped form of it, which no other computer can use.
//! - **Pairing.** `peers/add` connects to a peer's WebSocket and pairs with the code `weave
//!   pair` showed there, naming this Host's id, so the peer keeps this Host as a paired device.
//!   `peers.json` (0600) records each peer's id, name, URL and the device id it gave this Host.
//! - **Connections.** A peer is reached when a Host tool names it: this Host connects as a
//!   remote client, proving its key at hello, or the tool fails at once. A connection stays
//!   while a turn there is followed, and closes after a minute unused otherwise. How the last
//!   attempt went, or how the peer closed the connection, is its status.
//! - **Beginning a turn.** A request that begins a turn on a peer is recorded in `peers.json`
//!   before it's sent, and kept until the peer answers; one whose answer was lost is sent again
//!   under the same key until one comes, across restarts, and its caller told then.
//! - **Following.** A turn this Host's agent began on a peer is followed until it ends: this
//!   Host observes the peer's session, and reports to the calling session here, as
//!   [`host_tools::tell`] does for its own sessions, how the turn ended or that it waits on a
//!   person there. `peers.json` keeps the turns followed, so a Host that restarts follows them
//!   again, and one that loses a peer reconnects and catches up after its position.
//! - **One hop.** Nothing here passes a peer's request on: peers reach this Host as remote
//!   clients, which may not manage peers, and turns a peer's agent began here reach none of
//!   this Host's peers ([`host_tools`]).

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

use agent_client_protocol::Error;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use serde::Serialize;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use weave_acp_core::schema::SessionId;
use weave_host_client::ConnectError;
use weave_host_client::Credentials;
use weave_host_client::HostConnection;
use weave_host_client::HostEvent;
use weave_host_client::HostHandle;
use weave_host_client::remote::CloseReason;
use weave_host_client::remote::DeviceKey;
use weave_host_client::remote::answered_without_host;
use weave_host_client::remote::connect_websocket;
use weave_host_protocol::Timestamp;
use weave_host_protocol::devices::DeviceId;
use weave_host_protocol::errors;
use weave_host_protocol::events::SessionEvent;
use weave_host_protocol::hello::ClientCapabilities;
use weave_host_protocol::hello::ClientInfo;
use weave_host_protocol::peers::AddPeerRequest;
use weave_host_protocol::peers::ListPeersResponse;
use weave_host_protocol::peers::Peer;
use weave_host_protocol::peers::PeerStatus;
use weave_host_protocol::pending::PendingId;
use weave_host_protocol::pending::PendingKind;
use weave_host_protocol::pending::PendingRequest;
use weave_host_protocol::queue::AddQueuedRequest;
use weave_host_protocol::queue::AddQueuedResponse;
use weave_host_protocol::sessions::AttachSessionRequest;
use weave_host_protocol::sessions::CloseWhen;
use weave_host_protocol::sessions::DetachSessionRequest;
use weave_host_protocol::sessions::GetSessionRequest;
use weave_host_protocol::sessions::JournalPosition;
use weave_host_protocol::sessions::RunRequest;
use weave_host_protocol::sessions::RunResponse;
use weave_host_protocol::turns::TurnId;
use weave_host_protocol::websocket::CLOSE_REVOKED;

use crate::Shared;
use crate::devices::write_private;
use crate::host_tools;
use crate::host_tools::Asks;
use crate::host_tools::Named;
use crate::journal::now_ms;
use crate::session::lock;

/// How long reaching a peer may take before a tool call says it can't be reached.
const REACH_TIMEOUT: Duration = Duration::from_secs(10);
/// How long to wait before trying a lost peer again, at first, while following a turn there.
const RETRY: Duration = Duration::from_secs(5);
/// The longest wait between tries.
const MAX_RETRY: Duration = Duration::from_secs(300);
/// How long a connection to a peer nothing follows stays open after its last use.
const IDLE: Duration = Duration::from_secs(60);
/// What this Host calls itself as a client of its peers.
const CLIENT_NAME: &str = "weave-host";

/// How a Host pairs with and reaches its peer Hosts.
#[derive(Clone, Debug)]
pub struct PeerSettings {
    /// `peers.json`: the peers and the turns followed there; none keeps them in memory.
    pub file: Option<PathBuf>,
    /// `host-key.json`: the key this Host proves itself with; none keeps it in memory.
    pub key: Option<PathBuf>,
    /// Make the key in the Secure Enclave where there's one.
    pub secure_enclave: bool,
    /// What this Host calls itself when it pairs: the computer's name.
    pub name: String,
    /// How long reaching a peer may take.
    pub reach_timeout: Duration,
    /// How long to wait before trying a lost peer again, at first.
    pub retry: Duration,
    /// How long a connection nothing follows stays open after its last use.
    pub idle: Duration,
    /// The home directory `~/…` paths between Hosts are under; `$HOME` when none.
    pub home: Option<PathBuf>,
}

impl PeerSettings {
    /// The Host's defaults, with its peers in `file` and its key in `key`.
    pub fn new(file: Option<PathBuf>, key: Option<PathBuf>) -> Self {
        Self {
            file,
            key,
            secure_enclave: true,
            name: computer_name(),
            reach_timeout: REACH_TIMEOUT,
            retry: RETRY,
            idle: IDLE,
            home: None,
        }
    }
}

/// `peers.json`.
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct File {
    #[serde(default)]
    peers: Vec<Stored>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    following: Vec<Followed>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    sending: Vec<Sending>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    host_id: String,
    name: String,
    url: String,
    /// The id the peer gave this Host as its paired device.
    device_id: DeviceId,
    paired_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_seen_at: Option<Timestamp>,
}

/// A turn this Host's agent began on a peer, followed until it ends.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Followed {
    pub(crate) host_id: String,
    pub(crate) session_id: SessionId,
    pub(crate) turn_id: TurnId,
    /// The session here whose agent began it, which hears how it goes.
    pub(crate) caller: SessionId,
    /// The caller started the session there, so the turn counts among its delegated sessions
    /// running.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(crate) delegated: bool,
    /// The requests waiting on a person there that the caller has been told of.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) told: Vec<PendingId>,
}

impl Followed {
    fn is(&self, other: &Self) -> bool {
        self.host_id == other.host_id
            && self.session_id == other.session_id
            && self.turn_id == other.turn_id
            && self.caller == other.caller
    }
}

/// A request beginning a turn on a peer, which this Host records before it sends it and keeps
/// until the peer answers, so that a lost answer, or this Host stopping, doesn't leave a turn
/// there that nobody follows. Its key makes sending it again safe.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Sending {
    pub(crate) host_id: String,
    /// The session here whose agent asks.
    pub(crate) caller: SessionId,
    /// It starts a session there, delegated by the caller.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(crate) delegated: bool,
    pub(crate) request: Begin,
}

/// What begins a turn on a peer.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Begin {
    Run(RunRequest),
    Queue(AddQueuedRequest),
}

impl Begin {
    fn key(&self) -> Option<&str> {
        match self {
            Self::Run(request) => request.key.as_deref(),
            Self::Queue(request) => request.key.as_deref(),
        }
    }

    /// The tool that asked, for reports.
    fn tool(&self) -> &'static str {
        match self {
            Self::Run(_) => "start_session",
            Self::Queue(_) => "prompt_session",
        }
    }
}

/// A peer's answer to a [`Begin`].
pub(crate) enum Begun {
    Run(RunResponse),
    Queue(AddQueuedResponse),
}

/// `host-key.json`: the key, or the Secure Enclave's wrapped form of it, in unpadded base64url.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum SavedKey {
    SecureEnclave(String),
    Software(String),
}

/// Why a peer couldn't be reached: refused, down, unreachable or another Host, and how.
#[derive(Debug)]
pub(crate) struct Unreached {
    pub(crate) status: PeerStatus,
    pub(crate) why: String,
}

impl Unreached {
    fn new(status: PeerStatus, why: impl Into<String>) -> Self {
        Self {
            status,
            why: why.into(),
        }
    }

    /// Nothing answered, or the connection failed.
    fn unreachable(why: impl Into<String>) -> Self {
        Self::new(PeerStatus::Unreachable, why)
    }

    /// It refused this Host, as after revoking it: pairing again is the way back, so trying
    /// again won't help.
    fn refused(&self) -> bool {
        self.status == PeerStatus::Refused
    }
}

impl std::fmt::Display for Unreached {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.why)
    }
}

pub(crate) struct Peers {
    settings: PeerSettings,
    /// Cancelled when the Host stops: following ends, and connections close.
    stopping: CancellationToken,
    state: Mutex<State>,
    /// Connecting to each peer, one attempt at a time.
    connecting: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

#[derive(Default)]
struct State {
    key: Option<DeviceKey>,
    peers: BTreeMap<String, Stored>,
    following: Vec<Followed>,
    sending: Vec<Sending>,
    links: HashMap<String, Link>,
    /// How the last attempt to reach each peer since this Host started went, and why it
    /// failed.
    reached: HashMap<String, (PeerStatus, Option<String>)>,
    /// The task following each peer session's turns, woken when one is added.
    watches: HashMap<(String, SessionId), mpsc::UnboundedSender<()>>,
    next_link: u64,
}

/// A connection to a peer, which hands what the peer sends about each session to the task
/// following it.
#[derive(Clone)]
struct Link {
    id: u64,
    handle: HostHandle,
    routes: Arc<Mutex<HashMap<SessionId, mpsc::UnboundedSender<HostEvent>>>>,
    used: Arc<Mutex<Instant>>,
    stop: CancellationToken,
}

impl Link {
    fn touch(&self) {
        *lock(&self.used) = Instant::now();
    }
}

impl Peers {
    /// The peers `settings.file` records, or none yet.
    pub(crate) fn load(settings: PeerSettings) -> Self {
        let file = settings
            .file
            .as_deref()
            .and_then(|path| match std::fs::read(path) {
                Ok(bytes) => serde_json::from_slice::<File>(&bytes)
                    .inspect_err(|error| {
                        tracing::warn!(%error, path = %path.display(), "peers unreadable; starting with none");
                    })
                    .ok(),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => {
                    tracing::warn!(%error, path = %path.display(), "peers unreadable; starting with none");
                    None
                }
            })
            .unwrap_or_default();
        Self {
            settings,
            stopping: CancellationToken::new(),
            state: Mutex::new(State {
                peers: file
                    .peers
                    .into_iter()
                    .map(|peer| (peer.host_id.clone(), peer))
                    .collect(),
                following: file.following,
                sending: file.sending,
                ..State::default()
            }),
            connecting: Mutex::new(HashMap::new()),
        }
    }

    fn save(&self, state: &State) {
        let Some(path) = &self.settings.file else {
            return;
        };
        let file = File {
            peers: state.peers.values().cloned().collect(),
            following: state.following.clone(),
            sending: state.sending.clone(),
        };
        if let Err(error) = write_private(path, &file) {
            tracing::warn!(%error, path = %path.display(), "writing peers failed");
        }
    }

    /// This Host's key: the one it keeps, or a new one, in the Secure Enclave where it can.
    fn key(&self) -> Result<DeviceKey, String> {
        let mut state = lock(&self.state);
        if let Some(key) = &state.key {
            return Ok(key.clone());
        }
        let kept = match &self.settings.key {
            Some(path) => read_key(path)?,
            None => None,
        };
        let key = match kept {
            Some(key) => key,
            None => {
                let key = if self.settings.secure_enclave {
                    DeviceKey::in_secure_enclave().unwrap_or_else(|why| {
                        tracing::info!(%why, "no Secure Enclave for this Host's key; keeping it in a file");
                        DeviceKey::generate()
                    })
                } else {
                    DeviceKey::generate()
                };
                if let Some(path) = &self.settings.key {
                    write_key(path, &key)?;
                }
                key
            }
        };
        state.key = Some(key.clone());
        Ok(key)
    }

    /// The peer `host` names, by id or else by name: its id and name.
    pub(crate) fn resolve(&self, host: &str) -> Result<(String, String), String> {
        let state = lock(&self.state);
        if let Some(peer) = state.peers.get(host) {
            return Ok((peer.host_id.clone(), peer.name.clone()));
        }
        let named: Vec<&Stored> = state
            .peers
            .values()
            .filter(|peer| peer.name.eq_ignore_ascii_case(host))
            .collect();
        match named.as_slice() {
            [peer] => Ok((peer.host_id.clone(), peer.name.clone())),
            [] if state.peers.is_empty() => Err(format!(
                "This Host has no peer Host {host}: it isn't paired with any. Pairing Hosts is \
                 the person's to do, with `weave hosts add`."
            )),
            [] => Err(format!(
                "This Host has no peer Host {host}. list_hosts gives the ones it has: {}.",
                state
                    .peers
                    .values()
                    .map(|peer| format!("{} ({})", peer.name, peer.host_id))
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
            _ => Err(format!(
                "More than one peer Host is called {host}; name it by its id, as list_hosts \
                 gives it."
            )),
        }
    }

    /// The home directory `~/…` paths between Hosts are under.
    pub(crate) fn home(&self) -> PathBuf {
        self.settings
            .home
            .clone()
            .unwrap_or_else(crate::client::home)
    }

    /// What this Host calls the peer `host_id`.
    pub(crate) fn name_of(&self, host_id: &str) -> Option<String> {
        lock(&self.state)
            .peers
            .get(host_id)
            .map(|peer| peer.name.clone())
    }

    /// `peers/add`: pair with the Host at the request's URL, with the code `weave pair` showed
    /// there. Pairing again with a peer replaces it.
    pub(crate) async fn add(
        &self,
        shared: &Arc<Shared>,
        request: AddPeerRequest,
    ) -> Result<Peer, Error> {
        let url = request.url.trim().to_owned();
        let key = self.key().map_err(|why| {
            Error::internal_error().data(format!("this Host's key can't be used: {why}"))
        })?;
        let me = shared.devices.host_id();
        let credentials = Credentials::Pair {
            code: request.code,
            name: self.settings.name.clone(),
            key,
            host: Some(me.clone()),
        };
        let (connection, events, closed) = connect(&url, credentials, self.settings.reach_timeout)
            .await
            .map_err(|unreached| {
                if unreached.refused() {
                    errors::peer_unavailable(
                        "it refused the code, which may have expired or been used: show a new \
                         one with `weave pair` there",
                    )
                } else {
                    errors::peer_unavailable(unreached.why)
                }
            })?;
        let hello = connection.hello().clone();
        let device = match hello.device {
            Some(_) if hello.host.id == me => Err("that's this Host's own URL"),
            Some(device) => Ok(device),
            None => Err("it didn't take this Host as a paired device"),
        };
        let device = match device {
            Ok(device) => device,
            Err(why) => {
                connection.shutdown().await;
                return Err(errors::peer_unavailable(why));
            }
        };
        let now = now_ms();
        let stored = Stored {
            host_id: hello.host.id.clone(),
            name: request.name.unwrap_or_else(|| tailnet_name(&url)),
            url,
            device_id: device.id,
            paired_at: now,
            last_seen_at: Some(now),
        };
        let replaced = {
            let mut state = lock(&self.state);
            state.peers.insert(stored.host_id.clone(), stored.clone());
            state
                .reached
                .insert(stored.host_id.clone(), (PeerStatus::Reachable, None));
            self.save(&state);
            state.links.remove(&stored.host_id)
        };
        if let Some(link) = replaced {
            link.stop.cancel();
        }
        self.link(shared, &stored.host_id, connection, events, closed);
        tracing::info!(peer = %stored.host_id, name = %stored.name, "paired with a peer Host");
        Ok(self.listing(&lock(&self.state), &stored))
    }

    /// `peers/list`: the peers, and with `check`, whether each can be reached now.
    pub(crate) async fn list(&self, shared: &Arc<Shared>, check: bool) -> ListPeersResponse {
        if check {
            let unlinked: Vec<String> = {
                let state = lock(&self.state);
                state
                    .peers
                    .keys()
                    .filter(|host_id| !state.links.contains_key(*host_id))
                    .cloned()
                    .collect()
            };
            futures::future::join_all(unlinked.iter().map(|host_id| self.reach(shared, host_id)))
                .await;
        }
        let state = lock(&self.state);
        ListPeersResponse {
            host_id: shared.devices.host_id(),
            peers: state
                .peers
                .values()
                .map(|peer| self.listing(&state, peer))
                .collect(),
        }
    }

    fn listing(&self, state: &State, peer: &Stored) -> Peer {
        let (status, error) = if state.links.contains_key(&peer.host_id) {
            (PeerStatus::Reachable, None)
        } else {
            state
                .reached
                .get(&peer.host_id)
                .cloned()
                .unwrap_or((PeerStatus::Unchecked, None))
        };
        Peer {
            host_id: peer.host_id.clone(),
            name: peer.name.clone(),
            url: peer.url.clone(),
            paired_at: peer.paired_at,
            last_seen_at: peer.last_seen_at,
            status,
            error,
        }
    }

    /// `peers/remove`: forget a peer and close the connection to it. Turns followed there are
    /// given up, their callers told.
    pub(crate) fn remove(&self, host_id: &str) -> Result<(), Error> {
        let (link, watches) = {
            let mut state = lock(&self.state);
            if state.peers.remove(host_id).is_none() {
                return Err(Error::invalid_params().data(format!("no peer Host {host_id}")));
            }
            state.reached.remove(host_id);
            self.save(&state);
            let watches: Vec<mpsc::UnboundedSender<()>> = state
                .watches
                .iter()
                .filter(|((host, _), _)| host == host_id)
                .map(|(_, wake)| wake.clone())
                .collect();
            (state.links.remove(host_id), watches)
        };
        if let Some(link) = link {
            link.stop.cancel();
        }
        for wake in watches {
            let _ = wake.send(());
        }
        tracing::info!(peer = %host_id, "forgot a peer Host");
        Ok(())
    }

    /// A connection to the peer `host_id`: the one open, or a new one. Fails at once when the
    /// peer can't be reached within the reach timeout, or refuses this Host.
    pub(crate) async fn reach(
        &self,
        shared: &Arc<Shared>,
        host_id: &str,
    ) -> Result<HostHandle, Unreached> {
        if let Some(handle) = self.linked(host_id) {
            return Ok(handle);
        }
        if self.stopping.is_cancelled() {
            return Err(Unreached::unreachable("this Host is stopping"));
        }
        let attempt = Arc::clone(
            lock(&self.connecting)
                .entry(host_id.to_owned())
                .or_default(),
        );
        let _connecting = attempt.lock().await;
        // Someone may have connected while this waited.
        if let Some(handle) = self.linked(host_id) {
            return Ok(handle);
        }
        let stored = lock(&self.state)
            .peers
            .get(host_id)
            .cloned()
            .ok_or_else(|| {
                Unreached::new(PeerStatus::Refused, "this Host no longer pairs with it")
            })?;
        let key = self.key().map_err(Unreached::unreachable)?;
        let credentials = Credentials::Device {
            device_id: stored.device_id.clone(),
            key,
            host_id: Some(host_id.to_owned()),
        };
        match connect(&stored.url, credentials, self.settings.reach_timeout).await {
            Ok((connection, events, closed)) => {
                {
                    let mut state = lock(&self.state);
                    state
                        .reached
                        .insert(host_id.to_owned(), (PeerStatus::Reachable, None));
                    if let Some(peer) = state.peers.get_mut(host_id) {
                        peer.last_seen_at = Some(now_ms());
                    }
                    self.save(&state);
                }
                Ok(self.link(shared, host_id, connection, events, closed))
            }
            Err(mut unreached) => {
                if unreached.refused() {
                    unreached.why = format!(
                        "{}; it may have revoked this Host. Pair again with `weave hosts add` here",
                        unreached.why
                    );
                }
                tracing::info!(peer = %host_id, why = %unreached.why, "couldn't reach a peer Host");
                lock(&self.state).reached.insert(
                    host_id.to_owned(),
                    (unreached.status, Some(unreached.why.clone())),
                );
                Err(unreached)
            }
        }
    }

    fn linked(&self, host_id: &str) -> Option<HostHandle> {
        let state = lock(&self.state);
        let link = state.links.get(host_id)?;
        link.touch();
        Some(link.handle.clone())
    }

    /// Keep `connection` to `host_id`, handing what it sends to the sessions' followers.
    fn link(
        &self,
        shared: &Arc<Shared>,
        host_id: &str,
        connection: HostConnection,
        events: mpsc::UnboundedReceiver<HostEvent>,
        closed: CloseReason,
    ) -> HostHandle {
        let link = {
            let mut state = lock(&self.state);
            state.next_link += 1;
            let link = Link {
                id: state.next_link,
                handle: connection.handle(),
                routes: Arc::default(),
                used: Arc::new(Mutex::new(Instant::now())),
                stop: CancellationToken::new(),
            };
            state.links.insert(host_id.to_owned(), link.clone());
            link
        };
        let handle = link.handle.clone();
        tokio::spawn(dispatch(
            Arc::clone(shared),
            host_id.to_owned(),
            link,
            connection,
            (events, closed),
            self.settings.idle,
        ));
        handle
    }

    /// Forget the link `id` to `host_id`, unless another replaced it; and when the peer closed
    /// it, with `closed` as the reason, note how, so listing says so.
    fn unlink(&self, host_id: &str, id: u64, closed: Option<Option<(u16, String)>>) {
        let mut state = lock(&self.state);
        if state.links.get(host_id).is_none_or(|link| link.id != id) {
            return;
        }
        state.links.remove(host_id);
        let Some(closed) = closed else {
            return;
        };
        let reached = match closed {
            Some((code, _)) if code == CLOSE_REVOKED => (
                PeerStatus::Refused,
                "it revoked this Host. Pair again with `weave hosts add` here".to_owned(),
            ),
            _ => (PeerStatus::Unreachable, "its connection closed".to_owned()),
        };
        state
            .reached
            .insert(host_id.to_owned(), (reached.0, Some(reached.1)));
    }

    /// Have what the peer sends about `session_id` go to `events`. False when the connection
    /// to the peer has gone since it was reached.
    fn route(
        &self,
        host_id: &str,
        session_id: &SessionId,
        events: mpsc::UnboundedSender<HostEvent>,
    ) -> bool {
        let state = lock(&self.state);
        let Some(link) = state.links.get(host_id) else {
            return false;
        };
        link.touch();
        lock(&link.routes).insert(session_id.clone(), events);
        true
    }

    fn unroute(&self, host_id: &str, session_id: &SessionId) {
        let state = lock(&self.state);
        if let Some(link) = state.links.get(host_id) {
            link.touch();
            lock(&link.routes).remove(session_id);
        }
    }

    /// Send `sending` to its peer, having recorded it, and follow the turn it begins there. A
    /// peer that can't be reached, or refuses it, leaves nothing begun; one that stops answering
    /// before it says leaves this Host sending it again, under the same key, until it does, and
    /// telling the caller then.
    pub(crate) async fn begin(
        &self,
        shared: &Arc<Shared>,
        sending: Sending,
    ) -> Result<Begun, String> {
        let name = self
            .name_of(&sending.host_id)
            .unwrap_or_else(|| sending.host_id.clone());
        {
            let mut state = lock(&self.state);
            state.sending.push(sending.clone());
            self.save(&state);
        }
        let handle = match self.reach(shared, &sending.host_id).await {
            Ok(handle) => handle,
            Err(unreached) => {
                self.sent(&sending, None);
                return Err(format!("{name} can't be reached: {unreached}."));
            }
        };
        match send(&handle, &sending.request).await {
            Ok(begun) => {
                self.sent(&sending, Some(&begun));
                self.watch_begun(shared, &sending, &begun);
                Ok(begun)
            }
            Err(error) if unanswered(&error) => {
                self.deliver(shared, sending.clone());
                Err(format!(
                    "{name} stopped answering before it said whether it took {}. This Host \
                     keeps asking, with the same request key, and tells this thread what \
                     happened.",
                    sending.request.tool()
                ))
            }
            Err(error) => {
                self.sent(&sending, None);
                Err(format!("On {name}: {}", host_tools::why(&error)))
            }
        }
    }

    /// `sending` was answered: stop keeping it, and follow the turn it began.
    fn sent(&self, sending: &Sending, begun: Option<&Begun>) {
        let mut state = lock(&self.state);
        state.sending.retain(|known| {
            !(known.host_id == sending.host_id
                && known.caller == sending.caller
                && known.request.key() == sending.request.key())
        });
        if let Some(followed) = begun.and_then(|begun| followed(sending, begun))
            && !state.following.iter().any(|known| known.is(&followed))
        {
            state.following.push(followed);
        }
        self.save(&state);
    }

    fn watch_begun(&self, shared: &Arc<Shared>, sending: &Sending, begun: &Begun) {
        if let Some(followed) = followed(sending, begun) {
            let mut state = lock(&self.state);
            self.watch(shared, &mut state, &followed.host_id, &followed.session_id);
        }
    }

    /// Send `sending` again until its peer answers, then tell its caller what happened.
    fn deliver(&self, shared: &Arc<Shared>, sending: Sending) {
        let shared = Arc::clone(shared);
        tokio::spawn(async move {
            let Some(peers) = shared.peers.as_ref() else {
                return;
            };
            tokio::select! {
                () = redeliver(&shared, peers, sending) => {}
                () = peers.stopping.cancelled() => {}
            }
        });
    }

    /// At startup: follow again the turns a stopped Host was following, and send again what
    /// it sent without an answer.
    pub(crate) fn resume(&self, shared: &Arc<Shared>) {
        let unanswered = lock(&self.state).sending.clone();
        for sending in unanswered {
            self.deliver(shared, sending);
        }
        let mut state = lock(&self.state);
        let sessions: Vec<(String, SessionId)> = state
            .following
            .iter()
            .map(|followed| (followed.host_id.clone(), followed.session_id.clone()))
            .collect();
        for (host_id, session_id) in sessions {
            self.watch(shared, &mut state, &host_id, &session_id);
        }
    }

    /// Wake the task following `session_id` on `host_id`, or start one.
    fn watch(
        &self,
        shared: &Arc<Shared>,
        state: &mut State,
        host_id: &str,
        session_id: &SessionId,
    ) {
        let key = (host_id.to_owned(), session_id.clone());
        if let Some(wake) = state.watches.get(&key)
            && wake.send(()).is_ok()
        {
            return;
        }
        let (wake, woken) = mpsc::unbounded_channel();
        state.watches.insert(key, wake);
        tokio::spawn(watch(
            Arc::clone(shared),
            host_id.to_owned(),
            session_id.clone(),
            woken,
        ));
    }

    /// Stop following `session_id` on `host_id`, unless a turn there was added meanwhile.
    fn unwatch(&self, host_id: &str, session_id: &SessionId) -> bool {
        let mut state = lock(&self.state);
        if followed_in(&state, host_id, session_id).next().is_some() {
            return false;
        }
        state
            .watches
            .remove(&(host_id.to_owned(), session_id.clone()));
        true
    }

    fn followed(&self, host_id: &str, session_id: &SessionId) -> Vec<Followed> {
        followed_in(&lock(&self.state), host_id, session_id)
            .cloned()
            .collect()
    }

    /// The Host is stopping: stop following, keeping the turns followed for the next Host to
    /// follow again, and close every connection.
    pub(crate) fn stop(&self) {
        self.stopping.cancel();
        let links: Vec<Link> = lock(&self.state)
            .links
            .drain()
            .map(|(_, link)| link)
            .collect();
        for link in links {
            link.stop.cancel();
        }
    }

    /// Whether a turn on a peer is followed, or a request beginning one is unanswered, which
    /// keeps the Host from exiting when idle.
    pub(crate) fn following_any(&self) -> bool {
        let state = lock(&self.state);
        !state.following.is_empty() || !state.sending.is_empty()
    }

    /// How many sessions `caller` started on peers run a turn it began, or may.
    pub(crate) fn delegated_running(&self, caller: &SessionId) -> usize {
        let state = lock(&self.state);
        let following = state
            .following
            .iter()
            .filter(|followed| followed.delegated && followed.caller == *caller)
            .count();
        let sending = state
            .sending
            .iter()
            .filter(|sending| sending.delegated && sending.caller == *caller)
            .count();
        following + sending
    }

    /// Stop following `followed`, and tell its caller `text`.
    fn done(&self, shared: &Arc<Shared>, followed: &Followed, text: String) {
        {
            let mut state = lock(&self.state);
            state.following.retain(|known| !known.is(followed));
            self.save(&state);
        }
        tokio::spawn(host_tools::tell(
            Arc::clone(shared),
            followed.caller.clone(),
            followed.session_id.clone(),
            Some(followed.host_id.clone()),
            text,
        ));
    }

    /// Stop following every turn of `session_id` on `host_id`, telling each caller why.
    fn give_up(&self, shared: &Arc<Shared>, host_id: &str, session_id: &SessionId, why: &str) {
        let name = self.name_of(host_id).unwrap_or_else(|| host_id.to_owned());
        for followed in self.followed(host_id, session_id) {
            let text = format!(
                "[weave] This Host can't follow thread {session_id} on {name} any more, so it \
                 won't hear how the turn {} your thread began there goes: {why}.",
                followed.turn_id
            );
            self.done(shared, &followed, text);
        }
    }

    /// Note that the callers of the turn `running` were told of the requests `asks` holds,
    /// telling the ones not told yet.
    fn tell_waiting(
        &self,
        shared: &Arc<Shared>,
        named: &Named<'_>,
        host_id: &str,
        running: Option<&TurnId>,
        asks: &BTreeMap<PendingId, Asks>,
    ) {
        let Some(running) = running else {
            return;
        };
        let mut told = Vec::new();
        {
            let mut state = lock(&self.state);
            for followed in &mut state.following {
                if followed.host_id != host_id
                    || followed.session_id != *named.session_id
                    || followed.turn_id != *running
                {
                    continue;
                }
                for (pending_id, what) in asks {
                    if !followed.told.contains(pending_id) {
                        followed.told.push(pending_id.clone());
                        told.push((
                            followed.caller.clone(),
                            host_tools::waiting_text(named, what),
                        ));
                    }
                }
            }
            if !told.is_empty() {
                self.save(&state);
            }
        }
        for (caller, text) in told {
            tokio::spawn(host_tools::tell(
                Arc::clone(shared),
                caller,
                named.session_id.clone(),
                Some(host_id.to_owned()),
                text,
            ));
        }
    }
}

/// The turn `begun` began, to follow.
fn followed(sending: &Sending, begun: &Begun) -> Option<Followed> {
    let (session_id, turn_id) = match (&sending.request, begun) {
        (Begin::Run(_), Begun::Run(ran)) => (ran.session_id.clone(), ran.turn_id.clone()?),
        (Begin::Queue(request), Begun::Queue(added)) => {
            (request.session_id.clone(), added.queued_id.clone())
        }
        _ => return None,
    };
    Some(Followed {
        host_id: sending.host_id.clone(),
        session_id,
        turn_id,
        caller: sending.caller.clone(),
        delegated: sending.delegated,
        told: Vec::new(),
    })
}

async fn send(handle: &HostHandle, request: &Begin) -> Result<Begun, Error> {
    match request {
        Begin::Run(request) => handle.send(request.clone()).await.map(Begun::Run),
        Begin::Queue(request) => handle.send(request.clone()).await.map(Begun::Queue),
    }
}

/// Whether `error` leaves it unknown whether the peer did what it was asked: the connection
/// went before it answered, which the client reports as an internal error, as it does the
/// peer's own, which asking again under the same key settles too.
fn unanswered(error: &Error) -> bool {
    error.code == agent_client_protocol::ErrorCode::InternalError
}

/// [`Peers::deliver`]'s work.
async fn redeliver(shared: &Arc<Shared>, peers: &Peers, sending: Sending) {
    let mut retry = peers.settings.retry;
    let tool = sending.request.tool();
    loop {
        let name = peers
            .name_of(&sending.host_id)
            .unwrap_or_else(|| sending.host_id.clone());
        let outcome = match peers.reach(shared, &sending.host_id).await {
            Ok(handle) => match send(&handle, &sending.request).await {
                Ok(begun) => Ok(begun),
                Err(error) if unanswered(&error) => {
                    tracing::debug!(peer = %sending.host_id, error = %error.message, "sending again: no answer yet");
                    Err(None)
                }
                Err(error) => Err(Some(format!(
                    "[weave] {name} refused the {tool} this thread asked of it, which this Host \
                     sent again after it stopped answering: {}.",
                    host_tools::why(&error)
                ))),
            },
            Err(unreached) if unreached.refused() => Err(Some(format!(
                "[weave] This Host can't ask {name} any more whether it took the {tool} this \
                 thread asked of it: {unreached}."
            ))),
            Err(_) => Err(None),
        };
        let about = match &sending.request {
            Begin::Run(request) => request.session_id.clone(),
            Begin::Queue(request) => Some(request.session_id.clone()),
        };
        match outcome {
            Ok(begun) => {
                peers.sent(&sending, Some(&begun));
                peers.watch_begun(shared, &sending, &begun);
                let (session_id, text) = match &begun {
                    Begun::Run(ran) => (
                        ran.session_id.clone(),
                        format!(
                            "[weave] {name} took the {tool} this thread asked of it after all: \
                             thread {}{}. You'll hear here when its turn ends.",
                            ran.session_id,
                            ran.turn_id
                                .as_ref()
                                .map_or_else(String::new, |turn| format!(", turn {turn}"))
                        ),
                    ),
                    Begun::Queue(added) => (
                        about.clone().unwrap_or_else(|| sending.caller.clone()),
                        format!(
                            "[weave] {name} took the {tool} this thread asked of it after all, \
                             as {}. You'll hear here when its turn ends.",
                            added.queued_id
                        ),
                    ),
                };
                host_tools::tell(
                    Arc::clone(shared),
                    sending.caller.clone(),
                    session_id,
                    Some(sending.host_id.clone()),
                    text,
                )
                .await;
                return;
            }
            Err(Some(text)) => {
                peers.sent(&sending, None);
                host_tools::tell(
                    Arc::clone(shared),
                    sending.caller.clone(),
                    about.unwrap_or_else(|| sending.caller.clone()),
                    Some(sending.host_id.clone()),
                    text,
                )
                .await;
                return;
            }
            Err(None) => {
                tokio::time::sleep(retry).await;
                retry = (retry * 2).min(MAX_RETRY);
            }
        }
    }
}

fn followed_in<'a>(
    state: &'a State,
    host_id: &'a str,
    session_id: &'a SessionId,
) -> impl Iterator<Item = &'a Followed> {
    state
        .following
        .iter()
        .filter(move |followed| followed.host_id == host_id && followed.session_id == *session_id)
}

/// Connect to the Host at `url` and say hello with `credentials`, within `timeout`.
async fn connect(
    url: &str,
    credentials: Credentials,
    timeout: Duration,
) -> Result<
    (
        HostConnection,
        mpsc::UnboundedReceiver<HostEvent>,
        CloseReason,
    ),
    Unreached,
> {
    let attempt = async {
        let (transport, closed) =
            connect_websocket(url)
                .await
                .map_err(|error| match answered_without_host(&error) {
                    Some(status) => Unreached::new(
                        PeerStatus::Down,
                        format!(
                            "its computer answered at {url} (HTTP {status}), but no weave Host \
                             did: the Host may not be running there"
                        ),
                    ),
                    None => Unreached::unreachable(format!("nothing answered at {url}: {error}")),
                })?;
        let client = ClientInfo {
            name: CLIENT_NAME.to_owned(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
        };
        HostConnection::connect_with(
            transport,
            client,
            ClientCapabilities::default(),
            credentials,
        )
        .await
        .map_err(|error| match error {
            ConnectError::Refused(error) if errors::is(&error, errors::UNAUTHENTICATED) => {
                Unreached::new(
                    PeerStatus::Refused,
                    format!("it refused this Host: {}", error.message),
                )
            }
            ConnectError::WrongHost => Unreached::new(
                PeerStatus::OtherHost,
                format!(
                    "another weave Host answers at {url} now: pair again with the one that \
                     should be there"
                ),
            ),
            other => Unreached::unreachable(other.to_string()),
        })
        .map(|(connection, events)| (connection, events, closed))
    };
    tokio::time::timeout(timeout, attempt)
        .await
        .unwrap_or_else(|_| {
            Err(Unreached::unreachable(format!(
                "it didn't answer within {} seconds",
                timeout.as_secs_f32()
            )))
        })
}

/// Hand what a peer sends to the followers of its sessions, until the connection ends, is
/// replaced, or has gone unused for `idle` with nothing followed.
async fn dispatch(
    shared: Arc<Shared>,
    host_id: String,
    link: Link,
    connection: HostConnection,
    (mut events, closed): (mpsc::UnboundedReceiver<HostEvent>, CloseReason),
    idle: Duration,
) {
    // Whether the peer closed the connection, rather than this Host.
    let mut lost = false;
    let mut checks =
        tokio::time::interval(idle.clamp(Duration::from_millis(10), Duration::from_secs(5)));
    loop {
        tokio::select! {
            event = events.recv() => match event {
                None | Some(HostEvent::Disconnected(_)) => {
                    lost = true;
                    break;
                }
                Some(event) => {
                    let session_id = match &event {
                        HostEvent::Event(notification) => &notification.session_id,
                        HostEvent::PendingAdded(added) => &added.session_id,
                        HostEvent::PendingResolved(resolved) => &resolved.session_id,
                        _ => continue,
                    };
                    let route = lock(&link.routes).get(session_id).cloned();
                    if let Some(route) = route {
                        let _ = route.send(event);
                    }
                }
            },
            _ = checks.tick() => {
                if lock(&link.routes).is_empty() && lock(&link.used).elapsed() >= idle {
                    break;
                }
            }
            () = link.stop.cancelled() => break,
        }
    }
    if let Some(peers) = &shared.peers {
        peers.unlink(&host_id, link.id, lost.then(|| closed.get()));
    }
    connection.shutdown().await;
    let routes: Vec<mpsc::UnboundedSender<HostEvent>> =
        lock(&link.routes).drain().map(|(_, route)| route).collect();
    for route in routes {
        let _ = route.send(HostEvent::Disconnected(None));
    }
}

/// How observing a peer's session ended.
enum Observed {
    /// No turn there is followed any more.
    Done,
    /// The connection went: reconnect, and catch up.
    Lost,
}

/// Follow the turns of `session_id` on the peer `host_id` until none is left, or the Host
/// stops.
async fn watch(
    shared: Arc<Shared>,
    host_id: String,
    session_id: SessionId,
    mut wake: mpsc::UnboundedReceiver<()>,
) {
    let Some(peers) = shared.peers.as_ref() else {
        return;
    };
    tokio::select! {
        () = follow_turns(&shared, peers, &host_id, &session_id, &mut wake) => {}
        () = peers.stopping.cancelled() => {}
    }
}

/// [`watch`]'s work: reconnect whenever the peer is lost, and give up only when it refuses
/// this Host or this Host forgets it.
async fn follow_turns(
    shared: &Arc<Shared>,
    peers: &Peers,
    host_id: &str,
    session_id: &SessionId,
    wake: &mut mpsc::UnboundedReceiver<()>,
) {
    let mut retry = peers.settings.retry;
    let mut position = None;
    loop {
        if peers.followed(host_id, session_id).is_empty() {
            if peers.unwatch(host_id, session_id) {
                return;
            }
            continue;
        }
        let Some(name) = peers.name_of(host_id) else {
            peers.give_up(
                shared,
                host_id,
                session_id,
                "this Host no longer pairs with it",
            );
            continue;
        };
        let handle = match peers.reach(shared, host_id).await {
            Ok(handle) => handle,
            Err(unreached) if unreached.refused() => {
                peers.give_up(shared, host_id, session_id, &unreached.why);
                continue;
            }
            Err(unreached) => {
                tracing::debug!(peer = %host_id, %unreached, "following a turn: the peer can't be reached yet");
                pause(wake, &mut retry).await;
                continue;
            }
        };
        let (events, mut routed) = mpsc::unbounded_channel();
        if !peers.route(host_id, session_id, events) {
            continue;
        }
        let observed = observe(
            shared,
            peers,
            &handle,
            host_id,
            &name,
            session_id,
            &mut routed,
            wake,
            &mut position,
        )
        .await;
        peers.unroute(host_id, session_id);
        match observed {
            Observed::Done => {
                let _ = handle
                    .send(DetachSessionRequest {
                        session_id: session_id.clone(),
                        close: CloseWhen::Never,
                    })
                    .await;
                retry = peers.settings.retry;
            }
            Observed::Lost => pause(wake, &mut retry).await,
        }
    }
}

/// Wait `retry`, or until a turn is added, and wait longer next time.
async fn pause(wake: &mut mpsc::UnboundedReceiver<()>, retry: &mut Duration) {
    tokio::select! {
        () = tokio::time::sleep(*retry) => {}
        _ = wake.recv() => {}
    }
    *retry = (*retry * 2).min(MAX_RETRY);
}

/// Observe `session_id` on a peer as it goes, reporting the followed turns that end and the
/// requests in them that wait on a person, until none is followed or the connection goes.
#[allow(clippy::too_many_arguments)]
async fn observe(
    shared: &Arc<Shared>,
    peers: &Peers,
    handle: &HostHandle,
    host_id: &str,
    name: &str,
    session_id: &SessionId,
    routed: &mut mpsc::UnboundedReceiver<HostEvent>,
    wake: &mut mpsc::UnboundedReceiver<()>,
    position: &mut Option<JournalPosition>,
) -> Observed {
    let attached = match handle
        .send(AttachSessionRequest {
            session_id: session_id.clone(),
            after: position.clone(),
            agent_id: None,
            cwd: None,
            trace: false,
            observe: true,
        })
        .await
    {
        Ok(attached) => attached,
        Err(error)
            if errors::is(&error, errors::SESSION_NOT_OPEN)
                || errors::is(&error, errors::UNKNOWN_SESSION) =>
        {
            // Nothing runs in a session that isn't open: its followed turns ended, or never
            // will till someone opens it.
            if check(shared, peers, handle, host_id, name, session_id)
                .await
                .is_err()
            {
                return Observed::Lost;
            }
            peers.give_up(
                shared,
                host_id,
                session_id,
                "its thread there isn't open, so the turn can't run",
            );
            return Observed::Done;
        }
        Err(error) => {
            tracing::debug!(peer = %host_id, %session_id, error = %error.message, "couldn't observe a peer's thread");
            return Observed::Lost;
        }
    };
    let state = attached.state;
    let head = state.journal.head;
    let journal = state.journal.id.clone();
    let title = state.title.clone();
    let agent_id = state.agent.id.clone();
    let named = Named {
        session_id,
        title: title.as_deref(),
        agent_id: &agent_id,
        host: Some(name),
    };
    let mut running = state
        .turns
        .iter()
        .find(|turn| turn.session_id == *session_id)
        .and_then(|turn| turn.turn_id.clone());
    let mut waiting: BTreeMap<PendingId, Asks> = state
        .pending
        .iter()
        .filter_map(|pending| Some((pending.id.clone(), asks(pending)?)))
        .collect();
    // Turns that ended while nobody watched, up to the attach.
    if check(shared, peers, handle, host_id, name, session_id)
        .await
        .is_err()
    {
        return Observed::Lost;
    }
    peers.tell_waiting(shared, &named, host_id, running.as_ref(), &waiting);
    loop {
        if peers.followed(host_id, session_id).is_empty() {
            return Observed::Done;
        }
        let event = tokio::select! {
            event = routed.recv() => event,
            woken = wake.recv() => {
                if woken.is_some() {
                    // A turn was added, which may have started, or ended, already.
                    if check(shared, peers, handle, host_id, name, session_id).await.is_err() {
                        return Observed::Lost;
                    }
                    peers.tell_waiting(shared, &named, host_id, running.as_ref(), &waiting);
                }
                continue;
            }
        };
        match event {
            None | Some(HostEvent::Disconnected(_)) => return Observed::Lost,
            Some(HostEvent::Event(notification)) => {
                *position = Some(JournalPosition {
                    journal: journal.clone(),
                    seq: notification.seq,
                });
                // The replay up to the attach is what the state and the check covered.
                if notification.seq <= head {
                    continue;
                }
                // Whether to look at the followed turns, and whether the thread closed.
                let (look, closed) = match notification.event {
                    SessionEvent::TurnStarted {
                        session_id: started,
                        turn_id,
                        queued_id,
                        ..
                    } if started == *session_id => {
                        running = turn_id.or(queued_id);
                        (false, false)
                    }
                    SessionEvent::TurnEnded {
                        session_id: ended, ..
                    } if ended == *session_id => {
                        running = None;
                        (true, false)
                    }
                    SessionEvent::Unqueued { .. } => (true, false),
                    SessionEvent::Closed { .. } => (true, true),
                    _ => (false, false),
                };
                if look
                    && check(shared, peers, handle, host_id, name, session_id)
                        .await
                        .is_err()
                {
                    return Observed::Lost;
                }
                if closed {
                    peers.give_up(
                        shared,
                        host_id,
                        session_id,
                        "its thread there closed before the turn ran",
                    );
                    return Observed::Done;
                }
            }
            Some(HostEvent::PendingAdded(added)) => {
                if let Some(what) = asks(&added.pending) {
                    waiting.insert(added.pending.id.clone(), what);
                    peers.tell_waiting(shared, &named, host_id, running.as_ref(), &waiting);
                }
            }
            Some(HostEvent::PendingResolved(resolved)) => {
                waiting.remove(&resolved.pending_id);
            }
            Some(_) => {}
        }
    }
}

/// Report the followed turns of `session_id` on the peer that are over, or gone. Fails when
/// the peer can't be asked.
async fn check(
    shared: &Arc<Shared>,
    peers: &Peers,
    handle: &HostHandle,
    host_id: &str,
    name: &str,
    session_id: &SessionId,
) -> Result<(), ()> {
    for followed in peers.followed(host_id, session_id) {
        let got = handle
            .send(GetSessionRequest {
                session_id: session_id.clone(),
                turn_id: Some(followed.turn_id.clone()),
            })
            .await;
        match got {
            Ok(got) => {
                let Some(latest) = got.latest_turn.filter(|turn| turn.state.is_over()) else {
                    continue;
                };
                let named = Named::of(&got.session, Some(name));
                peers.done(
                    shared,
                    &followed,
                    host_tools::ended_text(&named, Some(&latest)),
                );
            }
            Err(error)
                if errors::is(&error, errors::UNKNOWN_TURN)
                    || errors::is(&error, errors::UNKNOWN_SESSION) =>
            {
                let text = format!(
                    "[weave] Thread {session_id} on {name} no longer has the turn {} your \
                     thread began there, as when its prompt was taken out of the queue. \
                     read_session with host {name} says how the thread stands.",
                    followed.turn_id
                );
                peers.done(shared, &followed, text);
            }
            Err(error) => {
                tracing::debug!(peer = %host_id, %session_id, error = %error.message, "couldn't read a followed turn");
                return Err(());
            }
        }
    }
    Ok(())
}

/// What a person must answer in `pending`; nothing for a client tool call.
fn asks(pending: &PendingRequest) -> Option<Asks> {
    match &pending.request {
        PendingKind::Permission { request } => {
            Some(Asks::Permission(request.tool_call.fields.title.clone()))
        }
        PendingKind::Elicitation { request } => Some(Asks::Elicitation(request.message.clone())),
        PendingKind::ClientTool { .. } => None,
    }
}

fn read_key(path: &Path) -> Result<Option<DeviceKey>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("reading {}: {error}", path.display())),
    };
    let saved: SavedKey = serde_json::from_slice(&bytes)
        .map_err(|error| format!("reading {}: {error}", path.display()))?;
    let decode = |text: &str| {
        URL_SAFE_NO_PAD
            .decode(text)
            .map_err(|error| format!("reading {}: {error}", path.display()))
    };
    let key = match saved {
        SavedKey::SecureEnclave(wrapped) => DeviceKey::from_wrapped(&decode(&wrapped)?)
            .map_err(|why| format!("the Secure Enclave key in {}: {why}", path.display()))?,
        SavedKey::Software(scalar) => DeviceKey::from_bytes(&decode(&scalar)?)
            .ok_or_else(|| format!("{} holds no P-256 key", path.display()))?,
    };
    Ok(Some(key))
}

fn write_key(path: &Path, key: &DeviceKey) -> Result<(), String> {
    let saved = match (key.wrapped(), key.to_bytes()) {
        (Some(wrapped), _) => SavedKey::SecureEnclave(URL_SAFE_NO_PAD.encode(wrapped)),
        (None, Some(scalar)) => SavedKey::Software(URL_SAFE_NO_PAD.encode(scalar)),
        (None, None) => return Err("the key can't be saved".to_owned()),
    };
    write_private(path, &saved).map_err(|error| format!("writing {}: {error}", path.display()))
}

/// What the person likely calls the Host at `url`: its tailnet name's first label, as in
/// `wss://mac-mini.example.ts.net:7341`.
fn tailnet_name(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = rest.split(['/', '?']).next().unwrap_or(rest);
    let host = match authority.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') && port.bytes().all(|b| b.is_ascii_digit()) => {
            host
        }
        _ => authority,
    };
    if host.parse::<std::net::IpAddr>().is_ok() || host.starts_with('[') {
        return host.to_owned();
    }
    host.split('.').next().unwrap_or(host).to_owned()
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
    "weave Host".to_owned()
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn a_peer_is_named_by_its_tailnet_name() {
        assert_eq!(
            tailnet_name("wss://mac-mini.example.ts.net:7341"),
            "mac-mini"
        );
        assert_eq!(tailnet_name("wss://studio.example.ts.net"), "studio");
        assert_eq!(tailnet_name("ws://127.0.0.1:7341"), "127.0.0.1");
        assert_eq!(tailnet_name("wss://box:7341/path"), "box");
    }

    #[test]
    fn the_key_is_kept_and_comes_back() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("host-key.json");
        let settings = PeerSettings {
            secure_enclave: false,
            ..PeerSettings::new(None, Some(path.clone()))
        };
        let made = Peers::load(settings.clone()).key().expect("a key");
        let kept = Peers::load(settings).key().expect("the key again");
        assert_eq!(kept.jwk(), made.jwk());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).expect("file").permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn peers_resolve_by_id_or_name() {
        let peers = Peers::load(PeerSettings::new(None, None));
        {
            let mut state = lock(&peers.state);
            for (id, name) in [("h1", "studio"), ("h2", "mini")] {
                state.peers.insert(
                    id.to_owned(),
                    Stored {
                        host_id: id.to_owned(),
                        name: name.to_owned(),
                        url: format!("wss://{name}.example.ts.net:7341"),
                        device_id: format!("d-{id}"),
                        paired_at: 0,
                        last_seen_at: None,
                    },
                );
            }
        }
        assert_eq!(
            peers.resolve("h2"),
            Ok(("h2".to_owned(), "mini".to_owned()))
        );
        assert_eq!(
            peers.resolve("Studio"),
            Ok(("h1".to_owned(), "studio".to_owned()))
        );
        let unknown = peers.resolve("laptop").expect_err("no such peer");
        assert!(unknown.contains("studio (h1)"), "{unknown}");
    }
}
