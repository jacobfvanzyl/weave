//! Starting a new session in a mode, as `[agents.<name>] mode` or `session/create` asks: by
//! the mode's id, or its name in any case, through the mode config option when the agent
//! offers one and its modes otherwise.

use weave_acp_core::AgentHandle;
use weave_acp_core::schema::SessionConfigKind;
use weave_acp_core::schema::SessionConfigOptionCategory;
use weave_acp_core::schema::SessionConfigOptionValue;
use weave_acp_core::schema::SessionConfigSelectOptions;
use weave_acp_core::schema::SessionId;

use crate::session::Snapshot;

/// Put `session_id` in the mode `wanted` names, updating `snapshot`. It stays in the agent's
/// own default when that fails, and the error says why, for the client to show.
pub(crate) async fn start_in(
    agent: &AgentHandle,
    session_id: &SessionId,
    snapshot: &mut Snapshot,
    wanted: &str,
) -> Result<(), String> {
    let named = |id: &str, name: &str| id == wanted || name.eq_ignore_ascii_case(wanted);
    let failed =
        |error: agent_client_protocol::Error| format!("Couldn't start in mode {wanted}: {error}");
    let missing = || format!("The agent has no mode {wanted}; the thread uses its default");
    let mode_option = snapshot
        .config_options
        .iter()
        .find(|option| option.category == Some(SessionConfigOptionCategory::Mode));
    if let Some(option) = mode_option
        && let SessionConfigKind::Select(select) = &option.kind
    {
        let options = match &select.options {
            SessionConfigSelectOptions::Ungrouped(options) => options.clone(),
            SessionConfigSelectOptions::Grouped(groups) => groups
                .iter()
                .flat_map(|group| group.options.iter().cloned())
                .collect(),
            _ => Vec::new(),
        };
        let choice = options
            .iter()
            .find(|choice| named(&choice.value.0, &choice.name))
            .ok_or_else(missing)?;
        let value = SessionConfigOptionValue::ValueId {
            value: choice.value.clone(),
        };
        snapshot.config_options = agent
            .set_config_option(session_id.clone(), option.id.clone(), value)
            .await
            .map_err(failed)?;
        return Ok(());
    }
    if !snapshot.config_options.is_empty() {
        return Err(missing());
    }
    let mode_id = snapshot
        .modes
        .as_ref()
        .and_then(|modes| {
            modes
                .available_modes
                .iter()
                .find(|mode| named(&mode.id.0, &mode.name))
        })
        .map(|mode| mode.id.clone())
        .ok_or_else(missing)?;
    agent
        .set_mode(session_id.clone(), mode_id.clone())
        .await
        .map_err(failed)?;
    if let Some(modes) = &mut snapshot.modes {
        modes.current_mode_id = mode_id;
    }
    Ok(())
}
