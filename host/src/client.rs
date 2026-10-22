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
use weave_host_protocol::agents::UPDATES_FEATURE;
use weave_host_protocol::agents::UpdateAgentRequest;
use weave_host_protocol::agents::UpdateAgentResponse;
use weave_host_protocol::devices::DEVICES_FEATURE;
use weave_host_protocol::devices::DeviceInfo;
use weave_host_protocol::devices::ListDevicesRequest;
use weave_host_protocol::devices::ListDevicesResponse;
use weave_host_protocol::devices::OfferDeviceRequest;
use weave_host_protocol::devices::OfferDeviceResponse;
use weave_host_protocol::devices::RevokeDeviceRequest;
use weave_host_protocol::errors;
use weave_host_protocol::files::LIST_FEATURE as LIST_FILES_FEATURE;
use weave_host_protocol::files::ListFilesRequest;
use weave_host_protocol::files::ListFilesResponse;
use weave_host_protocol::hello::AcpInfo;
use weave_host_protocol::hello::Auth;
use weave_host_protocol::hello::ChallengeRequest;
use weave_host_protocol::hello::ChallengeResponse;
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
use weave_host_protocol::sessions::RENAME_FEATURE;
use weave_host_protocol::sessions::RenameSessionRequest;
use weave_host_protocol::sessions::ReopenSessionRequest;
use weave_host_protocol::sessions::ReopenSessionResponse;
use weave_host_protocol::sessions::RunRequest;
use weave_host_protocol::sessions::RunResponse;
use weave_host_protocol::sessions::SessionListing;
use weave_host_protocol::sessions::SessionRemovedNotification;
use weave_host_protocol::sessions::SessionState;
use weave_host_protocol::sessions::SessionStatus;
use weave_host_protocol::sessions::SetConfigOptionRequest;
use weave_host_protocol::sessions::SetModeRequest;
use weave_host_protocol::sessions::TurnOrigin;
use weave_host_protocol::sessions::UnwatchSessionsRequest;
use weave_host_protocol::sessions::WATCH_FEATURE;
use weave_host_protocol::sessions::WatchSessionsRequest;
use weave_host_protocol::sessions::WatchSessionsResponse;
use weave_host_protocol::tools::CLIENT_TOOLS_FEATURE;
use weave_host_protocol::tools::Tool;
use weave_host_protocol::tools::catalog;
use weave_host_protocol::tools::host_catalog;
use weave_host_protocol::turns::CancelTurnRequest;
use weave_host_protocol::turns::STEER_FEATURE;
use weave_host_protocol::turns::StartTurnRequest;
use weave_host_protocol::turns::StartTurnResponse;
use weave_host_protocol::turns::SteerTurnRequest;
use weave_host_protocol::turns::SteerTurnResponse;
use weave_host_protocol::websocket::CLOSE_REVOKED;
use weave_host_protocol::websocket::CLOSE_UNAUTHENTICATED;

use crate::Agent;
use crate::Shared;
use crate::devices::Closer;
use crate::files;
use crate::instance::Instance;
use crate::journal;
use crate::journal::Entry;
use crate::journal::Journal;
use crate::journal::Recorded;
use crate::journal::now_ms;
use crate::mcp::Binding;
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
use crate::updates;
use crate::websocket::Link;

/// What a client said at `host/hello`.
#[derive(Clone)]
struct Hello {
    client: ClientInfo,
    capabilities: ClientCapabilities,
}

/// Where a connection comes from.
enum Peer {
    /// The Unix socket, whose peers are checked when they connect, or the same process.
    Local,
    /// The WebSocket: a remote client, which proves a paired device at hello.
    Remote(Arc<Link>),
}

struct Connection {
    id: ClientId,
    shared: Arc<Shared>,
    peer: Peer,
    hello: Mutex<Option<Hello>>,
    /// The paired device a remote client proved at hello.
    device: Mutex<Option<DeviceInfo>>,
    /// Open sessions this client is attached to.
    attached: Mutex<HashSet<SessionId>>,
}

/// A session opened for a client, ready to attach it to.
struct Ready {
    session: SessionHandle,
    notices: Vec<String>,
    trace: Option<PathBuf>,
}

