//! Threads: listing them, creating them, attaching to them and letting them go.
//!
//! A thread's id is its agent's ACP session id ([`ThreadId`]). Subagent threads are reached
//! through their parent: requests for them go to the parent's agent, and their events into the
//! parent's journal.

use std::path::PathBuf;

use agent_client_protocol::Error;
use agent_client_protocol::JsonRpcNotification;
use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::JsonRpcResponse;
use agent_client_protocol::schema::v1::ContentBlock;
use agent_client_protocol::schema::v1::InitializeResponse;
use agent_client_protocol::schema::v1::PromptResponse;
use agent_client_protocol::schema::v1::SessionConfigId;
use agent_client_protocol::schema::v1::SessionConfigOption;
use agent_client_protocol::schema::v1::SessionConfigOptionValue;
use agent_client_protocol::schema::v1::SessionId;
use agent_client_protocol::schema::v1::SessionInfo;
use agent_client_protocol::schema::v1::SessionModeId;
use agent_client_protocol::schema::v1::SessionModeState;
use agent_client_protocol::schema::v1::SetSessionConfigOptionResponse;
use serde::Deserialize;
use serde::Serialize;

use crate::Empty;
use crate::Timestamp;
use crate::agents::AgentId;
use crate::agents::AgentRelease;
use crate::agents::AgentUpdate;
use crate::hello::ClientId;
use crate::mcp::McpServerStatus;
use crate::pending::PendingRequest;
use crate::policy::PermissionPolicy;
use crate::queue::QueuePause;
use crate::queue::QueuedPrompt;
use crate::turns::TurnId;
use crate::worktrees::GitLocation;

/// A thread's id: the id of its agent's ACP session (ADR 0021).
pub type ThreadId = SessionId;

/// A thread's journal, by an id that changes only when the Host starts a new journal for
/// the thread, as when a closed thread is opened again.
pub type JournalId = String;

/// An event's place in a thread's journal: where a client catches up after.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct JournalPosition {
    pub journal: JournalId,
    pub seq: u64,
}

/// Where a thread's journal is up to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct JournalHead {
    pub id: JournalId,
    /// The position of the last event written; 0 before any.
    pub head: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum ThreadStatus {
    /// The Host holds it and its agent runs.
    Open,
    /// It was open when its Host stopped; attaching opens it again from its journal.
    Suspended,
    /// The Host no longer holds it; attaching opens it again from the agent's history.
    Closed,
}

/// What an open thread is doing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum Activity {
    Idle,
    Running,
    /// A pending request waits for a person.
    Waiting,
}

/// The agent a thread runs with.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ThreadAgent {
    pub id: AgentId,
    pub name: String,
    /// What the agent said about itself: capabilities, prompt capabilities, sign-in.
    pub initialize: InitializeResponse,
    /// The version the Host launched, for presets and registry agents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release: Option<AgentRelease>,
}

/// Who started a turn.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum TurnOrigin {
    /// A client's prompt: its name, and its connection, so it knows its own prompts. A
    /// remote client's names its device too.
    Client {
        name: String,
        id: ClientId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        device: Option<String>,
    },
    /// A headless run.
    Run {},
    /// Another thread: one whose agent began the turn through a Host tool, or, in a report,
    /// the thread the Host reports on (ADR 0023).
    #[serde(rename_all = "camelCase")]
    Thread {
        thread_id: ThreadId,
        /// The Host that thread is on, when it isn't this one: the id of another of the
        /// person's Hosts, as the service that reaches them gave it (ADR 0029).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        host: Option<String>,
        /// What the person calls that Host, as the service gave it, for clients to show.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        host_name: Option<String>,
        /// The Host's report on that thread, of how a turn this thread's agent began there
        /// ended or that it waits on a person. Nobody hears how a report's turn ends.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        report: bool,
    },
    /// A service's turn (ADR 0027), naming what started it in the service's own words.
    Service {
        /// The name the service paired with, which the Host gives, never the request.
        name: String,
        /// What started the turn, such as "schedule daily-review".
        label: String,
        /// The service's own id for it, such as a trigger's occurrence.
        id: String,
    },
}

