//! The Dispatcher's API (ADR 0027, WVE-175): what the `weave` CLI asks the Dispatcher, over its
//! Unix socket on its own computer, or over its WebSocket from the person's other devices,
//! paired with it (WVE-176). The Dispatcher is a client of the
//! person's Hosts, which join it and keep a connection open to it (ADR 0030, WVE-194): the
//! Hosts that joined and how each stands, its schedules (WVE-145) and their occurrences, the
//! person's Projects (ADR 0031, WVE-189), which [`crate::projects`] places threads in, and their
//! Bots (ADR 0028, WVE-118), whose work goes on in ordinary threads on one Host.
//! Its devices are managed with `devices/*`, on its own computer only; Hosts pair with nothing
//! since WVE-197, and take the Dispatcher's word for the devices it carries to them.
//!
//! A Host's own connection begins with `dispatcher/challenge` and [`ConnectHostRequest`], after
//! which the Dispatcher says `host/hello` to it on the same connection. The Host's side of
//! joining is in the Host protocol: [`JoinDispatcherRequest`] and [`LeaveDispatcherRequest`],
//! for clients on the Host's own computer.
//!
//! The person's devices reach their Hosts through the Dispatcher (WVE-195): a device asks for a
//! Host with [`OpenHostRequest`], the Dispatcher asks that Host with [`CarryRequest`] to open a
//! connection of its own, which the Host presents with [`HostCarryRequest`], the Dispatcher
//! proving its key there by signing the Host's nonce, and the Dispatcher joins the two and passes
//! the Host protocol through unchanged. The specification is
//! `docs/specs/wve-175-dispatcher.md`.

use std::path::PathBuf;

use agent_client_protocol::JsonRpcNotification;
use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::JsonRpcResponse;
use agent_client_protocol::schema::v1::ContentBlock;
use serde::Deserialize;
use serde::Serialize;

use crate::Empty;
use crate::Timestamp;
use crate::agents::AgentId;
use crate::devices::DeviceInfo;
use crate::devices::Jwk;
use crate::hello::Auth;
use crate::hello::ClientInfo;
use crate::policy::PermissionPolicy;
use crate::threads::ThreadId;
use crate::threads::TurnState;
use crate::turns::TurnId;
use crate::worktrees::InitRepositoryResponse;

/// How the Dispatcher's last attempt to connect to a Host went.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum Reachability {
    /// It took the Dispatcher's key at hello; the Dispatcher may be connected to it now.
    Reachable,
    /// It hasn't connected since the Dispatcher started.
    Unchecked,
    /// It left the Dispatcher, or refused its key: joining again is the way back.
    Refused,
    /// It was paired before Hosts joined the Dispatcher (ADR 0030), which no longer dials it:
    /// `weave hosts add` there joins it.
    Unjoined,
    /// Its computer answered at the URL, but no weave Host did, as when the Host isn't running
    /// there.
    Down,
    /// Nothing answered at the URL, as when the computer is asleep or off the tailnet.
    Unreachable,
    /// Another weave Host answers at the URL.
    OtherHost,
}

/// The Dispatcher API's version, which a client and the Dispatcher must share.
pub const DISPATCHER_PROTOCOL: u32 = 2;

/// The subprotocol a client of the Dispatcher's WebSocket asks for, so one that reached a Host
/// instead fails at the upgrade.
pub const DISPATCHER_SUBPROTOCOL: &str = "weave-dispatcher";

/// The subprotocol a Host asks for on the connection it opens to the Dispatcher it joined
/// (ADR 0030), beside the devices' [`DISPATCHER_SUBPROTOCOL`], and on each connection it opens
/// for the Dispatcher to carry a device's ([`HostCarryRequest`]).
pub const DISPATCHER_HOST_SUBPROTOCOL: &str = "weave-dispatcher-host";

/// The subprotocol a device asks for on a connection the Dispatcher carries to one of the
/// person's Hosts (ADR 0030, WVE-195): its challenge, hello and [`OpenHostRequest`], then the
/// Host protocol, or a terminal's stream, passed through unchanged.
pub const DISPATCHER_CARRY_SUBPROTOCOL: &str = "weave-dispatcher-carry";

/// The [`crate::hello::HelloResponse::features`] entry of a Host the Dispatcher can carry
/// devices' connections to: it answers [`CarryRequest`] from the Dispatcher it joined, and takes
/// [`Auth::Dispatcher`] on the connections it opens for that.
pub const CARRY_FEATURE: &str = "carry";

/// The [`DispatcherHello::features`] entry of a Dispatcher that keeps Projects (ADR 0031,
/// WVE-189): it answers `projects/*`.
pub const PROJECTS_FEATURE: &str = "projects";

