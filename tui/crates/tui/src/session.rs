//! Opening sessions: new, or an existing one by load (with history) or resume (without).

use std::path::PathBuf;

use weave_acp_core::AgentHandle;
use weave_acp_core::SessionSetup;
use weave_acp_core::daemon_protocol;
use weave_acp_core::schema::Error;
use weave_acp_core::schema::Meta;
use weave_acp_core::schema::SessionConfigOption;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::SessionModeState;

use crate::settings;
use crate::settings::SettingChange;

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
    /// The directory it works in, when the weave daemon says: the client works there too.
    pub cwd: Option<PathBuf>,
    /// Why a new session didn't start in the configured mode.
    pub notice: Option<String>,
}

/// The directory the weave daemon says a reopened session works in.
fn daemon_cwd(meta: Option<&Meta>) -> Option<PathBuf> {
    daemon_protocol::read_meta::<daemon_protocol::OpenedSession>(meta).map(|opened| opened.cwd)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reopened {
    /// `session/load`: the history was replayed as updates before this returned.
    Loaded,
    /// `session/resume`: the agent has the context, but nothing was replayed.
    Resumed,
}

/// Reattach to a session this client already shows, after reconnecting: `session/resume`,
/// with no replay of what it has. Fails, for a reload instead, when the agent can't resume.
pub async fn reattach_session(
    handle: &AgentHandle,
    session_id: SessionId,
    setup: &SessionSetup,
) -> Result<OpenedSession, Error> {
    let response = handle.resume_session(session_id.clone(), setup).await?;
    Ok(OpenedSession {
        session_id,
        cwd: daemon_cwd(response.meta.as_ref()),
        modes: response.modes,
        config_options: response.config_options.unwrap_or_default(),
        reopened: Some(Reopened::Resumed),
        notice: None,
    })
}

/// Open `target`, preferring `session/load` (which shows the history) over `session/resume`.
/// A new session is put in `mode`, the agent's configured default; a reopened one is in
/// whatever mode the agent restores.
pub async fn open_session(
    handle: &AgentHandle,
    target: SessionTarget,
    setup: &SessionSetup,
    mode: Option<&str>,
) -> Result<OpenedSession, Error> {
    match target {
        SessionTarget::New => {
            let response = handle.new_session(setup).await?;
            let mut opened = OpenedSession {
                session_id: response.session_id,
                modes: response.modes,
                config_options: response.config_options.unwrap_or_default(),
                reopened: None,
                cwd: None,
                notice: None,
            };
            if let Some(mode) = mode {
                opened.notice = start_in_mode(handle, &mut opened, mode).await.err();
            }
            Ok(opened)
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
                    cwd: daemon_cwd(response.meta.as_ref()),
                    modes: response.modes,
                    config_options: response.config_options.unwrap_or_default(),
                    reopened: Some(Reopened::Loaded),
                    notice: None,
                })
            } else {
                let response = handle.resume_session(session_id.clone(), setup).await?;
                Ok(OpenedSession {
                    session_id,
                    cwd: daemon_cwd(response.meta.as_ref()),
                    modes: response.modes,
                    config_options: response.config_options.unwrap_or_default(),
                    reopened: Some(Reopened::Resumed),
                    notice: None,
                })
            }
        }
    }
}

/// Put a new session in `mode`, as choosing it in the settings would. The session stays open
/// in the agent's own default when that fails, and the error says why.
async fn start_in_mode(
    handle: &AgentHandle,
    opened: &mut OpenedSession,
    mode: &str,
) -> Result<(), String> {
    let change = settings::mode_change(&opened.config_options, opened.modes.as_ref(), mode)
        .ok_or_else(|| format!("The agent has no mode {mode}; the session uses its default"))?;
    let failed = |error: Error| format!("Couldn't start in mode {mode}: {error}");
    match change {
        SettingChange::ConfigOption(config_id, value) => {
            opened.config_options = handle
                .set_config_option(opened.session_id.clone(), config_id, value)
                .await
                .map_err(failed)?;
        }
        SettingChange::Mode(mode_id) => {
            handle
                .set_mode(opened.session_id.clone(), mode_id.clone())
                .await
                .map_err(failed)?;
            if let Some(modes) = &mut opened.modes {
                modes.current_mode_id = mode_id;
            }
        }
    }
    Ok(())
}
