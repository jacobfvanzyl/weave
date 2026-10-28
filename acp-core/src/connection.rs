use std::collections::BTreeMap;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use agent_client_protocol::AcpAgent;
use agent_client_protocol::Agent;
use agent_client_protocol::Client;
use agent_client_protocol::ConnectTo;
use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use agent_client_protocol::Handled;
use agent_client_protocol::LineDirection;
use agent_client_protocol::RequestCancellation;
use agent_client_protocol::UntypedMessage;
use agent_client_protocol::schema::v1::AuthCapabilities;
use agent_client_protocol::schema::v1::BooleanConfigOptionCapabilities;
use agent_client_protocol::schema::v1::ClientCapabilities;
use agent_client_protocol::schema::v1::ClientSessionCapabilities;
use agent_client_protocol::schema::v1::CompactionCapabilities;
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
use agent_client_protocol::schema::v1::McpError;
use agent_client_protocol::schema::v1::MessageMcpNotification;
use agent_client_protocol::schema::v1::MessageMcpRequest;
use agent_client_protocol::schema::v1::MessageMcpResponse;
use agent_client_protocol::schema::v1::Meta;
use agent_client_protocol::schema::v1::PromptResponse;
use agent_client_protocol::schema::v1::ReadTextFileRequest;
use agent_client_protocol::schema::v1::ReleaseTerminalRequest;
use agent_client_protocol::schema::v1::RequestPermissionRequest;
use agent_client_protocol::schema::v1::SessionConfigOptionsCapabilities;
use agent_client_protocol::schema::v1::SessionId;
use agent_client_protocol::schema::v1::SessionNotification;
use agent_client_protocol::schema::v1::SubagentCapabilities;
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
use crate::RequestKey;
use crate::SteerOutcome;
use crate::Traces;
use crate::fs;
use crate::mcp::McpCall;
use crate::mcp::McpNotifier;
use crate::mcp::McpOutcome;
use crate::mcp::McpProvider;
use crate::subagent_compat;
use crate::terminal_meta;
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
    /// The agent withdrew a pending permission or elicitation request with
    /// `$/cancel_request`; answer it with `withdrawn()` and stop showing it.
    RequestWithdrawn(RequestKey),
    /// The response to a prompt sent with [`AgentHandle::prompt`]. Updates
    /// the agent sent before responding are always delivered first.
    TurnEnded {
        session_id: SessionId,
        result: Result<PromptResponse, Error>,
    },
    /// The answer to a message sent with [`AgentHandle::steer`], with its `tag`. Updates the
    /// agent sent before answering are always delivered first.
    Steered {
        session_id: SessionId,
        tag: u64,
        result: Result<SteerOutcome, Error>,
    },
    /// New output from a command the agent started with `terminal/create`, or from one it
    /// runs itself and reports through the terminal output extension (see `terminal_meta`).
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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ClientOptions {
    pub read_files: bool,
    pub write_files: bool,
    pub terminals: bool,
    /// Form and URL elicitation.
    pub elicitation: bool,
    /// Whether the client can rerun the agent's command interactively for `terminal` sign-in.
    pub terminal_auth: bool,
    /// Context compaction updates (`compaction_update`, `compaction_summary_chunk`), an ACP
    /// Preview feature; without them agents describe compaction in ordinary output.
    pub compaction: bool,
    /// Subagent sessions (`subagent_update`, session-directed messages, and the children's
    /// own updates), from ACP's draft Subagent Sessions RFD; without them agents report
    /// subagent work through the parent session.
    pub subagents: bool,
}

impl Default for ClientOptions {
    fn default() -> Self {
        Self {
            read_files: true,
            write_files: true,
            terminals: true,
            elicitation: true,
            terminal_auth: false,
            compaction: true,
            subagents: true,
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
                ClientSessionCapabilities::new()
                    .config_options(
                        SessionConfigOptionsCapabilities::new()
                            .boolean(BooleanConfigOptionCapabilities::new()),
                    )
                    .compaction(self.compaction.then(CompactionCapabilities::new)),
            )
            .subagents(self.subagents.then(SubagentCapabilities::new))
            .meta(terminal_output_meta())
    }
}

