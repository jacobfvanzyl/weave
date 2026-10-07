use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use agent_client_protocol::AcpAgent;
use agent_client_protocol::Agent;
use agent_client_protocol::Client;
use agent_client_protocol::ConnectTo;
use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use agent_client_protocol::LineDirection;
use agent_client_protocol::Responder;
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::BooleanConfigOptionCapabilities;
use agent_client_protocol::schema::v1::CancelNotification;
use agent_client_protocol::schema::v1::ClientCapabilities;
use agent_client_protocol::schema::v1::ClientSessionCapabilities;
use agent_client_protocol::schema::v1::ContentBlock;
use agent_client_protocol::schema::v1::CreateTerminalRequest;
use agent_client_protocol::schema::v1::FileSystemCapabilities;
use agent_client_protocol::schema::v1::Implementation;
use agent_client_protocol::schema::v1::InitializeRequest;
use agent_client_protocol::schema::v1::InitializeResponse;
use agent_client_protocol::schema::v1::KillTerminalRequest;
use agent_client_protocol::schema::v1::NewSessionRequest;
use agent_client_protocol::schema::v1::NewSessionResponse;
use agent_client_protocol::schema::v1::PermissionOptionId;
use agent_client_protocol::schema::v1::PromptRequest;
use agent_client_protocol::schema::v1::PromptResponse;
use agent_client_protocol::schema::v1::ReadTextFileRequest;
use agent_client_protocol::schema::v1::ReleaseTerminalRequest;
use agent_client_protocol::schema::v1::RequestPermissionOutcome;
use agent_client_protocol::schema::v1::RequestPermissionRequest;
use agent_client_protocol::schema::v1::RequestPermissionResponse;
use agent_client_protocol::schema::v1::SelectedPermissionOutcome;
use agent_client_protocol::schema::v1::SessionConfigId;
use agent_client_protocol::schema::v1::SessionConfigOption;
use agent_client_protocol::schema::v1::SessionConfigOptionValue;
use agent_client_protocol::schema::v1::SessionConfigOptionsCapabilities;
use agent_client_protocol::schema::v1::SessionId;
use agent_client_protocol::schema::v1::SessionModeId;
use agent_client_protocol::schema::v1::SessionNotification;
use agent_client_protocol::schema::v1::SetSessionConfigOptionRequest;
use agent_client_protocol::schema::v1::SetSessionModeRequest;
use agent_client_protocol::schema::v1::TerminalExitStatus;
use agent_client_protocol::schema::v1::TerminalId;
use agent_client_protocol::schema::v1::TerminalOutputRequest;
use agent_client_protocol::schema::v1::WaitForTerminalExitRequest;
use agent_client_protocol::schema::v1::WriteTextFileRequest;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::AgentSpec;
use crate::ProtocolTrace;
use crate::fs;
use crate::terminals::Terminals;

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
    /// New output from a command the agent started with `terminal/create`.
    TerminalOutput {
        terminal_id: TerminalId,
        text: String,
    },
    /// A command the agent started has exited.
    TerminalExited {
        terminal_id: TerminalId,
        status: TerminalExitStatus,
    },
    /// The connection ended. Carries the reason unless the agent closed it cleanly.
    Disconnected(Option<Error>),
}

/// Which client services this connection offers the agent.
///
/// Only advertised services are answered; the agent must not call the others, and if it
/// does it gets "method not found".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClientOptions {
    pub read_files: bool,
    pub write_files: bool,
    pub terminals: bool,
}

impl Default for ClientOptions {
    fn default() -> Self {
        Self {
            read_files: true,
            write_files: true,
            terminals: true,
        }
    }
}

impl ClientOptions {
    fn capabilities(self) -> ClientCapabilities {
        ClientCapabilities::new()
            .fs(FileSystemCapabilities::new()
                .read_text_file(self.read_files)
                .write_text_file(self.write_files))
            .terminal(self.terminals)
            .session(
                ClientSessionCapabilities::new().config_options(
                    SessionConfigOptionsCapabilities::new()
                        .boolean(BooleanConfigOptionCapabilities::new()),
                ),
            )
    }
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

/// A cloneable handle for requests whose responses a UI awaits off its event loop.
#[derive(Clone)]
pub struct AgentHandle {
    cx: ConnectionTo<Agent>,
}

impl AgentHandle {
    /// `session/set_mode`. Superseded by config options when the agent offers them.
    pub async fn set_mode(
        &self,
        session_id: SessionId,
        mode_id: SessionModeId,
    ) -> Result<(), Error> {
        self.cx
            .send_request(SetSessionModeRequest::new(session_id, mode_id))
            .block_task()
            .await
            .map(drop)
    }

