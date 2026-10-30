//! A session's queue: prompts waiting, in order, to start its next turns. The Host holds it,
//! so every attached client sees the same queue, and it outlives the client that added to it.
//! When the session's turn ends, the Host starts the first queued prompt as the next turn,
//! unless the queue is paused: after a cancelled or failed turn, or when an interactive session
//! is taken up again with prompts waiting.

use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::JsonRpcResponse;
use agent_client_protocol::schema::v1::ContentBlock;
use agent_client_protocol::schema::v1::SessionId;
use serde::Deserialize;
use serde::Serialize;

use crate::Empty;
use crate::Timestamp;
use crate::sessions::TurnOrigin;

/// The [`crate::hello::HelloResponse::features`] entry of a Host that holds sessions' queues.
pub const FEATURE: &str = "queue";

/// A queued prompt, by an id unique in its session.
pub type QueuedId = String;

/// A prompt waiting in a session's queue.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct QueuedPrompt {
    pub id: QueuedId,
    pub prompt: Vec<ContentBlock>,
    /// Who added it, which its turn's origin will be.
    pub origin: TurnOrigin,
    pub queued_at: Timestamp,
}

/// Why a queue waits rather than start the next turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum QueuePause {
    /// The turn was cancelled.
    Cancelled,
    /// The turn failed.
    Failed,
    /// The Host took the session up again, after it stopped or the session closed.
    Interrupted,
}

/// `queue/add`: add a prompt to the end of the session's queue. With no turn running and
/// nothing waiting, it starts a turn at once. Adding to a paused queue resumes it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "queue/add", response = AddQueuedResponse)]
#[serde(rename_all = "camelCase")]
pub struct AddQueuedRequest {
    /// The session's own id, not a subagent session's.
    pub session_id: SessionId,
    pub prompt: Vec<ContentBlock>,
    /// Makes it safe to send again (feature `requestKeys`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct AddQueuedResponse {
    /// The prompt's id, which is also its turn's ([`crate::turns::TurnId`]).
    pub queued_id: QueuedId,
    /// The position of its `turnStarted` when it started a turn at once, otherwise of its
    /// `queued` event.
    pub seq: u64,
    /// It started a turn at once.
    pub started: bool,
}

/// `queue/remove`: take a prompt out of the queue, whoever added it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "queue/remove", response = RemoveQueuedResponse)]
#[serde(rename_all = "camelCase")]
pub struct RemoveQueuedRequest {
    pub session_id: SessionId,
    pub queued_id: QueuedId,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct RemoveQueuedResponse {
    /// The prompt taken out; absent when it had already left the queue, started or removed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed: Option<QueuedPrompt>,
}

/// `queue/resume`: start a paused queue again. A queue that isn't paused stays as it is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "queue/resume", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct ResumeQueueRequest {
    pub session_id: SessionId,
}
