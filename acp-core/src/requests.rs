//! Requests from the agent that wait on the user.

use std::collections::BTreeMap;

use agent_client_protocol::Error;
use agent_client_protocol::v1::Responder;
use agent_client_protocol::v1::schema::CreateElicitationRequest;
use agent_client_protocol::v1::schema::CreateElicitationResponse;
use agent_client_protocol::v1::schema::ElicitationAcceptAction;
use agent_client_protocol::v1::schema::ElicitationAction;
use agent_client_protocol::v1::schema::ElicitationContentValue;
use agent_client_protocol::v1::schema::PermissionOptionId;
use agent_client_protocol::v1::schema::RequestPermissionOutcome;
use agent_client_protocol::v1::schema::RequestPermissionRequest;
use agent_client_protocol::v1::schema::RequestPermissionResponse;
use agent_client_protocol::v1::schema::SelectedPermissionOutcome;
use tokio::sync::oneshot;

/// Identifies a request awaiting the user, so the agent's withdrawal of it can be matched.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct RequestKey(pub(crate) u64);

/// A `session/request_permission` request. Dropped unanswered, it answers `cancelled`, as
/// the protocol asks of a request nobody will answer any more; the SDK would otherwise
/// answer for it with an internal error.
pub struct PermissionRequest {
    pub key: RequestKey,
    pub request: RequestPermissionRequest,
    pub(crate) responder: Option<Responder<RequestPermissionResponse>>,
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
    pub fn withdrawn(mut self) -> Result<(), Error> {
        match self.responder.take() {
            Some(responder) => responder.respond_with_error(Error::request_cancelled()),
            None => Ok(()),
        }
    }

    /// Answer with a response another client gave, as the weave Host passes one on.
    pub fn respond_with(mut self, response: RequestPermissionResponse) -> Result<(), Error> {
        match self.responder.take() {
            Some(responder) => responder.respond(response),
            None => Ok(()),
        }
    }

    fn respond(self, outcome: RequestPermissionOutcome) -> Result<(), Error> {
        self.respond_with(RequestPermissionResponse::new(outcome))
    }
}

impl Drop for PermissionRequest {
    fn drop(&mut self) {
        if let Some(responder) = self.responder.take() {
            let _ = responder.respond(RequestPermissionResponse::new(
                RequestPermissionOutcome::Cancelled,
            ));
        }
    }
}

/// An `elicitation/create` request: the agent asks the user for information or consent.
/// Dropped unanswered, it answers `cancel`.
pub struct ElicitationRequest {
    pub key: RequestKey,
    pub request: CreateElicitationRequest,
    pub(crate) responder: Option<Responder<CreateElicitationResponse>>,
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
    pub fn withdrawn(mut self) -> Result<(), Error> {
        match self.responder.take() {
            Some(responder) => responder.respond_with_error(Error::request_cancelled()),
            None => Ok(()),
        }
    }

    /// Answer with a response another client gave, as the weave Host passes one on.
    pub fn respond_with(mut self, response: CreateElicitationResponse) -> Result<(), Error> {
        match self.responder.take() {
            Some(responder) => responder.respond(response),
            None => Ok(()),
        }
    }

    fn respond(self, action: ElicitationAction) -> Result<(), Error> {
        self.respond_with(CreateElicitationResponse::new(action))
    }
}

impl Drop for ElicitationRequest {
    fn drop(&mut self) {
        if let Some(responder) = self.responder.take() {
            let _ = responder.respond(CreateElicitationResponse::new(ElicitationAction::Cancel));
        }
    }
}
