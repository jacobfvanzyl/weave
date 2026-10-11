//! What a session's attached clients are sent. [`SessionEventNotification`]s are journaled
//! and numbered, so a client catches up from the last one it handled; the rest describe the
//! session as it is now.

use agent_client_protocol::Error;
use agent_client_protocol::JsonRpcNotification;
use agent_client_protocol::schema::v1::CompleteElicitationNotification;
use agent_client_protocol::schema::v1::ContentBlock;
use agent_client_protocol::schema::v1::PromptResponse;
use agent_client_protocol::schema::v1::SessionId;
use agent_client_protocol::schema::v1::SessionNotification;
use agent_client_protocol::schema::v1::TerminalExitStatus;
use agent_client_protocol::schema::v1::TerminalId;
use serde::Deserialize;
use serde::Serialize;

use crate::Timestamp;
use crate::sessions::Activity;
use crate::sessions::TurnOrigin;

/// `session/event`: one journaled event, in order.
#[derive(Clone, Debug, Serialize, Deserialize, JsonRpcNotification)]
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
    /// The session closed.
    Closed { reason: String },
    /// A kind this build doesn't know, from a newer Host. Its position still counts.
    #[serde(other)]
    Unknown,
}

/// `session/changed`: what changed about the session, as `SessionState` describes it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcNotification)]
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
}

/// `session/elicitationCompleted`: an accepted URL elicitation's external step finished.
#[derive(Clone, Debug, Serialize, Deserialize, JsonRpcNotification)]
#[notification(method = "session/elicitationCompleted")]
#[serde(rename_all = "camelCase")]
pub struct ElicitationCompletedNotification {
    pub session_id: SessionId,
    pub notification: CompleteElicitationNotification,
}