/// What started a turn a service sends (ADR 0027), which its origin names.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ServiceOrigin {
    /// What started it, such as "schedule daily-review" or "your message from iPhone".
    pub label: String,
    /// The service's own id for it, such as a trigger's occurrence.
    pub id: String,
}

/// The [`crate::hello::HelloResponse::features`] entry of a Host whose agents reach the
/// person's other Hosts through a service, the Dispatcher (ADR 0029, WVE-185): a service may
/// declare that it reaches them ([`crate::tools::DeclareToolsRequest::hosts`]), and is sent
/// the Host tool calls that name another Host ([`crate::tools::HostCallNotification`]); it may
/// name a thread on another Host as a turn's caller ([`RunRequest::caller`]) and report on one
/// ([`ReportThreadRequest`]); and `thread/run` takes a `cwd` under the home, `~/…`, and the
/// `remote` it has to be a checkout of.
pub const OTHER_HOSTS_FEATURE: &str = "otherHosts";

/// A thread on another of the person's Hosts (feature `otherHosts`), as a service names it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct OtherThread {
    pub thread_id: ThreadId,
    /// The Host it's on, by its id.
    pub host: String,
    /// What the person calls that Host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_name: Option<String>,
}

/// A turn running now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct RunningTurn {
    /// The thread it runs in: the root or a subagent thread.
    pub thread_id: ThreadId,
    pub started_at: Timestamp,
    pub origin: TurnOrigin,
    /// Its id (feature `turnIds`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
}

/// An open thread as a client attached to it sees it; notifications keep it up to date.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ThreadState {
    pub thread_id: ThreadId,
    pub agent: ThreadAgent,
    pub cwd: PathBuf,
    #[serde(default)]
    pub additional_directories: Vec<PathBuf>,
    /// Where in a git repository `cwd` is; absent outside one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<GitLocation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub state: ThreadStatus,
    pub activity: Activity,
    /// Attached now, the receiving client included.
    pub clients: u32,
    /// Nobody has prompted it yet.
    pub blank: bool,
    pub policy: PermissionPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modes: Option<SessionModeState>,
    #[serde(default)]
    pub config_options: Vec<SessionConfigOption>,
    #[serde(default)]
    pub turns: Vec<RunningTurn>,
    /// Prompts waiting, in order, for the next turns (feature `queue`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub queue: Vec<QueuedPrompt>,
    /// Why the queue waits rather than start the next turn; absent while it runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_paused: Option<QueuePause>,
    #[serde(default)]
    pub pending: Vec<PendingRequest>,
    /// Subagent threads so far.
    #[serde(default)]
    pub subagents: Vec<ThreadId>,
    pub journal: JournalHead,
    /// Things worth telling the user, such as skipped MCP servers.
    #[serde(default)]
    pub notices: Vec<String>,
    /// The MCP servers its agent was given, or left without (feature [`crate::mcp::FEATURE`]).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_servers: Vec<McpServerStatus>,
    /// Where the Host writes this thread's protocol trace, when asked to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace: Option<PathBuf>,
    /// A newer version of the agent than the thread runs, once the Host has found one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update: Option<AgentUpdate>,
    /// The thread whose agent started it, for a delegated thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_by: Option<ThreadId>,
    /// The Host the thread that started it is on, when it isn't this one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_by_host: Option<String>,
    /// Its successor, as its listing's `continuedIn` (WVE-168).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continued_in: Option<ThreadId>,
    /// Its labels, as its listing's (WVE-173).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ThreadListing {
    /// As ACP lists it: id, directory, title, last update.
    pub info: SessionInfo,
    pub agent_id: AgentId,
    pub state: ThreadStatus,
    /// Open threads only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<Activity>,
    #[serde(default)]
    pub clients: u32,
    /// A permission policy answers its requests, so it runs with nobody attached.
    #[serde(default)]
    pub headless: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<Timestamp>,
    /// Where in a git repository its directory is, as the Host last read it while the thread
    /// was open; absent outside one, and for threads the Host has no record of.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<GitLocation>,
    /// The thread whose agent started it, for a delegated thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_by: Option<ThreadId>,
    /// The Host the thread that started it is on, when it isn't this one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_by_host: Option<String>,
    /// Its successor (feature `successors`, WVE-168): the thread its work goes on in, which a
    /// client named with `thread/setSuccessor`. Clients following this one may follow that,
    /// and reports to this one go there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continued_in: Option<ThreadId>,
    /// Its labels (feature `labels`, WVE-173), in order, which clients gave it and filter by.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
    /// How much of its agent's context window it uses (feature `context`, WVE-174), from its
    /// latest ACP `usage_update`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<ContextUsage>,
    /// Its last completed compaction (feature `context`), from ACP's `compaction_update`; absent
    /// for an agent that reports compaction otherwise, as Codex's adapter does in text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_compaction: Option<LastCompaction>,
    /// The client whose `thread/create` or `thread/attach` opened it last, while it's open:
    /// a paired device's names its `device`. A service's `thread/run` that opened it gives
    /// the turn's origin. Absent for one another headless run or a Host taking it up opened.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opened_by: Option<TurnOrigin>,
    /// When it opened last, while it's open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opened_at: Option<Timestamp>,
}