/// The [`DispatcherHello::features`] entry of a Dispatcher that keeps Bots (ADR 0028, WVE-118):
/// it answers `bots/*`, and `schedules/add` takes `bot`, and `at` for a one-off.
pub const BOTS_FEATURE: &str = "bots";

/// The [`DispatcherHello::features`] entry of a Dispatcher that makes a Bot's home itself
/// (WVE-178): `bots/add` asks the Bot's Host to make it with `repos/init`, takes no `home` for
/// `~/bots/<name>`, takes `job`, and answers what making the home did ([`AddBotResponse`]); a
/// Bot says which Bot made it, if one did; and `schedules/list` takes `bot`.
pub const BOTS_HOME_FEATURE: &str = "bots_home";

/// The [`DispatcherHello::features`] entry of a Dispatcher that answers `bots/watch` and
/// `bots/unwatch` (WVE-178).
pub const BOTS_WATCH_FEATURE: &str = "bots_watch";

/// How long a pending request in a Bot's thread waits for the person before the Bot's schedules
/// pause, unless the Bot says otherwise: 12 hours, in milliseconds.
pub const DEFAULT_PAUSE_AFTER: u64 = 12 * 60 * 60 * 1000;

/// The device the Dispatcher's own computer is, on a connection carried from its socket: it
/// proves nothing, as the socket's peer is the Dispatcher's own user, and is named after the
/// computer.
pub const LOCAL_DEVICE: &str = "local";

/// What a device signs in `dispatcher/hello`: the UTF-8 bytes of this line, which no Host
/// takes, as no Dispatcher takes a Host's ([`crate::devices::auth_message`]).
pub fn dispatcher_auth_message(dispatcher_id: &str, device_id: &str, nonce: &str) -> String {
    format!("weave-dispatcher-auth/1 {dispatcher_id} {device_id} {nonce}")
}

/// What a Host signs in `hosts/connect`: the UTF-8 bytes of this line, which neither a device's
/// hello to the Dispatcher nor a Host's hello takes.
pub fn host_connect_message(dispatcher_id: &str, host_id: &str, nonce: &str) -> String {
    format!("weave-dispatcher-host-auth/1 {dispatcher_id} {host_id} {nonce}")
}

/// What the Dispatcher signs in answer to `hosts/carry` ([`HostCarried`]): the UTF-8 bytes of
/// this line, binding the Host's own nonce to the token it presented, which no hello, Host's or
/// device's, takes.
pub fn carry_message(dispatcher_id: &str, host_id: &str, token: &str, nonce: &str) -> String {
    format!("weave-dispatcher-carry/1 {dispatcher_id} {host_id} {token} {nonce}")
}

/// Where a Host reaches the Dispatcher: its WebSocket, through its Tailscale Serve entry, or on
/// the Dispatcher's own computer the socket in its directory that Hosts connect to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum DispatcherAddress {
    Url(String),
    Socket(PathBuf),
}

impl std::fmt::Display for DispatcherAddress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Url(url) => f.write_str(url),
            Self::Socket(path) => write!(f, "{}", path.display()),
        }
    }
}

/// `dispatcher/hello`: the first request on a connection. Until it succeeds, the Dispatcher
/// answers every other request with [`crate::errors::UNAUTHENTICATED`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "dispatcher/hello", response = DispatcherHello)]
pub struct DispatcherHelloRequest {
    /// [`DISPATCHER_PROTOCOL`] as the client speaks it.
    pub protocol: u32,
    pub client: ClientInfo,
    /// How the connection authenticates: none is [`Auth::Local`], on the Unix socket. On the
    /// WebSocket, a paired device's signature of its `dispatcher/challenge`, as
    /// [`dispatcher_auth_message`] spells it, or a pairing with a code.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<Auth>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct DispatcherHello {
    pub protocol: u32,
    /// The weave release the Dispatcher runs.
    pub version: String,
    /// The Dispatcher's own id, which stays the same across restarts and which a device checks
    /// is the Dispatcher it paired with.
    #[serde(default)]
    pub id: String,
    /// The paired device a remote client connected as; none for a local client.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<DeviceInfo>,
    /// Optional parts of its API it answers, such as [`PROJECTS_FEATURE`]. A Dispatcher from
    /// before them says none.
    #[serde(default)]
    pub features: Vec<String>,
}

impl DispatcherHello {
    /// Whether the Dispatcher answers the optional part of its API `feature` names.
    pub fn offers(&self, feature: &str) -> bool {
        self.features.iter().any(|offered| offered == feature)
    }
}

/// `dispatcher/challenge`: what a paired device signs in its `dispatcher/hello`. Only on the
/// WebSocket, before hello.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "dispatcher/challenge", response = DispatcherChallenge)]
pub struct DispatcherChallengeRequest {}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct DispatcherChallenge {
    /// The Dispatcher's id, which the device checks is the Dispatcher it paired with.
    pub dispatcher_id: String,
    /// 32 random bytes, in unpadded base64url, good for one hello on this connection.
    pub nonce: String,
    pub expires_at: Timestamp,
}