/// `_meta` asking agents for their own commands' output as appended chunks.
fn terminal_output_meta() -> Meta {
    let mut meta = Meta::new();
    meta.insert(terminal_meta::CAPABILITY.to_owned(), true.into());
    meta
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

/// Report a user-facing request as withdrawn if the agent cancels it before it is answered.
async fn watch_withdrawal(
    cancellation: RequestCancellation,
    answered: oneshot::Receiver<()>,
    key: RequestKey,
    events: mpsc::UnboundedSender<AgentEvent>,
) -> Result<(), Error> {
    tokio::select! {
        () = cancellation.cancelled() => {
            let _ = events.send(AgentEvent::RequestWithdrawn(key));
        }
        _ = answered => {}
    }
    Ok(())
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
        // A spawned agent's command can be rerun interactively for terminal sign-in.
        let options = ClientOptions {
            terminal_auth: true,
            ..options
        };
        let traces = Traces::default();
        if let Some(trace) = trace {
            traces.add(0, trace);
        }
        Self::spawn_exactly(spec, Arc::new(traces), options).await
    }

    /// [`Self::spawn`], advertising exactly `options`, and tracing into whatever `traces`
    /// holds as it changes: for the weave Host, which offers an agent what its configuration
    /// offers, terminal sign-in included, and traces for each client that asks.
    pub async fn spawn_exactly(
        spec: &AgentSpec,
        traces: Arc<Traces>,
        options: ClientOptions,
    ) -> Result<(Self, mpsc::UnboundedReceiver<AgentEvent>), SpawnError> {
        let agent = AcpAgent::new(spec.to_config()).with_debug(move |line, direction| {
            if matches!(direction, LineDirection::Stderr) {
                tracing::debug!(target: "agent_stderr", "{line}");
            }
            traces.record(direction, line);
        });
        // Its terminals start in the environment it does.
        Self::connect_in(agent, options, spec.env.clone()).await
    }

    /// Connect over any transport, such as an in-process agent in tests.
    pub async fn connect(
        transport: impl ConnectTo<Client> + 'static,
        options: ClientOptions,
    ) -> Result<(Self, mpsc::UnboundedReceiver<AgentEvent>), SpawnError> {
        Self::connect_in(transport, options, BTreeMap::new()).await
    }

    /// [`Self::connect`], starting the commands the agent runs in client terminals with
    /// `environment` over this process's own: what the agent itself was started with.
    pub async fn connect_in(
        transport: impl ConnectTo<Client> + 'static,
        options: ClientOptions,
        environment: BTreeMap<String, String>,
    ) -> Result<(Self, mpsc::UnboundedReceiver<AgentEvent>), SpawnError> {
        let (events, mut event_rx) = mpsc::unbounded_channel();
        let session_dirs = Arc::new(Mutex::new(HashMap::new()));
        let terminals = Arc::new(Terminals::new(
            events.clone(),
            Arc::clone(&session_dirs),
            environment,
        ));

        let notifications = events.clone();
        let earlier_drafts = events.clone();
        let permissions = events.clone();
        let elicitations = events.clone();
        let keys = Arc::new(AtomicU64::new(1));
        let permission_keys = Arc::clone(&keys);
        let elicitation_keys = keys;
        let completions = events.clone();
        let create = Arc::clone(&terminals);
        let output = Arc::clone(&terminals);
        let wait = Arc::clone(&terminals);
        let kill = Arc::clone(&terminals);
        let release = terminals;
        let providers: Arc<OnceLock<Arc<dyn McpProvider>>> = Arc::new(OnceLock::new());
        let mcp = Arc::clone(&providers);
        let builder = Client
            .builder()
            .name("weave")
            // Before the typed handler, which rejects them: subagent updates in the earlier
            // draft that today's adapters still send, read as the current draft's.
            .on_receive_notification(
                async move |message: UntypedMessage, cx| {
                    let Some(updates) =
                        subagent_compat::translate(&message.method, &message.params)
                    else {
                        return Ok(Handled::No {
                            message: (message, cx),
                            retry: false,
                        });
                    };
                    for notification in updates {
                        let _ = earlier_drafts.send(AgentEvent::SessionUpdate(notification));
                    }
                    Ok(Handled::Yes)
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_notification(
                async move |notification: SessionNotification, _cx| {
                    // Output of commands the agent runs itself arrives in `_meta`; deliver it
                    // first, so a tool call this update finishes already has it.
                    for event in terminal_meta::terminal_events(&notification.update) {
                        let _ = notifications.send(event);
                    }
                    let _ = notifications.send(AgentEvent::SessionUpdate(notification));
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                async move |request: RequestPermissionRequest, responder, cx| {
                    let key = RequestKey(permission_keys.fetch_add(1, Ordering::Relaxed));
                    let (answered, done) = oneshot::channel();
                    let cancellation = responder.cancellation();
                    let pending = PermissionRequest {
                        key,
                        request,
                        responder,
                        _answered: answered,
                    };
                    if let Err(mpsc::error::SendError(AgentEvent::PermissionRequested(pending))) =
                        permissions.send(AgentEvent::PermissionRequested(pending))
                    {
                        // Nobody is listening any more, so nobody can answer.
                        return pending.cancel();
                    }
                    cx.spawn(watch_withdrawal(
                        cancellation,
                        done,
                        key,
                        permissions.clone(),
                    ))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |request: CreateElicitationRequest, responder, cx| {
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
                    let key = RequestKey(elicitation_keys.fetch_add(1, Ordering::Relaxed));
                    let (answered, done) = oneshot::channel();
                    let cancellation = responder.cancellation();
                    let pending = ElicitationRequest {
                        key,
                        request,
                        responder,
                        _answered: answered,
                    };
                    if let Err(mpsc::error::SendError(AgentEvent::ElicitationRequested(pending))) =
                        elicitations.send(AgentEvent::ElicitationRequested(pending))
                    {
                        return pending.cancel();
                    }
                    cx.spawn(watch_withdrawal(
                        cancellation,
                        done,
                        key,
                        elicitations.clone(),
                    ))
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
                    let cancellation = responder.cancellation();
                    cx.spawn(async move {
                        let read = cancellation.run_until_cancelled(fs::read_text_file(request));
                        responder.respond_with_result(read.await)
                    })
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |request: WriteTextFileRequest, responder, cx| {
                    if !options.write_files {
                        return responder.respond_with_error(Error::method_not_found());
                    }
                    let cancellation = responder.cancellation();
                    cx.spawn(async move {
                        let write = cancellation.run_until_cancelled(fs::write_text_file(request));
                        responder.respond_with_result(write.await)
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
                        let cancellation = responder.cancellation();
                        cx.spawn(async move {
                            let exited = cancellation.run_until_cancelled(exited);
                            responder.respond_with_result(exited.await)
                        })
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
            )
            // MCP-over-ACP: a request for an MCP server this client declared with `"type":
            // "acp"`, answered by the provider the connection's owner installed.
            .on_receive_request(
                async move |request: MessageMcpRequest, responder, cx| {
                    let Some(provider) = mcp.get().cloned() else {
                        return responder.respond(MessageMcpResponse::error(McpError::new(
                            -32601,
                            "this client provides no MCP servers",
                        )));
                    };
                    let MessageMcpRequest {
                        server_id,
                        request_id,
                        method,
                        params,
                        ..
                    } = request;
                    let call = McpCall {
                        server: server_id.0.to_string(),
                        request: request_id.0.to_string().into(),
                        method,
                        params,
                    };
                    let agent = cx.clone();
                    let notifier = McpNotifier::new(move |method, params| {
                        let notification = MessageMcpNotification::new(
                            server_id.clone(),
                            request_id.clone(),
                            method,
                        )
                        .params(params);
                        let _ = agent.send_notification(notification);
                    });
                    let cancellation = responder.cancellation();
                    let cancelled = Box::pin(async move { cancellation.cancelled().await });
                    cx.spawn(async move {
                        match provider.call(call, notifier, cancelled).await {
                            McpOutcome::Result(result) => {
                                responder.respond(MessageMcpResponse::success(result))
                            }
                            McpOutcome::Error(error) => {
                                responder.respond(MessageMcpResponse::error(error))
                            }
                            McpOutcome::Cancelled => {
                                responder.respond_with_error(Error::request_cancelled())
                            }
                        }
                    })
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
                    handle: AgentHandle::new(cx, options, events, session_dirs, providers),
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
