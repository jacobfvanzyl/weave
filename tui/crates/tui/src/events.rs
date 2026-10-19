//! What the chat is told about its session. The app turns the Host's messages into these,
//! marking what replays the session's journal apart from what happens now.

use std::time::Duration;

use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::CreateElicitationRequest;
use weave_acp_core::schema::ElicitationId;
use weave_acp_core::schema::Error;
use weave_acp_core::schema::PromptResponse;
use weave_acp_core::schema::RequestPermissionRequest;
use weave_acp_core::schema::SessionConfigOption;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::SessionModeState;
use weave_acp_core::schema::SessionNotification;
use weave_acp_core::schema::TerminalExitStatus;
use weave_acp_core::schema::TerminalId;
use weave_host_protocol::agents::AgentRelease;
use weave_host_protocol::pending::PendingId;
use weave_host_protocol::pending::Resolution;
use weave_host_protocol::sessions::SessionAgent;

/// A permission request waiting on a person, as the Host keeps it.
#[derive(Clone, Debug)]
pub struct PermissionAsk {
    pub id: PendingId,
    pub request: RequestPermissionRequest,
}

/// An elicitation waiting on a person, as the Host keeps it.
#[derive(Clone, Debug)]
pub struct ElicitationAsk {
    pub id: PendingId,
    pub request: CreateElicitationRequest,
}

pub enum ChatEvent {
    /// A `session/update`, for this session or one of its subagents.
    SessionUpdate(SessionNotification),
    PermissionRequested(PermissionAsk),
    ElicitationRequested(ElicitationAsk),
    /// An accepted URL elicitation's external step finished.
    ElicitationCompleted(ElicitationId),
    /// A pending request no longer waits: answered here or elsewhere, cancelled, or withdrawn.
    RequestResolved {
        id: PendingId,
        outcome: Resolution,
        /// Answered by another client.
        elsewhere: bool,
    },
    /// A turn started with `prompt`: another client's, a headless run's, or one in the replay.
    /// This client's own prompts are shown as they're sent instead.
    TurnStarted {
        session_id: SessionId,
        prompt: Vec<ContentBlock>,
        /// How long ago, for a live one.
        elapsed: Duration,
        /// From the journal, before this client was there: history, not news.
        replayed: bool,
    },
    /// A message joined the running turn: this client's, another's, or one in the replay.
    TurnSteered {
        session_id: SessionId,
        prompt: Vec<ContentBlock>,
    },
    TurnEnded {
        session_id: SessionId,
        result: Result<PromptResponse, Error>,
        replayed: bool,
    },
    /// A turn was already running when this client attached.
    TurnRunning {
        session_id: SessionId,
        elapsed: Duration,
    },
    TerminalOutput {
        terminal_id: TerminalId,
        text: String,
    },
    TerminalExited {
        terminal_id: TerminalId,
        status: TerminalExitStatus,
    },
    /// The session's agent was started again (`session/reopen`): on a new version, or on the
    /// one it ran when that one `failed` to take the session up.
    AgentReopened {
        agent: Box<SessionAgent>,
        previous: Option<AgentRelease>,
        modes: Option<SessionModeState>,
        config_options: Vec<SessionConfigOption>,
        failed: Option<String>,
        replayed: bool,
    },
    /// The session closed: its agent exited, or it was closed for everyone.
    SessionEnded {
        session_id: SessionId,
        reason: String,
    },
    /// The connection to the Host ended. Carries the reason unless it closed cleanly.
    Disconnected(Option<Error>),
    /// Something the Host tells the session's clients, such as why its agent can't use client
    /// tools.
    Notice(String),
}
