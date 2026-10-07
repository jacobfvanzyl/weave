use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use agent_client_protocol::AcpAgent;
use agent_client_protocol::Agent;
use agent_client_protocol::Client;
use agent_client_protocol::ConnectTo;
use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use agent_client_protocol::LineDirection;
use agent_client_protocol::schema::v1::AuthCapabilities;
use agent_client_protocol::schema::v1::BooleanConfigOptionCapabilities;
use agent_client_protocol::schema::v1::ClientCapabilities;
use agent_client_protocol::schema::v1::ClientSessionCapabilities;
use agent_client_protocol::schema::v1::CompleteElicitationNotification;
use agent_client_protocol::schema::v1::CreateElicitationRequest;
use agent_client_protocol::schema::v1::CreateTerminalRequest;
use agent_client_protocol::schema::v1::ElicitationCapabilities;
use agent_client_protocol::schema::v1::ElicitationFormCapabilities;
use agent_client_protocol::schema::v1::ElicitationId;
use agent_client_protocol::schema::v1::ElicitationMode;
use agent_client_protocol::schema::v1::ElicitationUrlCapabilities;
use agent_client_protocol::schema::v1::FileSystemCapabilities;
use agent_client_protocol::schema::v1::KillTerminalRequest;
use agent_client_protocol::schema::v1::PromptResponse;
use agent_client_protocol::schema::v1::ReadTextFileRequest;
use agent_client_protocol::schema::v1::ReleaseTerminalRequest;
use agent_client_protocol::schema::v1::RequestPermissionRequest;
use agent_client_protocol::schema::v1::SessionConfigOptionsCapabilities;
use agent_client_protocol::schema::v1::SessionId;
use agent_client_protocol::schema::v1::SessionNotification;
use agent_client_protocol::schema::v1::TerminalExitStatus;
use agent_client_protocol::schema::v1::TerminalId;
use agent_client_protocol::schema::v1::TerminalOutputRequest;
use agent_client_protocol::schema::v1::WaitForTerminalExitRequest;
use agent_client_protocol::schema::v1::WriteTextFileRequest;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::AgentHandle;
use crate::AgentSpec;
use crate::ElicitationRequest;
use crate::PermissionRequest;
use crate::ProtocolTrace;
use crate::fs;
use crate::terminals::Terminals;

/// Everything an agent sends, in the order the connection received it.
pub enum AgentEvent {
    /// A `session/update` notification.
    SessionUpdate(SessionNotification),
    /// A `session/request_permission` request awaiting an answer.
    PermissionRequested(PermissionRequest),
    /// An `elicitation/create` request awaiting the user.
    ElicitationRequested(ElicitationRequest),
    /// `elicitation/complete`: an accepted URL elicitation's external step finished.
    ElicitationCompleted(ElicitationId),
    /// The response to a prompt sent with [`AgentHandle::prompt`]. Updates
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

/// Which client capabilities this connection offers the agent.
///
/// Only advertised services are answered; the agent must not call the others, and if it
/// does it gets "method not found".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClientOptions {
    pub read_files: bool,
    pub write_files: bool,
    pub terminals: bool,
    /// Form and URL elicitation.
    pub elicitation: bool,
    /// Whether the client can rerun the agent's command interactively for `terminal` sign-in.
    pub terminal_auth: bool,
}

impl Default for ClientOptions {
    fn default() -> Self {
        Self {
            read_files: true,
            write_files: true,
            terminals: true,
            elicitation: true,
            terminal_auth: false,
        }
    }
}

impl ClientOptions {
    pub(crate) fn capabilities(self) -> ClientCapabilities {
        let elicitation = self.elicitation.then(|| {
            ElicitationCapabilities::new()
                .form(ElicitationFormCapabilities::new())
                .url(ElicitationUrlCapabilities::new())
        });
        ClientCapabilities::new()
            .fs(FileSystemCapabilities::new()
                .read_text_file(self.read_files)
                .write_text_file(self.write_files))
            .terminal(self.terminals)
            .auth(AuthCapabilities::new().terminal(self.terminal_auth))
            .elicitation(elicitation)
            .session(
                ClientSessionCapabilities::new().config_options(
                    SessionConfigOptionsCapabilities::new()
                        .boolean(BooleanConfigOptionCapabilities::new()),
                ),
            )
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SpawnError {
    #[error("agent failed to start: {0}")]
    Start(Error),
    #[error("agent exited before the connection was established")]
    Exited,
}

/// One ACP v1 connection to an agent. Dereferences to its [`AgentHandle`].
pub struct AgentConnection {
    handle: AgentHandle,
    shutdown: oneshot::Sender<()>,
    driver: JoinHandle<()>,
}

impl std::ops::Deref for AgentConnection {
    type Target = AgentHandle;

    fn deref(&self) -> &AgentHandle {
        &self.handle
    }
}

impl AgentConnection {
    /// Launch the agent process and connect to it. Nothing is sent until `initialize`.
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
        // A spawned agent's command can be rerun interactively for terminal sign-in.
        let options = ClientOptions {
            terminal_auth: true,
            ..options
        };
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
        let elicitations = events.clone();
        let completions = events.clone();
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
            .on_receive_request(
                async move |request: CreateElicitationRequest, responder, _cx| {
                    if !options.elicitation {
                        return responder.respond_with_error(Error::method_not_found());
                    }
                    // Only the advertised form and URL modes are accepted.
                    if !matches!(
                        request.mode,
                        ElicitationMode::Form(_) | ElicitationMode::Url(_)
                    ) {
                        return responder.respond_with_error(
                            Error::invalid_params().data("unsupported elicitation mode"),
                        );
                    }
                    let pending = ElicitationRequest { request, responder };
                    if let Err(mpsc::error::SendError(AgentEvent::ElicitationRequested(pending))) =
                        elicitations.send(AgentEvent::ElicitationRequested(pending))
                    {
                        return pending.cancel();
                    }
                    Ok(())
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_notification(
                async move |notification: CompleteElicitationNotification, _cx| {
                    let _ = completions.send(AgentEvent::ElicitationCompleted(
                        notification.elicitation_id,
                    ));
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
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
                    handle: AgentHandle::new(cx, options, events, session_dirs),
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

    /// Close the connection, terminate the agent's process group and any commands it started.
    pub async fn shutdown(self) {
        let _ = self.shutdown.send(());
        let _ = self.driver.await;
    }
}