/// `dispatcher/status`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "dispatcher/status", response = DispatcherStatus)]
pub struct DispatcherStatusRequest {}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct DispatcherStatus {
    pub version: String,
    pub pid: u32,
    pub started_at: Timestamp,
    /// What it calls itself to the Hosts that join it.
    pub name: String,
    /// Its database.
    pub database: String,
    /// Work written down for a Host that the Host hasn't taken yet.
    pub pending: u32,
    /// Its id, which its paired devices know it by.
    #[serde(default)]
    pub id: String,
    /// Where its WebSocket listens, while a paired device or a Host that joined over it keeps
    /// remote access on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
    /// The devices paired with it.
    #[serde(default)]
    pub devices: u32,
}

/// A Host that joined the Dispatcher, which is a client of it with the `service` role.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct DispatcherHost {
    pub host_id: String,
    /// What the Dispatcher calls it.
    pub name: String,
    /// Where the Dispatcher dialed it, for a Host paired before Hosts joined it
    /// ([`Reachability::Unjoined`]); empty for one that joined.
    #[serde(default)]
    pub url: String,
    /// The device the Host knows the Dispatcher as.
    pub device_id: String,
    /// When it first paired or joined.
    pub paired_at: Timestamp,
    /// When it last joined; none for a Host paired before Hosts joined the Dispatcher.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub joined_at: Option<Timestamp>,
    /// It joined over the Dispatcher's socket, on the Dispatcher's own computer.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub here: bool,
    /// Connected now.
    pub connected: bool,
    /// How the last attempt to connect went.
    pub status: Reachability,
    /// Why it failed, when it did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    /// When it last connected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connected_at: Option<Timestamp>,
    /// Work written down for it that it hasn't taken yet.
    pub pending: u32,
}

/// `hosts/list`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "hosts/list", response = ListHostsResponse)]
pub struct ListHostsRequest {}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ListHostsResponse {
    pub hosts: Vec<DispatcherHost>,
}

/// `hosts/offer`: a one-time code a Host joins the Dispatcher with, good for five minutes
/// (ADR 0030). For a Host on another computer it turns the Dispatcher's WebSocket on, as
/// `devices/offer` does, and gives its URL. For one on the Dispatcher's own computer (`here`),
/// which only a client there may ask for, it gives the socket Hosts connect to instead.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "hosts/offer", response = OfferHostResponse)]
pub struct OfferHostRequest {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub here: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct OfferHostResponse {
    /// 128 random bits in Crockford base32.
    pub code: String,
    pub expires_at: Timestamp,
    /// Where the Host connects to join.
    pub address: DispatcherAddress,
}

/// `hosts/connect`: the request a Host's own connection begins with, after
/// `dispatcher/challenge`: who it is, and its signature of the challenge, as
/// [`host_connect_message`] spells it. Joining, it gives the code `hosts/offer` showed and the
/// key it signs with. Once the Dispatcher answers, it says `host/hello` to the Host on the same
/// connection; a refusal answers [`crate::errors::UNAUTHENTICATED`] and closes it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "hosts/connect", response = HostConnected)]
#[serde(rename_all = "camelCase")]
pub struct ConnectHostRequest {
    /// [`DISPATCHER_PROTOCOL`] as the Host speaks it.
    pub protocol: u32,
    pub host_id: String,
    /// What the Host calls itself, which the Dispatcher calls it when it joins.
    pub name: String,
    /// The weave release the Host runs.
    pub version: String,
    pub signature: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub join: Option<HostJoin>,
}

/// A Host joining: the code `hosts/offer` gave, and the Host's P-256 public key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct HostJoin {
    pub code: String,
    pub public_key: Jwk,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct HostConnected {
    pub dispatcher_id: String,
    /// What the Dispatcher calls itself.
    pub dispatcher_name: String,
    /// The Dispatcher's P-256 public key. At `host/hello` it signs the Host's challenge with it,
    /// as [`crate::devices::auth_message`] spells it, with its id as the device's.
    pub public_key: Jwk,
    /// What the Dispatcher calls the Host.
    pub name: String,
}

/// `hosts/remove`: forget a Host, by id or name, and the work still written down for it. A
/// Host connected now is told, as its connection closes with
/// [`crate::websocket::CLOSE_REVOKED`], and forgets that it joined.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "hosts/remove", response = Empty)]
pub struct RemoveHostRequest {
    pub host: String,
}

/// What a connection the Dispatcher carries to a Host carries (ADR 0030, WVE-195).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum CarriedStream {
    /// The Host protocol, from `host/hello` on, with `auth: {method: "dispatcher"}`.
    #[default]
    Host,
    /// One terminal's stream, opened with the ticket `terminals/attach` gave on a carried
    /// connection of the same device's ([`crate::terminals::stream`]).
    Terminal,
}

