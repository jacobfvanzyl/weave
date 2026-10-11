//! The Host's own error codes. An agent's errors pass through unchanged, ACP's
//! `auth_required` (-32000) among them.

use agent_client_protocol::Error;

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
        format!("the Host has no record of session {session_id}; name its agent and directory"),
    )
}

pub fn session_not_open(session_id: &str) -> Error {
    Error::new(
        SESSION_NOT_OPEN,
        format!("session {session_id} isn't open; attach to it first"),
    )
}

pub fn turn_running() -> Error {
    Error::new(TURN_RUNNING, "a turn is already running in this session")
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
        format!("session {session_id} runs with {agent}, not this agent"),
    )
}

pub fn requires_terminal() -> Error {
    Error::new(
        REQUIRES_TERMINAL,
        "this sign-in method runs in a terminal on the Host's computer: run `weave login` there",
    )
}

/// Whether `error` carries `code`.
pub fn is(error: &Error, code: i32) -> bool {
    i32::from(error.code) == code
}
