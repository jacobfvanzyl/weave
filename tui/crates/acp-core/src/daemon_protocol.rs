//! The `_weave/*` extension: what the weave daemon and its clients say to each other beyond ACP.
//!
//! The daemon (`crates/daemon`) is an ACP agent to its clients and an ACP client to the agents
//! it launches, so everything else between them is plain ACP. These additions cover what a
//! client of a long-lived, shared session needs and ACP has no message for:
//!
//! - `initialize` `_meta.weave`: the client names the agent to launch ([`ClientHello`]); the
//!   daemon answers with its own version ([`DaemonHello`]).
//! - `session/new` `_meta.weave`: the session's [`PermissionPolicy`] ([`SessionOptions`]).
//! - `_weave/turn`: a turn another client started (or one already running when this client
//!   attached) started or ended. The client that sent a prompt gets its response as usual.
//! - `_weave/terminal_output` and `_weave/terminal_exit`: output of commands the daemon runs
//!   for the agent (`terminal/create`), which the client didn't run itself.
//! - `_weave/session_ended`: the session's agent exited or the daemon closed the session.
//! - `_weave/status`, `_weave/shutdown`, `_weave/end_session` and `_weave/run`: managing the
//!   daemon and its sessions, and headless runs.

use std::collections::BTreeMap;
use std::path::PathBuf;

use agent_client_protocol::Error;
use agent_client_protocol::JsonRpcNotification;
use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::JsonRpcResponse;
use agent_client_protocol::schema::v1::ContentBlock;
use agent_client_protocol::schema::v1::McpServer;
use agent_client_protocol::schema::v1::Meta;
use agent_client_protocol::schema::v1::SessionId;
use agent_client_protocol::schema::v1::StopReason;
use agent_client_protocol::schema::v1::TerminalExitStatus;
use agent_client_protocol::schema::v1::TerminalId;
use serde::Deserialize;
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::AgentSpec;
pub use crate::policy::PermissionPolicy;
pub use crate::policy::Unapproved;

/// The version of this extension. A client and a daemon that disagree can't work together;
/// the client asks the user to restart the daemon.
pub const PROTOCOL_VERSION: u32 = 1;

/// The `_meta` key everything here lives under.
pub const META_KEY: &str = "weave";

/// What `_meta.weave` holds, if it's there and well-formed.
pub fn read_meta<T: DeserializeOwned>(meta: Option<&Meta>) -> Option<T> {
    let value = meta?.get(META_KEY)?;
    serde_json::from_value(value.clone()).ok()
}

/// `_meta` with `value` under `weave`.
pub fn meta(value: &impl Serialize) -> Meta {
    let mut meta = Meta::new();
    if let Ok(value) = serde_json::to_value(value) {
        meta.insert(META_KEY.to_owned(), value);
    }
    meta
}

/// An agent as the user chose it, by name or as a command, so it can be chosen again: what
/// `--resume <id>` reopens a session with, and `--continue` remembers per directory.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentChoice {
    /// A preset, a config agent or a registry agent: `--agent <id>`.
    Named(String),
    /// A custom command: `-- <command>…`.
    Command(Vec<String>),
}

impl AgentChoice {
    /// How it's named in messages.
    pub fn describe(&self) -> String {
        match self {
            Self::Named(id) => id.clone(),
            Self::Command(words) => words.join(" "),
        }
    }
}

/// The agent a client wants, launched as if the client had started it itself.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Launch {
    #[serde(flatten)]
    pub spec: AgentSpec,
    /// How the user chose it, recorded with its sessions so they reopen with the same one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choice: Option<AgentChoice>,
    /// Where the agent process starts, and the session's directory.
    pub cwd: PathBuf,
    /// The client's environment, which the agent inherits. Never written to disk.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub environment: BTreeMap<String, String>,
    /// Append a protocol trace of the agents launched for this client to this file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace: Option<PathBuf>,
}

/// `initialize` `_meta.weave` from a client.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientHello {
    pub protocol: u32,
    /// The agent to launch; absent on connections that only manage the daemon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch: Option<Launch>,
}

/// `initialize` `_meta.weave` in the daemon's response.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonHello {
    pub protocol: u32,
    pub version: String,
    pub pid: u32,
}

/// `session/new` `_meta.weave`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOptions {
    #[serde(default)]
    pub policy: PermissionPolicy,
}

/// `_weave/turn`: a turn the receiving client didn't start began or ended.
#[derive(Clone, Debug, Serialize, Deserialize, JsonRpcNotification)]
#[notification(method = "_weave/turn")]
#[serde(rename_all = "camelCase")]
pub struct TurnNotification {
    pub session_id: SessionId,
    pub turn: TurnState,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum TurnState {
    /// Running, for this long already.
    Running {
        #[serde(rename = "elapsedMs")]
        elapsed_ms: u64,
    },
    /// Ended: how, as the prompt's response said, or why it failed.
    Ended {
        #[serde(
            rename = "stopReason",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        stop_reason: Option<StopReason>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<Error>,
    },
}

/// `_weave/terminal_output`: output from a command the daemon runs for the agent.
#[derive(Clone, Debug, Serialize, Deserialize, JsonRpcNotification)]
#[notification(method = "_weave/terminal_output")]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputNotification {
    pub session_id: SessionId,
    pub terminal_id: TerminalId,
    pub data: String,
}

