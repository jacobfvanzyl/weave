use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::AcpAgent;
use agent_client_protocol::Agent;
use agent_client_protocol::Client;
use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use agent_client_protocol::LineDirection;
use agent_client_protocol::Responder;
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::CancelNotification;
use agent_client_protocol::schema::v1::ClientCapabilities;
use agent_client_protocol::schema::v1::ContentBlock;
use agent_client_protocol::schema::v1::Implementation;
use agent_client_protocol::schema::v1::InitializeRequest;
use agent_client_protocol::schema::v1::InitializeResponse;
use agent_client_protocol::schema::v1::NewSessionRequest;
use agent_client_protocol::schema::v1::NewSessionResponse;
use agent_client_protocol::schema::v1::PermissionOptionId;
use agent_client_protocol::schema::v1::PromptRequest;
use agent_client_protocol::schema::v1::PromptResponse;
use agent_client_protocol::schema::v1::RequestPermissionOutcome;
use agent_client_protocol::schema::v1::RequestPermissionRequest;
use agent_client_protocol::schema::v1::RequestPermissionResponse;
use agent_client_protocol::schema::v1::SelectedPermissionOutcome;
use agent_client_protocol::schema::v1::SessionId;
use agent_client_protocol::schema::v1::SessionNotification;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::AgentSpec;
use crate::ProtocolTrace;

/// Everything an agent sends, in the order the connection received it.
pub enum AgentEvent {
    /// A `session/update` notification.
    SessionUpdate(SessionNotification),
    /// A `session/request_permission` request awaiting an answer.
    PermissionRequested(PermissionRequest),
    /// The response to a prompt sent with [`AgentConnection::prompt`]. Updates
    /// the agent sent before responding are always delivered first.
    TurnEnded {
        session_id: SessionId,
        result: Result<PromptResponse, Error>,
    },
    /// The connection ended. Carries the reason unless the agent closed it cleanly.
    Disconnected(Option<Error>),
}

/// A `session/request_permission` request. Dropping it unanswered leaves the agent waiting.
pub struct PermissionRequest {
    pub request: RequestPermissionRequest,
    responder: Responder<RequestPermissionResponse>,
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

    fn respond(self, outcome: RequestPermissionOutcome) -> Result<(), Error> {
        self.responder
            .respond(RequestPermissionResponse::new(outcome))
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SpawnError {
    #[error("agent failed to start: {0}")]
    Start(Error),
    #[error("agent exited before the connection was established")]
    Exited,
}

#[derive(Debug, thiserror::Error)]
pub enum InitializeError {
    #[error(transparent)]
    Protocol(#[from] Error),
    #[error("agent requires ACP protocol version {0:?}, but this client supports only v1")]
    UnsupportedVersion(ProtocolVersion),
}

/// One ACP v1 connection to an agent process this client launched.
pub struct AgentConnection {
    cx: ConnectionTo<Agent>,
    events: mpsc::UnboundedSender<AgentEvent>,
    shutdown: oneshot::Sender<()>,
    driver: JoinHandle<()>,
}

impl AgentConnection {
    /// Launch the agent and connect to it. Nothing is sent until [`Self::initialize`].
    pub async fn spawn(
        spec: &AgentSpec,
        trace: Option<ProtocolTrace>,
    ) -> Result<(Self, mpsc::UnboundedReceiver<AgentEvent>), SpawnError> {
        let (events, mut event_rx) = mpsc::unbounded_channel();
        let trace = trace.map(Arc::new);
        let agent = AcpAgent::new(spec.to_config()).with_debug(move |line, direction| {
            if matches!(direction, LineDirection::Stderr) {
                tracing::debug!(target: "agent_stderr", "{line}");
            }
            if let Some(trace) = &trace {
                trace.record(direction, line);
            }
        });

        let notifications = events.clone();
        let permissions = events.clone();
        let builder = Client
            .builder()
            .name("weave")
            .on_receive_notification(
                async move |notification: SessionNotification, _cx| {
                    let _ = notifications.send(AgentEvent::SessionUpdate(notification));
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                async move |request: RequestPermissionRequest, responder, _cx| {
                    let pending = PermissionRequest { request, responder };
                    if let Err(mpsc::error::SendError(AgentEvent::PermissionRequested(pending))) =
                        permissions.send(AgentEvent::PermissionRequested(pending))
                    {
                        // Nobody is listening any more, so nobody can answer.
                        return pending.cancel();
                    }
                    Ok(())
                },
                agent_client_protocol::on_receive_request!(),
            );

        let (cx_tx, cx_rx) = oneshot::channel();
        let (shutdown, shutdown_rx) = oneshot::channel::<()>();
        let disconnected = events.clone();
        let driver = tokio::spawn(async move {
            let result = builder
                .connect_with(agent, async move |cx: ConnectionTo<Agent>| {
                    let closed = cx.clone();
                    let _ = cx_tx.send(cx);
                    tokio::select! {
                        _ = shutdown_rx => {}
                        () = closed.incoming_closed() => {}
                    }
                    Ok(())
                })
                .await;
            let _ = disconnected.send(AgentEvent::Disconnected(result.err()));
        });

        match cx_rx.await {
            Ok(cx) => Ok((
                Self {
                    cx,
                    events,
                    shutdown,
                    driver,
                },
                event_rx,
            )),
            // The connection never ran, so the only event is the reason it failed.
            Err(_) => match event_rx.recv().await {
                Some(AgentEvent::Disconnected(Some(error))) => Err(SpawnError::Start(error)),
                _ => Err(SpawnError::Exited),
            },
        }
    }

    /// Negotiate ACP v1 and exchange capabilities.
    pub async fn initialize(&self) -> Result<InitializeResponse, InitializeError> {
        let request = InitializeRequest::new(ProtocolVersion::V1)
            .client_capabilities(ClientCapabilities::default())
            .client_info(Implementation::new("weave", env!("CARGO_PKG_VERSION")));
        let response = self.cx.send_request(request).block_task().await?;
        // The agent answers with the version it will speak; the client must not
        // continue with one it does not support.
        if response.protocol_version != ProtocolVersion::V1 {
            return Err(InitializeError::UnsupportedVersion(
                response.protocol_version,
            ));
        }
        Ok(response)
    }

    pub async fn new_session(&self, cwd: PathBuf) -> Result<NewSessionResponse, Error> {
        self.cx
            .send_request(NewSessionRequest::new(cwd))
            .block_task()
            .await
    }

    /// Start a prompt turn. Its updates and final [`AgentEvent::TurnEnded`] arrive as events.
    pub fn prompt(&self, session_id: SessionId, prompt: Vec<ContentBlock>) -> Result<(), Error> {
        let events = self.events.clone();
        self.cx
            .send_request(PromptRequest::new(session_id.clone(), prompt))
            // Delivered under the dispatch loop's ordering barrier, so every update
            // received before the response is already queued ahead of it.
            .on_receiving_result(async move |result| {
                let _ = events.send(AgentEvent::TurnEnded { session_id, result });
                Ok(())
            })
    }

    /// Ask the agent to stop the current turn. The turn still ends with
    /// [`AgentEvent::TurnEnded`], normally with the `cancelled` stop reason.
    pub fn cancel(&self, session_id: SessionId) -> Result<(), Error> {
        self.cx
            .send_notification(CancelNotification::new(session_id))
    }

    /// Close the connection and terminate the agent's process group.
    pub async fn shutdown(self) {
        let _ = self.shutdown.send(());
        let _ = self.driver.await;
    }
}
