//! The steering extension: a message for the turn that is running, which joins it rather than
//! waiting to start a turn of its own.
//!
//! It isn't part of ACP; claude-agent-acp and codex-acp define it. An agent that has it says
//! so in its `initialize` response, as `_meta.steering.supported: true`, and takes
//! `_session/steering` `{sessionId, prompt, _meta?}`, answering `{outcome}`:
//!
//! - `injected`: the message joined the running turn, which ends once it's answered;
//! - `startedNewTurn`: no turn was running, so the agent started one with it;
//! - `promptRequired`: no turn was running, and the request asked the agent not to start one
//!   (`_meta.steering.idleBehavior: "promptRequired"`), so the message is the client's to
//!   send as a prompt;
//! - `failed`: the agent couldn't take it.
//!
//! [`crate::AgentHandle::steer`] always asks for `promptRequired`, so that turns start only
//! through `session/prompt`, whose response says when they end. codex-acp doesn't honor it
//! yet and answers `startedNewTurn` instead, starting a turn whose end it never reports.

use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::JsonRpcResponse;
use agent_client_protocol::schema::v1::ContentBlock;
use agent_client_protocol::schema::v1::InitializeResponse;
use agent_client_protocol::schema::v1::Meta;
use agent_client_protocol::schema::v1::SessionId;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;

/// The `_meta` key, in `initialize` responses and steering requests.
const KEY: &str = "steering";

/// Whether the agent takes steering requests, as its `initialize` response says.
pub fn supports_steering(agent: &InitializeResponse) -> bool {
    agent
        .meta
        .as_ref()
        .and_then(|meta| meta.get(KEY))
        .and_then(|steering| steering.get("supported"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "_session/steering", response = SteerResponse)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SteerRequest {
    session_id: SessionId,
    prompt: Vec<ContentBlock>,
    #[serde(rename = "_meta", default, skip_serializing_if = "Option::is_none")]
    meta: Option<Meta>,
}

impl SteerRequest {
    /// A request that leaves starting a turn to the client.
    pub(crate) fn new(session_id: SessionId, prompt: Vec<ContentBlock>) -> Self {
        let mut meta = Meta::new();
        meta.insert(KEY.to_owned(), json!({"idleBehavior": "promptRequired"}));
        Self {
            session_id,
            prompt,
            meta: Some(meta),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonRpcResponse)]
pub(crate) struct SteerResponse {
    pub(crate) outcome: SteerOutcome,
}

/// How the agent took a steered message.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SteerOutcome {
    /// It joined the running turn.
    Injected,
    /// No turn was running, and the agent started one with it.
    StartedNewTurn,
    /// No turn was running, so nothing was sent: prompt with it instead.
    PromptRequired,
    /// The agent couldn't take it.
    Failed,
    /// An outcome this client doesn't know.
    #[serde(other)]
    Unknown,
}

#[cfg(test)]
mod tests {
    use agent_client_protocol::schema::ProtocolVersion;
    use pretty_assertions::assert_eq;

    use super::*;

    fn agent(meta: Option<Value>) -> InitializeResponse {
        let meta = meta.and_then(|meta| meta.as_object().cloned());
        InitializeResponse::new(ProtocolVersion::V1).meta(meta)
    }

    #[test]
    fn agents_say_whether_they_take_steering() {
        assert!(supports_steering(&agent(Some(
            json!({"steering": {"supported": true}})
        ))));
        assert!(!supports_steering(&agent(Some(
            json!({"steering": {"supported": false}})
        ))));
        assert!(!supports_steering(&agent(Some(json!({"other": true})))));
        assert!(!supports_steering(&agent(None)));
    }

    #[test]
    fn requests_leave_starting_a_turn_to_the_client() {
        let request = SteerRequest::new(SessionId::new("s-1"), vec![ContentBlock::from("hi")]);
        assert_eq!(
            serde_json::to_value(&request).ok(),
            Some(json!({
                "sessionId": "s-1",
                "prompt": [{"type": "text", "text": "hi"}],
                "_meta": {"steering": {"idleBehavior": "promptRequired"}},
            }))
        );
    }

    #[test]
    fn outcomes_read_as_the_adapters_send_them() {
        let outcome = |text: &str| {
            serde_json::from_value::<SteerResponse>(json!({"outcome": text}))
                .map(|response| response.outcome)
                .ok()
        };
        assert_eq!(outcome("injected"), Some(SteerOutcome::Injected));
        assert_eq!(
            outcome("startedNewTurn"),
            Some(SteerOutcome::StartedNewTurn)
        );
        assert_eq!(
            outcome("promptRequired"),
            Some(SteerOutcome::PromptRequired)
        );
        assert_eq!(outcome("failed"), Some(SteerOutcome::Failed));
        assert_eq!(outcome("later"), Some(SteerOutcome::Unknown));
    }
}