/// `hosts/open`: the last request on a connection a device asks the Dispatcher to carry to one
/// of the person's Hosts (ADR 0030, WVE-195), after its challenge and hello: on the WebSocket
/// with [`DISPATCHER_CARRY_SUBPROTOCOL`], or on the Dispatcher's socket on its own computer. The
/// Dispatcher answers once the Host has opened a connection of its own to be joined to this one,
/// and from then on passes what either sends to the other unchanged. A Host it isn't connected
/// to answers [`crate::errors::HOST_UNAVAILABLE`] at once, with [`HostUnavailable`] as its data.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "hosts/open", response = OpenedHost)]
pub struct OpenHostRequest {
    /// By id or name, as `hosts/list` gives them.
    pub host: String,
    #[serde(default)]
    pub stream: CarriedStream,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct OpenedHost {
    pub host_id: String,
    /// What the Dispatcher calls it.
    pub name: String,
}

/// Why the Dispatcher can't carry a connection to a Host: the `data` of the
/// [`crate::errors::HOST_UNAVAILABLE`] that `hosts/open` answers, as `hosts/list` says it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct HostUnavailable {
    pub status: Reachability,
    pub why: String,
}

/// `hosts/carry`: on a connection a Host opens to the Dispatcher it joined with
/// [`DISPATCHER_HOST_SUBPROTOCOL`], after `dispatcher/challenge`, in place of `hosts/connect`:
/// the token a [`CarryRequest`] gave it, and a nonce of the Host's own, which the Dispatcher
/// signs ([`HostCarried`]). Once the Host has checked the signature with the key it learned when
/// it joined, the connection is the Host's end of the device's, and the Host serves it; without
/// the signature, or with a wrong one, the Host closes it, serving nothing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "hosts/carry", response = HostCarried)]
pub struct HostCarryRequest {
    pub token: String,
    /// 32 random bytes, in unpadded base64url, fresh for this connection.
    pub nonce: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct HostCarried {
    /// The Dispatcher's signature of [`carry_message`] with its own key, as a device's in
    /// `host/hello`: DER, in unpadded base64url.
    pub signature: String,
}

/// `dispatcher/carry`, in the Host protocol: the Dispatcher the Host joined asks it, over the
/// connection the Host keeps open to it, to open another for a device's (ADR 0030, WVE-195).
/// The Host connects to the Dispatcher where it joined it, presents `token` in
/// [`HostCarryRequest`] with a nonce the Dispatcher signs, and answers once it has checked the
/// signature; then it serves that connection for `device`, a paired device of the Dispatcher's,
/// as a remote client of `stream`'s kind. Only the Dispatcher the Host joined may ask, on the connection the Host
/// opened to it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "dispatcher/carry", response = Empty)]
pub struct CarryRequest {
    /// Random, and good once for a few seconds.
    pub token: String,
    pub device: DeviceInfo,
    #[serde(default)]
    pub stream: CarriedStream,
}

/// What a schedule does about an occurrence it missed, as while its computer slept.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum Missed {
    /// Run the latest missed occurrence once, late, within the look-back; skip the rest.
    #[default]
    Latest,
    /// Skip every missed occurrence.
    Skip,
}

/// What a schedule does when an occurrence comes while its previous one is still waiting or
/// running.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum Overlap {
    /// Skip it.
    #[default]
    Skip,
    /// Start it anyway, in a thread of its own: only for a schedule that starts a new thread
    /// each time.
    Allow,
}

/// A schedule: a trigger whose occurrences start a headless turn on one of the person's Hosts
/// at the times its cron expression gives, in its time zone, or once at the time it names (a
/// one-off). A Bot's schedule prompts the Bot (WVE-118): its Host, agent, directory, policy,
/// mode and thread are the Bot's as it lists now.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: String,
    pub name: String,
    /// Five fields, minute to weekday, or a name such as `@daily`; empty for a one-off.
    pub cron: String,
    /// A one-off's time, its one occurrence's (feature `bots`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<Timestamp>,
    /// An IANA time zone, such as `Africa/Johannesburg`.
    pub zone: String,
    pub host_id: String,
    pub host_name: String,
    /// The Bot each occurrence prompts, for a Bot's schedule (feature `bots`): `run` gives its
    /// agent, home as `cwd`, policy, mode and current thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_name: Option<String>,
    /// The Bot asked for it itself, from one of its threads, with the Dispatcher's `wake_me`
    /// tool (feature `bots`): a one-off, which the Dispatcher forgets a week after its time once
    /// its occurrence is over. Absent for the person's own schedules.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub wake_up: bool,
    #[serde(flatten)]
    pub run: ScheduledRun,
    pub missed: Missed,
    pub overlap: Overlap,
    pub created_at: Timestamp,
    /// Why it's paused, when it is: by the person, or after failing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused: Option<String>,
    /// Its occurrences that failed or were interrupted in a row.
    pub failures: u32,
    /// When it next runs, unless it's paused; absent for a one-off once its time has come.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_at: Option<Timestamp>,
    /// That, in its time zone: "Wed 4 Nov 09:00 SAST".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
    /// Its latest occurrence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last: Option<Occurrence>,
}

