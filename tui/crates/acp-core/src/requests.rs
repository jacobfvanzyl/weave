//! Requests from the agent that wait on the user.

use std::collections::BTreeMap;

use agent_client_protocol::Error;
use agent_client_protocol::Responder;
use agent_client_protocol::schema::v1::CreateElicitationRequest;
use agent_client_protocol::schema::v1::CreateElicitationResponse;
use agent_client_protocol::schema::v1::ElicitationAcceptAction;
use agent_client_protocol::schema::v1::ElicitationAction;
use agent_client_protocol::schema::v1::ElicitationContentValue;
use agent_client_protocol::schema::v1::PermissionOptionId;
use agent_client_protocol::schema::v1::RequestPermissionOutcome;
use agent_client_protocol::schema::v1::RequestPermissionRequest;
use agent_client_protocol::schema::v1::RequestPermissionResponse;
use agent_client_protocol::schema::v1::SelectedPermissionOutcome;
use tokio::sync::oneshot;

/// Identifies a request awaiting the user, so the agent's withdrawal of it can be matched.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct RequestKey(pub(crate) u64);

/// A `session/request_permission` request. Dropping it unanswered leaves the agent waiting.
pub struct PermissionRequest {
    pub key: RequestKey,
    pub request: RequestPermissionRequest,
    pub(crate) responder: Responder<RequestPermissionResponse>,
    /// Dropped once answered, which stops the withdrawal watcher.
    pub(crate) _answered: oneshot::Sender<()>,
}

impl PermissionRequest {
    pub fn select(self, option_id: PermissionOptionId) -> Result<(), Error> {
        self.respond(RequestPermissionOutcome::Selected(
            SelectedPermissionOutcome::new(option_id),
        ))
    }

    /// Answer with the `cancelled` outcome, which the protocol requires for every
    /// pending permission request once the client cancels the turn.
    pub fn cancel(self) -> Result<(), Error> {
        self.respond(RequestPermissionOutcome::Cancelled)
    }

    /// Answer a request the agent withdrew with `$/cancel_request`: the standard
    /// request-cancelled error, since the protocol still requires a response.
    pub fn withdrawn(self) -> Result<(), Error> {
        self.responder
            .respond_with_error(Error::request_cancelled())
    }

    fn respond(self, outcome: RequestPermissionOutcome) -> Result<(), Error> {
        self.responder
            .respond(RequestPermissionResponse::new(outcome))
    }
}

/// An `elicitation/create` request: the agent asks the user for information or consent.
pub struct ElicitationRequest {
    pub key: RequestKey,
    pub request: CreateElicitationRequest,
    pub(crate) responder: Responder<CreateElicitationResponse>,
    pub(crate) _answered: oneshot::Sender<()>,
}

impl ElicitationRequest {
    /// The user submitted the form (with its values) or consented to open the URL (without).
    pub fn accept(
        self,
        content: Option<BTreeMap<String, ElicitationContentValue>>,
    ) -> Result<(), Error> {
        self.respond(ElicitationAction::Accept(
            ElicitationAcceptAction::new().content(content),
        ))
    }

    /// The user explicitly said no.
    pub fn decline(self) -> Result<(), Error> {
        self.respond(ElicitationAction::Decline)
    }

    /// The user dismissed the request without choosing, or the turn it belonged to ended.
    pub fn cancel(self) -> Result<(), Error> {
        self.respond(ElicitationAction::Cancel)
    }

    /// Answer a request the agent withdrew with `$/cancel_request`.
    pub fn withdrawn(self) -> Result<(), Error> {
        self.responder
            .respond_with_error(Error::request_cancelled())
    }

    fn respond(self, action: ElicitationAction) -> Result<(), Error> {
        self.responder
            .respond(CreateElicitationResponse::new(action))
    }
}