/// `_weave/terminal_exit`: a command the daemon runs for the agent exited.
#[derive(Clone, Debug, Serialize, Deserialize, JsonRpcNotification)]
#[notification(method = "_weave/terminal_exit")]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitNotification {
    pub session_id: SessionId,
    pub terminal_id: TerminalId,
    pub status: TerminalExitStatus,
}

/// `_weave/session_ended`: the session is gone from the daemon, so prompts can't reach it.
#[derive(Clone, Debug, Serialize, Deserialize, JsonRpcNotification)]
#[notification(method = "_weave/session_ended")]
#[serde(rename_all = "camelCase")]
pub struct SessionEndedNotification {
    pub session_id: SessionId,
    pub reason: String,
}

/// `_weave/status`: what the daemon is running.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "_weave/status", response = DaemonStatus)]
pub struct StatusRequest {}

#[derive(Clone, Debug, Serialize, Deserialize, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatus {
    pub protocol: u32,
    pub version: String,
    pub pid: u32,
    pub started_at_ms: u64,
    pub sessions: Vec<LiveSession>,
}

/// A session the daemon has open.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSession {
    pub session_id: SessionId,
    pub cwd: PathBuf,
    /// The agent's command line.
    pub agent: String,
    /// How the agent was chosen, when the client said.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choice: Option<AgentChoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub activity: Activity,
    /// Clients attached now.
    pub clients: usize,
    pub policy: PermissionPolicy,
    pub started_at_ms: u64,
    pub last_activity_ms: u64,
}

/// What a live session is doing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Activity {
    Idle,
    Running,
    /// A turn waits on a person: a permission request or elicitation nobody answered yet.
    Waiting,
}

/// `session/list` entries' `_meta.weave`, for sessions the daemon knows: open now, or
/// recorded in a journal.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedSession {
    /// What it's doing, while it's open in the daemon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<Activity>,
    /// Clients attached now.
    #[serde(default)]
    pub clients: usize,
    /// Its permission requests are answered by a policy, without anyone attached: `weave run`
    /// and triggers. `weave --continue` passes over these.
    #[serde(default)]
    pub headless: bool,
}

/// `session/load` and `session/resume` responses' `_meta.weave`: the session as it is in the
/// daemon, whose directory the client works in from then on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedSession {
    pub cwd: PathBuf,
}

/// `_weave/shutdown`: close every session and exit.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "_weave/shutdown", response = ShutdownResponse)]
pub struct ShutdownRequest {}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonRpcResponse)]
pub struct ShutdownResponse {}

/// `_weave/end_session`: close a live session for every client, ending any turn it's running
/// and stopping its agent. It can still be reopened from the agent's own history.
#[derive(Clone, Debug, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "_weave/end_session", response = EndSessionResponse)]
#[serde(rename_all = "camelCase")]
pub struct EndSessionRequest {
    pub session_id: SessionId,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonRpcResponse)]
pub struct EndSessionResponse {}

/// `_weave/run`: open a session (new, or one by id), send it a prompt and leave the turn
/// running. Nobody needs to be attached; the policy answers what it can.
#[derive(Clone, Debug, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "_weave/run", response = RunResponse)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    pub launch: Launch,
    /// An existing session to continue; a new one when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub additional_directories: Vec<PathBuf>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_servers: Vec<McpServer>,
    pub prompt: Vec<ContentBlock>,
    #[serde(default)]
    pub policy: PermissionPolicy,
    /// Attach the requesting client before the prompt is sent, so it sees the whole turn.
    #[serde(default)]
    pub attach: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct RunResponse {
    pub session_id: SessionId,
}

#[cfg(test)]
mod tests {
    use agent_client_protocol::schema::v1::ToolKind;
    use pretty_assertions::assert_eq;
    use serde_json::json;

    use super::*;

    #[test]
    fn turn_states_have_a_stable_shape() {
        let running = TurnNotification {
            session_id: "s1".into(),
            turn: TurnState::Running { elapsed_ms: 1500 },
        };
        assert_eq!(
            serde_json::to_value(&running).ok(),
            Some(json!({"sessionId": "s1", "turn": {"state": "running", "elapsedMs": 1500}}))
        );
        let ended: TurnNotification = serde_json::from_value(json!({
            "sessionId": "s1",
            "turn": {"state": "ended", "stopReason": "cancelled"}
        }))
        .expect("valid");
        assert_eq!(
            ended.turn,
            TurnState::Ended {
                stop_reason: Some(StopReason::Cancelled),
                error: None
            }
        );
    }

    #[test]
    fn launch_meta_round_trips_and_policies_default_to_asking() {
        let launch = Launch {
            spec: AgentSpec::new("agent", ["--acp"]),
            choice: Some(AgentChoice::Named("agent".into())),
            cwd: "/repo".into(),
            environment: BTreeMap::from([("PATH".to_owned(), "/bin".to_owned())]),
            trace: None,
        };
        let hello = ClientHello {
            protocol: PROTOCOL_VERSION,
            launch: Some(launch),
        };
        let meta = meta(&hello);
        assert_eq!(read_meta::<ClientHello>(Some(&meta)), Some(hello));
        assert_eq!(read_meta::<ClientHello>(None), None);

        let options: SessionOptions = serde_json::from_value(json!({})).expect("valid");
        assert_eq!(options.policy, PermissionPolicy::ask());
        assert!(!options.policy.is_headless());
        let policy: PermissionPolicy =
            serde_json::from_value(json!({"approve": ["read", "search"], "otherwise": "reject"}))
                .expect("valid");
        assert_eq!(policy.approve, [ToolKind::Read, ToolKind::Search]);
        assert!(policy.is_headless());
    }
}