/// The Host offers [`ThreadListing::context`] and [`ThreadListing::last_compaction`], in
/// `features` (WVE-174).
pub const CONTEXT_FEATURE: &str = "context";

/// A thread's context usage, as its agent last reported it: tokens in context, of the window.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    pub used: u64,
    pub size: u64,
}

/// A thread's last completed compaction: when it completed, and the tokens in context its
/// agent reported next, once it has.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct LastCompaction {
    pub at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used: Option<u64>,
}

/// `threads/list`. Without an agent: the threads the Host has a journal for, across
/// agents, most recently active first. With one: that agent's in `cwd`, the Host's own first,
/// then the agent's own listing, paged by its cursor. Blank threads are never listed.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "threads/list", response = ListThreadsResponse)]
#[serde(rename_all = "camelCase")]
pub struct ListThreadsRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<AgentId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<PathBuf>,
    /// Only the threads in this repository's worktrees, given by any directory in it. Without
    /// an agent only (feature `worktrees`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<PathBuf>,
    /// Only the open threads doing this. Without an agent only (feature `turnIds`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<Activity>,
    /// Only the threads that carry every one of these labels (feature `labels`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ListThreadsResponse {
    pub threads: Vec<ThreadListing>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// The Host offers [`GetThreadRequest`], in `features`.
pub const GET_FEATURE: &str = "threads/get";

/// `threads/get`: one thread the Host has a journal for, open or not, as `threads/list` lists
/// it, with its latest turn, or the turn asked for, read without opening it or attaching.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "threads/get", response = GetThreadResponse)]
#[serde(rename_all = "camelCase")]
pub struct GetThreadRequest {
    pub thread_id: ThreadId,
    /// This turn rather than the latest, a queued one included; it fails with `unknown_turn`
    /// when the thread's journal has no such turn (feature `turnIds`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct GetThreadResponse {
    pub thread: ThreadListing,
    /// The latest turn, or the one asked for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_turn: Option<LatestTurn>,
}

/// Where a turn is: waiting to start, running, waiting on a person, or how it ended. The
/// endings match the exit statuses of `weave run` and `weave threads follow`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum TurnState {
    /// Its prompt waits in the thread's queue.
    Queued,
    Running,
    /// It runs, and a permission request or elicitation in it waits for a person.
    Waiting,
    /// It ended as the agent meant it to (`end_turn`).
    Ended,
    /// It stopped short: the agent's token limit, a refusal, too many model requests.
    Stopped,
    Cancelled,
    /// It failed, or ended unexplained.
    Failed,
    /// The Host stopped or crashed while it ran (WVE-144). A headless thread continues it in a
    /// turn of its own.
    Interrupted,
}

