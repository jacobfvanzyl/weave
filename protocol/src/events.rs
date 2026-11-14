//! What a thread's attached clients are sent. [`ThreadEventNotification`]s are journaled
//! and numbered, so a client catches up from the last one it handled; the rest describe the
//! thread as it is now.

use agent_client_protocol::Error;
use agent_client_protocol::JsonRpcNotification;
use agent_client_protocol::v1::schema::CompleteElicitationNotification;
use agent_client_protocol::v1::schema::ContentBlock;
use agent_client_protocol::v1::schema::PromptResponse;
use agent_client_protocol::v1::schema::SessionConfigOption;
use agent_client_protocol::v1::schema::SessionModeState;
use agent_client_protocol::v1::schema::SessionNotification;
use agent_client_protocol::v1::schema::TerminalExitStatus;
use agent_client_protocol::v1::schema::TerminalId;
use serde::Deserialize;
use serde::Serialize;

use crate::Timestamp;
use crate::agents::AgentRelease;
use crate::mcp::McpServerStatus;
use crate::queue::QueuePause;
use crate::queue::QueuedId;
use crate::threads::Activity;
use crate::threads::ThreadAgent;
use crate::threads::ThreadId;
use crate::threads::TurnOrigin;
use crate::turns::TurnId;
use crate::worktrees::GitLocation;

/// `thread/event`: one journaled event, in order.
#[derive(Clone, Debug, Serialize, Deserialize, JsonRpcNotification)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[notification(method = "thread/event")]
#[serde(rename_all = "camelCase")]
pub struct ThreadEventNotification {
    /// The attached thread, the root of any subagent thread the event is about.
    pub thread_id: ThreadId,
    /// The event's position in the thread's journal.
    pub seq: u64,
    pub at: Timestamp,
    pub event: ThreadEvent,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ThreadEvent {
    /// The agent's `session/update`, for this thread or a subagent thread; or a client's
    /// mode or config option change, which reaches the others this way.
    Update {
        notification: Box<SessionNotification>,
    },
    /// A turn started, with its prompt.
    TurnStarted {
        thread_id: ThreadId,
        prompt: Vec<ContentBlock>,
        origin: TurnOrigin,
        /// The queued prompt it started from, which has left the queue.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        queued_id: Option<QueuedId>,
        /// The turn's id (feature `turnIds`): its `queuedId` when it has one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<TurnId>,
        /// The interrupted turn it continues, which a Host that stopped under it left
        /// (WVE-144).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        continues: Option<TurnId>,
    },
    /// A message joined the running turn (`turn/steer`).
    TurnSteered {
        thread_id: ThreadId,
        prompt: Vec<ContentBlock>,
        origin: TurnOrigin,
    },
    /// A turn ended: how, as the agent answered the prompt, or why it failed.
    TurnEnded {
        thread_id: ThreadId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        response: Option<PromptResponse>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        // The same on the wire as ACP's own error, which the schema names once.
        #[cfg_attr(
            feature = "schema",
            schemars(with = "Option<agent_client_protocol::v1::schema::Error>")
        )]
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
    /// The thread's agent was started again and took the thread up (`thread/reopen`).
    /// What it says about itself, its modes and its config options are the new process's.
    AgentReopened {
        agent: Box<ThreadAgent>,
        /// The version it ran before.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        previous: Option<AgentRelease>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        modes: Option<SessionModeState>,
        #[serde(default)]
        config_options: Vec<SessionConfigOption>,
        /// Why it runs the version it ran before: the one it was reopened for couldn't take
        /// the thread up.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        failed: Option<String>,
    },
    /// The thread closed. `by` is the client whose `thread/close` or `thread/delete` closed
    /// it for everyone; absent when nobody did, as when its agent exited.
    Closed {
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        by: Option<TurnOrigin>,
    },
    /// The thread was renamed through the Host (`thread/rename`, or the `rename_thread` Host
    /// tool). Its title is the Host's from then on: titles the agent sends later don't replace
    /// it.
    Renamed {
        title: String,
        /// The client that renamed it; absent when its own agent did.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        by: Option<TurnOrigin>,
    },
    /// The thread's work goes on in another, its successor, which a client named
    /// (`thread/setSuccessor`, WVE-168): clients following this one may follow that.
    ContinuedIn {
        successor: ThreadId,
        /// The client that named it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        by: Option<TurnOrigin>,
    },
    /// The thread's labels changed (`thread/label`, WVE-173): all of them, after.
    Labelled {
        labels: Vec<String>,
        /// The client that labelled it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        by: Option<TurnOrigin>,
    },
    /// Something the Host tells the thread's clients, such as why its agent can't use client
    /// tools.
    Notice { text: String },
    /// A prompt joined the thread's queue (`queue/add`).
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

/// `thread/changed`: what changed about the thread, as `ThreadState` describes it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcNotification)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[notification(method = "thread/changed")]
#[serde(rename_all = "camelCase")]
pub struct ThreadChangedNotification {
    pub thread_id: ThreadId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<Activity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clients: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blank: Option<bool>,
    /// Where in a git repository the thread's directory is, as a turn left it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<GitLocation>,
    /// The MCP servers its agent was given, all of them, when one changed (feature
    /// [`crate::mcp::FEATURE`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_servers: Option<Vec<McpServerStatus>>,
}

/// `thread/elicitationCompleted`: an accepted URL elicitation's external step finished.
#[derive(Clone, Debug, Serialize, Deserialize, JsonRpcNotification)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[notification(method = "thread/elicitationCompleted")]
#[serde(rename_all = "camelCase")]
pub struct ElicitationCompletedNotification {
    pub thread_id: ThreadId,
    pub notification: CompleteElicitationNotification,
}