/// What each of a schedule's occurrences starts on its Host.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRun {
    pub agent_id: AgentId,
    pub cwd: PathBuf,
    pub prompt: Vec<ContentBlock>,
    pub policy: PermissionPolicy,
    /// The mode a new thread starts in; the agent's configured one when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// The thread each occurrence prompts; each starts a new one when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<ThreadId>,
}

/// How one occurrence of a schedule went.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum OccurrenceState {
    /// Not run, saying why.
    Skipped,
    /// Written down for its Host, which hasn't taken it yet, as while it's unreachable.
    Waiting,
    /// Its Host started its turn.
    Started,
    /// Its turn is over, as `outcome` says.
    Finished,
    /// Its Host refused it, saying why.
    Failed,
}

/// One time a schedule came due, or was run by hand.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Occurrence {
    pub id: String,
    pub schedule_id: String,
    /// The time it was due: when it was run by hand, for one that was.
    pub scheduled_at: Timestamp,
    /// It started more than a minute after it was due, as a catch-up does.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub late: bool,
    /// Run by hand (`schedules/run`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub manual: bool,
    pub state: OccurrenceState,
    /// How its turn ended, once it's finished.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<TurnState>,
    /// Why it was skipped or failed, or what its turn's error said.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    pub recorded_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<Timestamp>,
}

/// `schedules/list`: every schedule, or with `bot` (feature `bots_home`) only the schedules
/// that prompt that Bot, its wake-ups included.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "schedules/list", response = ListSchedulesResponse)]
pub struct ListSchedulesRequest {
    /// By id or name; invalid params for none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ListSchedulesResponse {
    pub schedules: Vec<Schedule>,
}

/// `schedules/add`: a schedule with `cron`, or a one-off with `at` (feature `bots`), that names
/// either a Host with `agentId`, `cwd` and `policy`, and maybe `mode` or `thread`, or a Bot
/// (feature `bots`) in place of all of those. Invalid params, saying why, for both or neither of
/// each pair.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "schedules/add", response = ScheduleResponse)]
#[serde(rename_all = "camelCase")]
pub struct AddScheduleRequest {
    /// Unique among the Dispatcher's schedules.
    pub name: String,
    /// Absent for a one-off, which gives `at`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron: Option<String>,
    /// A one-off's time, after now, in place of `cron`: it has one occurrence then, or a
    /// catch-up after it as `missed` says, and is kept, done, with that occurrence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<Timestamp>,
    /// The Dispatcher's own time zone when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zone: Option<String>,
    /// The Host, by id or name; absent for a Bot's schedule.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    /// The Bot each occurrence prompts, by id or name, in place of `host`, `agentId`, `cwd`,
    /// `policy`, `mode` and `thread`: the prompt goes into its current thread, or starts its
    /// first. Its `overlap` is `skip`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<AgentId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<PathBuf>,
    pub prompt: Vec<ContentBlock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<PermissionPolicy>,
    /// The mode a new thread starts in; the agent's configured one when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// The thread each occurrence prompts; each starts a new one when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<ThreadId>,
    #[serde(default)]
    pub missed: Missed,
    #[serde(default)]
    pub overlap: Overlap,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ScheduleResponse {
    pub schedule: Schedule,
}

/// `schedules/remove`: forget a schedule, by id or name, and its occurrences. One already
/// started runs on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "schedules/remove", response = Empty)]
pub struct RemoveScheduleRequest {
    pub schedule: String,
}

/// `schedules/pause`: run nothing until resumed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "schedules/pause", response = ScheduleResponse)]
pub struct PauseScheduleRequest {
    pub schedule: String,
}

/// `schedules/resume`: run again from now on, catching up nothing missed while paused, and
/// forget its failures.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "schedules/resume", response = ScheduleResponse)]
pub struct ResumeScheduleRequest {
    pub schedule: String,
}

/// `schedules/run`: run it now, as an occurrence of its own, paused or not.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "schedules/run", response = OccurrenceResponse)]
pub struct RunScheduleRequest {
    pub schedule: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct OccurrenceResponse {
    pub occurrence: Occurrence,
}

/// `occurrences/list`: the latest occurrences, of one schedule or all, newest first.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "occurrences/list", response = ListOccurrencesResponse)]
pub struct ListOccurrencesRequest {
    /// By id or name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<String>,
    /// 50 when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ListOccurrencesResponse {
    pub occurrences: Vec<Occurrence>,
}

/// What a Project's locations are, fixed when it's made.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum ProjectKind {
    /// A git repository on each Host, by its primary worktree, so all its worktrees are in
    /// the Project.
    Git,
    /// A directory outside any repository, as given.
    Directory,
}

impl ProjectKind {
    /// How it's named in messages: "git" or "directory".
    pub fn name(self) -> &'static str {
        match self {
            Self::Git => "git",
            Self::Directory => "directory",
        }
    }
}

