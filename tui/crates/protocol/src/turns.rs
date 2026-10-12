//! Starting, steering and cancelling turns. A turn's end reaches every attached client as a
//! `turnEnded` event, whoever started it.

use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::JsonRpcResponse;
use agent_client_protocol::schema::v1::ContentBlock;
use agent_client_protocol::schema::v1::SessionId;
use serde::Deserialize;
use serde::Serialize;

use crate::Empty;

/// `turn/start`: send a prompt. Answered once the turn has started. The session must be
/// open; it may be a subagent session.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "turn/start", response = StartTurnResponse)]
#[serde(rename_all = "camelCase")]
pub struct StartTurnRequest {
    pub session_id: SessionId,
    pub prompt: Vec<ContentBlock>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct StartTurnResponse {
    /// The position of the turn's `turnStarted` event.
    pub seq: u64,
}

/// The [`crate::hello::HelloResponse::features`] entry of a Host that takes `turn/steer`.
pub const STEER_FEATURE: &str = "turn/steer";

/// `turn/steer`: a message for the session's running turn, which joins it rather than
/// starting a turn of its own. Every attached client sees it as a `turnSteered` event, in
/// order with the turn's updates. It needs an agent that takes steering, as its `initialize`
/// response says.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "turn/steer", response = SteerTurnResponse)]
#[serde(rename_all = "camelCase")]
pub struct SteerTurnRequest {
    pub session_id: SessionId,
    pub prompt: Vec<ContentBlock>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct SteerTurnResponse {
    pub outcome: SteerOutcome,
    /// The position of the message's `turnSteered` event, when it was steered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SteerOutcome {
    /// It joined the running turn.
    Steered,
    /// No turn was running by then, and nothing was sent: start a turn with it instead.
    NotRunning,
}

/// `turn/cancel`: cancel the session's running turn and its pending requests.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "turn/cancel", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct CancelTurnRequest {
    pub session_id: SessionId,
}
