//! One client's connection: the Host protocol's requests, answered against the Host's
//! sessions and agents.
//!
//! Session work goes to the open session's task. Requests that need an agent outside any
//! session (`agents/get`, sign-in, listing, deleting) use an open session's agent or a spare
//! one, which the next session for that agent and directory takes.

use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::Ordering;

use agent_client_protocol::ConnectTo;
use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use agent_client_protocol::Role as _;
use tokio::sync::oneshot;
use weave_acp_core::AgentHandle;
use weave_acp_core::ClientOptions;
use weave_acp_core::ProtocolTrace;
use weave_acp_core::ProtocolVersion;
use weave_acp_core::SessionSetup;
use weave_acp_core::schema::AuthMethod;
use weave_acp_core::schema::ConfigOptionUpdate;
use weave_acp_core::schema::CurrentModeUpdate;
use weave_acp_core::schema::InitializeRequest;
use weave_acp_core::schema::InitializeResponse;
use weave_acp_core::schema::Meta;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::SessionInfo;
use weave_acp_core::schema::SessionNotification;
use weave_acp_core::schema::SessionUpdate;
use weave_acp_core::schema::SetSessionConfigOptionResponse;
use weave_acp_core::schema::StopReason;
use weave_host_protocol::Empty;
use weave_host_protocol::Host;
use weave_host_protocol::HostClient;
use weave_host_protocol::PROTOCOL_VERSION;
use weave_host_protocol::VersionRange;
use weave_host_protocol::agents::AgentSource;
use weave_host_protocol::agents::AgentSummary;
use weave_host_protocol::agents::AuthenticateAgentRequest;
use weave_host_protocol::agents::GetAgentRequest;
use weave_host_protocol::agents::GetAgentResponse;
use weave_host_protocol::agents::ListAgentsRequest;
use weave_host_protocol::agents::ListAgentsResponse;
use weave_host_protocol::agents::LogoutAgentRequest;
use weave_host_protocol::agents::TerminalSignInRequest;
use weave_host_protocol::agents::TerminalSignInResponse;
use weave_host_protocol::errors;
use weave_host_protocol::hello::AcpInfo;
use weave_host_protocol::hello::Auth;
use weave_host_protocol::hello::ClientCapabilities;
use weave_host_protocol::hello::ClientInfo;
use weave_host_protocol::hello::HelloRequest;
use weave_host_protocol::hello::HelloResponse;
use weave_host_protocol::hello::HostInfo;
use weave_host_protocol::host::ShutdownRequest;
use weave_host_protocol::host::StatusRequest;
use weave_host_protocol::pending::AnswerPendingRequest;
use weave_host_protocol::policy::PermissionPolicy;
use weave_host_protocol::sessions::AttachSessionRequest;
use weave_host_protocol::sessions::CloseSessionRequest;
use weave_host_protocol::sessions::CloseWhen;
use weave_host_protocol::sessions::CreateSessionRequest;
use weave_host_protocol::sessions::DeleteSessionRequest;
use weave_host_protocol::sessions::DetachSessionRequest;
use weave_host_protocol::sessions::ListSessionsRequest;
use weave_host_protocol::sessions::ListSessionsResponse;
use weave_host_protocol::sessions::RunRequest;
use weave_host_protocol::sessions::RunResponse;
use weave_host_protocol::sessions::SessionAgent;
use weave_host_protocol::sessions::SessionListing;
use weave_host_protocol::sessions::SessionState;
use weave_host_protocol::sessions::SessionStatus;
use weave_host_protocol::sessions::SetConfigOptionRequest;
use weave_host_protocol::sessions::SetModeRequest;
use weave_host_protocol::sessions::TurnOrigin;
use weave_host_protocol::turns::CancelTurnRequest;
use weave_host_protocol::turns::STEER_FEATURE;
use weave_host_protocol::turns::StartTurnRequest;
use weave_host_protocol::turns::StartTurnResponse;
use weave_host_protocol::turns::SteerTurnRequest;
use weave_host_protocol::turns::SteerTurnResponse;

use crate::Agent;
use crate::Shared;
use crate::instance::Instance;
use crate::journal;
use crate::journal::Entry;
use crate::journal::Journal;
use crate::journal::Recorded;
use crate::journal::now_ms;
use crate::modes;
use crate::session;
use crate::session::Answer;
use crate::session::AttachReply;
use crate::session::ClientId;
use crate::session::ClientLink;
use crate::session::Command;
use crate::session::Opened;
use crate::session::ReplayFrom;
use crate::session::SessionHandle;
use crate::session::Snapshot;
use crate::session::Steer;
use crate::session::lock;

/// What a client said at `host/hello`.
#[derive(Clone)]
struct Hello {
    client: ClientInfo,
    capabilities: ClientCapabilities,
}

struct Connection {
    id: ClientId,
    shared: Arc<Shared>,
    hello: Mutex<Option<Hello>>,
    /// Open sessions this client is attached to.
    attached: Mutex<HashSet<SessionId>>,
}

/// A session opened for a client, ready to attach it to.
struct Ready {
    session: SessionHandle,
    notices: Vec<String>,
    trace: Option<PathBuf>,
}