/// Where a Project is on one of the person's Hosts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ProjectLocation {
    /// The Host, by its id; `hosts/list` gives its name.
    pub host_id: String,
    /// Absolute on that Host's computer: a git Project's repository by its primary worktree.
    pub path: PathBuf,
}

/// A named piece of the person's work (ADR 0031, WVE-189), with at most one location on each of
/// their Hosts: a repository there, or a directory outside one. The Dispatcher keeps it, as the
/// only one of the person's programs that sees every Host; Hosts know nothing of it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Project {
    /// `p-` and 20 hex digits.
    pub id: String,
    /// What it's shown as and named by, with its id: unique among the Dispatcher's Projects,
    /// ignoring case.
    pub name: String,
    pub kind: ProjectKind,
    /// A git Project's repository's remote, as [`crate::worktrees::GitLocation::remote`] gives
    /// it, such as `github.com/owner/name`: a clone with it on another Host may join the
    /// Project. Absent for a repository without one, and for a directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
    /// At most one for each Host, in the order they were added. Empty once every Host it was on
    /// has been removed from the Dispatcher.
    #[serde(default)]
    pub locations: Vec<ProjectLocation>,
    pub created_at: Timestamp,
    /// When it was renamed, or a location added or removed, last.
    pub updated_at: Timestamp,
}

impl Project {
    /// Its location on `host_id`, if it has one there.
    pub fn location(&self, host_id: &str) -> Option<&ProjectLocation> {
        self.locations
            .iter()
            .find(|location| location.host_id == host_id)
    }
}

/// A directory to make a location of a Project, as its Host's `worktrees/list` placed it: a
/// repository by its primary worktree, with the repository's remote, or a directory outside one,
/// as given.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct NewLocation {
    /// A Host that joined the Dispatcher, by its id.
    pub host_id: String,
    /// Absolute on that Host's computer.
    pub path: PathBuf,
    pub kind: ProjectKind,
    /// As [`crate::worktrees::GitLocation::remote`], for a repository that has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
}

/// `projects/list`: the Projects, by name.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "projects/list", response = ListProjectsResponse)]
pub struct ListProjectsRequest {}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ListProjectsResponse {
    pub projects: Vec<Project>,
}

/// `projects/get`: one Project, by id or name, ignoring case.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "projects/get", response = ProjectResponse)]
pub struct GetProjectRequest {
    pub project: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ProjectResponse {
    pub project: Project,
}

/// `projects/add`: a new Project, of the kind its first location is. Invalid params, saying
/// why, for an empty name, a name another Project has ignoring case, a Host that hasn't joined
/// the Dispatcher, a path that isn't absolute, or a location another Project has.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "projects/add", response = ProjectResponse)]
pub struct AddProjectRequest {
    pub name: String,
    pub location: NewLocation,
}

/// `projects/update`: rename a Project, remove its location on one Host, and add one, in that
/// order and all or none. A location added is refused when it's another kind than the
/// Project's, a repository whose remote isn't the Project's, or on a Host where the Project
/// has a location still: one at the same path again changes nothing. A git Project without a
/// remote takes the remote of a location added with one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "projects/update", response = ProjectResponse)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProjectRequest {
    /// By id or name.
    pub project: String,
    /// Its new name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Remove its location on this Host, by id or name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remove_host: Option<String>,
    /// Add this location.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub add: Option<NewLocation>,
}

/// `projects/remove`: forget a Project, by id or name, and all its locations. What's in its
/// directories stays.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "projects/remove", response = Empty)]
pub struct RemoveProjectRequest {
    pub project: String,
}

/// What a Bot's current thread is doing, as the Dispatcher last saw it on the Bot's Host.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum BotState {
    /// Its thread runs a turn.
    Working,
    /// A pending request in its thread waits for the person.
    NeedsYou,
    /// Nothing runs: its thread is idle or not open, it has none yet, or the Dispatcher isn't
    /// connected to its Host.
    Idle,
}

/// One of a Bot's threads.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct BotThread {
    pub thread_id: ThreadId,
    /// When its Host started it.
    pub started_at: Timestamp,
    /// When a new thread took over from it; absent for the current one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<Timestamp>,
}