impl TurnState {
    /// Whether the turn is over.
    pub fn is_over(self) -> bool {
        matches!(
            self,
            Self::Ended | Self::Stopped | Self::Cancelled | Self::Failed | Self::Interrupted
        )
    }
}

/// A thread's latest turn, or one asked for by id, as its journal records it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct LatestTurn {
    /// Its id, unless the Host journaled it before it gave ids.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    /// Where it is (feature `turnIds`).
    pub state: TurnState,
    /// The interrupted turn it continues (WVE-144).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continues: Option<TurnId>,
    /// Its successor, for an interrupted turn the thread continued: the turn that continues it,
    /// started as this one ended (WVE-168).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continued_in: Option<TurnId>,
    pub prompt: Vec<ContentBlock>,
    pub origin: TurnOrigin,
    /// When it started; for a queued turn, when it was queued.
    pub started_at: Timestamp,
    pub running: bool,
    /// How it ended, once it has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response: Option<PromptResponse>,
    /// Why it failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<Error>,
    /// The agent's last message in it, as text: its message chunks since the last tool call,
    /// thought or other message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// The Host offers [`WatchThreadsRequest`], in `features`.
pub const WATCH_FEATURE: &str = "threads/watch";

/// `threads/watch`: the Host's threads as `threads/list` gives them without an agent, then a
/// [`ThreadUpdatedNotification`] or [`ThreadRemovedNotification`] for every change, until the
/// connection ends or the client sends `threads/unwatch`. Blank threads never appear. With
/// `labels` (feature `labels`), only the threads that carry every one of them: a change that
/// makes one stop matching is the last the watcher hears of it, as an update showing its labels.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "threads/watch", response = WatchThreadsResponse)]
#[serde(rename_all = "camelCase")]
pub struct WatchThreadsRequest {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct WatchThreadsResponse {
    pub threads: Vec<ThreadListing>,
}

/// `threads/unwatch`: stop what `threads/watch` sends.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "threads/unwatch", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct UnwatchThreadsRequest {}

/// `threads/updated`, to watching clients: a thread appeared or changed (opened, suspended,
/// closed, its activity, its clients, its title, or a blank thread's first prompt), as it lists
/// now.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcNotification)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[notification(method = "threads/updated")]
#[serde(rename_all = "camelCase")]
pub struct ThreadUpdatedNotification {
    pub thread: ThreadListing,
}

/// `threads/removed`, to watching clients: a thread went away: deleted, its journal pruned,
/// or closed while blank.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcNotification)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[notification(method = "threads/removed")]
#[serde(rename_all = "camelCase")]
pub struct ThreadRemovedNotification {
    pub thread_id: ThreadId,
}

/// `thread/create`: start a thread and attach to it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "thread/create", response = ThreadState)]
#[serde(rename_all = "camelCase")]
pub struct CreateThreadRequest {
    pub agent_id: AgentId,
    pub cwd: PathBuf,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub additional_directories: Vec<PathBuf>,
    /// The mode to start in; the agent's configured one when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// Asking, when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<PermissionPolicy>,
    /// Have the Host trace the agent's protocol.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub trace: bool,
    /// Its labels from the start (feature `labels`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
}

/// The Host offers [`AttachThreadRequest::observe`], in `features`.
pub const OBSERVE_FEATURE: &str = "thread/observe";

/// `thread/attach`: attach to a thread, opening it first if it isn't open. The thread's
/// events after `after` follow the response, then live ones.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "thread/attach", response = AttachThreadResponse)]
#[serde(rename_all = "camelCase")]
pub struct AttachThreadRequest {
    pub thread_id: ThreadId,
    /// The last event this client handled; everything is sent without it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<JournalPosition>,
    /// Required when the Host has no record of the thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<AgentId>,
    /// Required when the Host has no record of the thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub trace: bool,
    /// Receive the thread as an observer ([`OBSERVE_FEATURE`]), as a script following it does:
    /// only an open thread, which this doesn't open; not one of its `clients`, so it never keeps
    /// the thread open or closes it, and is never sent a client tool to run.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub observe: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct AttachThreadResponse {
    #[serde(flatten)]
    pub state: ThreadState,
    pub replay: Replay,
}

/// The events that follow an attach response before live ones.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Replay {
    /// The first position sent.
    pub from: u64,
    /// The journal isn't the one the client asked after: clear the transcript first.
    pub reset: bool,
}