/// Serve one client until it disconnects, then detach it from its sessions.
pub(crate) async fn serve(
    shared: Arc<Shared>,
    transport: impl ConnectTo<Host> + 'static,
) -> Result<(), Error> {
    let connection = Arc::new(Connection {
        id: shared.next_client.fetch_add(1, Ordering::Relaxed),
        shared: Arc::clone(&shared),
        hello: Mutex::new(None),
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
    result
}

/// Answer one request off the dispatch loop, as handlers must not wait inside it.
macro_rules! answer {
    ($connection:expr, $method:ident) => {{
        let connection = Arc::clone(&$connection);
        async move |request,
                    responder: agent_client_protocol::Responder<_>,
                    cx: ConnectionTo<HostClient>| {
            let connection = Arc::clone(&connection);
            cx.spawn(
                async move { responder.respond_with_result(connection.$method(request).await) },
            )
        }
    }};
}

async fn handlers(
    connection: &Arc<Connection>,
    transport: impl ConnectTo<Host> + 'static,
) -> Result<(), Error> {
    let on_hello = Arc::clone(connection);
    let on_status = Arc::clone(connection);
    let on_shutdown = Arc::clone(connection);
    let on_create = Arc::clone(connection);
    let on_attach = Arc::clone(connection);
    Host.builder()
        .name("weave-host")
        .on_receive_request(
            async move |request: HelloRequest, responder, _cx| {
                responder.respond_with_result(on_hello.hello(request))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: StatusRequest, responder, _cx| {
                responder
                    .respond_with_result(on_status.hello_info().map(|_| on_status.shared.status()))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: ShutdownRequest, responder, _cx| {
                on_shutdown.hello_info()?;
                responder.respond(Empty {})?;
                let _ = on_shutdown.shared.stop.send(true);
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, list_agents),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, get_agent),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, authenticate),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, terminal_sign_in),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, logout),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, list_sessions),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: CreateSessionRequest, responder, cx: ConnectionTo<HostClient>| {
                let connection = Arc::clone(&on_create);
                let client = cx.clone();
                cx.spawn(async move {
                    match connection.create(request).await {
                        Ok(ready) => {
                            connection.attach_to(
                                ready,
                                client,
                                ReplayFrom::Start,
                                AttachReply::Created(responder),
                            );
                            Ok(())
                        }
                        Err(error) => responder.respond_with_error(error),
                    }
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: AttachSessionRequest, responder, cx: ConnectionTo<HostClient>| {
                let connection = Arc::clone(&on_attach);
                let client = cx.clone();
                cx.spawn(async move {
                    let from = match &request.after {
                        Some(after) => ReplayFrom::After(after.clone()),
                        None => ReplayFrom::Start,
                    };
                    match connection.open_existing(&request).await {
                        Ok(ready) => {
                            connection.attach_to(
                                ready,
                                client,
                                from,
                                AttachReply::Attached(responder),
                            );
                            Ok(())
                        }
                        Err(error) => responder.respond_with_error(error),
                    }
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, detach),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, close),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, delete),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, set_mode),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, set_config_option),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, start_turn),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, steer_turn),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, cancel_turn),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, answer_pending),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let connection = Arc::clone(connection);
                async move |request: RunRequest, responder, cx: ConnectionTo<HostClient>| {
                    let connection = Arc::clone(&connection);
                    let client = cx.clone();
                    cx.spawn(async move {
                        responder.respond_with_result(connection.run(request, client).await)
                    })
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        // A client from before this protocol speaks ACP to the Host. Telling it the version
        // has it reload into the current weave.
        .on_receive_request(
            async move |_request: InitializeRequest, responder, _cx| {
                responder.respond(legacy_initialize())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_to(transport)
        .await
}

/// What a client from before this protocol reads as "another version".
fn legacy_initialize() -> InitializeResponse {
    let mut meta = Meta::new();
    meta.insert(
        "weave".to_owned(),
        serde_json::json!({
            "protocol": PROTOCOL_VERSION,
            "version": env!("CARGO_PKG_VERSION"),
            "pid": std::process::id(),
        }),
    );
    InitializeResponse::new(ProtocolVersion::V1).meta(meta)
}

/// The services an interactive session's agent is offered: a local client can run its
/// command for terminal sign-in.
fn interactive(options: ClientOptions) -> ClientOptions {
    ClientOptions {
        terminal_auth: true,
        ..options
    }
}

/// Nobody can sign in at a terminal for a headless session.
fn headless(options: ClientOptions) -> ClientOptions {
    ClientOptions {
        terminal_auth: false,
        ..options
    }
}

/// Where agents asked things outside any session start.
fn home() -> PathBuf {
    std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map_or_else(|| PathBuf::from("/"), PathBuf::from)
}

fn summary(agent: &Agent, initialize: Option<&InitializeResponse>) -> AgentSummary {
    let name = initialize
        .and_then(|init| init.agent_info.as_ref())
        .map_or_else(
            || agent.name.clone(),
            |info| info.title.clone().unwrap_or_else(|| info.name.clone()),
        );
    AgentSummary {
        id: agent.id.clone(),
        name,
        source: agent.source,
        version: agent.version.clone(),
        installed: true,
        description: None,
    }
}

impl Connection {
    /// This connection's `clientId`.
    fn client_id(&self) -> String {
        format!("c{}", self.id)
    }

    fn hello_info(&self) -> Result<Hello, Error> {
        lock(&self.hello)
            .clone()
            .ok_or_else(|| errors::unauthenticated("say host/hello first"))
    }

    fn hello(&self, request: HelloRequest) -> Result<HelloResponse, Error> {
        let supported = VersionRange::supported();
        let protocol = request
            .protocol
            .highest_common(supported)
            .ok_or_else(|| errors::incompatible_protocol(supported))?;
        // Every transport there is now is local: the Unix socket, whose peers are checked
        // when they connect, or a channel in the same process.
        match request.auth {
            Auth::Local => {}
            Auth::Token { .. } => {
                return Err(errors::unauthenticated(
                    "tokens are for network connections, which this Host doesn't accept yet",
                ));
            }
        }
        *lock(&self.hello) = Some(Hello {
            client: request.client,
            capabilities: request.capabilities,
        });
        let status = self.shared.status();
        Ok(HelloResponse {
            protocol,
            client_id: self.client_id(),
            host: HostInfo {
                version: status.version,
                pid: status.pid,
                started_at: status.started_at,
            },
            features: vec![STEER_FEATURE.to_owned()],
            acp: AcpInfo {
                protocol_version: 1,
                unstable: vec!["session_compaction".to_owned(), "subagents".to_owned()],
            },
        })
    }

    async fn list_agents(&self, request: ListAgentsRequest) -> Result<ListAgentsResponse, Error> {
        self.hello_info()?;
        let config = self.shared.load_config()?;
        let mut agents: Vec<AgentSummary> = Vec::new();
        let local = |id: &str, source| AgentSummary {
            id: id.to_owned(),
            name: id.to_owned(),
            source,
            version: None,
            installed: true,
            description: None,
        };
        for id in self.shared.config.agents.keys() {
            agents.push(local(id, AgentSource::Config));
        }
        for id in config.known_agents() {
            if agents.iter().any(|agent| agent.id == id) {
                continue;
            }
            let defined = config
                .agents
                .get(&id)
                .is_some_and(|agent| agent.command.is_some());
            let source = if defined {
                AgentSource::Config
            } else {
                AgentSource::Preset
            };
            agents.push(local(&id, source));
        }
        if request.include_registry {
            let cache = self.shared.registry_cache()?;
            let loaded = weave_agents::registry::load(&cache, request.refresh)
                .await
                .map_err(|error| Error::internal_error().data(format!("{error:#}")))?;
            for agent in &loaded.registry.agents {
                if agents.iter().any(|known| known.id == agent.id) {
                    continue;
                }
                agents.push(AgentSummary {
                    id: agent.id.clone(),
                    name: agent.name.clone(),
                    source: AgentSource::Registry,
                    version: Some(agent.version.clone()),
                    installed: weave_agents::registry::is_installed(&cache, agent),
                    description: (!agent.description.is_empty()).then(|| agent.description.clone()),
                });
            }
        }
        Ok(ListAgentsResponse {
            agents,
            default_agent: config.default_agent,
        })
    }

    async fn get_agent(&self, request: GetAgentRequest) -> Result<GetAgentResponse, Error> {
        self.hello_info()?;
        let agent = self.shared.resolve(&request.agent_id).await?;
        let handle = self
            .shared
            .agent_handle(&agent, &home(), interactive(agent.options))
            .await?;
        let initialize = handle
            .agent()
            .cloned()
            .ok_or_else(|| Error::internal_error().data("the agent isn't initialized"))?;
        Ok(GetAgentResponse {
            agent: summary(&agent, Some(&initialize)),
            initialize,
        })
    }

    /// The agents to sign in: the spare ones of `agent`, which the next sessions take, or one
    /// started for it.
    async fn sign_in_handles(&self, agent: &Agent) -> Result<Vec<AgentHandle>, Error> {
        let spares = self.shared.spare_handles(&agent.id);
        if !spares.is_empty() {
            return Ok(spares);
        }
        let handle = self
            .shared
            .agent_handle(agent, &home(), interactive(agent.options))
            .await?;
        Ok(vec![handle])
    }

    async fn authenticate(&self, request: AuthenticateAgentRequest) -> Result<Empty, Error> {
        self.hello_info()?;
        let agent = self.shared.resolve(&request.agent_id).await?;
        let handles = self.sign_in_handles(&agent).await?;
        for handle in handles {
            let terminal = handle.agent().is_some_and(|init| {
                init.auth_methods.iter().any(|method| {
                    matches!(method, AuthMethod::Terminal(terminal) if terminal.id == request.method_id)
                })
            });
            if terminal {
                return Err(errors::requires_terminal());
            }
            handle.authenticate(request.method_id.clone()).await?;
        }
        Ok(Empty {})
    }

    async fn terminal_sign_in(
        &self,
        request: TerminalSignInRequest,
    ) -> Result<TerminalSignInResponse, Error> {
        let hello = self.hello_info()?;
        if !hello.capabilities.terminal_sign_in {
            return Err(errors::requires_terminal());
        }
        let agent = self.shared.resolve(&request.agent_id).await?;
        let handle = self
            .shared
            .agent_handle(&agent, &home(), interactive(agent.options))
            .await?;
        let method = handle
            .agent()
            .and_then(|init| {
                init.auth_methods.iter().find_map(|method| match method {
                    AuthMethod::Terminal(terminal) if terminal.id == request.method_id => {
                        Some(terminal.clone())
                    }
                    _ => None,
                })
            })
            .ok_or_else(|| {
                Error::invalid_params().data(format!(
                    "{} has no terminal sign-in method {}",
                    agent.id, request.method_id
                ))
            })?;
        let login = agent.spec.for_terminal_sign_in(&method);
        self.shared.drop_spares(&agent.id);
        Ok(TerminalSignInResponse {
            command: login.command,
            args: login.args,
            env: login.env,
        })
    }

    async fn logout(&self, request: LogoutAgentRequest) -> Result<Empty, Error> {
        self.hello_info()?;
        let agent = self.shared.resolve(&request.agent_id).await?;
        for handle in self.sign_in_handles(&agent).await? {
            handle.logout().await?;
        }
        Ok(Empty {})
    }

    async fn list_sessions(
        &self,
        request: ListSessionsRequest,
    ) -> Result<ListSessionsResponse, Error> {
        self.hello_info()?;
        match request.agent_id.clone() {
            None => Ok(ListSessionsResponse {
                sessions: self.host_sessions(request.cwd.as_deref()),
                next_cursor: None,
            }),
            Some(agent_id) => self.agent_sessions(&agent_id, request).await,
        }
    }

    /// The sessions the Host has a journal for, across agents, most recently active first.
    fn host_sessions(&self, cwd: Option<&Path>) -> Vec<SessionListing> {
        let registry = self.shared.registry();
        let in_scope = |dir: &Path| cwd.is_none_or(|cwd| cwd == dir);
        let mut sessions: Vec<SessionListing> = registry
            .sessions
            .values()
            .filter(|session| !session.is_blank())
            .map(SessionHandle::summary)
            .filter(|summary| in_scope(&summary.cwd))
            .map(|summary| summary.listing())
            .collect();
        for (session_id, recorded) in &registry.known {
            if registry.sessions.contains_key(session_id) || !in_scope(&recorded.cwd) {
                continue;
            }
            let Some(agent_id) = recorded.agent_id() else {
                continue;
            };
            sessions.push(dormant(session_id, agent_id, recorded));
        }
        sessions.sort_by_key(|listing| std::cmp::Reverse(listing.last_activity_at));
        sessions
    }

    /// `agent_id`'s sessions: the Host's own in the directory first, open ones and then ones
    /// a stopped Host left open within the idle grace of their last activity; then the
    /// agent's own listing, paged by its cursor.
    async fn agent_sessions(
        &self,
        agent_id: &str,
        request: ListSessionsRequest,
    ) -> Result<ListSessionsResponse, Error> {
        let agent = self.shared.resolve(agent_id).await?;
        let cwd = request.cwd.clone().unwrap_or_else(home);
        let handle = self
            .shared
            .agent_handle(&agent, &cwd, interactive(agent.options))
            .await?;
        let listed = handle
            .list_sessions(request.cwd.clone(), request.cursor.clone())
            .await?;
        let in_scope = |dir: &Path| request.cwd.as_deref().is_none_or(|cwd| cwd == dir);
        let grace_ms = u64::try_from(self.shared.config.idle_grace.as_millis()).unwrap_or(u64::MAX);
        let (open, blank, known) = {
            let registry = self.shared.registry();
            let (blank, open): (Vec<&SessionHandle>, Vec<&SessionHandle>) = registry
                .sessions
                .values()
                .partition(|session| session.is_blank());
            let blank: HashSet<SessionId> = blank
                .into_iter()
                .map(|session| session.summary().session_id)
                .collect();
            let open: Vec<session::Summary> =
                open.into_iter().map(SessionHandle::summary).collect();
            (open, blank, registry.known.clone())
        };
        let mut leading: Vec<SessionListing> = open
            .iter()
            .filter(|summary| summary.agent_id == agent.id && in_scope(&summary.cwd))
            .map(session::Summary::listing)
            .collect();
        leading.sort_by_key(|listing| std::cmp::Reverse(listing.last_activity_at));
        let mut dormant_here: Vec<SessionListing> = known
            .iter()
            .filter(|(session_id, recorded)| {
                !recorded.closed
                    && now_ms().saturating_sub(recorded.last_activity_ms) < grace_ms
                    && in_scope(&recorded.cwd)
                    && recorded.agent_id() == Some(agent.id.as_str())
                    && !blank.contains(*session_id)
                    && !open
                        .iter()
                        .any(|summary| summary.session_id == **session_id)
            })
            .map(|(session_id, recorded)| dormant(session_id, &agent.id, recorded))
            .collect();
        dormant_here.sort_by_key(|listing| std::cmp::Reverse(listing.last_activity_at));
        leading.extend(dormant_here);

        let mut sessions = Vec::new();
        let mut agents_own = listed.sessions;
        agents_own.retain(|info| !blank.contains(&info.session_id));
        if request.cursor.is_none() {
            for mut listing in leading.iter().cloned() {
                // The agent may save the title only once a turn ends; the Host has seen it.
                if let Some(index) = agents_own
                    .iter()
                    .position(|info| info.session_id == listing.info.session_id)
                {
                    let info = agents_own.remove(index);
                    let title = listing.info.title.take();
                    listing.info = info;
                    if listing.info.title.is_none() {
                        listing.info.title = title;
                    }
                }
                sessions.push(listing);
            }
        } else {
            agents_own.retain(|info| {
                !leading
                    .iter()
                    .any(|listing| listing.info.session_id == info.session_id)
            });
        }
        for info in agents_own {
            let state = match known.get(&info.session_id) {
                Some(recorded) if !recorded.closed => SessionStatus::Suspended,
                _ => SessionStatus::Closed,
            };
            let open = open
                .iter()
                .find(|summary| summary.session_id == info.session_id);
            let listing = match open {
                Some(summary) => SessionListing {
                    info,
                    ..summary.listing()
                },
                None => SessionListing {
                    headless: known
                        .get(&info.session_id)
                        .is_some_and(|recorded| recorded.policy.is_headless()),
                    last_activity_at: known
                        .get(&info.session_id)
                        .map(|recorded| recorded.last_activity_ms),
                    info,
                    agent_id: agent.id.clone(),
                    state,
                    activity: None,
                    clients: 0,
                },
            };
            sessions.push(listing);
        }
        Ok(ListSessionsResponse {
            sessions,
            next_cursor: listed.next_cursor,
        })
    }

    async fn create(&self, request: CreateSessionRequest) -> Result<Ready, Error> {
        self.hello_info()?;
        let agent = self.shared.resolve(&request.agent_id).await?;
        let instance = self
            .shared
            .instance(&agent, &request.cwd, interactive(agent.options))
            .await?;
        let (setup, mut notices) = setup(
            &agent,
            &instance,
            request.cwd.clone(),
            request.additional_directories,
        );
        let response = match instance.connection.new_session(&setup).await {
            Ok(response) => response,
            Err(error) => {
                self.shared.keep_spare(instance);
                return Err(error);
            }
        };
        let mut snapshot = Snapshot {
            modes: response.modes.clone(),
            config_options: response.config_options.clone().unwrap_or_default(),
        };
        if let Some(mode) = request.mode.or_else(|| agent.mode.clone()) {
            let handle = instance.connection.handle();
            if let Err(notice) =
                modes::start_in(&handle, &response.session_id, &mut snapshot, &mode).await
            {
                notices.push(notice);
            }
        }
        let session = open(
            &self.shared,
            response.session_id,
            instance,
            &agent,
            setup.cwd,
            setup.additional_directories,
            request.policy.unwrap_or_default(),
            snapshot,
            Origin::New,
        )?;
        let trace = self.trace(&session, request.trace)?;
        Ok(Ready {
            session,
            notices,
            trace,
        })
    }

    /// Open a session the client named: attach to it if it's open, otherwise open it in its
    /// agent (from its journal, if a stopped Host left it open).
    async fn open_existing(&self, request: &AttachSessionRequest) -> Result<Ready, Error> {
        self.hello_info()?;
        let session_id = &request.session_id;
        let (live, known) = {
            let registry = self.shared.registry();
            let live = registry.live(session_id);
            let root = live.as_ref().map_or_else(
                || session_id.clone(),
                |session| session.summary().session_id,
            );
            (live, registry.known.get(&root).cloned())
        };
        // A session belongs to the agent it was started with.
        let recorded_agent = live
            .as_ref()
            .map(|session| session.agent_id.clone())
            .or_else(|| {
                known
                    .as_ref()
                    .and_then(Recorded::agent_id)
                    .map(str::to_owned)
            });
        if let (Some(recorded), Some(asked)) = (&recorded_agent, &request.agent_id)
            && recorded != asked
        {
            return Err(errors::wrong_agent(&session_id.to_string(), recorded));
        }
        if let Some(session) = live {
            let trace = self.trace(&session, request.trace)?;
            return Ok(Ready {
                session,
                notices: Vec::new(),
                trace,
            });
        }
        let agent_id = recorded_agent
            .or_else(|| request.agent_id.clone())
            .ok_or_else(|| errors::unknown_session(&session_id.to_string()))?;
        let cwd = known
            .as_ref()
            .map(|recorded| recorded.cwd.clone())
            .or_else(|| request.cwd.clone())
            .ok_or_else(|| errors::unknown_session(&session_id.to_string()))?;
        let agent = self.shared.resolve(&agent_id).await?;
        let instance = self
            .shared
            .instance(&agent, &cwd, interactive(agent.options))
            .await?;
        let (setup, notices) = setup(&agent, &instance, cwd, Vec::new());
        match reopen(
            &self.shared,
            instance,
            session_id.clone(),
            setup,
            &agent,
            PermissionPolicy::ask(),
            true,
        )
        .await
        {
            Ok(session) => {
                let trace = self.trace(&session, request.trace)?;
                Ok(Ready {
                    session,
                    notices,
                    trace,
                })
            }
            Err((error, instance)) => {
                if let Some(instance) = instance {
                    self.shared.keep_spare(instance);
                }
                Err(error)
            }
        }
    }

    /// Trace the session's agent for this client, when it asked.
    fn trace(&self, session: &SessionHandle, wanted: bool) -> Result<Option<PathBuf>, Error> {
        if !wanted {
            return Ok(None);
        }
        let path = self.shared.trace_path(&session.summary().session_id)?;
        let trace = ProtocolTrace::create(&path).map_err(|error| {
            Error::internal_error().data(format!(
                "creating the protocol trace {}: {error}",
                path.display()
            ))
        })?;
        session.traces.add(self.id, trace);
        Ok(Some(path))
    }

    /// Attach this client to `ready`'s session, answering through `reply` before its replay.
    fn attach_to(
        &self,
        ready: Ready,
        cx: ConnectionTo<HostClient>,
        from: ReplayFrom,
        reply: AttachReply,
    ) {
        let session_id = ready.session.summary().session_id;
        lock(&self.attached).insert(session_id);
        let command = Command::Attach {
            client: self.id,
            link: ClientLink { cx },
            from,
            notices: ready.notices,
            trace: ready.trace,
            reply,
        };
        if let Err(tokio::sync::mpsc::error::SendError(Command::Attach { reply, .. })) =
            ready.session.commands.send(command)
        {
            reply.fail(session::ended());
        }
    }

    async fn detach(&self, request: DetachSessionRequest) -> Result<Empty, Error> {
        self.hello_info()?;
        let live = self.shared.registry().live(&request.session_id);
        if let Some(session) = live
            && lock(&self.attached).remove(&session.summary().session_id)
        {
            session.traces.remove(self.id);
            let client = self.id;
            match request.close {
                CloseWhen::Never => session.send(Command::Detach { client })?,
                CloseWhen::IfUnused => {
                    session
                        .finish(|done| Command::Close { client, done })
                        .await?;
                }
            }
        }
        Ok(Empty {})
    }

    async fn close(&self, request: CloseSessionRequest) -> Result<Empty, Error> {
        self.hello_info()?;
        let session = self.live(&request.session_id)?;
        session
            .finish(|done| Command::End {
                reason: "closed by a client".to_owned(),
                done,
            })
            .await?;
        Ok(Empty {})
    }

    async fn delete(&self, request: DeleteSessionRequest) -> Result<Empty, Error> {
        self.hello_info()?;
        let session_id = request.session_id;
        let live = self.shared.registry().live(&session_id);
        let known = self.shared.registry().known.get(&session_id).cloned();
        let agent_id = live
            .as_ref()
            .map(|session| session.agent_id.clone())
            .or_else(|| {
                known
                    .as_ref()
                    .and_then(Recorded::agent_id)
                    .map(str::to_owned)
            })
            .or(request.agent_id)
            .ok_or_else(|| errors::unknown_session(&session_id.to_string()))?;
        if let Some(session) = live {
            let _ = session
                .finish(|done| Command::End {
                    reason: "deleted".to_owned(),
                    done,
                })
                .await;
        }
        let agent = self.shared.resolve(&agent_id).await?;
        let cwd = known
            .as_ref()
            .map_or_else(home, |recorded| recorded.cwd.clone());
        let handle = self
            .shared
            .agent_handle(&agent, &cwd, interactive(agent.options))
            .await?;
        handle.delete_session(session_id.clone()).await?;
        self.shared.registry().known.remove(&session_id);
        if let Some(dir) = &self.shared.config.journals {
            let _ = std::fs::remove_file(journal::path_for(dir, &session_id));
        }
        Ok(Empty {})
    }

    fn live(&self, session_id: &SessionId) -> Result<SessionHandle, Error> {
        self.shared
            .registry()
            .live(session_id)
            .ok_or_else(|| errors::session_not_open(&session_id.to_string()))
    }

    async fn set_mode(&self, request: SetModeRequest) -> Result<Empty, Error> {
        self.hello_info()?;
        let session = self.live(&request.session_id)?;
        session
            .agent
            .set_mode(request.session_id.clone(), request.mode_id.clone())
            .await?;
        let update = SessionUpdate::CurrentModeUpdate(CurrentModeUpdate::new(request.mode_id));
        session.send(Command::Changed {
            notification: Box::new(SessionNotification::new(request.session_id, update)),
        })?;
        Ok(Empty {})
    }

    async fn set_config_option(
        &self,
        request: SetConfigOptionRequest,
    ) -> Result<SetSessionConfigOptionResponse, Error> {
        self.hello_info()?;
        let session = self.live(&request.session_id)?;
        let options = session
            .agent
            .set_config_option(request.session_id.clone(), request.config_id, request.value)
            .await?;
        let update = SessionUpdate::ConfigOptionUpdate(ConfigOptionUpdate::new(options.clone()));
        session.send(Command::Changed {
            notification: Box::new(SessionNotification::new(request.session_id, update)),
        })?;
        Ok(SetSessionConfigOptionResponse::new(options))
    }

    async fn start_turn(&self, request: StartTurnRequest) -> Result<StartTurnResponse, Error> {
        let hello = self.hello_info()?;
        let session = self.live(&request.session_id)?;
        let (reply, started) = oneshot::channel();
        session.send(Command::Prompt {
            origin: TurnOrigin::Client {
                name: hello.client.name,
                id: self.client_id(),
            },
            session_id: request.session_id,
            prompt: request.prompt,
            reply,
        })?;
        let seq = started.await.map_err(|_| session::ended())??;
        Ok(StartTurnResponse { seq })
    }

    async fn steer_turn(&self, request: SteerTurnRequest) -> Result<SteerTurnResponse, Error> {
        let hello = self.hello_info()?;
        let session = self.live(&request.session_id)?;
        let (reply, answered) = oneshot::channel();
        session.send(Command::Steer(Steer {
            origin: TurnOrigin::Client {
                name: hello.client.name,
                id: self.client_id(),
            },
            session_id: request.session_id,
            prompt: request.prompt,
            reply,
        }))?;
        answered.await.map_err(|_| session::ended())?
    }

    async fn cancel_turn(&self, request: CancelTurnRequest) -> Result<Empty, Error> {
        self.hello_info()?;
        let session = self.live(&request.session_id)?;
        session.send(Command::Cancel {
            session_id: request.session_id,
        })?;
        Ok(Empty {})
    }

    async fn answer_pending(&self, request: AnswerPendingRequest) -> Result<Empty, Error> {
        self.hello_info()?;
        let session = self.live(&request.session_id)?;
        let answer = match (request.permission, request.elicitation) {
            (Some(permission), None) => Answer::Permission(permission),
            (None, Some(elicitation)) => Answer::Elicitation(elicitation),
            _ => {
                return Err(Error::invalid_params()
                    .data("answer with exactly one of `permission` and `elicitation`"));
            }
        };
        let (reply, answered) = oneshot::channel();
        session.send(Command::Answer {
            pending_id: request.pending_id,
            by: self.client_id(),
            answer,
            reply,
        })?;
        answered.await.map_err(|_| session::ended())??;
        Ok(Empty {})
    }

    async fn run(
        &self,
        request: RunRequest,
        cx: ConnectionTo<HostClient>,
    ) -> Result<RunResponse, Error> {
        self.hello_info()?;
        let link = request.attach.then(|| (self.id, ClientLink { cx }));
        let attaching = link.is_some();
        let (session_id, state) = run(&self.shared, request, link).await?;
        if attaching {
            lock(&self.attached).insert(session_id.clone());
        }
        Ok(RunResponse {
            session_id,
            state: state.map(Box::new),
        })
    }
}

/// A session a stopped Host left, or one closed since, as listings show it.
fn dormant(session_id: &SessionId, agent_id: &str, recorded: &Recorded) -> SessionListing {
    SessionListing {
        info: SessionInfo::new(session_id.clone(), recorded.cwd.clone()),
        agent_id: agent_id.to_owned(),
        state: if recorded.closed {
            SessionStatus::Closed
        } else {
            SessionStatus::Suspended
        },
        activity: None,
        clients: 0,
        headless: recorded.policy.is_headless(),
        last_activity_at: Some(recorded.last_activity_ms),
    }
}

/// How a session in `cwd` is set up for `instance`'s agent: the configured MCP servers it
/// accepts, and `additional_directories` if it accepts those; with a notice for each left out.
fn setup(
    agent: &Agent,
    instance: &Instance,
    cwd: PathBuf,
    mut additional_directories: Vec<PathBuf>,
) -> (SessionSetup, Vec<String>) {
    let capabilities = instance
        .init()
        .map(|init| init.agent_capabilities.clone())
        .unwrap_or_default();
    let (mcp_servers, mut notices) = agent.config.mcp_servers(&capabilities.mcp_capabilities);
    if !additional_directories.is_empty()
        && capabilities
            .session_capabilities
            .additional_directories
            .is_none()
    {
        notices
            .push("The agent doesn't support extra workspace roots; they were left out".to_owned());
        additional_directories.clear();
    }
    (
        SessionSetup {
            cwd,
            additional_directories,
            mcp_servers,
        },
        notices,
    )
}

/// Open `request`'s session and start its turn; see [`crate::Daemon::run`]. `link` is the
/// requesting client, attached before the prompt goes out so it sees the whole turn.
pub(crate) async fn run(
    shared: &Arc<Shared>,
    request: RunRequest,
    link: Option<(ClientId, ClientLink)>,
) -> Result<(SessionId, Option<SessionState>), Error> {
    let RunRequest {
        agent_id,
        cwd,
        session_id,
        additional_directories,
        prompt,
        policy,
        attach: _,
        trace,
    } = request;
    let agent = shared.resolve(&agent_id).await?;
    let options = headless(agent.options);
    let live = session_id
        .as_ref()
        .and_then(|session_id| shared.registry().live(session_id));
    let mut notices = Vec::new();
    let session = match (live, session_id) {
        // An open session keeps its own policy.
        (Some(session), _) => session,
        (None, Some(session_id)) => {
            let instance = shared.instance(&agent, &cwd, options).await?;
            let (setup, more) = setup(&agent, &instance, cwd, additional_directories);
            notices = more;
            match reopen(shared, instance, session_id, setup, &agent, policy, false).await {
                Ok(session) => session,
                Err((error, instance)) => {
                    if let Some(instance) = instance {
                        instance.connection.shutdown().await;
                    }
                    return Err(error);
                }
            }
        }
        (None, None) => {
            let instance = shared.instance(&agent, &cwd, options).await?;
            let (setup, more) = setup(&agent, &instance, cwd, additional_directories);
            notices = more;
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
                &agent,
                setup.cwd,
                setup.additional_directories,
                policy,
                snapshot,
                Origin::New,
            )?
        }
    };
    let root = session.summary().session_id;
    let owner = link.as_ref().map_or(0, |(client, _)| *client);
    let trace = if trace {
        let path = shared.trace_path(&root)?;
        let trace = ProtocolTrace::create(&path).map_err(|error| {
            Error::internal_error().data(format!(
                "creating the protocol trace {}: {error}",
                path.display()
            ))
        })?;
        // For the attached client while it's there; for a run nobody attaches to, for good.
        session.traces.add(owner, trace);
        Some(path)
    } else {
        None
    };
    let state = match link {
        Some((client, link)) => {
            let (reply, attached) = oneshot::channel();
            session.send(Command::Attach {
                client,
                link,
                from: ReplayFrom::Now,
                notices,
                trace,
                reply: AttachReply::Run(reply),
            })?;
            Some(attached.await.map_err(|_| session::ended())?)
        }
        None => None,
    };
    let (reply, started) = oneshot::channel();
    session.send(Command::Prompt {
        origin: TurnOrigin::Run {},
        session_id: root.clone(),
        prompt,
        reply,
    })?;
    started.await.map_err(|_| session::ended())??;
    Ok((root, state))
}

/// Open a session the Host doesn't have open in `instance`: resume it from the journal a
/// stopped Host left, or reopen it in the agent, loading it when `replay` asks for its
/// history and there's no journal to show instead. On failure the agent comes back, unless
/// it's gone.
async fn reopen(
    shared: &Arc<Shared>,
    mut instance: Instance,
    session_id: SessionId,
    setup: SessionSetup,
    agent: &Agent,
    policy: PermissionPolicy,
    replay: bool,
) -> Result<SessionHandle, (Error, Option<Instance>)> {
    let recovered = recoverable(shared, &session_id);
    let capabilities = instance
        .init()
        .map(|init| init.agent_capabilities.clone())
        .unwrap_or_default();
    let can_resume = capabilities.session_capabilities.resume.is_some();
    let can_load = capabilities.load_session;
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
        Some((path, records)) => {
            let policy = records
                .iter()
                .find_map(|record| match &record.entry {
                    Entry::Header { policy, .. } => Some(policy.clone()),
                    _ => None,
                })
                .unwrap_or(policy);
            let open_turns = journal::open_turns(&records);
            let mut journal = match Journal::reopen(&path, records) {
                Ok(journal) => journal,
                Err(error) => return Err((journal_error(&error), Some(instance))),
            };
            // A turn the stopped Host was running ended with it.
            for session_id in open_turns {
                journal.append(Entry::turn_ended(
                    session_id,
                    &Ok(weave_acp_core::schema::PromptResponse::new(
                        StopReason::Cancelled,
                    )),
                ));
            }
            (Some(journal), policy)
        }
        None => (None, policy),
    };
    match open(
        shared,
        session_id,
        instance,
        agent,
        setup.cwd,
        setup.additional_directories,
        policy,
        snapshot,
        Origin::Reopened(journal),
    ) {
        Ok(session) => Ok(session),
        Err(error) => Err((error, None)),
    }
}

