//! The terminal output extension: how agents show the output of commands they run
//! themselves, rather than through `terminal/create`.
//!
//! This is Zed's `_meta` convention, which codex-acp and claude-agent-acp both use. A tool
//! call embeds `{"type": "terminal", "terminalId": …}` content for a terminal the agent owns,
//! and its `tool_call` and `tool_call_update` notifications carry the terminal's progress in
//! `_meta`:
//!
//! - `terminal_output_delta` (or `terminal_output`): `{"terminal_id", "data"}`, appended;
//! - `terminal_exit`: `{"terminal_id", "exit_code", "signal"}`.
//!
//! The client opts in with `clientCapabilities._meta.terminal_output_delta: true`; agents
//! that don't recognize it ignore it. The connection turns these into the same
//! [`AgentEvent::TerminalOutput`] and [`AgentEvent::TerminalExited`] events as client
//! terminals produce, ahead of the update that carried them, so a tool call that finishes in
//! the same update already has its output. Replayed sessions resend the output, so it shows
//! when a session is loaded too.

use agent_client_protocol::schema::v1::Meta;
use agent_client_protocol::schema::v1::SessionUpdate;
use agent_client_protocol::schema::v1::TerminalExitStatus;
use serde_json::Value;

use crate::AgentEvent;

/// The `clientCapabilities._meta` key that asks for appended output chunks.
pub(crate) const CAPABILITY: &str = "terminal_output_delta";

/// The terminal events in an update's `_meta`, output before exit.
pub(crate) fn terminal_events(update: &SessionUpdate) -> Vec<AgentEvent> {
    let meta = match update {
        SessionUpdate::ToolCall(call) => call.meta.as_ref(),
        SessionUpdate::ToolCallUpdate(update) => update.meta.as_ref(),
        _ => None,
    };
    meta.map(events_in).unwrap_or_default()
}

fn events_in(meta: &Meta) -> Vec<AgentEvent> {
    let mut events = Vec::new();
    for key in ["terminal_output_delta", "terminal_output"] {
        if let Some(output) = meta.get(key)
            && let (Some(terminal_id), Some(data)) = (
                output.get("terminal_id").and_then(Value::as_str),
                output.get("data").and_then(Value::as_str),
            )
            && !data.is_empty()
        {
            events.push(AgentEvent::TerminalOutput {
                terminal_id: terminal_id.to_owned().into(),
                text: data.to_owned(),
            });
        }
    }
    if let Some(exit) = meta.get("terminal_exit")
        && let Some(terminal_id) = exit.get("terminal_id").and_then(Value::as_str)
    {
        let exit_code = exit
            .get("exit_code")
            .and_then(Value::as_u64)
            .and_then(|code| u32::try_from(code).ok());
        let signal = exit
            .get("signal")
            .and_then(Value::as_str)
            .map(str::to_owned);
        events.push(AgentEvent::TerminalExited {
            terminal_id: terminal_id.to_owned().into(),
            status: TerminalExitStatus::new()
                .exit_code(exit_code)
                .signal(signal),
        });
    }
    events
}

#[cfg(test)]
mod tests {
    use agent_client_protocol::schema::v1::ToolCallUpdate;
    use agent_client_protocol::schema::v1::ToolCallUpdateFields;
    use pretty_assertions::assert_eq;
    use serde_json::json;

    use super::*;

    fn update(meta: Value) -> SessionUpdate {
        let mut update = ToolCallUpdate::new("exec-1", ToolCallUpdateFields::new());
        update.meta = meta.as_object().cloned();
        SessionUpdate::ToolCallUpdate(update)
    }

    fn describe(events: &[AgentEvent]) -> Vec<String> {
        events
            .iter()
            .map(|event| match event {
                AgentEvent::TerminalOutput { terminal_id, text } => {
                    format!("output {terminal_id}: {text:?}")
                }
                AgentEvent::TerminalExited {
                    terminal_id,
                    status,
                } => {
                    format!(
                        "exit {terminal_id}: {:?} {:?}",
                        status.exit_code, status.signal
                    )
                }
                _ => "other".to_owned(),
            })
            .collect()
    }

    #[test]
    fn output_chunks_and_exits_become_terminal_events() {
        // As codex-acp sends a finished command.
        let events = terminal_events(&update(json!({
            "terminal_info": {"terminal_id": "exec-1", "cwd": "/repo"},
            "terminal_output_delta": {"terminal_id": "exec-1", "data": "hello\n"},
            "terminal_exit": {"terminal_id": "exec-1", "exit_code": 2, "signal": null}
        })));
        assert_eq!(
            describe(&events),
            ["output exec-1: \"hello\\n\"", "exit exec-1: Some(2) None"]
        );
        // Zed's non-delta key appends the same way.
        let events = terminal_events(&update(json!({
            "terminal_output": {"terminal_id": "exec-1", "data": "more"}
        })));
        assert_eq!(describe(&events), ["output exec-1: \"more\""]);
    }

    #[test]
    fn other_metadata_and_updates_carry_nothing() {
        assert!(terminal_events(&update(json!({"is_mcp_tool_call": true}))).is_empty());
        assert!(
            terminal_events(&update(json!({"terminal_output_delta": {"data": "x"}}))).is_empty()
        );
    }
}
