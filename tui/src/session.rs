//! A session the Host opened for this client: new, or an existing one it attached to.

use weave_acp_core::schema::SessionConfigOption;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::SessionModeState;
use weave_host_protocol::sessions::Replay;
use weave_host_protocol::sessions::SessionState;

/// Which session to open.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionTarget {
    New,
    Existing(SessionId),
}

/// A session ready for prompts.
#[derive(Clone, Debug)]
pub struct OpenedSession {
    pub session_id: SessionId,
    pub modes: Option<SessionModeState>,
    pub config_options: Vec<SessionConfigOption>,
    /// How an existing session was reopened: `None` for a new one, and for one the Host
    /// says is still blank, with nothing sent in it to reopen.
    pub reopened: Option<Reopened>,
    /// Worth telling the user, such as skipped MCP servers or a mode it couldn't start in.
    pub notices: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reopened {
    /// Its history follows, from the Host's journal.
    Loaded,
    /// The agent has the context, but there's no history to show.
    Resumed,
}

impl OpenedSession {
    /// The session `state` describes, with `replay` saying what follows for one attached to.
    pub fn from_state(state: &SessionState, replay: Option<&Replay>) -> Self {
        let reopened = match replay {
            _ if state.blank => None,
            None => None,
            Some(replay) if replay.from <= state.journal.head => Some(Reopened::Loaded),
            Some(_) if state.journal.head == 0 => Some(Reopened::Resumed),
            Some(_) => Some(Reopened::Loaded),
        };
        Self {
            session_id: state.session_id.clone(),
            modes: state.modes.clone(),
            config_options: state.config_options.clone(),
            reopened,
            notices: state.notices.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use weave_acp_core::schema::InitializeResponse;
    use weave_host_protocol::policy::PermissionPolicy;
    use weave_host_protocol::sessions::Activity;
    use weave_host_protocol::sessions::JournalHead;
    use weave_host_protocol::sessions::SessionAgent;
    use weave_host_protocol::sessions::SessionStatus;

    use super::*;

    fn state(blank: bool, head: u64) -> SessionState {
        SessionState {
            session_id: "s1".into(),
            agent: SessionAgent {
                id: "fake".into(),
                name: "Fake".into(),
                initialize: InitializeResponse::new(weave_acp_core::ProtocolVersion::V1),
                release: None,
            },
            cwd: "/repo".into(),
            additional_directories: Vec::new(),
            git: None,
            title: None,
            state: SessionStatus::Open,
            activity: Activity::Idle,
            clients: 1,
            blank,
            policy: PermissionPolicy::ask(),
            modes: None,
            config_options: Vec::new(),
            turns: Vec::new(),
            queue: Vec::new(),
            queue_paused: None,
            pending: Vec::new(),
            subagents: Vec::new(),
            journal: JournalHead {
                id: "1".into(),
                head,
            },
            notices: Vec::new(),
            trace: None,
            update: None,
            started_by: None,
        }
    }

    #[test]
    fn a_session_says_how_it_was_reopened() {
        let replay = |from| Replay { from, reset: true };
        // New, or blank: nothing to come back to.
        assert_eq!(
            OpenedSession::from_state(&state(false, 3), None).reopened,
            None
        );
        assert_eq!(
            OpenedSession::from_state(&state(true, 3), Some(&replay(1))).reopened,
            None
        );
        // Attached with history to show, or none at all.
        assert_eq!(
            OpenedSession::from_state(&state(false, 3), Some(&replay(1))).reopened,
            Some(Reopened::Loaded)
        );
        assert_eq!(
            OpenedSession::from_state(&state(false, 0), Some(&replay(1))).reopened,
            Some(Reopened::Resumed)
        );
    }
}
