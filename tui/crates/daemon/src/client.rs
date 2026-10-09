//! One client's connection: the daemon as the ACP agent the client talks to, standing in for
//! the agents it runs.
//!
//! Session work goes to the live session's task. A client also gets a spare agent of its own,
//! started when it first needs one (to answer `initialize`, sign in, or list sessions) and
//! taken by the first session it opens; reattaching to a live session starts nothing.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::Ordering;

use agent_client_protocol::Agent;
use agent_client_protocol::Client;
use agent_client_protocol::ConnectTo;
use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use agent_client_protocol::Responder;
use tokio::sync::mpsc::error::SendError;
use tokio::sync::oneshot;
use weave_acp_core::AgentHandle;
use weave_acp_core::ClientOptions;
use weave_acp_core::ProtocolTrace;
use weave_acp_core::ProtocolVersion;
use weave_acp_core::SessionSetup;
use weave_acp_core::Traces;
use weave_acp_core::daemon_protocol;
use weave_acp_core::daemon_protocol::AgentChoice;
use weave_acp_core::daemon_protocol::ClientHello;
use weave_acp_core::daemon_protocol::DaemonStatus;
use weave_acp_core::daemon_protocol::EndSessionRequest;
use weave_acp_core::daemon_protocol::EndSessionResponse;
use weave_acp_core::daemon_protocol::Launch;
use weave_acp_core::daemon_protocol::ListedSession;
use weave_acp_core::daemon_protocol::LiveSession;
use weave_acp_core::daemon_protocol::OpenedSession;
use weave_acp_core::daemon_protocol::PROTOCOL_VERSION;
use weave_acp_core::daemon_protocol::PermissionPolicy;
use weave_acp_core::daemon_protocol::RunRequest;
use weave_acp_core::daemon_protocol::RunResponse;
use weave_acp_core::daemon_protocol::SessionOptions;
use weave_acp_core::daemon_protocol::ShutdownRequest;
use weave_acp_core::daemon_protocol::ShutdownResponse;
use weave_acp_core::daemon_protocol::StatusRequest;
use weave_acp_core::schema::AuthenticateRequest;
use weave_acp_core::schema::AuthenticateResponse;
use weave_acp_core::schema::CancelNotification;
use weave_acp_core::schema::ClientCapabilities;
use weave_acp_core::schema::CloseSessionRequest;
use weave_acp_core::schema::CloseSessionResponse;
use weave_acp_core::schema::ConfigOptionUpdate;
use weave_acp_core::schema::CurrentModeUpdate;
use weave_acp_core::schema::DeleteSessionRequest;
use weave_acp_core::schema::DeleteSessionResponse;
use weave_acp_core::schema::Implementation;
use weave_acp_core::schema::InitializeRequest;
use weave_acp_core::schema::InitializeResponse;
use weave_acp_core::schema::ListSessionsRequest;
use weave_acp_core::schema::ListSessionsResponse;
use weave_acp_core::schema::LoadSessionRequest;
use weave_acp_core::schema::LoadSessionResponse;
use weave_acp_core::schema::LogoutRequest;
use weave_acp_core::schema::LogoutResponse;
use weave_acp_core::schema::NewSessionRequest;
use weave_acp_core::schema::NewSessionResponse;
use weave_acp_core::schema::PromptRequest;
use weave_acp_core::schema::PromptResponse;
use weave_acp_core::schema::ResumeSessionRequest;
use weave_acp_core::schema::ResumeSessionResponse;
use weave_acp_core::schema::SessionCloseCapabilities;
use weave_acp_core::schema::SessionConfigOption;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::SessionInfo;
use weave_acp_core::schema::SessionNotification;
use weave_acp_core::schema::SessionUpdate;
use weave_acp_core::schema::SetSessionConfigOptionRequest;
use weave_acp_core::schema::SetSessionConfigOptionResponse;
use weave_acp_core::schema::SetSessionModeRequest;
use weave_acp_core::schema::SetSessionModeResponse;
use weave_acp_core::schema::StopReason;

use crate::Shared;
use crate::hello;
use crate::instance::Instance;
use crate::instance::LaunchKey;
use crate::journal;
use crate::journal::Entry;
use crate::journal::Journal;
use crate::journal::Recorded;
use crate::session;
use crate::session::ClientId;
use crate::session::Command;
use crate::session::Opened;
use crate::session::Reply;
use crate::session::SessionHandle;
use crate::session::Snapshot;
use crate::session::lock;

/// What a client asked for at `initialize`.
#[derive(Clone)]
struct Hello {
    launch: Launch,
    options: ClientOptions,
}

