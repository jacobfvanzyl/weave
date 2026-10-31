//! Sessions: listing them, creating them, attaching to them and letting them go.
//!
//! A session's id is the agent's own ACP session id. Subagent sessions are reached through
//! their parent: requests for them go to the parent's agent, and their events into the
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
use crate::pending::PendingRequest;
use crate::policy::PermissionPolicy;
use crate::queue::QueuePause;
use crate::queue::QueuedPrompt;
use crate::turns::TurnId;
use crate::worktrees::GitLocation;

/// A session's journal, by an id that changes only when the Host starts a new journal for
/// the session, as when a closed session is opened again.
pub type JournalId = String;

/// An event's place in a session's journal: where a client catches up after.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct JournalPosition {
    pub journal: JournalId,
    pub seq: u64,
}

/// Where a session's journal is up to.
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
pub enum SessionStatus {
    /// The Host holds it and its agent runs.
    Open,
    /// It was open when its Host stopped; attaching opens it again from its journal.
    Suspended,
    /// The Host no longer holds it; attaching opens it again from the agent's history.
    Closed,
}

/// What an open session is doing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum Activity {
    Idle,
    Running,
    /// A pending request waits for a person.
    Waiting,
}

/// The agent a session runs with.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct SessionAgent {
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
    /// Another session: one whose agent began the turn through a Host tool, or, in a report,
    /// the session the Host reports on (ADR 0023).
    #[serde(rename_all = "camelCase")]
    Session {
        session_id: SessionId,
        /// The Host that session is on, when it isn't this one: a peer Host's id (ADR 0017).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        host: Option<String>,
        /// What this Host calls that Host: the name it paired with, for clients to show.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        host_name: Option<String>,
        /// The Host's report on that session, of how a turn this session's agent began there
        /// ended or that it waits on a person. Nobody hears how a report's turn ends.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        report: bool,
    },
}

/// A turn running now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct RunningTurn {
    /// The session it runs in: the root or a subagent session.
    pub session_id: SessionId,
    pub started_at: Timestamp,
    pub origin: TurnOrigin,
    /// Its id (feature `turnIds`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
}

/// An open session as a client attached to it sees it; notifications keep it up to date.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub session_id: SessionId,
    pub agent: SessionAgent,
    pub cwd: PathBuf,
    #[serde(default)]
    pub additional_directories: Vec<PathBuf>,
    /// Where in a git repository `cwd` is; absent outside one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<GitLocation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub state: SessionStatus,
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
    /// Subagent sessions so far.
    #[serde(default)]
    pub subagents: Vec<SessionId>,
    pub journal: JournalHead,
    /// Things worth telling the user, such as skipped MCP servers.
    #[serde(default)]
    pub notices: Vec<String>,
    /// Where the Host writes this session's protocol trace, when asked to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace: Option<PathBuf>,
    /// A newer version of the agent than the session runs, once the Host has found one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update: Option<AgentUpdate>,
    /// The session whose agent started it, for a delegated session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_by: Option<SessionId>,
    /// The peer Host the session that started it is on, when it isn't this one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_by_host: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct SessionListing {
    /// As ACP lists it: id, directory, title, last update.
    pub info: SessionInfo,
    pub agent_id: AgentId,
    pub state: SessionStatus,
    /// Open sessions only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<Activity>,
    #[serde(default)]
    pub clients: u32,
    /// A permission policy answers its requests, so it runs with nobody attached.
    #[serde(default)]
    pub headless: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<Timestamp>,
    /// Where in a git repository its directory is, as the Host last read it while the session
    /// was open; absent outside one, and for sessions the Host has no record of.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<GitLocation>,
    /// The session whose agent started it, for a delegated session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_by: Option<SessionId>,
    /// The peer Host the session that started it is on, when it isn't this one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_by_host: Option<String>,
}