/// When detaching closes the thread.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum CloseWhen {
    #[default]
    Never,
    /// Now, if nothing else needs it.
    IfUnused,
}

/// `thread/detach`: stop receiving the thread.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "thread/detach", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct DetachThreadRequest {
    pub thread_id: ThreadId,
    #[serde(default)]
    pub close: CloseWhen,
}

/// `thread/close`: close the thread for everyone, ending its turn and stopping its agent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "thread/close", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct CloseThreadRequest {
    pub thread_id: ThreadId,
}

/// `thread/delete`: close it if open, delete it in the agent, and remove its journal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "thread/delete", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct DeleteThreadRequest {
    pub thread_id: ThreadId,
    /// Required when the Host has no record of the thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<AgentId>,
}

/// The Host offers [`RenameThreadRequest`], in `features`.
pub const RENAME_FEATURE: &str = "thread/rename";

/// The longest title [`RenameThreadRequest`] takes, in characters.
pub const MAX_TITLE: usize = 200;

/// `thread/rename`: give an open thread a title of the Host's, which its clients see, journaled
/// as a `renamed` event, and which titles the agent sends later don't replace. The title is
/// trimmed, and must be 1 to [`MAX_TITLE`] characters. The agent's own record of the thread
/// keeps its title: ACP has no way to change it from outside.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "thread/rename", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct RenameThreadRequest {
    pub thread_id: ThreadId,
    pub title: String,
}

/// The Host offers [`LabelThreadRequest`] and labels in listings and requests, in `features`
/// (WVE-173).
pub const LABELS_FEATURE: &str = "labels";

/// The most labels a thread carries.
pub const MAX_LABELS: usize = 16;

/// The longest label, in characters.
pub const MAX_LABEL: usize = 64;

/// Whether `label` is one: 1 to [`MAX_LABEL`] letters, digits and `-_.:/`; why not otherwise.
pub fn check_label(label: &str) -> Result<(), String> {
    let allowed = |c: char| c.is_alphanumeric() || "-_.:/".contains(c);
    if label.is_empty() || label.chars().count() > MAX_LABEL {
        return Err(format!("a label is 1 to {MAX_LABEL} characters: {label:?}"));
    }
    if !label.chars().all(allowed) {
        return Err(format!(
            "a label is letters, digits and - _ . : / only: {label:?}"
        ));
    }
    Ok(())
}

/// `thread/label`: add labels to an open thread and take others off, journaled as a
/// `labelled` event, answered with its labels after. Labels mean nothing to the Host: clients
/// give them, and filter `threads/list` and `threads/watch` by them. A labelled thread's
/// journal is kept past pruning. Each label is checked with [`check_label`], and a thread
/// carries at most [`MAX_LABELS`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "thread/label", response = LabelThreadResponse)]
#[serde(rename_all = "camelCase")]
pub struct LabelThreadRequest {
    pub thread_id: ThreadId,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub add: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub remove: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct LabelThreadResponse {
    pub labels: Vec<String>,
}

/// The Host offers [`SetSuccessorRequest`] and the successors of turns and threads, in
/// `features` (WVE-168).
pub const SUCCESSORS_FEATURE: &str = "successors";

/// `thread/setSuccessor`: name the thread an open thread's work goes on in, as the
/// Dispatcher does when it starts a Bot's new thread. Journaled as a `continuedIn` event and
/// listed as the thread's `continuedIn`; reports to the thread go to its successor from then
/// on. The successor is a thread the Host has a record of, other than this one and not one
/// whose successors lead back to it. A thread's successor is named once: naming the same one
/// again does nothing, and another is refused.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "thread/setSuccessor", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct SetSuccessorRequest {
    pub thread_id: ThreadId,
    pub successor: ThreadId,
}

