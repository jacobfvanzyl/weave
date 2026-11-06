//! The Dispatcher's API (ADR 0027, WVE-175): what the `weave` CLI asks the Dispatcher, over its
//! Unix socket on its own computer, or over its WebSocket from the person's other devices,
//! paired with it as they pair with a Host (WVE-176). The Dispatcher is a client of the
//! person's Hosts, paired with each as a service: the Hosts it is paired with and how it
//! reaches them, and its schedules (WVE-145) and their occurrences. Its devices are managed
//! with the Host's `devices/*` requests, on its own computer only. The specification is
//! `docs/specs/wve-175-dispatcher.md`.

use std::path::PathBuf;

use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::JsonRpcResponse;
use agent_client_protocol::schema::v1::ContentBlock;
use agent_client_protocol::schema::v1::SessionId;
use serde::Deserialize;
use serde::Serialize;

use crate::Empty;
use crate::Timestamp;
use crate::agents::AgentId;
use crate::devices::DeviceInfo;
use crate::hello::Auth;
use crate::hello::ClientInfo;
use crate::policy::PermissionPolicy;
use crate::sessions::TurnState;
use crate::turns::TurnId;

/// How the Dispatcher's last attempt to connect to a Host went.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum Reachability {
    /// It took the Dispatcher's key at hello; the Dispatcher may be connected to it now.
    Reachable,
    /// Not tried since the Dispatcher started.
    Unchecked,
    /// It refused the Dispatcher's key, as after it revoked it: pairing again is the way back.
    Refused,
    /// Its computer answered at the URL, but no weave Host did, as when the Host isn't running
    /// there.
    Down,
    /// Nothing answered at the URL, as when the computer is asleep or off the tailnet.
    Unreachable,
    /// Another weave Host answers at the URL.
    OtherHost,
}

/// The Dispatcher API's version, which a client and the Dispatcher must share.
pub const DISPATCHER_PROTOCOL: u32 = 1;

/// The subprotocol a client of the Dispatcher's WebSocket asks for, so one that reached a Host
/// instead fails at the upgrade.
pub const DISPATCHER_SUBPROTOCOL: &str = "weave-dispatcher";

/// What a device signs in `dispatcher/hello`: the UTF-8 bytes of this line, which no Host
/// takes, as no Dispatcher takes a Host's ([`crate::devices::auth_message`]).
pub fn dispatcher_auth_message(dispatcher_id: &str, device_id: &str, nonce: &str) -> String {
    format!("weave-dispatcher-auth/1 {dispatcher_id} {device_id} {nonce}")
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
    /// The name it pairs with Hosts as.
    pub name: String,
    /// Its database.
    pub database: String,
    /// Work written down for a Host that the Host hasn't taken yet.
    pub pending: u32,
    /// Its id, which its paired devices know it by.
    #[serde(default)]
    pub id: String,
    /// Where its WebSocket listens, while a paired device keeps remote access on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
    /// The devices paired with it.
    #[serde(default)]
    pub devices: u32,
}

/// A Host the Dispatcher is paired with, as a service.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct DispatcherHost {
    pub host_id: String,
    /// What the Dispatcher calls it.
    pub name: String,
    pub url: String,
    /// The device the Host knows the Dispatcher as, which `weave devices revoke` there takes.
    pub device_id: String,
    pub paired_at: Timestamp,
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

/// `hosts/add`: pair with the Host at `url` as a service, with the code `weave pair` showed
/// there.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "hosts/add", response = AddHostResponse)]
pub struct AddHostRequest {
    pub url: String,
    pub code: String,
    /// What to call it; its tailnet name when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct AddHostResponse {
    pub host: DispatcherHost,
}

/// `hosts/remove`: forget a Host, by id or name, and close the connection to it. Work still
/// written down for it is dropped. The Host keeps the Dispatcher as a device until it's
/// revoked there.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "hosts/remove", response = Empty)]
pub struct RemoveHostRequest {
    pub host: String,
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
/// at the times its cron expression gives, in its time zone.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: String,
    pub name: String,
    /// Five fields, minute to weekday, or a name such as `@daily`.
    pub cron: String,
    /// An IANA time zone, such as `Africa/Johannesburg`.
    pub zone: String,
    pub host_id: String,
    pub host_name: String,
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
    /// When it next runs, unless it's paused.
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
    pub thread: Option<SessionId>,
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
    pub session_id: Option<SessionId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    pub recorded_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<Timestamp>,
}

/// `schedules/list`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "schedules/list", response = ListSchedulesResponse)]
pub struct ListSchedulesRequest {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ListSchedulesResponse {
    pub schedules: Vec<Schedule>,
}

/// `schedules/add`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "schedules/add", response = ScheduleResponse)]
#[serde(rename_all = "camelCase")]
pub struct AddScheduleRequest {
    /// Unique among the Dispatcher's schedules.
    pub name: String,
    pub cron: String,
    /// The Dispatcher's own time zone when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zone: Option<String>,
    /// The Host, by id or name.
    pub host: String,
    #[serde(flatten)]
    pub run: ScheduledRun,
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