struct Connection {
    id: ClientId,
    shared: Arc<Shared>,
    hello: Mutex<Option<Hello>>,
    /// An agent started for this client that no session has taken yet.
    spare: tokio::sync::Mutex<Option<Instance>>,
    /// Live sessions this client is attached to.
    attached: Mutex<HashSet<SessionId>>,
}

/// Serve one client until it disconnects, then detach it from its sessions.
pub(crate) async fn serve(
    shared: Arc<Shared>,
    transport: impl ConnectTo<Agent> + 'static,
) -> Result<(), Error> {
    let connection = Arc::new(Connection {
        id: shared.next_client.fetch_add(1, Ordering::Relaxed),
        shared: Arc::clone(&shared),
        hello: Mutex::new(None),
        spare: tokio::sync::Mutex::new(None),
        attached: Mutex::new(HashSet::new()),
    });
    shared.registry().clients += 1;
    let result = handlers(&connection, transport).await;
    shared.registry().clients -= 1;
    let attached: Vec<SessionId> = lock(&connection.attached).drain().collect();
    for session_id in attached {
        if let Some(session) = shared.registry().live(&session_id) {
            session.traces.remove(connection.id);
            let _ = session.send(Command::Detach {
                client: connection.id,
            });
        }
    }
    if let Some(spare) = connection.spare.lock().await.take() {
        spare.connection.shutdown().await;
    }
    result
}

