//! The earlier draft of ACP's Subagent Sessions RFD, which claude-agent-acp (0.86, 0.87) and
//! codex-acp (2.1.1) still send: `subagent_spawned` and `subagent_state_update`, naming the
//! child `subagentSessionId` and ending it with an outcome (`completed`, `failed`,
//! `cancelled`). The current draft, which the pinned schema implements, has one upsert,
//! `subagent_update`, with a work state, and reports instructions to a child as a
//! `session_message`.
//!
//! The pinned schema rejects the earlier variants, so they are read here first and passed on
//! as the current draft's updates; the rest of weave sees one model. A spawn is reported as
//! running, its prompt as the parent's message to the child, and an outcome as idle: a
//! `failed` outcome has no stop reason in the pinned schema, so it is idle with none.
//!
//! Delete this once the adapters send `subagent_update` (claude-agent-acp PRs #1214 and
//! #1257).

use agent_client_protocol::schema::MaybeUndefined;
use agent_client_protocol::schema::v1::ContentBlock;
use agent_client_protocol::schema::v1::IdleStateUpdate;
use agent_client_protocol::schema::v1::RunningStateUpdate;
use agent_client_protocol::schema::v1::SessionCancelCapabilities;
use agent_client_protocol::schema::v1::SessionId;
use agent_client_protocol::schema::v1::SessionMessage;
use agent_client_protocol::schema::v1::SessionNotification;
use agent_client_protocol::schema::v1::SessionUpdate;
use agent_client_protocol::schema::v1::StateUpdate;
use agent_client_protocol::schema::v1::StopReason;
use agent_client_protocol::schema::v1::SubagentSessionCapabilities;
use agent_client_protocol::schema::v1::SubagentUpdate;
use agent_client_protocol::schema::v1::UnknownStateUpdate;
use serde_json::Value;

