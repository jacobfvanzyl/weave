//! Sessions: listing them, creating them, attaching to them and letting them go.
//!
//! A session's id is the agent's own ACP session id. Subagent sessions are reached through
//! their parent: requests for them go to the parent's agent, and their events into the
//! parent's journal.

use std::path::PathBuf;

use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::JsonRpcResponse;
use agent_client_protocol::schema::v1::ContentBlock;
use agent_client_protocol::schema::v1::InitializeResponse;
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
use crate::hello::ClientId;
use crate::pending::PendingRequest;
use crate::policy::PermissionPolicy;

/// A session's journal, by an id that changes only when the Host starts a new journal for
/// the session, as when a closed session is opened again.
pub type JournalId = String;

/// An event's place in a session's journal: where a client catches up after.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalPosition {
    pub journal: JournalId,
    pub seq: u64,
}

/// Where a session's journal is up to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalHead {
    pub id: JournalId,
    /// The position of the last event written; 0 before any.
    pub head: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
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
#[serde(rename_all = "camelCase")]
pub enum Activity {
    Idle,
    Running,
    /// A pending request waits for a person.
    Waiting,
}

/// The agent a session runs with.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAgent {
    pub id: AgentId,
    pub name: String,
    /// What the agent said about itself: capabilities, prompt capabilities, sign-in.
    pub initialize: InitializeResponse,
}

/// Who started a turn.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TurnOrigin {
    /// A client's prompt: its name, and its connection, so it knows its own prompts.
    Client { name: String, id: ClientId },
    /// A headless run.
    Run {},
}

/// A turn running now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningTurn {
    /// The session it runs in: the root or a subagent session.
    pub session_id: SessionId,
    pub started_at: Timestamp,
    pub origin: TurnOrigin,
}

/// An open session as a client attached to it sees it; notifications keep it up to date.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub session_id: SessionId,
    pub agent: SessionAgent,
    pub cwd: PathBuf,
    #[serde(default)]
    pub additional_directories: Vec<PathBuf>,
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
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
}

/// `sessions/list`. Without an agent: the sessions the Host has a journal for, across
/// agents, most recently active first. With one: that agent's, the Host's own in `cwd` first,
/// then the agent's own listing, paged by its cursor. Blank sessions are never listed.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "sessions/list", response = ListSessionsResponse)]
#[serde(rename_all = "camelCase")]
pub struct ListSessionsRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<AgentId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct ListSessionsResponse {
    pub sessions: Vec<SessionListing>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// `session/create`: start a session and attach to it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
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

/// `session/attach`: attach to a session, opening it first if it isn't open. The session's
/// events after `after` follow the response, then live ones.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
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
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct AttachSessionResponse {
    #[serde(flatten)]
    pub state: SessionState,
    pub replay: Replay,
}

/// The events that follow an attach response before live ones.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Replay {
    /// The first position sent.
    pub from: u64,
    /// The journal isn't the one the client asked after: clear the transcript first.
    pub reset: bool,
}

/// When detaching closes the session.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CloseWhen {
    #[default]
    Never,
    /// Now, if nothing else needs it.
    IfUnused,
}

/// `session/detach`: stop receiving the session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "session/detach", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct DetachSessionRequest {
    pub session_id: SessionId,
    #[serde(default)]
    pub close: CloseWhen,
}

/// `session/close`: close the session for everyone, ending its turn and stopping its agent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "session/close", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct CloseSessionRequest {
    pub session_id: SessionId,
}

/// `session/delete`: close it if open, delete it in the agent, and remove its journal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "session/delete", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSessionRequest {
    pub session_id: SessionId,
    /// Required when the Host has no record of the session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<AgentId>,
}

/// `session/setMode`. The change reaches every attached client as an ACP update.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "session/setMode", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct SetModeRequest {
    pub session_id: SessionId,
    pub mode_id: SessionModeId,
}

/// `session/setConfigOption`. The change reaches every attached client as an ACP update.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "session/setConfigOption", response = SetSessionConfigOptionResponse)]
#[serde(rename_all = "camelCase")]
pub struct SetConfigOptionRequest {
    pub session_id: SessionId,
    pub config_id: SessionConfigId,
    #[serde(flatten)]
    pub value: SessionConfigOptionValue,
}

/// `session/run`: open a session (this one, or a new one) and start a turn in it, without
/// the client having to stay.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "session/run", response = RunResponse)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    pub agent_id: AgentId,
    pub cwd: PathBuf,
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
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct RunResponse {
    pub session_id: SessionId,
    /// When attached.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<Box<SessionState>>,
}