/// Serve one local client until it disconnects, then detach it from its sessions.
pub(crate) async fn serve(
    shared: Arc<Shared>,
    transport: impl ConnectTo<Host> + 'static,
) -> Result<(), Error> {
    serve_as(shared, transport, Peer::Local).await
}

/// Serve one WebSocket client, which has to prove a paired device at hello.
pub(crate) async fn serve_remote(
    shared: Arc<Shared>,
    transport: impl ConnectTo<Host> + 'static,
    link: Arc<Link>,
) -> Result<(), Error> {
    serve_as(shared, transport, Peer::Remote(link)).await
}

async fn serve_as(
    shared: Arc<Shared>,
    transport: impl ConnectTo<Host> + 'static,
    peer: Peer,
) -> Result<(), Error> {
    let connection = Arc::new(Connection {
        id: shared.next_client.fetch_add(1, Ordering::Relaxed),
        shared: Arc::clone(&shared),
        peer,
        hello: Mutex::new(None),
        device: Mutex::new(None),
        attached: Mutex::new(HashSet::new()),
    });
    shared.registry().clients += 1;
    let result = handlers(&connection, transport).await;
    shared.registry().clients -= 1;
    shared.unwatch(connection.id);
    if let Some(device) = lock(&connection.device).take() {
        shared.devices.disconnected(&device.id, connection.id);
    }
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
    let on_challenge = Arc::clone(connection);
    let on_offer = Arc::clone(connection);
    let on_devices = Arc::clone(connection);
    let on_revoke = Arc::clone(connection);
    let on_status = Arc::clone(connection);
    let on_shutdown = Arc::clone(connection);
    let on_create = Arc::clone(connection);
    let on_watch = Arc::clone(connection);
    let on_unwatch = Arc::clone(connection);
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
            async move |_request: ChallengeRequest, responder, _cx| {
                responder.respond_with_result(on_challenge.challenge())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: OfferDeviceRequest, responder, cx: ConnectionTo<HostClient>| {
                responder.respond_with_result(on_offer.offer_device(request, cx).await)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: ListDevicesRequest, responder, _cx| {
                responder.respond_with_result(on_devices.local_hello().map(|_| {
                    ListDevicesResponse {
                        devices: on_devices.shared.devices.list(),
                    }
                }))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: RevokeDeviceRequest, responder, _cx| {
                let revoked = on_revoke.local_hello().and_then(|_| {
                    on_revoke
                        .shared
                        .devices
                        .revoke(&request.device_id, CLOSE_REVOKED)
                        .map(|()| Empty {})
                });
                // The last device gone turns remote access off (ADR 0016).
                if revoked.is_ok() {
                    let shared = &on_revoke.shared;
                    shared.remote.stop_if_unused(shared).await;
                }
                responder.respond_with_result(revoked)
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
                if let Err(error) = on_shutdown.local_hello() {
                    return responder.respond_with_error(error);
                }
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
            answer!(connection, update_agent),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, list_sessions),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, list_files),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: WatchSessionsRequest, responder, cx: ConnectionTo<HostClient>| {
                if let Err(error) = on_watch.hello_info() {
                    return responder.respond_with_error(error);
                }
                on_watch.shared.watch(on_watch.id, cx, |sessions| {
                    responder.respond(WatchSessionsResponse { sessions })
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: UnwatchSessionsRequest, responder, _cx| {
                on_unwatch.shared.unwatch(on_unwatch.id);
                responder.respond(Empty {})
            },
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
            answer!(connection, reopen_session),
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
            answer!(connection, rename_session),
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
pub(crate) fn home() -> PathBuf {
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

    /// The client tools the client said at hello that it runs.
    fn client_tools(&self) -> Arc<[String]> {
        lock(&self.hello).as_ref().map_or_else(
            || Arc::from(Vec::new()),
            |hello| Arc::from(hello.capabilities.client_tools.as_slice()),
        )
    }

    fn hello_info(&self) -> Result<Hello, Error> {
        lock(&self.hello)
            .clone()
            .ok_or_else(|| errors::unauthenticated("say host/hello first"))
    }

    /// The client's hello, if it's local: remote clients may not administer the Host.
    fn local_hello(&self) -> Result<Hello, Error> {
        let hello = self.hello_info()?;
        match self.peer {
            Peer::Local => Ok(hello),
            Peer::Remote(_) => Err(errors::forbidden()),
        }
    }

    /// The name of the device a remote client proved, for its turns' origins.
    fn device_name(&self) -> Option<String> {
        lock(&self.device)
            .as_ref()
            .map(|device| device.name.clone())
    }

    fn hello(&self, request: HelloRequest) -> Result<HelloResponse, Error> {
        let supported = VersionRange::supported();
        let protocol = request
            .protocol
            .highest_common(supported)
            .ok_or_else(|| errors::incompatible_protocol(supported))?;
        let device = self.identify(request.auth)?;
        let mut capabilities = request.capabilities;
        if let (Some(device), Peer::Remote(link)) = (&device, &self.peer) {
            // Only local clients may run a sign-in command on the Host's computer.
            capabilities.terminal_sign_in = false;
            let mut current = lock(&self.device);
            if let Some(previous) = current.take() {
                self.shared.devices.disconnected(&previous.id, self.id);
            }
            link.proved();
            let closer: Arc<dyn Closer> = Arc::clone(link) as Arc<dyn Closer>;
            self.shared.devices.connected(&device.id, self.id, closer);
            *current = Some(device.clone());
        }
        *lock(&self.hello) = Some(Hello {
            client: request.client,
            capabilities,
        });
        let status = self.shared.status();
        Ok(HelloResponse {
            protocol,
            client_id: self.client_id(),
            host: HostInfo {
                id: self.shared.devices.host_id(),
                version: status.version,
                pid: status.pid,
                started_at: status.started_at,
            },
            features: vec![
                STEER_FEATURE.to_owned(),
                DEVICES_FEATURE.to_owned(),
                UPDATES_FEATURE.to_owned(),
                CLIENT_TOOLS_FEATURE.to_owned(),
                WATCH_FEATURE.to_owned(),
                LIST_FILES_FEATURE.to_owned(),
                RENAME_FEATURE.to_owned(),
            ],
            acp: AcpInfo {
                protocol_version: 1,
                unstable: vec!["session_compaction".to_owned(), "subagents".to_owned()],
            },
            device,
        })
    }

    /// Who the connection is, by where it comes from and what it says: nobody in particular
    /// for a local client, and the device it proves for a remote one. A remote client that
    /// proves none is closed after the error.
    fn identify(&self, auth: Auth) -> Result<Option<DeviceInfo>, Error> {
        let Peer::Remote(link) = &self.peer else {
            return match auth {
                Auth::Local => Ok(None),
                Auth::Token { .. } => Err(errors::unauthenticated("tokens aren't accepted")),
                Auth::Device { .. } | Auth::Pair { .. } => Err(errors::unauthenticated(
                    "devices connect over the Host's WebSocket",
                )),
            };
        };
        let device = match auth {
            Auth::Device {
                device_id,
                signature,
            } => link
                .take_challenge()
                .and_then(|nonce| self.shared.devices.verify(&device_id, &nonce, &signature)),
            Auth::Pair { code, device } => self.shared.devices.pair(&code, device),
            Auth::Local | Auth::Token { .. } => None,
        };
        if device.is_none() {
            tracing::info!("refused a remote client's hello");
            link.close_after_next(CLOSE_UNAUTHENTICATED);
            return Err(errors::unauthenticated(
                "this device couldn't be authenticated",
            ));
        }
        Ok(device)
    }

    /// `host/challenge`, for a remote client to sign at hello.
    fn challenge(&self) -> Result<ChallengeResponse, Error> {
        let Peer::Remote(link) = &self.peer else {
            return Err(errors::unauthenticated(
                "challenges are for the Host's WebSocket",
            ));
        };
        let (nonce, expires_at) = link.challenge();
        Ok(ChallengeResponse {
            host_id: self.shared.devices.host_id(),
            nonce,
            expires_at,
        })
    }

    /// `devices/offer`: a code `weave pair` shows, and this connection is told who takes it.
    /// It turns remote access on (ADR 0016), and back off once the offer expires if no device
    /// took one.
    async fn offer_device(
        &self,
        request: OfferDeviceRequest,
        cx: ConnectionTo<HostClient>,
    ) -> Result<OfferDeviceResponse, Error> {
        self.local_hello()?;
        let settings = self.shared.config.remote.as_ref();
        let url = match settings {
            Some(_) => Some(self.shared.remote.start(&self.shared).await?),
            None => None,
        };
        let lifetime = settings.map_or(
            std::time::Duration::from_millis(crate::devices::OFFER_LIFETIME_MS),
            |settings| settings.offer_lifetime,
        );
        let lifetime_ms = u64::try_from(lifetime.as_millis()).unwrap_or(u64::MAX);
        let (code, expires_at) = self
            .shared
            .devices
            .offer(request.name, Some(cx), lifetime_ms);
        if settings.is_some() {
            let shared = Arc::clone(&self.shared);
            tokio::spawn(async move {
                tokio::time::sleep(lifetime + std::time::Duration::from_millis(100)).await;
                shared.remote.stop_if_unused(&shared).await;
            });
        }
        Ok(OfferDeviceResponse {
            code,
            expires_at,
            url,
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
            let mut summary = local(&id, AgentSource::Config);
            if let Some(preset) = weave_acp_core::Preset::find(&id).filter(|_| !defined) {
                summary.source = AgentSource::Preset;
                summary.version = Some(config.lock.version_of(preset));
            }
            agents.push(summary);
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
        self.local_hello()?;
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
        let hello = self.local_hello()?;
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

    /// `agents/update`: local clients only, as it changes what the Host launches.
    async fn update_agent(
        &self,
        request: UpdateAgentRequest,
    ) -> Result<UpdateAgentResponse, Error> {
        self.local_hello()?;
        let version = updates::update(&self.shared, &request.agent_id).await?;
        Ok(UpdateAgentResponse { version })
    }

    async fn logout(&self, request: LogoutAgentRequest) -> Result<Empty, Error> {
        self.local_hello()?;
        let agent = self.shared.resolve(&request.agent_id).await?;
        for handle in self.sign_in_handles(&agent).await? {
            handle.logout().await?;
        }
        Ok(Empty {})
    }

    /// `files/list`, off the dispatch loop's thread: a slow disk shouldn't hold it up.
    async fn list_files(&self, request: ListFilesRequest) -> Result<ListFilesResponse, Error> {
        self.hello_info()?;
        let home = home();
        tokio::task::spawn_blocking(move || files::list(&request, &home))
            .await
            .map_err(|error| Error::internal_error().data(error.to_string()))?
    }

    async fn list_sessions(
        &self,
        request: ListSessionsRequest,
    ) -> Result<ListSessionsResponse, Error> {
        self.hello_info()?;
        match request.agent_id.clone() {
            None => Ok(ListSessionsResponse {
                sessions: self.shared.listings(request.cwd.as_deref()),
                next_cursor: None,
            }),
            Some(agent_id) => self.agent_sessions(&agent_id, request).await,
        }
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
                    // The Host's title: the agent may save its own only once a turn ends, and
                    // one the session was renamed to is the session's.
                    if title.is_some() {
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
        let (setup, mut notices, binding) = setup(
            &self.shared,
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
            binding,
        )?;
        let trace = self.trace(&session, request.trace)?;
        updates::look_for_update(&self.shared, &session);
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
            updates::look_for_update(&self.shared, &session);
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
        let (setup, notices, binding) = setup(&self.shared, &agent, &instance, cwd, Vec::new());
        match reopen(
            &self.shared,
            instance,
            session_id.clone(),
            setup,
            binding,
            &agent,
            PermissionPolicy::ask(),
            true,
        )
        .await
        {
            Ok(session) => {
                let trace = self.trace(&session, request.trace)?;
                updates::look_for_update(&self.shared, &session);
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
            link: ClientLink {
                cx,
                client_tools: self.client_tools(),
            },
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

    /// `session/reopen`: answered once the session runs in its new process, after any turn.
    async fn reopen_session(
        &self,
        request: ReopenSessionRequest,
    ) -> Result<ReopenSessionResponse, Error> {
        self.hello_info()?;
        let session = self.live(&request.session_id)?;
        let (reply, reopened) = oneshot::channel();
        session.send(Command::Reopen { reply })?;
        reopened.await.map_err(|_| session::ended())?
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
        let cwd = known
            .as_ref()
            .map_or_else(home, |recorded| recorded.cwd.clone());
        // The agent's part runs it in the session's directory. One that's gone, as a removed
        // worktree, leaves the agent its own history of the session; the Host forgets it anyway.
        if cwd.is_dir() {
            self.delete_in_agent(&agent_id, &cwd, &session_id).await?;
        } else {
            tracing::info!(%session_id, cwd = %cwd.display(), "deleting a session whose directory is gone; its agent keeps its history");
        }
        self.shared.registry().known.remove(&session_id);
        if let Some(dir) = &self.shared.config.journals {
            let _ = std::fs::remove_file(journal::path_for(dir, &session_id));
        }
        self.shared
            .tell_watchers(&SessionRemovedNotification { session_id });
        Ok(Empty {})
    }

    /// Delete a session in its agent, run in `cwd`, when the agent can delete sessions; one that
    /// can't keeps its own history of it.
    async fn delete_in_agent(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &SessionId,
    ) -> Result<(), Error> {
        let agent = self.shared.resolve(agent_id).await?;
        let handle = self
            .shared
            .agent_handle(&agent, cwd, interactive(agent.options))
            .await?;
        let deletes = handle.agent().is_some_and(|agent| {
            agent
                .agent_capabilities
                .session_capabilities
                .delete
                .is_some()
        });
        if deletes {
            handle.delete_session(session_id.clone()).await?;
        }
        Ok(())
    }

    fn live(&self, session_id: &SessionId) -> Result<SessionHandle, Error> {
        self.shared
            .registry()
            .live(session_id)
            .ok_or_else(|| errors::session_not_open(&session_id.to_string()))
    }

    /// `session/rename`: a title of the Host's, which the session keeps.
    async fn rename_session(&self, request: RenameSessionRequest) -> Result<Empty, Error> {
        let hello = self.hello_info()?;
        let title =
            session::title(&request.title).map_err(|why| Error::invalid_params().data(why))?;
        let session = self.live(&request.session_id)?;
        let by = TurnOrigin::Client {
            name: hello.client.name,
            id: self.client_id(),
            device: self.device_name(),
        };
        session
            .finish(|done| Command::Rename {
                title,
                by: Some(by),
                done,
            })
            .await?;
        Ok(Empty {})
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
                device: self.device_name(),
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
                device: self.device_name(),
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
        let answer = match (request.permission, request.elicitation, request.client_tool) {
            (Some(permission), None, None) => Answer::Permission(permission),
            (None, Some(elicitation), None) => Answer::Elicitation(elicitation),
            (None, None, Some(result)) => Answer::ClientTool(result),
            _ => {
                return Err(Error::invalid_params().data(
                    "answer with exactly one of `permission`, `elicitation` and `clientTool`",
                ));
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
        let link = request.attach.then(|| {
            let client_tools = self.client_tools();
            (self.id, ClientLink { cx, client_tools })
        });
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
pub(crate) fn dormant(
    session_id: &SessionId,
    agent_id: &str,
    recorded: &Recorded,
) -> SessionListing {
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
/// accepts, the Host MCP server, and `additional_directories` if it accepts those; with a
/// notice for each left out, and the Host MCP server's declaration for the session to keep.
pub(crate) fn setup(
    shared: &Arc<Shared>,
    agent: &Agent,
    instance: &Instance,
    cwd: PathBuf,
    mut additional_directories: Vec<PathBuf>,
) -> (SessionSetup, Vec<String>, Option<Binding>) {
    let capabilities = instance
        .init()
        .map(|init| init.agent_capabilities.clone())
        .unwrap_or_default();
    let (mut mcp_servers, mut notices) = agent.config.mcp_servers(&capabilities.mcp_capabilities);
    let binding = match shared.mcp.declare(
        client_tools(agent),
        host_tools(agent),
        &capabilities.mcp_capabilities,
        &shared.config.mcp_bridge,
    ) {
        Ok((server, binding)) => {
            mcp_servers.push(server);
            Some(binding)
        }
        Err(why) => {
            notices.push(format!("weave's tools are unavailable: {why}"));
            None
        }
    };
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
        binding,
    )
}

/// The client tools `agent` is offered: the catalog, less what its configuration leaves out.
fn client_tools(agent: &Agent) -> Vec<Tool> {
    let chosen = agent.config.client_tools(&agent.id);
    catalog()
        .into_iter()
        .filter(|tool| chosen.is_none_or(|names| names.contains(&tool.name)))
        .collect()
}

/// The Host tools `agent` is offered: their catalog, less what its configuration leaves out.
fn host_tools(agent: &Agent) -> Vec<Tool> {
    let chosen = agent.config.host_tools(&agent.id);
    host_catalog()
        .into_iter()
        .filter(|tool| chosen.is_none_or(|names| names.contains(&tool.name)))
        .collect()
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
            let (setup, more, binding) =
                setup(shared, &agent, &instance, cwd, additional_directories);
            notices = more;
            match reopen(
                shared, instance, session_id, setup, binding, &agent, policy, false,
            )
            .await
            {
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
            let (setup, more, binding) =
                setup(shared, &agent, &instance, cwd, additional_directories);
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
                binding,
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
#[allow(clippy::too_many_arguments)]
async fn reopen(
    shared: &Arc<Shared>,
    mut instance: Instance,
    session_id: SessionId,
    setup: SessionSetup,
    binding: Option<Binding>,
    agent: &Agent,
    policy: PermissionPolicy,
    replay: bool,
) -> Result<SessionHandle, (Error, Option<Instance>)> {
    // Nothing closes the journal while it's taken up (`Daemon::close_unclaimed`).
    let _taking_up = TakingUp::new(shared, &session_id);
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
    // A title the Host kept outlives the journal: a closed session's new one begins with it.
    let title = match &recovered {
        Some((_, records)) => journal::kept_title(records),
        None => shared
            .config
            .journals
            .as_ref()
            .and_then(|dir| journal::read(&journal::path_for(dir, &session_id)).ok())
            .and_then(|records| journal::kept_title(&records)),
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
        Origin::Reopened(journal, title),
        binding,
    ) {
        Ok(session) => Ok(session),
        Err(error) => Err((error, None)),
    }
}

/// The journal a stopped Host left for `session_id` while it was open.
/// A session being taken up from its journal, until dropped.
struct TakingUp<'a> {
    shared: &'a Shared,
    session_id: SessionId,
}

impl<'a> TakingUp<'a> {
    fn new(shared: &'a Shared, session_id: &SessionId) -> Self {
        shared.registry().taking_up.insert(session_id.clone());
        Self {
            shared,
            session_id: session_id.clone(),
        }
    }
}

impl Drop for TakingUp<'_> {
    fn drop(&mut self) {
        self.shared.registry().taking_up.remove(&self.session_id);
    }
}

fn recoverable(shared: &Shared, session_id: &SessionId) -> Option<(PathBuf, Vec<journal::Record>)> {
    let path = journal::path_for(shared.config.journals.as_ref()?, session_id);
    let records = journal::read(&path).ok()?;
    (!records.is_empty() && !journal::is_closed(&records)).then_some((path, records))
}

/// Where a session [`open`] starts came from.
enum Origin {
    /// `session/create` or a new run: the session is blank until it's prompted.
    New,
    /// The agent's session reopened, with the journal a stopped Host left, if there is one,
    /// and the title the Host kept for it.
    Reopened(Option<Journal>, Option<String>),
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
    binding: Option<Binding>,
) -> Result<SessionHandle, Error> {
    let (journal, blank, title) = match origin {
        Origin::New => (None, true, None),
        Origin::Reopened(journal, title) => (journal, false, title),
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
                title.clone(),
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
    Ok(session::start(
        shared,
        Opened {
            session_id,
            instance,
            agent: agent.session_agent(initialize),
            resolved: agent.clone(),
            journal,
            policy,
            snapshot,
            cwd,
            additional_directories,
            blank,
            binding,
            title,
        },
    ))
}

fn journal_error(error: &std::io::Error) -> Error {
    Error::internal_error().data(format!("the session journal: {error}"))
}
