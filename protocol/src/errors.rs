//! The Host's own error codes. An agent's errors pass through unchanged, ACP's
//! `auth_required` (-32000) among them.

use std::path::Path;

use agent_client_protocol::Error;
use agent_client_protocol::schema::v1::SessionId;

/// No successful `host/hello`, or authentication failed.
pub const UNAUTHENTICATED: i32 = -32060;
/// No major version both ends speak; `data` is the Host's range.
pub const INCOMPATIBLE_PROTOCOL: i32 = -32061;
/// The agent id doesn't resolve.
pub const UNKNOWN_AGENT: i32 = -32062;
/// The Host doesn't know the session and wasn't told its agent and directory.
pub const UNKNOWN_SESSION: i32 = -32063;
/// The request needs an open session.
pub const SESSION_NOT_OPEN: i32 = -32064;
/// A turn already runs in the session.
pub const TURN_RUNNING: i32 = -32065;
/// The pending request was answered, cancelled or withdrawn already.
pub const ALREADY_RESOLVED: i32 = -32066;
/// The session belongs to another agent.
pub const WRONG_AGENT: i32 = -32067;
/// The sign-in method needs a terminal on the Host's computer.
pub const REQUIRES_TERMINAL: i32 = -32068;
/// Only local clients may ask this: it administers the Host.
pub const FORBIDDEN: i32 = -32069;
/// The pending request is a client tool call for another client.
pub const NOT_TARGET: i32 = -32070;
/// Remote access couldn't be turned on, as when Tailscale Serve can't reach the Host.
pub const REMOTE_UNAVAILABLE: i32 = -32071;
/// A session in the worktree runs a turn or waits on a request; `data.sessions` says which.
pub const WORKTREE_BUSY: i32 = -32072;
/// The path isn't in a git repository.
pub const NOT_A_REPOSITORY: i32 = -32073;
/// Git refused or failed; the message is what it said.
pub const GIT_FAILED: i32 = -32074;
/// The worktree has staged, unstaged or untracked changes, which removing it would lose.
pub const UNCOMMITTED_CHANGES: i32 = -32075;
/// The request key was used for another request: another method, or other params.
pub const KEY_REUSED: i32 = -32076;
/// The Host is draining before it stops, and starts no new turns.
pub const HOST_STOPPING: i32 = -32077;

pub fn unauthenticated(why: impl Into<String>) -> Error {
    Error::new(UNAUTHENTICATED, why)
}

pub fn incompatible_protocol(host: crate::VersionRange) -> Error {
    Error::new(
        INCOMPATIBLE_PROTOCOL,
        format!(
            "this Host speaks protocol versions {} to {}",
            host.min, host.max
        ),
    )
    .data(serde_json::json!({"min": host.min, "max": host.max}))
}

pub fn unknown_agent(agent_id: &str) -> Error {
    Error::new(UNKNOWN_AGENT, format!("no agent {agent_id:?}"))
}

pub fn unknown_session(session_id: &str) -> Error {
    Error::new(
        UNKNOWN_SESSION,
        format!("the Host has no record of thread {session_id}; name its agent and directory"),
    )
}

pub fn session_not_open(session_id: &str) -> Error {
    Error::new(
        SESSION_NOT_OPEN,
        format!("thread {session_id} isn't open; attach to it first"),
    )
}

pub fn turn_running() -> Error {
    Error::new(TURN_RUNNING, "a turn is already running in this thread")
}

pub fn already_resolved() -> Error {
    Error::new(
        ALREADY_RESOLVED,
        "the request no longer waits for an answer",
    )
}

pub fn wrong_agent(session_id: &str, agent: &str) -> Error {
    Error::new(
        WRONG_AGENT,
        format!("thread {session_id} runs with {agent}, not this agent"),
    )
}

pub fn requires_terminal() -> Error {
    Error::new(
        REQUIRES_TERMINAL,
        "this sign-in method runs in a terminal on the Host's computer: run `weave login` there",
    )
}

pub fn forbidden() -> Error {
    Error::new(
        FORBIDDEN,
        "only a client on the Host's computer may do this",
    )
}

pub fn remote_unavailable(why: impl Into<String>) -> Error {
    Error::new(REMOTE_UNAVAILABLE, why)
}

pub fn not_target() -> Error {
    Error::new(
        NOT_TARGET,
        "this tool call is for the client that sent the turn",
    )
}

pub fn worktree_busy(sessions: &[SessionId]) -> Error {
    let ids: Vec<String> = sessions.iter().map(ToString::to_string).collect();
    Error::new(
        WORKTREE_BUSY,
        format!(
            "a thread in this worktree is running a turn or waiting on a request: {}",
            ids.join(", ")
        ),
    )
    .data(serde_json::json!({"sessions": ids}))
}

pub fn not_a_repository(path: &Path) -> Error {
    Error::new(
        NOT_A_REPOSITORY,
        format!("{} isn't in a git repository", path.display()),
    )
}

pub fn git_failed(what: impl Into<String>) -> Error {
    Error::new(GIT_FAILED, what)
}

pub fn uncommitted_changes(path: &Path) -> Error {
    Error::new(
        UNCOMMITTED_CHANGES,
        format!(
            "{} has changes that removing it would lose; remove it with force to discard them",
            path.display()
        ),
    )
}

pub fn key_reused() -> Error {
    Error::new(
        KEY_REUSED,
        "this request key was used for another request; choose a new one",
    )
}

pub fn host_stopping() -> Error {
    Error::new(
        HOST_STOPPING,
        "the Host is stopping once its running turns end, and starts no new ones; prompt again \
         once it's back",
    )
}

/// Whether `error` carries `code`.
pub fn is(error: &Error, code: i32) -> bool {
    i32::from(error.code) == code
}