/// The current draft's updates for a `session/update` in the earlier draft's form, or `None`
/// for anything else.
pub fn translate(method: &str, params: &Value) -> Option<Vec<SessionNotification>> {
    if method != "session/update" {
        return None;
    }
    let parent = SessionId::new(params.get("sessionId")?.as_str()?);
    let update = params.get("update")?;
    let child = SessionId::new(update.get("subagentSessionId")?.as_str()?);
    let text = |key: &str| {
        update
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    let notify = |update| SessionNotification::new(parent.clone(), update);
    match update.get("sessionUpdate")?.as_str()? {
        "subagent_spawned" => {
            let mut subagent = SubagentUpdate::new(child.clone())
                .capabilities(capabilities(update.get("capabilities")))
                .state(StateUpdate::Running(RunningStateUpdate::new()));
            if let Some(name) = text("name") {
                subagent = subagent.title(name);
            }
            // claude-agent-acp sends the prompt as the task too; the message says it once.
            if let Some(task) = text("task").filter(|task| Some(task) != text("prompt").as_ref()) {
                subagent = subagent.description(task);
            }
            let mut updates = vec![notify(SessionUpdate::SubagentUpdate(subagent))];
            if let Some(prompt) = text("prompt") {
                let message = SessionMessage::new(format!("{child}:prompt"))
                    .sender_session_id(parent.clone())
                    .recipient_session_id(child)
                    .content(MaybeUndefined::Value(vec![ContentBlock::from(prompt)]));
                updates.push(notify(SessionUpdate::SessionMessage(message)));
            }
            Some(updates)
        }
        "subagent_state_update" => {
            let state = match update.get("state").and_then(Value::as_str) {
                Some("completed") => {
                    StateUpdate::Idle(IdleStateUpdate::new().stop_reason(StopReason::EndTurn))
                }
                Some("cancelled") => {
                    StateUpdate::Idle(IdleStateUpdate::new().stop_reason(StopReason::Cancelled))
                }
                Some("failed") => StateUpdate::Idle(IdleStateUpdate::new()),
                Some("running") => StateUpdate::Running(RunningStateUpdate::new()),
                _ => StateUpdate::Unknown(UnknownStateUpdate::new()),
            };
            let subagent = SubagentUpdate::new(child).state(state);
            Some(vec![notify(SessionUpdate::SubagentUpdate(subagent))])
        }
        _ => None,
    }
}

/// The child's controls: cancellation where the earlier draft offered it.
fn capabilities(value: Option<&Value>) -> SubagentSessionCapabilities {
    let cancel = value
        .and_then(|capabilities| capabilities.get("cancel"))
        .is_some_and(Value::is_object);
    SubagentSessionCapabilities::new().cancel(cancel.then(SessionCancelCapabilities::new))
}

#[cfg(test)]
mod tests {
    // Assertions on parsed updates fail fast.
    #![allow(clippy::expect_used)]

    use pretty_assertions::assert_eq;
    use serde_json::json;

    use super::*;

    fn updates(params: Value) -> Vec<SessionUpdate> {
        translate("session/update", &params)
            .expect("translated")
            .into_iter()
            .map(|notification| {
                assert_eq!(notification.session_id.to_string(), "parent");
                notification.update
            })
            .collect()
    }

    #[test]
    fn a_spawn_is_a_running_association_and_its_prompt_a_message() {
        let updates = updates(json!({
            "sessionId": "parent",
            "update": {
                "sessionUpdate": "subagent_spawned",
                "subagentSessionId": "child",
                "name": "Explore",
                "task": "Find the parser",
                "prompt": "Look under src/ for the parser.",
                "capabilities": {"cancel": {}}
            }
        }));
        let [
            SessionUpdate::SubagentUpdate(subagent),
            SessionUpdate::SessionMessage(message),
        ] = updates.as_slice()
        else {
            panic!("unexpected updates: {updates:?}");
        };
        assert_eq!(subagent.session_id.to_string(), "child");
        assert_eq!(subagent.title, MaybeUndefined::Value("Explore".to_owned()));
        assert_eq!(
            subagent.description,
            MaybeUndefined::Value("Find the parser".to_owned())
        );
        assert!(matches!(
            &subagent.capabilities,
            MaybeUndefined::Value(capabilities) if capabilities.cancel.is_some()
        ));
        assert!(matches!(
            subagent.state,
            MaybeUndefined::Value(StateUpdate::Running(_))
        ));
        assert_eq!(
            message
                .recipient_session_id
                .as_ref()
                .map(ToString::to_string),
            Some("child".to_owned())
        );
    }

    #[test]
    fn a_task_that_repeats_the_prompt_is_said_once() {
        let updates = updates(json!({
            "sessionId": "parent",
            "update": {
                "sessionUpdate": "subagent_spawned",
                "subagentSessionId": "child",
                "name": "Count files",
                "task": "Count the files.",
                "prompt": "Count the files.",
                "capabilities": {}
            }
        }));
        let [
            SessionUpdate::SubagentUpdate(subagent),
            SessionUpdate::SessionMessage(_),
        ] = updates.as_slice()
        else {
            panic!("unexpected updates: {updates:?}");
        };
        assert_eq!(subagent.description, MaybeUndefined::Undefined);
        assert!(matches!(
            &subagent.capabilities,
            MaybeUndefined::Value(capabilities) if capabilities.cancel.is_none()
        ));
    }

    #[test]
    fn outcomes_are_idle_with_their_stop_reason() {
        let state = |outcome: &str| {
            let updates = updates(json!({
                "sessionId": "parent",
                "update": {
                    "sessionUpdate": "subagent_state_update",
                    "subagentSessionId": "child",
                    "state": outcome
                }
            }));
            match updates.as_slice() {
                [SessionUpdate::SubagentUpdate(subagent)] => subagent.state.clone(),
                other => panic!("unexpected updates: {other:?}"),
            }
        };
        let idle = |reason: Option<StopReason>| {
            MaybeUndefined::Value(StateUpdate::Idle(
                IdleStateUpdate::new().stop_reason(reason),
            ))
        };
        assert_eq!(state("completed"), idle(Some(StopReason::EndTurn)));
        assert_eq!(state("cancelled"), idle(Some(StopReason::Cancelled)));
        assert_eq!(state("failed"), idle(None));
    }

    #[test]
    fn everything_else_passes_through() {
        let message = json!({
            "sessionId": "parent",
            "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "hi"}}
        });
        assert!(translate("session/update", &message).is_none());
        assert!(translate("session/other", &json!({})).is_none());
    }
}