/// `sessions/list`. Without an agent: the sessions the Host has a journal for, across
/// agents, most recently active first. With one: that agent's in `cwd`, the Host's own first,
/// then the agent's own listing, paged by its cursor. Blank sessions are never listed.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "sessions/list", response = ListSessionsResponse)]
#[serde(rename_all = "camelCase")]
pub struct ListSessionsRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<AgentId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<PathBuf>,
    /// Only the sessions in this repository's worktrees, given by any directory in it. Without
    /// an agent only (feature `worktrees`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<PathBuf>,
    /// Only the open sessions doing this. Without an agent only (feature `turnIds`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<Activity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ListSessionsResponse {
    pub sessions: Vec<SessionListing>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// The Host offers [`GetSessionRequest`], in `features`.
pub const GET_FEATURE: &str = "sessions/get";

/// `sessions/get`: one session the Host has a journal for, open or not, as `sessions/list` lists
/// it, with its latest turn, or the turn asked for, read without opening it or attaching.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "sessions/get", response = GetSessionResponse)]
#[serde(rename_all = "camelCase")]
pub struct GetSessionRequest {
    pub session_id: SessionId,
    /// This turn rather than the latest, a queued one included; it fails with `unknown_turn`
    /// when the session's journal has no such turn (feature `turnIds`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct GetSessionResponse {
    pub session: SessionListing,
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
    /// Its prompt waits in the session's queue.
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
}

impl TurnState {
    /// Whether the turn is over.
    pub fn is_over(self) -> bool {
        matches!(
            self,
            Self::Ended | Self::Stopped | Self::Cancelled | Self::Failed
        )
    }
}

/// A session's latest turn, or one asked for by id, as its journal records it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct LatestTurn {
    /// Its id, unless the Host journaled it before it gave ids.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    /// Where it is (feature `turnIds`).
    pub state: TurnState,
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

/// The Host offers [`WatchSessionsRequest`], in `features`.
pub const WATCH_FEATURE: &str = "sessions/watch";

/// `sessions/watch`: the Host's sessions as `sessions/list` gives them without an agent, then a
/// [`SessionUpdatedNotification`] or [`SessionRemovedNotification`] for every change, until the
/// connection ends or the client sends `sessions/unwatch`. Blank sessions never appear.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "sessions/watch", response = WatchSessionsResponse)]
#[serde(rename_all = "camelCase")]
pub struct WatchSessionsRequest {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct WatchSessionsResponse {
    pub sessions: Vec<SessionListing>,
}

/// `sessions/unwatch`: stop what `sessions/watch` sends.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "sessions/unwatch", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct UnwatchSessionsRequest {}

/// `sessions/updated`, to watching clients: a session appeared or changed (opened, suspended,
/// closed, its activity, its clients, its title, or a blank session's first prompt), as it lists
/// now.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcNotification)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[notification(method = "sessions/updated")]
#[serde(rename_all = "camelCase")]
pub struct SessionUpdatedNotification {
    pub session: SessionListing,
}

/// `sessions/removed`, to watching clients: a session went away: deleted, its journal pruned,
/// or closed while blank.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcNotification)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[notification(method = "sessions/removed")]
#[serde(rename_all = "camelCase")]
pub struct SessionRemovedNotification {
    pub session_id: SessionId,
}

/// `session/create`: start a session and attach to it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "session/create", response = SessionState)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
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
}

/// The Host offers [`AttachSessionRequest::observe`], in `features`.
pub const OBSERVE_FEATURE: &str = "session/observe";

/// `session/attach`: attach to a session, opening it first if it isn't open. The session's
/// events after `after` follow the response, then live ones.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "session/attach", response = AttachSessionResponse)]
#[serde(rename_all = "camelCase")]
pub struct AttachSessionRequest {
    pub session_id: SessionId,
    /// The last event this client handled; everything is sent without it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<JournalPosition>,
    /// Required when the Host has no record of the session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<AgentId>,
    /// Required when the Host has no record of the session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub trace: bool,
    /// Receive the session as an observer ([`OBSERVE_FEATURE`]), as a script following it does:
    /// only an open session, which this doesn't open; not one of its `clients`, so it never keeps
    /// the session open or closes it, and is never sent a client tool to run.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub observe: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct AttachSessionResponse {
    #[serde(flatten)]
    pub state: SessionState,
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

/// When detaching closes the session.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum CloseWhen {
    #[default]
    Never,
    /// Now, if nothing else needs it.
    IfUnused,
}