/// `thread/report` (feature `otherHosts`), a service's only: tell a thread how a turn its
/// agent began on another Host went, or that it waits on a person there, as the Host tells it
/// of its own threads' turns (ADR 0023): into its running turn if its agent takes steers,
/// otherwise through its queue, in the last of its successors, taking it up again if it isn't
/// open. The turn or steer it makes is a report on `about`, which nobody hears the end of.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "thread/report", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct ReportThreadRequest {
    pub thread_id: ThreadId,
    /// The thread the report is on.
    pub about: OtherThread,
    pub text: String,
    /// Makes it safe to send again (feature `requestKeys`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

/// `thread/setMode`. The change reaches every attached client as an ACP update.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "thread/setMode", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct SetModeRequest {
    pub thread_id: ThreadId,
    pub mode_id: SessionModeId,
}

/// `thread/setConfigOption`. The change reaches every attached client as an ACP update.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "thread/setConfigOption", response = SetSessionConfigOptionResponse)]
#[serde(rename_all = "camelCase")]
pub struct SetConfigOptionRequest {
    pub thread_id: ThreadId,
    pub config_id: SessionConfigId,
    #[serde(flatten)]
    pub value: SessionConfigOptionValue,
}

/// `thread/reopen`: stop the thread's agent and take the thread up again in a new process
/// of the version the agent's new threads get, through ACP `session/resume` or
/// `session/load`. The thread keeps its id and journal, where an `agentReopened` event marks
/// the change. While a turn runs or a request waits, it waits for them. When the new version
/// can't take the thread up, the old one does again, and the event says why. Anything that
/// lived only in the old process, such as its background commands, ends with it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "thread/reopen", response = ReopenThreadResponse)]
#[serde(rename_all = "camelCase")]
pub struct ReopenThreadRequest {
    pub thread_id: ThreadId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ReopenThreadResponse {
    /// The version the thread's agent runs now.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// `thread/run`: open a thread (this one, or a new one) and start a turn in it, without
/// the client having to stay.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "thread/run", response = RunResponse)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    pub agent_id: AgentId,
    /// Absolute, or under the Host's home as `~/…` (feature `otherHosts`), for a client that
    /// doesn't know where the home is on the Host's computer.
    pub cwd: PathBuf,
    /// The repository `cwd` has to be a checkout of (feature `otherHosts`), by its remote as
    /// [`crate::worktrees::GitLocation::remote`] gives it, such as `github.com/owner/name`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub additional_directories: Vec<PathBuf>,
    /// The mode a new thread starts in; the agent's configured one when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    pub prompt: Vec<ContentBlock>,
    #[serde(default)]
    pub policy: PermissionPolicy,
    /// Attach before the prompt is sent, to see the whole turn.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub attach: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub trace: bool,
    /// Makes it safe to send again (feature `requestKeys`). A repeat answers with the thread's
    /// id alone; a client that asked to attach attaches with `thread/attach`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// A service's only (feature `otherHosts`): the thread on another Host whose agent asks,
    /// which the turn's origin names, and a new thread's `startedBy` and `startedByHost`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caller: Option<OtherThread>,
    /// A service's only: what started the turn, which its origin names.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<ServiceOrigin>,
    /// Labels for a thread it starts, from the start (feature `labels`); an existing thread
    /// keeps its own.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct RunResponse {
    pub thread_id: ThreadId,
    /// The id of the turn it started (feature `turnIds`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    /// When attached.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<Box<ThreadState>>,
    /// The policy the thread runs under (feature `otherHosts`): the one asked for, or an open
    /// thread's own. Absent from a repeat under a request key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<PermissionPolicy>,
}
