//! What the chat is told about its thread. The app turns the Host's messages into these,
//! marking what replays the thread's journal apart from what happens now.

use std::time::Duration;

use weave_acp_core::Error;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::CreateElicitationRequest;
use weave_acp_core::schema::ElicitationId;
use weave_acp_core::schema::PromptResponse;
use weave_acp_core::schema::RequestPermissionRequest;
use weave_acp_core::schema::SessionConfigOption;
use weave_acp_core::schema::SessionModeState;
use weave_acp_core::schema::SessionNotification;
use weave_acp_core::schema::TerminalExitStatus;
use weave_acp_core::schema::TerminalId;
use weave_host_protocol::agents::AgentRelease;
use weave_host_protocol::pending::PendingId;
use weave_host_protocol::pending::Resolution;
use weave_host_protocol::threads::ThreadAgent;
use weave_host_protocol::threads::ThreadId;

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
    /// A `session/update`, for this thread or one of its subagents.
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
        thread_id: ThreadId,
        prompt: Vec<ContentBlock>,
        /// How long ago, for a live one.
        elapsed: Duration,
        /// From the journal, before this client was there: history, not news.
        replayed: bool,
        /// What started it, when a service did: "schedule daily-review, via Dispatcher".
        started_by: Option<String>,
    },
    /// A message joined the running turn: this client's, another's, or one in the replay.
    TurnSteered {
        thread_id: ThreadId,
        prompt: Vec<ContentBlock>,
    },
    TurnEnded {
        thread_id: ThreadId,
        result: Result<PromptResponse, Error>,
        replayed: bool,
    },
    /// A turn was already running when this client attached.
    TurnRunning {
        thread_id: ThreadId,
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
    /// The thread's agent was started again (`thread/reopen`): on a new version, or on the
    /// one it ran when that one `failed` to take the thread up.
    AgentReopened {
        agent: Box<ThreadAgent>,
        previous: Option<AgentRelease>,
        modes: Option<SessionModeState>,
        config_options: Vec<SessionConfigOption>,
        failed: Option<String>,
        replayed: bool,
    },
    /// The thread closed: its agent exited, or it was closed for everyone.
    ThreadEnded {
        thread_id: ThreadId,
        reason: String,
    },
    /// The connection to the Host ended. Carries the reason unless it closed cleanly.
    Disconnected(Option<Error>),
    /// Something the Host tells the thread's clients, such as why its agent can't use client
    /// tools.
    Notice(String),
    /// The thread was renamed through the Host. `by` says who, to start a sentence: "You",
    /// "The agent", or another client or its device.
    Renamed {
        title: String,
        by: String,
    },
    /// The thread's work goes on in another, its successor, which a client named (WVE-168).
    ContinuedIn {
        successor: ThreadId,
    },
    /// A prompt joined the thread's queue in the Host (WVE-107); `mine` when this client
    /// added it.
    Queued {
        id: String,
        text: String,
        mine: bool,
    },
    /// A prompt left the Host's queue: taken out, or its turn started.
    Unqueued {
        id: String,
    },
    /// The Host's queue stopped starting turns, or started again.
    QueuePaused(bool),
}