async fn handlers(
    connection: &Arc<Connection>,
    transport: impl ConnectTo<Agent> + 'static,
) -> Result<(), Error> {
    let on_initialize = Arc::clone(connection);
    let on_authenticate = Arc::clone(connection);
    let on_logout = Arc::clone(connection);
    let on_new = Arc::clone(connection);
    let on_load = Arc::clone(connection);
    let on_resume = Arc::clone(connection);
    let on_list = Arc::clone(connection);
    let on_close = Arc::clone(connection);
    let on_delete = Arc::clone(connection);
    let on_prompt = Arc::clone(connection);
    let on_cancel = Arc::clone(connection);
    let on_mode = Arc::clone(connection);
    let on_config = Arc::clone(connection);
    let on_status = Arc::clone(connection);
    let on_shutdown = Arc::clone(connection);
    let on_run = Arc::clone(connection);
    let on_end = Arc::clone(connection);
    // Handlers run inside the dispatch loop, so anything that waits moves to a task.
    Agent
        .builder()
        .name("weave-daemon")
        .on_receive_request(
            async move |request: InitializeRequest, responder, cx: ConnectionTo<Client>| {
                let connection = Arc::clone(&on_initialize);
                cx.spawn(async move {
                    responder.respond_with_result(connection.initialize(request).await)
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: AuthenticateRequest, responder, cx: ConnectionTo<Client>| {
                let connection = Arc::clone(&on_authenticate);
                cx.spawn(async move {
                    let result = connection.authenticate(request).await;
                    responder.respond_with_result(result)
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: LogoutRequest, responder, cx: ConnectionTo<Client>| {
                let connection = Arc::clone(&on_logout);
                cx.spawn(async move { responder.respond_with_result(connection.logout().await) })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: NewSessionRequest, responder, cx: ConnectionTo<Client>| {
                let connection = Arc::clone(&on_new);
                let client = cx.clone();
                cx.spawn(async move {
                    responder.respond_with_result(connection.new_session(client, request).await)
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: LoadSessionRequest, responder, cx: ConnectionTo<Client>| {
                let connection = Arc::clone(&on_load);
                let client = cx.clone();
                cx.spawn(async move {
                    let setup = SessionSetup {
                        cwd: request.cwd,
                        additional_directories: request.additional_directories,
                        mcp_servers: request.mcp_servers,
                    };
                    let result = connection
                        .open_existing(client, request.session_id, setup, true)
                        .await
                        .map(|(snapshot, cwd)| {
                            LoadSessionResponse::new()
                                .modes(snapshot.modes)
                                .config_options(config_options(snapshot.config_options))
                                .meta(daemon_protocol::meta(&OpenedSession { cwd }))
                        });
                    responder.respond_with_result(result)
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: ResumeSessionRequest, responder, cx: ConnectionTo<Client>| {
                let connection = Arc::clone(&on_resume);
                let client = cx.clone();
                cx.spawn(async move {
                    let setup = SessionSetup {
                        cwd: request.cwd,
                        additional_directories: request.additional_directories,
                        mcp_servers: request.mcp_servers,
                    };
                    let result = connection
                        .open_existing(client, request.session_id, setup, false)
                        .await
                        .map(|(snapshot, cwd)| {
                            ResumeSessionResponse::new()
                                .modes(snapshot.modes)
                                .config_options(config_options(snapshot.config_options))
                                .meta(daemon_protocol::meta(&OpenedSession { cwd }))
                        });
                    responder.respond_with_result(result)
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: ListSessionsRequest, responder, cx: ConnectionTo<Client>| {
                let connection = Arc::clone(&on_list);
                cx.spawn(
                    async move { responder.respond_with_result(connection.list(request).await) },
                )
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: CloseSessionRequest, responder, cx: ConnectionTo<Client>| {
                let connection = Arc::clone(&on_close);
                cx.spawn(async move {
                    responder.respond_with_result(connection.close(request.session_id).await)
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: DeleteSessionRequest, responder, cx: ConnectionTo<Client>| {
                let connection = Arc::clone(&on_delete);
                cx.spawn(async move {
                    responder.respond_with_result(connection.delete(request.session_id).await)
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: PromptRequest, responder, _cx| {
                on_prompt.prompt(request, responder);
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_notification(
            async move |notification: CancelNotification, _cx| {
                if let Some(session) = on_cancel.shared.registry().live(&notification.session_id) {
                    let _ = session.send(Command::Cancel {
                        session_id: notification.session_id,
                    });
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: SetSessionModeRequest, responder, cx: ConnectionTo<Client>| {
                let connection = Arc::clone(&on_mode);
                cx.spawn(async move {
                    responder.respond_with_result(connection.set_mode(request).await)
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: SetSessionConfigOptionRequest,
                        responder,
                        cx: ConnectionTo<Client>| {
                let connection = Arc::clone(&on_config);
                cx.spawn(async move {
                    responder.respond_with_result(connection.set_config_option(request).await)
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: StatusRequest, responder, _cx| {
                responder.respond(status(&on_status.shared))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: ShutdownRequest, responder, _cx| {
                responder.respond(ShutdownResponse {})?;
                let _ = on_shutdown.shared.stop.send(true);
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: RunRequest, responder, cx: ConnectionTo<Client>| {
                let connection = Arc::clone(&on_run);
                let client = cx.clone();
                cx.spawn(async move {
                    let attach = request.attach.then(|| (connection.id, client));
                    let attaching = attach.is_some();
                    let result = run(&connection.shared, request, attach).await;
                    if attaching && let Ok(session_id) = &result {
                        lock(&connection.attached).insert(session_id.clone());
                    }
                    responder
                        .respond_with_result(result.map(|session_id| RunResponse { session_id }))
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: EndSessionRequest, responder, cx: ConnectionTo<Client>| {
                let shared = Arc::clone(&on_end.shared);
                cx.spawn(async move {
                    responder.respond_with_result(end_session(&shared, &request.session_id).await)
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_to(transport)
        .await
}

/// Close a live session for every client.
async fn end_session(shared: &Shared, session_id: &SessionId) -> Result<EndSessionResponse, Error> {
    let session = shared
        .registry()
        .live(session_id)
        .ok_or_else(|| Error::invalid_params().data("the session isn't open in the daemon"))?;
    session
        .finish(|done| Command::End {
            reason: "closed from the command line".to_owned(),
            done,
        })
        .await?;
    Ok(EndSessionResponse {})
}

impl Connection {
    fn hello(&self) -> Result<Hello, Error> {
        lock(&self.hello).clone().ok_or_else(|| {
            Error::invalid_request().data("this connection didn't name an agent to launch")
        })
    }

    async fn initialize(&self, request: InitializeRequest) -> Result<InitializeResponse, Error> {
        let options = options_from(&request.client_capabilities);
        let client: Option<ClientHello> = daemon_protocol::read_meta(request.meta.as_ref());
        if let Some(client) = &client
            && client.protocol != PROTOCOL_VERSION
        {
            tracing::warn!(
                client = client.protocol,
                "a client speaks another extension version"
            );
        }
        let Some(launch) = client.and_then(|client| client.launch) else {
            // Only managing the daemon.
            return Ok(InitializeResponse::new(ProtocolVersion::V1)
                .agent_info(Implementation::new(
                    "weave-daemon",
                    env!("CARGO_PKG_VERSION"),
                ))
                .meta(daemon_protocol::meta(&hello())));
        };
        let key = LaunchKey::new(&launch, options);
        *lock(&self.hello) = Some(Hello { launch, options });
        let known = self.shared.registry().initialized.get(&key).cloned();
        let init = match known {
            Some(init) => init,
            None => {
                let mut spare = self.spare().await?;
                let init = spare
                    .as_mut()
                    .and_then(|instance| instance.init().cloned())
                    .ok_or_else(|| Error::internal_error().data("the agent isn't initialized"))?;
                self.shared.registry().initialized.insert(key, init.clone());
                init
            }
        };
        Ok(as_daemon(init))
    }

    /// The client's spare agent, started if there isn't one.
    async fn spare(&self) -> Result<tokio::sync::MutexGuard<'_, Option<Instance>>, Error> {
        let mut spare = self.spare.lock().await;
        if spare.is_none() {
            let hello = self.hello()?;
            let instance =
                Instance::start(&self.shared.config.launcher, &hello.launch, hello.options).await?;
            self.trace_into(&instance.traces)?;
            *spare = Some(instance);
        }
        Ok(spare)
    }

    /// Trace an agent's protocol for this client while it's attached, if it asked to.
    fn trace_into(&self, traces: &Traces) -> Result<(), Error> {
        let Some(path) = lock(&self.hello)
            .as_ref()
            .and_then(|hello| hello.launch.trace.clone())
        else {
            return Ok(());
        };
        let trace = ProtocolTrace::create(&path).map_err(|error| {
            Error::internal_error().data(format!(
                "creating the protocol trace {}: {error}",
                path.display()
            ))
        })?;
        traces.add(self.id, trace);
        Ok(())
    }

    async fn take_spare(&self) -> Result<Instance, Error> {
        self.spare()
            .await?
            .take()
            .ok_or_else(|| Error::internal_error().data("no agent"))
    }

    /// Keep an agent a session didn't take, as after `auth_required`, for the retry.
    async fn keep_spare(&self, instance: Instance) {
        let mut spare = self.spare.lock().await;
        match spare.as_ref() {
            Some(_) => instance.connection.shutdown().await,
            None => *spare = Some(instance),
        }
    }

    async fn authenticate(
        &self,
        request: AuthenticateRequest,
    ) -> Result<AuthenticateResponse, Error> {
        let agent = self.spare_handle().await?;
        agent.authenticate(request.method_id).await?;
        Ok(AuthenticateResponse::new())
    }

    async fn logout(&self) -> Result<LogoutResponse, Error> {
        let agent = self.spare_handle().await?;
        agent.logout().await?;
        Ok(LogoutResponse::new())
    }

    async fn spare_handle(&self) -> Result<AgentHandle, Error> {
        self.spare()
            .await?
            .as_ref()
            .map(|instance| instance.connection.handle())
            .ok_or_else(|| Error::internal_error().data("no agent"))
    }

    /// An agent to list or delete sessions with: the spare, or one a live session of the same
    /// agent runs, before starting another.
    async fn any_agent(&self) -> Result<AgentHandle, Error> {
        let hello = self.hello()?;
        if let Some(spare) = self.spare.lock().await.as_ref() {
            return Ok(spare.connection.handle());
        }
        let key = LaunchKey::new(&hello.launch, hello.options);
        let live = self
            .shared
            .registry()
            .sessions
            .values()
            .find(|session| session.key == key)
            .map(|session| session.agent.clone());
        match live {
            Some(agent) => Ok(agent),
            None => self.spare_handle().await,
        }
    }

    async fn new_session(
        &self,
        cx: ConnectionTo<Client>,
        request: NewSessionRequest,
    ) -> Result<NewSessionResponse, Error> {
        let hello = self.hello()?;
        let options: SessionOptions =
            daemon_protocol::read_meta(request.meta.as_ref()).unwrap_or_default();
        let setup = SessionSetup {
            cwd: request.cwd,
            additional_directories: request.additional_directories,
            mcp_servers: request.mcp_servers,
        };
        let instance = self.take_spare().await?;
        let response = match instance.connection.new_session(&setup).await {
            Ok(response) => response,
            Err(error) => {
                self.keep_spare(instance).await;
                return Err(error);
            }
        };
        let snapshot = Snapshot {
            modes: response.modes.clone(),
            config_options: response.config_options.clone().unwrap_or_default(),
        };
        let session = open(
            &self.shared,
            response.session_id.clone(),
            instance,
            &hello.launch,
            setup.cwd,
            options.policy,
            snapshot,
            None,
        )?;
        self.attach(&session, cx, false).await?;
        Ok(response)
    }

    /// Load or resume a session: attach to it if it's live, otherwise open it in an agent
    /// (from its journal, if a stopped daemon left it live).
    async fn open_existing(
        &self,
        cx: ConnectionTo<Client>,
        session_id: SessionId,
        setup: SessionSetup,
        replay: bool,
    ) -> Result<(Snapshot, PathBuf), Error> {
        let hello = self.hello()?;
        let (live, known) = {
            let registry = self.shared.registry();
            let live = registry.live(&session_id);
            let root = live.as_ref().map_or_else(
                || session_id.clone(),
                |session| session.summary().session_id,
            );
            (live, registry.known.get(&root).cloned())
        };
        // A session belongs to the agent it was started with.
        if let Some(recorded) = &known
            && !same_agent(recorded, &hello.launch)
        {
            let agent = recorded
                .choice
                .as_ref()
                .map_or_else(|| recorded.agent.display_command(), AgentChoice::describe);
            return Err(Error::invalid_params().data(format!(
                "session {session_id} runs with {agent}, not this agent"
            )));
        }
        if let Some(session) = live {
            let cwd = session.summary().cwd;
            return Ok((self.attach(&session, cx, replay).await?, cwd));
        }
        let instance = self.take_spare().await?;
        match reopen(
            &self.shared,
            instance,
            session_id,
            setup,
            &hello.launch,
            PermissionPolicy::ask(),
            replay,
        )
        .await
        {
            // A recovered session's history comes from its journal; an agent's replay is
            // already queued and reaches the client as the session's first events.
            Ok((session, recovered)) => {
                let cwd = session.summary().cwd;
                Ok((self.attach(&session, cx, recovered && replay).await?, cwd))
            }
            Err((error, instance)) => {
                if let Some(instance) = instance {
                    self.keep_spare(instance).await;
                }
                Err(error)
            }
        }
    }

    async fn attach(
        &self,
        session: &SessionHandle,
        cx: ConnectionTo<Client>,
        replay: bool,
    ) -> Result<Snapshot, Error> {
        // Traced from here on, even when another client's agent started untraced.
        self.trace_into(&session.traces)?;
        let snapshot = session.attach(self.id, cx, replay).await?;
        lock(&self.attached).insert(session.summary().session_id);
        Ok(snapshot)
    }

    async fn list(&self, request: ListSessionsRequest) -> Result<ListSessionsResponse, Error> {
        let hello = self.hello()?;
        let agent = self.any_agent().await?;
        let mut response = agent
            .list_sessions(request.cwd.clone(), request.cursor.clone())
            .await?;
        let in_scope = |cwd: &PathBuf| request.cwd.as_ref().is_none_or(|listed| listed == cwd);
        let (mut live, known) = {
            let registry = self.shared.registry();
            let live: Vec<LiveSession> = registry
                .sessions
                .values()
                .map(SessionHandle::summary)
                .collect();
            (live, registry.known.clone())
        };
        live.sort_by_key(|session| std::cmp::Reverse(session.last_activity_ms));
        // This agent's sessions the daemon has in the listed directory lead the first page,
        // whatever order the agent keeps: open ones, then ones a stopped daemon left open, the
        // most recently active first. `--continue` takes the first that isn't headless.
        // Later pages leave them out.
        let mut leading: Vec<(SessionId, PathBuf, Option<String>, ListedSession)> = live
            .iter()
            .filter(|session| {
                in_scope(&session.cwd)
                    && known
                        .get(&session.session_id)
                        .is_some_and(|recorded| same_agent(recorded, &hello.launch))
            })
            .map(|session| {
                let listed = ListedSession {
                    activity: Some(session.activity),
                    clients: session.clients,
                    headless: session.policy.is_headless(),
                };
                (
                    session.session_id.clone(),
                    session.cwd.clone(),
                    session.title.clone(),
                    listed,
                )
            })
            .collect();
        let mut dormant: Vec<(&SessionId, &Recorded)> = known
            .iter()
            .filter(|(session_id, recorded)| {
                !recorded.closed
                    && in_scope(&recorded.cwd)
                    && same_agent(recorded, &hello.launch)
                    && !live
                        .iter()
                        .any(|session| session.session_id == **session_id)
            })
            .collect();
        dormant.sort_by_key(|(_, recorded)| std::cmp::Reverse(recorded.last_activity_ms));
        leading.extend(dormant.into_iter().map(|(session_id, recorded)| {
            let listed = ListedSession {
                headless: recorded.policy.is_headless(),
                ..ListedSession::default()
            };
            (session_id.clone(), recorded.cwd.clone(), None, listed)
        }));
        let mut listed = std::mem::take(&mut response.sessions);
        if request.cursor.is_none() {
            for (session_id, cwd, title, meta) in leading {
                let mut info = match listed.iter().position(|info| info.session_id == session_id) {
                    Some(index) => listed.remove(index),
                    // The agent may save a session only once it's used.
                    None => SessionInfo::new(session_id, cwd),
                };
                // It may save the title only once a turn ends; the daemon has seen it already.
                if info.title.is_none() {
                    info.title = title;
                }
                annotate(&mut info, &meta);
                response.sessions.push(info);
            }
        } else {
            listed.retain(|info| {
                !leading
                    .iter()
                    .any(|(session_id, ..)| *session_id == info.session_id)
            });
        }
        for mut info in listed {
            let live = live
                .iter()
                .find(|session| session.session_id == info.session_id);
            let meta = match (live, known.get(&info.session_id)) {
                (Some(session), _) => Some(ListedSession {
                    activity: Some(session.activity),
                    clients: session.clients,
                    headless: session.policy.is_headless(),
                }),
                (None, Some(recorded)) if recorded.policy.is_headless() => Some(ListedSession {
                    headless: true,
                    ..ListedSession::default()
                }),
                _ => None,
            };
            if let Some(meta) = meta {
                annotate(&mut info, &meta);
            }
            response.sessions.push(info);
        }
        Ok(response)
    }

    /// This client is done with the session; it closes if nothing else needs it.
    async fn close(&self, session_id: SessionId) -> Result<CloseSessionResponse, Error> {
        let live = self.shared.registry().live(&session_id);
        if let Some(session) = live
            && lock(&self.attached).remove(&session.summary().session_id)
        {
            session.traces.remove(self.id);
            let client = self.id;
            session
                .finish(|done| Command::Close { client, done })
                .await?;
        }
        Ok(CloseSessionResponse::new())
    }

    async fn delete(&self, session_id: SessionId) -> Result<DeleteSessionResponse, Error> {
        let live = self.shared.registry().live(&session_id);
        if let Some(session) = live {
            let _ = session
                .finish(|done| Command::End {
                    reason: "deleted".to_owned(),
                    done,
                })
                .await;
        }
        let agent = self.any_agent().await?;
        agent.delete_session(session_id.clone()).await?;
        self.shared.registry().known.remove(&session_id);
        if let Some(dir) = &self.shared.config.journals {
            let _ = std::fs::remove_file(journal::path_for(dir, &session_id));
        }
        Ok(DeleteSessionResponse::new())
    }

    fn prompt(&self, request: PromptRequest, responder: Responder<PromptResponse>) {
        let reply = Reply::Responder(responder);
        let Some(session) = self.shared.registry().live(&request.session_id) else {
            reply.fail(Error::invalid_params().data("the session isn't open; load it first"));
            return;
        };
        let command = Command::Prompt {
            client: Some(self.id),
            session_id: request.session_id,
            prompt: request.prompt,
            reply,
        };
        if let Err(SendError(Command::Prompt { reply, .. })) = session.commands.send(command) {
            reply.fail(Error::invalid_request().data("the session has ended"));
        }
    }

    async fn set_mode(
        &self,
        request: SetSessionModeRequest,
    ) -> Result<SetSessionModeResponse, Error> {
        let session = self.live(&request.session_id)?;
        session
            .agent
            .set_mode(request.session_id.clone(), request.mode_id.clone())
            .await?;
        let update = SessionUpdate::CurrentModeUpdate(CurrentModeUpdate::new(request.mode_id));
        self.changed(&session, request.session_id, update);
        Ok(SetSessionModeResponse::new())
    }

    async fn set_config_option(
        &self,
        request: SetSessionConfigOptionRequest,
    ) -> Result<SetSessionConfigOptionResponse, Error> {
        let session = self.live(&request.session_id)?;
        let options = session
            .agent
            .set_config_option(request.session_id.clone(), request.config_id, request.value)
            .await?;
        let update = SessionUpdate::ConfigOptionUpdate(ConfigOptionUpdate::new(options.clone()));
        self.changed(&session, request.session_id, update);
        Ok(SetSessionConfigOptionResponse::new(options))
    }

    fn live(&self, session_id: &SessionId) -> Result<SessionHandle, Error> {
        self.shared
            .registry()
            .live(session_id)
            .ok_or_else(|| Error::invalid_params().data("the session isn't open; load it first"))
    }

    /// Tell the session's other clients about a change this one made.
    fn changed(&self, session: &SessionHandle, session_id: SessionId, update: SessionUpdate) {
        let _ = session.send(Command::Changed {
            client: self.id,
            notification: Box::new(SessionNotification::new(session_id, update)),
        });
    }
}

/// Open `request`'s session and start its turn; see [`crate::Daemon::run`]. `attach` is the
/// requesting client, attached before the prompt goes out so it sees the whole turn.
pub(crate) async fn run(
    shared: &Arc<Shared>,
    request: RunRequest,
    attach: Option<(ClientId, ConnectionTo<Client>)>,
) -> Result<SessionId, Error> {
    let RunRequest {
        launch,
        session_id,
        additional_directories,
        mcp_servers,
        prompt,
        policy,
        attach: _,
    } = request;
    let setup = SessionSetup {
        cwd: launch.cwd.clone(),
        additional_directories,
        mcp_servers,
    };
    // Nobody can sign in at a terminal for a headless session.
    let options = ClientOptions {
        terminal_auth: false,
        ..ClientOptions::default()
    };
    let live = session_id
        .as_ref()
        .and_then(|session_id| shared.registry().live(session_id));
    let session = match (live, session_id) {
        // A live session keeps its own policy.
        (Some(session), _) => session,
        (None, Some(session_id)) => {
            let instance = Instance::start(&shared.config.launcher, &launch, options).await?;
            match reopen(shared, instance, session_id, setup, &launch, policy, false).await {
                Ok((session, _)) => session,
                Err((error, instance)) => {
                    if let Some(instance) = instance {
                        instance.connection.shutdown().await;
                    }
                    return Err(error);
                }
            }
        }
        (None, None) => {
            let instance = Instance::start(&shared.config.launcher, &launch, options).await?;
            let response = match instance.connection.new_session(&setup).await {
                Ok(response) => response,
                Err(error) => {
                    instance.connection.shutdown().await;
                    return Err(error);
                }
            };
            let snapshot = Snapshot {
                modes: response.modes,
                config_options: response.config_options.unwrap_or_default(),
            };
            open(
                shared,
                response.session_id,
                instance,
                &launch,
                setup.cwd,
                policy,
                snapshot,
                None,
            )?
        }
    };
    let root = session.summary().session_id;
    if let Some(path) = &launch.trace {
        // For the attached client while it's there; for a run nobody attaches to, for good.
        let owner = attach.as_ref().map_or(0, |(client, _)| *client);
        let trace = ProtocolTrace::create(path).map_err(|error| {
            Error::internal_error().data(format!(
                "creating the protocol trace {}: {error}",
                path.display()
            ))
        })?;
        session.traces.add(owner, trace);
    }
    if let Some((client, cx)) = attach {
        session.attach(client, cx, false).await?;
    }
    let (started, sent) = oneshot::channel();
    session.send(Command::Prompt {
        client: None,
        session_id: root.clone(),
        prompt,
        reply: Reply::Started(started),
    })?;
    sent.await
        .map_err(|_| Error::invalid_request().data("the session has ended"))??;
    Ok(root)
}

/// Open a session the daemon doesn't have live in `instance`: resume it from the journal a
/// stopped daemon left, or reopen it in the agent, loading it when `replay` asks for its
/// history. Returns whether it was recovered from a journal. On failure the agent comes back,
/// unless it's gone.
async fn reopen(
    shared: &Arc<Shared>,
    mut instance: Instance,
    session_id: SessionId,
    setup: SessionSetup,
    launch: &Launch,
    policy: PermissionPolicy,
    replay: bool,
) -> Result<(SessionHandle, bool), (Error, Option<Instance>)> {
    let recovered = recoverable(shared, &session_id);
    let capabilities = instance
        .init()
        .map(|init| init.agent_capabilities.clone())
        .unwrap_or_default();
    let can_resume = capabilities.session_capabilities.resume.is_some();
    let can_load = capabilities.load_session;
    // The agent's replay is wanted only when there's no journal to show instead.
    let wants_replay = replay && recovered.is_none();
    let load = if wants_replay {
        can_load
    } else {
        can_load && !can_resume
    };
    let opened = if load {
        instance
            .connection
            .load_session(session_id.clone(), &setup)
            .await
            .map(|response| (response.modes, response.config_options))
    } else if can_resume {
        instance
            .connection
            .resume_session(session_id.clone(), &setup)
            .await
            .map(|response| (response.modes, response.config_options))
    } else {
        Err(Error::method_not_found().data("the agent can't reopen sessions"))
    };
    let (modes, config_options) = match opened {
        Ok(opened) => opened,
        Err(error) => return Err((error, Some(instance))),
    };
    if load && !wants_replay {
        instance.discard_queued_events();
    }
    let snapshot = Snapshot {
        modes,
        config_options: config_options.unwrap_or_default(),
    };
    let (journal, policy) = match recovered {
        Some((path, entries)) => {
            let policy = entries
                .iter()
                .find_map(|entry| match entry {
                    Entry::Header { policy, .. } => Some(policy.clone()),
                    _ => None,
                })
                .unwrap_or(policy);
            let open_turns = journal::open_turns(&entries);
            let mut journal = match Journal::reopen(&path, entries) {
                Ok(journal) => journal,
                Err(error) => return Err((journal_error(&error), Some(instance))),
            };
            // A turn the stopped daemon was running ended with it.
            for session_id in open_turns {
                journal.append(Entry::TurnEnded {
                    session_id,
                    stop_reason: Some(StopReason::Cancelled),
                    error: None,
                });
            }
            (Some(journal), policy)
        }
        None => (None, policy),
    };
    let was_recovered = journal.is_some();
    match open(
        shared, session_id, instance, launch, setup.cwd, policy, snapshot, journal,
    ) {
        Ok(session) => Ok((session, was_recovered)),
        Err(error) => Err((error, None)),
    }
}

/// The journal a stopped daemon left for `session_id` while it was live.
fn recoverable(shared: &Shared, session_id: &SessionId) -> Option<(PathBuf, Vec<Entry>)> {
    let path = journal::path_for(shared.config.journals.as_ref()?, session_id);
    let entries = journal::read(&path).ok()?;
    (!entries.is_empty() && !journal::is_closed(&entries)).then_some((path, entries))
}

#[allow(clippy::too_many_arguments)]
fn open(
    shared: &Arc<Shared>,
    session_id: SessionId,
    instance: Instance,
    launch: &Launch,
    cwd: PathBuf,
    policy: PermissionPolicy,
    snapshot: Snapshot,
    journal: Option<Journal>,
) -> Result<SessionHandle, Error> {
    let journal = match journal {
        Some(journal) => journal,
        None => {
            let header = Entry::header(
                session_id.clone(),
                launch.spec.clone(),
                launch.choice.clone(),
                cwd.clone(),
                policy.clone(),
            );
            match &shared.config.journals {
                Some(dir) => Journal::create(dir, &session_id, header)
                    .map_err(|error| journal_error(&error))?,
                None => Journal::memory(header),
            }
        }
    };
    Ok(session::start(
        shared,
        Opened {
            session_id,
            instance,
            journal,
            policy,
            snapshot,
            cwd,
            agent: launch.spec.display_command(),
            choice: launch.choice.clone(),
        },
    ))
}

fn journal_error(error: &std::io::Error) -> Error {
    Error::internal_error().data(format!("the session journal: {error}"))
}

pub(crate) fn status(shared: &Shared) -> DaemonStatus {
    let hello = hello();
    let mut sessions: Vec<_> = shared
        .registry()
        .sessions
        .values()
        .map(SessionHandle::summary)
        .collect();
    sessions.sort_by_key(|session| session.started_at_ms);
    DaemonStatus {
        protocol: hello.protocol,
        version: hello.version,
        pid: hello.pid,
        started_at_ms: shared.started_ms,
        sessions,
    }
}

/// An agent's `initialize` answer as the daemon gives it: the daemon can load and close any
/// session it has live, whatever the agent supports, and says which daemon it is.
fn as_daemon(mut init: InitializeResponse) -> InitializeResponse {
    init.agent_capabilities.load_session = true;
    init.agent_capabilities.session_capabilities.close = Some(SessionCloseCapabilities::new());
    let mut meta = init.meta.take().unwrap_or_default();
    meta.extend(daemon_protocol::meta(&hello()));
    init.meta = Some(meta);
    init
}

/// What a client offers, so the daemon offers its agents the same.
fn options_from(capabilities: &ClientCapabilities) -> ClientOptions {
    ClientOptions {
        read_files: capabilities.fs.read_text_file,
        write_files: capabilities.fs.write_text_file,
        terminals: capabilities.terminal,
        elicitation: capabilities.elicitation.is_some(),
        terminal_auth: capabilities.auth.terminal,
        compaction: capabilities
            .session
            .as_ref()
            .is_some_and(|session| session.compaction.is_some()),
        subagents: capabilities.subagents.is_some(),
    }
}

fn config_options(options: Vec<SessionConfigOption>) -> Option<Vec<SessionConfigOption>> {
    (!options.is_empty()).then_some(options)
}

fn annotate(info: &mut SessionInfo, listed: &ListedSession) {
    let mut meta = info.meta.take().unwrap_or_default();
    meta.extend(daemon_protocol::meta(listed));
    info.meta = Some(meta);
}

/// Whether a recorded session belongs to the agent `launch` starts: the same choice when both
/// say how the agent was chosen (so a preset's new version still matches), else the same
/// command.
fn same_agent(recorded: &Recorded, launch: &Launch) -> bool {
    match (&recorded.choice, &launch.choice) {
        (Some(recorded), Some(launched)) => recorded == launched,
        _ => recorded.agent == launch.spec,
    }
}
