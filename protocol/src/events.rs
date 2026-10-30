//! What a session's attached clients are sent. [`SessionEventNotification`]s are journaled
//! and numbered, so a client catches up from the last one it handled; the rest describe the
//! session as it is now.

use agent_client_protocol::Error;
use agent_client_protocol::JsonRpcNotification;
use agent_client_protocol::schema::v1::CompleteElicitationNotification;
use agent_client_protocol::schema::v1::ContentBlock;
use agent_client_protocol::schema::v1::PromptResponse;
use agent_client_protocol::schema::v1::SessionConfigOption;
use agent_client_protocol::schema::v1::SessionId;
use agent_client_protocol::schema::v1::SessionModeState;
use agent_client_protocol::schema::v1::SessionNotification;
use agent_client_protocol::schema::v1::TerminalExitStatus;
use agent_client_protocol::schema::v1::TerminalId;
use serde::Deserialize;
use serde::Serialize;

use crate::Timestamp;
use crate::agents::AgentRelease;
use crate::queue::QueuePause;
use crate::queue::QueuedId;
use crate::sessions::Activity;
use crate::sessions::SessionAgent;
use crate::sessions::TurnOrigin;
use crate::turns::TurnId;
use crate::worktrees::GitLocation;

/// `session/event`: one journaled event, in order.
#[derive(Clone, Debug, Serialize, Deserialize, JsonRpcNotification)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[notification(method = "session/event")]
#[serde(rename_all = "camelCase")]
pub struct SessionEventNotification {
    /// The attached session, the root of any subagent session the event is about.
    pub session_id: SessionId,
    /// The event's position in the session's journal.
    pub seq: u64,
    pub at: Timestamp,
    pub event: SessionEvent,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SessionEvent {
    /// The agent's `session/update`, for this session or a subagent session; or a client's
    /// mode or config option change, which reaches the others this way.
    Update {
        notification: Box<SessionNotification>,
    },
    /// A turn started, with its prompt.
    TurnStarted {
        session_id: SessionId,
        prompt: Vec<ContentBlock>,
        origin: TurnOrigin,
        /// The queued prompt it started from, which has left the queue.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        queued_id: Option<QueuedId>,
        /// The turn's id (feature `turnIds`): its `queuedId` when it has one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<TurnId>,
    },
    /// A message joined the running turn (`turn/steer`).
    TurnSteered {
        session_id: SessionId,
        prompt: Vec<ContentBlock>,
        origin: TurnOrigin,
    },
    /// A turn ended: how, as the agent answered the prompt, or why it failed.
    TurnEnded {
        session_id: SessionId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        response: Option<PromptResponse>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<Error>,
    },
    /// Output from a command the Host runs for the agent.
    TerminalOutput {
        terminal_id: TerminalId,
        data: String,
    },
    /// That command exited.
    TerminalExit {
        terminal_id: TerminalId,
        status: TerminalExitStatus,
    },
    /// The session's agent was started again and took the session up (`session/reopen`).
    /// What it says about itself, its modes and its config options are the new process's.
    AgentReopened {
        agent: Box<SessionAgent>,
        /// The version it ran before.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        previous: Option<AgentRelease>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        modes: Option<SessionModeState>,
        #[serde(default)]
        config_options: Vec<SessionConfigOption>,
        /// Why it runs the version it ran before: the one it was reopened for couldn't take
        /// the session up.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        failed: Option<String>,
    },
    /// The session closed.
    Closed { reason: String },
    /// The session was renamed through the Host (`session/rename`, or the `rename_session` Host
    /// tool). Its title is the Host's from then on: titles the agent sends later don't replace
    /// it.
    Renamed {
        title: String,
        /// The client that renamed it; absent when its own agent did.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        by: Option<TurnOrigin>,
    },
    /// Something the Host tells the session's clients, such as why its agent can't use client
    /// tools.
    Notice { text: String },
    /// A prompt joined the session's queue (`queue/add`).
    Queued {
        queued_id: QueuedId,
        prompt: Vec<ContentBlock>,
        origin: TurnOrigin,
    },
    /// A client took a prompt out of the queue (`queue/remove`).
    Unqueued {
        queued_id: QueuedId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        by: Option<TurnOrigin>,
    },
    /// The queue stopped starting turns. A paused queue that empties isn't paused any more.
    QueuePaused { reason: QueuePause },
    /// The queue started again.
    QueueResumed {
        /// The client that resumed it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        by: Option<TurnOrigin>,
    },
    /// A kind this build doesn't know, from a newer Host. Its position still counts.
    #[serde(other)]
    Unknown,
}

/// `session/changed`: what changed about the session, as `SessionState` describes it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcNotification)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[notification(method = "session/changed")]
#[serde(rename_all = "camelCase")]
pub struct SessionChangedNotification {
    pub session_id: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<Activity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clients: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blank: Option<bool>,
    /// Where in a git repository the session's directory is, as a turn left it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<GitLocation>,
}

/// `session/elicitationCompleted`: an accepted URL elicitation's external step finished.
#[derive(Clone, Debug, Serialize, Deserialize, JsonRpcNotification)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[notification(method = "session/elicitationCompleted")]
#[serde(rename_all = "camelCase")]
pub struct ElicitationCompletedNotification {
    pub session_id: SessionId,
    pub notification: CompleteElicitationNotification,
}
