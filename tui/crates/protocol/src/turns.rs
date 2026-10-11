//! Starting and cancelling turns. A turn's end reaches every attached client as a
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

/// `turn/cancel`: cancel the session's running turn and its pending requests.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "turn/cancel", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct CancelTurnRequest {
    pub session_id: SessionId,
}
