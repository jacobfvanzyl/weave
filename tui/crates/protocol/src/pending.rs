//! Permission requests and elicitations waiting on a person. Every attached client sees them,
//! clients that attach later too, and the first answer counts.

use agent_client_protocol::JsonRpcNotification;
use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::schema::v1::CreateElicitationRequest;
use agent_client_protocol::schema::v1::CreateElicitationResponse;
use agent_client_protocol::schema::v1::RequestPermissionRequest;
use agent_client_protocol::schema::v1::RequestPermissionResponse;
use agent_client_protocol::schema::v1::SessionId;
use serde::Deserialize;
use serde::Serialize;

use crate::Empty;
use crate::Timestamp;
use crate::hello::ClientId;

pub type PendingId = String;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRequest {
    pub id: PendingId,
    /// The session it's for, the root or a subagent session, when it's for one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
    pub created_at: Timestamp,
    #[serde(flatten)]
    pub request: PendingKind,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PendingKind {
    Permission { request: RequestPermissionRequest },
    Elicitation { request: CreateElicitationRequest },
}

/// `pending/added`: a request now waits in an attached session.
#[derive(Clone, Debug, Serialize, Deserialize, JsonRpcNotification)]
#[notification(method = "pending/added")]
#[serde(rename_all = "camelCase")]
pub struct PendingAddedNotification {
    pub session_id: SessionId,
    pub pending: PendingRequest,
}

/// How a pending request stopped waiting.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Resolution {
    Answered,
    /// Its turn was cancelled or ended, or its session closed.
    Cancelled,
    /// The agent withdrew it.
    Withdrawn,
}

/// `pending/resolved`: a request no longer waits.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcNotification)]
#[notification(method = "pending/resolved")]
#[serde(rename_all = "camelCase")]
pub struct PendingResolvedNotification {
    pub session_id: SessionId,
    pub pending_id: PendingId,
    pub outcome: Resolution,
    /// The client that answered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<ClientId>,
}

/// `pending/answer`: answer a pending request, with the response for its kind. The first
/// answer goes to the agent; later ones fail with [`crate::errors::ALREADY_RESOLVED`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "pending/answer", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct AnswerPendingRequest {
    pub session_id: SessionId,
    pub pending_id: PendingId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission: Option<RequestPermissionResponse>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elicitation: Option<CreateElicitationResponse>,
}