/// A named assistant the Dispatcher keeps (ADR 0028, WVE-118), whose work goes on in ordinary
/// threads, one at a time, on the one Host it names, in its home. Its prompts, from the person
/// through the Dispatcher and from its schedules, go into its current thread; a new thread takes
/// over when asked or daily, after the one before saves what it learned to the home. Its Host
/// learns nothing of it: its threads carry the labels `dispatcher` and `bot:<id>`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Bot {
    /// `b-` and 20 hex digits.
    pub id: String,
    /// What it's shown as and named by, with its id: unique among the Dispatcher's Bots,
    /// ignoring case.
    pub name: String,
    pub agent_id: AgentId,
    /// The Host its threads run on, which it never leaves.
    pub host_id: String,
    /// What the Dispatcher calls that Host now.
    pub host_name: String,
    /// Whether the Dispatcher is connected to its Host now.
    pub connected: bool,
    /// Where its threads run and its memory files are, on its Host: absolute there, or under
    /// the Host's home as `~/…`.
    pub home: PathBuf,
    /// What its new threads answer permission requests by.
    pub policy: PermissionPolicy,
    /// The mode its new threads start in; the agent's configured one when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// A local time, `HH:MM` in `zone`, at which it starts a new thread each day, if its
    /// thread has had a turn since it started.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_thread_at: Option<String>,
    /// An IANA time zone, such as `Africa/Johannesburg`.
    pub zone: String,
    /// How long, in milliseconds, a pending request in its thread may wait for the person
    /// before its schedules pause.
    pub pause_after: u64,
    /// Its current thread; absent until the first prompt that reaches it starts one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<ThreadId>,
    /// Every thread it has had, oldest first, the current one last.
    #[serde(default)]
    pub threads: Vec<BotThread>,
    pub state: BotState,
    /// Since when a pending request in its current thread has waited for the person, as the
    /// Dispatcher saw it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting_since: Option<Timestamp>,
    /// Why its schedules' occurrences are skipped, while they are: its thread has waited on
    /// the person longer than `pause_after`. It resumes by itself once the thread no longer
    /// waits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused: Option<String>,
    /// A new thread is being started: prompts for it wait, oldest first, to go into that one.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub starting_thread: bool,
    pub created_at: Timestamp,
    /// When it was last changed with `bots/update`.
    pub updated_at: Timestamp,
    /// The Bot that made it, by id, when another Bot did (feature `bots_home`); absent for one
    /// the person added.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
    /// That Bot's name now; absent once it's gone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_by_name: Option<String>,
}

/// `bots/list`: the Bots, by name.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "bots/list", response = ListBotsResponse)]
pub struct ListBotsRequest {}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ListBotsResponse {
    pub bots: Vec<Bot>,
}

/// `bots/get`: one Bot, by id or name, ignoring case; invalid params for none.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "bots/get", response = BotResponse)]
pub struct GetBotRequest {
    pub bot: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct BotResponse {
    pub bot: Bot,
}

/// `bots/add`: a new Bot, with no thread yet: the first prompt that reaches it starts one in
/// its home. Invalid params, saying why, for an empty name or one of more than one line, a name
/// another Bot has ignoring case, a Host that hasn't joined, an empty agent, a home that is
/// neither whole nor under `~`, a time zone that doesn't parse, or a `newThreadAt` that isn't
/// `HH:MM`.
///
/// With feature `bots_home` (WVE-178), once those pass the Dispatcher has the Bot's Host make
/// the home with `repos/init`: a git repository of its own, with the Bot's first memory files,
/// `AGENTS.md` and `CLAUDE.md`, committed unless one of them is there already. The Bot is added
/// only once that's done, with the home as the Host gives it, whole, and the answer says what
/// making it did. Refused with `host_unavailable` while the Host isn't connected, and as invalid
/// params when the Host is too old to make one or refuses, saying why; no Bot is added then.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "bots/add", response = AddBotResponse)]
#[serde(rename_all = "camelCase")]
pub struct AddBotRequest {
    pub name: String,
    /// The Host, by id or name.
    pub host: String,
    pub agent_id: AgentId,
    /// Whole on the Host, or under its home as `~/…`; `~/bots/<name>` when absent, the name
    /// lowercased with a hyphen for each run of spaces or slash.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home: Option<PathBuf>,
    /// What the Bot is for, in the person's words: its first `AGENTS.md` says so.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job: Option<String>,
    /// Approving nothing, so what isn't approved waits for the person, when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<PermissionPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// `HH:MM`: a new thread daily, then, in `zone`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_thread_at: Option<String>,
    /// The Dispatcher's own time zone when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zone: Option<String>,
    /// [`DEFAULT_PAUSE_AFTER`] when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause_after: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct AddBotResponse {
    pub bot: Bot,
    /// What making its home on its Host did; absent from a Dispatcher without `bots_home`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home: Option<InitRepositoryResponse>,
}

/// `bots/watch`: the Bots, as `bots/list` gives them; then a [`BotUpdatedNotification`]
/// whenever one is added or anything `bots/list` gives of it changes, and a
/// [`BotRemovedNotification`] when one is removed, until the connection ends or the client
/// sends `bots/unwatch` (feature `bots_watch`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "bots/watch", response = ListBotsResponse)]
pub struct WatchBotsRequest {}

/// `bots/unwatch`: stop what `bots/watch` sends.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "bots/unwatch", response = Empty)]
pub struct UnwatchBotsRequest {}

/// `bots/updated`, to clients watching the Bots: one was added, or changed, as it lists now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcNotification)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[notification(method = "bots/updated")]
pub struct BotUpdatedNotification {
    pub bot: Bot,
}

/// `bots/removed`, to clients watching the Bots: the Bot `bot`, by id, was removed, or its
/// Host was.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcNotification)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[notification(method = "bots/removed")]
pub struct BotRemovedNotification {
    pub bot: String,
}

/// `bots/update`: change what's given, all or none, checked as `bots/add` checks it. A policy
/// or mode applies to threads started from then on: an open thread keeps its own. `mode` and
/// `newThreadAt` are cleared with `null`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "bots/update", response = BotResponse)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBotRequest {
    /// By id or name.
    pub bot: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<PermissionPolicy>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "schema", schemars(with = "Option<String>"))]
    pub mode: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "schema", schemars(with = "Option<String>"))]
    pub new_thread_at: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zone: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause_after: Option<u64>,
}

