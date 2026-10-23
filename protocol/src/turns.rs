//! Starting, steering and cancelling turns. A turn's end reaches every attached client as a
//! `turnEnded` event, whoever started it.
//!
//! Request keys: `session/run`, `turn/start` and `queue/add` take a `key` the caller chooses, so
//! a request sent again after a dropped connection answers as the first did and starts nothing.

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
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "turn/start", response = StartTurnResponse)]
#[serde(rename_all = "camelCase")]
pub struct StartTurnRequest {
    pub session_id: SessionId,
    pub prompt: Vec<ContentBlock>,
    /// Makes it safe to send again (feature [`REQUEST_KEYS_FEATURE`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct StartTurnResponse {
    /// The position of the turn's `turnStarted` event.
    pub seq: u64,
}

/// The [`crate::hello::HelloResponse::features`] entry of a Host that takes request keys: the
/// `key` of `session/run`, `turn/start` and `queue/add`. A repeat, the same method with the same
/// key, answers as the first did and starts nothing, across Host restarts too; one whose method
/// or params differ fails with `key_reused`. A request that fails doesn't use its key up.
pub const REQUEST_KEYS_FEATURE: &str = "requestKeys";

/// The longest request key, in characters.
pub const MAX_KEY: usize = 200;

/// The [`crate::hello::HelloResponse::features`] entry of a Host that takes `turn/steer`.
pub const STEER_FEATURE: &str = "turn/steer";

/// `turn/steer`: a message for the session's running turn, which joins it rather than
/// starting a turn of its own. Every attached client sees it as a `turnSteered` event, in
/// order with the turn's updates. It needs an agent that takes steering, as its `initialize`
/// response says.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "turn/steer", response = SteerTurnResponse)]
#[serde(rename_all = "camelCase")]
pub struct SteerTurnRequest {
    pub session_id: SessionId,
    pub prompt: Vec<ContentBlock>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct SteerTurnResponse {
    pub outcome: SteerOutcome,
    /// The position of the message's `turnSteered` event, when it was steered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum SteerOutcome {
    /// It joined the running turn.
    Steered,
    /// No turn was running by then, and nothing was sent: start a turn with it instead.
    NotRunning,
}

/// `turn/cancel`: cancel the session's running turn and its pending requests.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "turn/cancel", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct CancelTurnRequest {
    pub session_id: SessionId,
}