/// `session/detach`: stop receiving the session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "session/detach", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct DetachSessionRequest {
    pub session_id: SessionId,
    #[serde(default)]
    pub close: CloseWhen,
}

/// `session/close`: close the session for everyone, ending its turn and stopping its agent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "session/close", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct CloseSessionRequest {
    pub session_id: SessionId,
}

/// `session/delete`: close it if open, delete it in the agent, and remove its journal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "session/delete", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSessionRequest {
    pub session_id: SessionId,
    /// Required when the Host has no record of the session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<AgentId>,
}

/// The Host offers [`RenameSessionRequest`], in `features`.
pub const RENAME_FEATURE: &str = "session/rename";

/// The longest title [`RenameSessionRequest`] takes, in characters.
pub const MAX_TITLE: usize = 200;

/// `session/rename`: give an open session a title of the Host's, which its clients see, journaled
/// as a `renamed` event, and which titles the agent sends later don't replace. The title is
/// trimmed, and must be 1 to [`MAX_TITLE`] characters. The agent's own record of the session
/// keeps its title: ACP has no way to change it from outside.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "session/rename", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct RenameSessionRequest {
    pub session_id: SessionId,
    pub title: String,
}

/// `session/setMode`. The change reaches every attached client as an ACP update.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "session/setMode", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct SetModeRequest {
    pub session_id: SessionId,
    pub mode_id: SessionModeId,
}

/// `session/setConfigOption`. The change reaches every attached client as an ACP update.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "session/setConfigOption", response = SetSessionConfigOptionResponse)]
#[serde(rename_all = "camelCase")]
pub struct SetConfigOptionRequest {
    pub session_id: SessionId,
    pub config_id: SessionConfigId,
    #[serde(flatten)]
    pub value: SessionConfigOptionValue,
}

/// `session/reopen`: stop the session's agent and take the session up again in a new process
/// of the version the agent's new sessions get, through ACP `session/resume` or
/// `session/load`. The session keeps its id and journal, where an `agentReopened` event marks
/// the change. While a turn runs or a request waits, it waits for them. When the new version
/// can't take the session up, the old one does again, and the event says why. Anything that
/// lived only in the old process, such as its background commands, ends with it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "session/reopen", response = ReopenSessionResponse)]
#[serde(rename_all = "camelCase")]
pub struct ReopenSessionRequest {
    pub session_id: SessionId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ReopenSessionResponse {
    /// The version the session's agent runs now.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// `session/run`: open a session (this one, or a new one) and start a turn in it, without
/// the client having to stay.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "session/run", response = RunResponse)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    pub agent_id: AgentId,
    /// Absolute, or under the Host's home as `~/…` (feature `peers`), for a client that doesn't
    /// know where the home is on the Host's computer.
    pub cwd: PathBuf,
    /// The repository `cwd` has to be a checkout of (feature `peers`), by its remote as
    /// [`crate::worktrees::GitLocation::remote`] gives it, such as `github.com/owner/name`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub additional_directories: Vec<PathBuf>,
    pub prompt: Vec<ContentBlock>,
    #[serde(default)]
    pub policy: PermissionPolicy,
    /// Attach before the prompt is sent, to see the whole turn.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub attach: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub trace: bool,
    /// Makes it safe to send again (feature `requestKeys`). A repeat answers with the session's
    /// id alone; a client that asked to attach attaches with `session/attach`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// A peer Host's only (feature `peers`): the session on it whose agent asks, which the
    /// turn's origin names, and a new session's `startedBy`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caller: Option<SessionId>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct RunResponse {
    pub session_id: SessionId,
    /// The id of the turn it started (feature `turnIds`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    /// When attached.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<Box<SessionState>>,
    /// The policy the session runs under (feature `peers`): the one asked for, or an open
    /// session's own. Absent from a repeat under a request key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<PermissionPolicy>,
}