/// The journal a stopped Host left for `session_id` while it was open.
fn recoverable(shared: &Shared, session_id: &SessionId) -> Option<(PathBuf, Vec<journal::Record>)> {
    let path = journal::path_for(shared.config.journals.as_ref()?, session_id);
    let records = journal::read(&path).ok()?;
    (!records.is_empty() && !journal::is_closed(&records)).then_some((path, records))
}

/// Where a session [`open`] starts came from.
enum Origin {
    /// `session/create` or a new run: the session is blank until it's prompted.
    New,
    /// The agent's session reopened, with the journal a stopped Host left, if there is one.
    Reopened(Option<Journal>),
}

#[allow(clippy::too_many_arguments)]
fn open(
    shared: &Arc<Shared>,
    session_id: SessionId,
    instance: Instance,
    agent: &Agent,
    cwd: PathBuf,
    additional_directories: Vec<PathBuf>,
    policy: PermissionPolicy,
    snapshot: Snapshot,
    origin: Origin,
) -> Result<SessionHandle, Error> {
    let (journal, blank) = match origin {
        Origin::New => (None, true),
        Origin::Reopened(journal) => (journal, false),
    };
    let journal = match journal {
        Some(journal) => journal,
        None => {
            let header = Entry::header(
                session_id.clone(),
                agent.spec.clone(),
                &agent.id,
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
    let initialize = instance
        .init()
        .cloned()
        .unwrap_or_else(|| InitializeResponse::new(ProtocolVersion::V1));
    let session_agent = SessionAgent {
        name: summary(agent, Some(&initialize)).name,
        id: agent.id.clone(),
        initialize,
    };
    Ok(session::start(
        shared,
        Opened {
            session_id,
            instance,
            agent: session_agent,
            journal,
            policy,
            snapshot,
            cwd,
            additional_directories,
            blank,
        },
    ))
}

fn journal_error(error: &std::io::Error) -> Error {
    Error::internal_error().data(format!("the session journal: {error}"))
}
