//! Opening sessions: new, or an existing one by load (with history) or resume (without).

use weave_acp_core::AgentHandle;
use weave_acp_core::SessionSetup;
use weave_acp_core::schema::Error;
use weave_acp_core::schema::SessionConfigOption;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::SessionModeState;

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
    /// How an existing session was reopened.
    pub reopened: Option<Reopened>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reopened {
    /// `session/load`: the history was replayed as updates before this returned.
    Loaded,
    /// `session/resume`: the agent has the context, but nothing was replayed.
    Resumed,
}

/// Open `target`, preferring `session/load` (which shows the history) over `session/resume`.
pub async fn open_session(
    handle: &AgentHandle,
    target: SessionTarget,
    setup: &SessionSetup,
) -> Result<OpenedSession, Error> {
    match target {
        SessionTarget::New => {
            let response = handle.new_session(setup).await?;
            Ok(OpenedSession {
                session_id: response.session_id,
                modes: response.modes,
                config_options: response.config_options.unwrap_or_default(),
                reopened: None,
            })
        }
        SessionTarget::Existing(session_id) => {
            let capabilities = handle
                .agent()
                .map(|agent| agent.agent_capabilities.clone())
                .unwrap_or_default();
            if capabilities.load_session {
                let response = handle.load_session(session_id.clone(), setup).await?;
                Ok(OpenedSession {
                    session_id,
                    modes: response.modes,
                    config_options: response.config_options.unwrap_or_default(),
                    reopened: Some(Reopened::Loaded),
                })
            } else {
                let response = handle.resume_session(session_id.clone(), setup).await?;
                Ok(OpenedSession {
                    session_id,
                    modes: response.modes,
                    config_options: response.config_options.unwrap_or_default(),
                    reopened: Some(Reopened::Resumed),
                })
            }
        }
    }
}