/// A field an update leaves as it is when absent, clears when `null`, and sets otherwise.
fn nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// `bots/remove`: forget a Bot, by id or name, its schedules and the prompts still waiting for
/// it. Its threads and its home stay on its Host.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "bots/remove", response = Empty)]
pub struct RemoveBotRequest {
    pub bot: String,
}

/// `bots/send`: a prompt for a Bot, by id or name, from a sender that isn't attached to its
/// thread, such as the CLI or a script. It's written down, as a delivery, and goes into the
/// Bot's current thread when first sent (queued there behind whatever runs), or starts its
/// first thread; while a new thread is being started, it waits for that one. With `key`, the
/// same key again names the same delivery and sends nothing more.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "bots/send", response = SentToBot)]
pub struct SendToBotRequest {
    pub bot: String,
    pub prompt: Vec<ContentBlock>,
    /// The sender's own name for this prompt, unique for the Bot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct SentToBot {
    /// The delivery that carries the prompt, which its turn's origin names as its `id`.
    pub delivery_id: String,
    /// The Bot as it stands now: its current thread, if it has one yet, and whether a new
    /// one is being started.
    pub bot: Bot,
}

/// `bots/newThread`: start a Bot's new thread, by id or name. Prompts for it wait from now on;
/// once its current thread is idle, that thread is asked to save what's worth keeping to the
/// Bot's memory files, note itself in `threads/` in the home and commit; then a new thread
/// starts in the home, the old one names it as its successor, and the prompts that waited go
/// into it. Invalid params, saying why, for a Bot with no thread yet or one starting one
/// already.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "bots/newThread", response = BotResponse)]
pub struct NewBotThreadRequest {
    pub bot: String,
}

/// `dispatcher/join`, in the Host protocol: have the Host join the Dispatcher at `address` with
/// the code `hosts/offer` gave there, and keep a connection open to it from then on (ADR 0030).
/// Only clients on the Host's own computer may ask. A Host joins one Dispatcher: joining another
/// leaves the first.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "dispatcher/join", response = JoinDispatcherResponse)]
pub struct JoinDispatcherRequest {
    pub address: DispatcherAddress,
    pub code: String,
    /// What the Dispatcher calls this Host; the computer's name when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct JoinDispatcherResponse {
    pub dispatcher: JoinedDispatcher,
}

/// `dispatcher/leave`, in the Host protocol: forget the Dispatcher the Host joined and close the
/// connection to it, which tells the Dispatcher. Only clients on the Host's own computer may ask.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "dispatcher/leave", response = Empty)]
pub struct LeaveDispatcherRequest {}

/// The Dispatcher a Host joined, and its connection to it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct JoinedDispatcher {
    pub id: String,
    /// What the Dispatcher calls itself.
    pub name: String,
    pub address: DispatcherAddress,
    /// What the Dispatcher calls this Host.
    pub host_name: String,
    pub joined_at: Timestamp,
    /// Connected now.
    pub connected: bool,
    /// When it last connected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connected_at: Option<Timestamp>,
    /// Why the last connection failed or closed, when it did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
}