    /// `session/set_config_option`. Returns every option's new state.
    pub async fn set_config_option(
        &self,
        session_id: SessionId,
        config_id: SessionConfigId,
        value: SessionConfigOptionValue,
    ) -> Result<Vec<SessionConfigOption>, Error> {
        self.cx
            .send_request(SetSessionConfigOptionRequest::new(
                session_id, config_id, value,
            ))
            .block_task()
            .await
            .map(|response| response.config_options)
    }
}

/// One ACP v1 connection to an agent.
pub struct AgentConnection {
    handle: AgentHandle,
    options: ClientOptions,
    events: mpsc::UnboundedSender<AgentEvent>,
    session_dirs: Arc<Mutex<HashMap<SessionId, PathBuf>>>,
    shutdown: oneshot::Sender<()>,
    driver: JoinHandle<()>,
}

impl AgentConnection {
    /// Launch the agent process and connect to it. Nothing is sent until [`Self::initialize`].
    pub async fn spawn(
        spec: &AgentSpec,
        trace: Option<ProtocolTrace>,
        options: ClientOptions,
    ) -> Result<(Self, mpsc::UnboundedReceiver<AgentEvent>), SpawnError> {
        let trace = trace.map(Arc::new);
        let agent = AcpAgent::new(spec.to_config()).with_debug(move |line, direction| {
            if matches!(direction, LineDirection::Stderr) {
                tracing::debug!(target: "agent_stderr", "{line}");
            }
            if let Some(trace) = &trace {
                trace.record(direction, line);
            }
        });
        Self::connect(agent, options).await
    }

    /// Connect over any transport, such as an in-process agent in tests.
    pub async fn connect(
        transport: impl ConnectTo<Client> + 'static,
        options: ClientOptions,
    ) -> Result<(Self, mpsc::UnboundedReceiver<AgentEvent>), SpawnError> {
        let (events, mut event_rx) = mpsc::unbounded_channel();
        let session_dirs = Arc::new(Mutex::new(HashMap::new()));
        let terminals = Arc::new(Terminals::new(events.clone(), Arc::clone(&session_dirs)));

        let notifications = events.clone();
        let permissions = events.clone();
        let create = Arc::clone(&terminals);
        let output = Arc::clone(&terminals);
        let wait = Arc::clone(&terminals);
        let kill = Arc::clone(&terminals);
        let release = terminals;
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
            )
            // Handlers run inside the dispatch loop, so file I/O and waiting move to tasks.
            .on_receive_request(
                async move |request: ReadTextFileRequest, responder, cx| {
                    if !options.read_files {
                        return responder.respond_with_error(Error::method_not_found());
                    }
                    cx.spawn(async move {
                        responder.respond_with_result(fs::read_text_file(request).await)
                    })
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |request: WriteTextFileRequest, responder, cx| {
                    if !options.write_files {
                        return responder.respond_with_error(Error::method_not_found());
                    }
                    cx.spawn(async move {
                        responder.respond_with_result(fs::write_text_file(request).await)
                    })
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |request: CreateTerminalRequest, responder, _cx| {
                    if !options.terminals {
                        return responder.respond_with_error(Error::method_not_found());
                    }
                    responder.respond_with_result(create.create(request))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |request: TerminalOutputRequest, responder, _cx| {
                    responder.respond_with_result(output.output(&request))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |request: WaitForTerminalExitRequest, responder, cx| match wait
                    .wait_for_exit(&request)
                {
                    Ok(exited) => {
                        cx.spawn(async move { responder.respond_with_result(exited.await) })
                    }
                    Err(error) => responder.respond_with_error(error),
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |request: KillTerminalRequest, responder, _cx| {
                    responder.respond_with_result(kill.kill(&request))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |request: ReleaseTerminalRequest, responder, _cx| {
                    responder.respond_with_result(release.release(&request))
                },
                agent_client_protocol::on_receive_request!(),
            );

        let (cx_tx, cx_rx) = oneshot::channel();
        let (shutdown, shutdown_rx) = oneshot::channel::<()>();
        let disconnected = events.clone();
        let driver = tokio::spawn(async move {
            let result = builder
                .connect_with(transport, async move |cx: ConnectionTo<Agent>| {
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
                    handle: AgentHandle { cx },
                    options,
                    events,
                    session_dirs,
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

    pub fn handle(&self) -> AgentHandle {
        self.handle.clone()
    }

    /// Negotiate ACP v1 and advertise this connection's client services.
    pub async fn initialize(&self) -> Result<InitializeResponse, InitializeError> {
        let request = InitializeRequest::new(ProtocolVersion::V1)
            .client_capabilities(self.options.capabilities())
            .client_info(Implementation::new("weave", env!("CARGO_PKG_VERSION")));
        let response = self.handle.cx.send_request(request).block_task().await?;
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
        let response = self
            .handle
            .cx
            .send_request(NewSessionRequest::new(cwd.clone()))
            .block_task()
            .await?;
        // Commands the agent starts without a directory run in the session's.
        self.session_dirs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(response.session_id.clone(), cwd);
        Ok(response)
    }

    /// Start a prompt turn. Its updates and final [`AgentEvent::TurnEnded`] arrive as events.
    pub fn prompt(&self, session_id: SessionId, prompt: Vec<ContentBlock>) -> Result<(), Error> {
        let events = self.events.clone();
        self.handle
            .cx
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
        self.handle
            .cx
            .send_notification(CancelNotification::new(session_id))
    }

    /// Close the connection, terminate the agent's process group and any commands it started.
    pub async fn shutdown(self) {
        let _ = self.shutdown.send(());
        let _ = self.driver.await;
    }
}
