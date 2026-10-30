//! One client's connection: the Host protocol's requests, answered against the Host's
//! sessions and agents.
//!
//! Session work goes to the open session's task. Requests that need an agent outside any
//! session (`agents/get`, sign-in, listing, deleting) use an open session's agent or a spare
//! one, which the next session for that agent and directory takes.

use std::collections::HashSet;
use std::future::Future;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::Ordering;

use agent_client_protocol::ConnectTo;
use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use agent_client_protocol::Role as _;
use serde::Serialize;
use serde::de::DeserializeOwned;
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
use weave_host_protocol::host::DRAIN_FEATURE;
use weave_host_protocol::host::DrainRequest;
use weave_host_protocol::host::DrainResponse;
use weave_host_protocol::host::ShutdownRequest;
use weave_host_protocol::host::StatusRequest;
use weave_host_protocol::pending::AnswerPendingRequest;
use weave_host_protocol::policy::PermissionPolicy;
use weave_host_protocol::queue::AddQueuedRequest;
use weave_host_protocol::queue::AddQueuedResponse;
use weave_host_protocol::queue::FEATURE as QUEUE_FEATURE;
use weave_host_protocol::queue::QueuePause;
use weave_host_protocol::queue::RemoveQueuedRequest;
use weave_host_protocol::queue::RemoveQueuedResponse;
use weave_host_protocol::queue::ResumeQueueRequest;
use weave_host_protocol::sessions::AttachSessionRequest;
use weave_host_protocol::sessions::CloseSessionRequest;
use weave_host_protocol::sessions::CloseWhen;
use weave_host_protocol::sessions::CreateSessionRequest;
use weave_host_protocol::sessions::DeleteSessionRequest;
use weave_host_protocol::sessions::DetachSessionRequest;
use weave_host_protocol::sessions::GET_FEATURE;
use weave_host_protocol::sessions::GetSessionRequest;
use weave_host_protocol::sessions::GetSessionResponse;
use weave_host_protocol::sessions::LatestTurn;
use weave_host_protocol::sessions::ListSessionsRequest;
use weave_host_protocol::sessions::ListSessionsResponse;
use weave_host_protocol::sessions::OBSERVE_FEATURE;
use weave_host_protocol::sessions::RENAME_FEATURE;
use weave_host_protocol::sessions::RenameSessionRequest;
use weave_host_protocol::sessions::ReopenSessionRequest;
use weave_host_protocol::sessions::ReopenSessionResponse;
use weave_host_protocol::sessions::RunRequest;
use weave_host_protocol::sessions::RunResponse;
use weave_host_protocol::sessions::SessionListing;
use weave_host_protocol::sessions::SessionRemovedNotification;
use weave_host_protocol::sessions::SessionStatus;
use weave_host_protocol::sessions::SetConfigOptionRequest;
use weave_host_protocol::sessions::SetModeRequest;
use weave_host_protocol::sessions::TurnOrigin;
use weave_host_protocol::sessions::UnwatchSessionsRequest;
use weave_host_protocol::sessions::WATCH_FEATURE;
use weave_host_protocol::sessions::WatchSessionsRequest;
use weave_host_protocol::sessions::WatchSessionsResponse;
use weave_host_protocol::terminals::AttachTerminalRequest;
use weave_host_protocol::terminals::AttachTerminalResponse;
use weave_host_protocol::terminals::CloseTerminalRequest;
use weave_host_protocol::terminals::FEATURE as TERMINALS_FEATURE;
use weave_host_protocol::terminals::FormatTerminalRequest;
use weave_host_protocol::terminals::FormatTerminalResponse;
use weave_host_protocol::terminals::ListTerminalsRequest;
use weave_host_protocol::terminals::NewTerminalRequest;
use weave_host_protocol::terminals::SetTerminalLabelRequest;
use weave_host_protocol::terminals::TerminalResponse;
use weave_host_protocol::terminals::TerminalsResponse;
use weave_host_protocol::terminals::UnwatchTerminalsRequest;
use weave_host_protocol::terminals::WatchTerminalsRequest;
use weave_host_protocol::terminals::WriteTerminalRequest;
use weave_host_protocol::tools::CLIENT_TOOLS_FEATURE;
use weave_host_protocol::tools::Tool;
use weave_host_protocol::tools::catalog;
use weave_host_protocol::tools::host_catalog;
use weave_host_protocol::turns::CancelTurnRequest;
use weave_host_protocol::turns::REQUEST_KEYS_FEATURE;
use weave_host_protocol::turns::STEER_FEATURE;
use weave_host_protocol::turns::StartTurnRequest;
use weave_host_protocol::turns::StartTurnResponse;
use weave_host_protocol::turns::SteerTurnRequest;
use weave_host_protocol::turns::SteerTurnResponse;
use weave_host_protocol::turns::TURN_IDS_FEATURE;
use weave_host_protocol::websocket::CLOSE_REVOKED;
use weave_host_protocol::websocket::CLOSE_UNAUTHENTICATED;
use weave_host_protocol::worktrees::CreateWorktreeRequest;
use weave_host_protocol::worktrees::CreateWorktreeResponse;
use weave_host_protocol::worktrees::FEATURE as WORKTREES_FEATURE;
use weave_host_protocol::worktrees::GitLocation;
use weave_host_protocol::worktrees::ListWorktreesRequest;
use weave_host_protocol::worktrees::ListWorktreesResponse;
use weave_host_protocol::worktrees::ReleaseWorktreeRequest;
use weave_host_protocol::worktrees::ReleaseWorktreeResponse;
use weave_host_protocol::worktrees::RemoveWorktreeRequest;
use weave_host_protocol::worktrees::RemoveWorktreeResponse;

use crate::Agent;
use crate::Shared;
use crate::admissions;
use crate::admissions::Admitted;
use crate::devices::Closer;
use crate::files;
use crate::git;
use crate::instance::Instance;
use crate::journal;
use crate::journal::Entry;
use crate::journal::Journal;
use crate::journal::Recorded;
use crate::journal::now_ms;
use crate::mcp::Binding;
use crate::modes;
use crate::queue::Queue;
use crate::session;
use crate::session::Answer;
use crate::session::AttachReply;
use crate::session::Backlog;
use crate::session::ClientId;
use crate::session::ClientLink;
use crate::session::Command;
use crate::session::Opened;
use crate::session::ReplayFrom;
use crate::session::SessionHandle;
use crate::session::Snapshot;
use crate::session::Steer;
use crate::session::lock;
use crate::terminals;
use crate::terminals::Terminals;
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
    if let Some(terminals) = &shared.terminals {
        terminals.forget(connection.id);
    }
    shared.lapse_drain(connection.id);
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
    let on_watch_terminals = Arc::clone(connection);
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
            answer!(connection, drain),
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
            answer!(connection, get_session),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, list_worktrees),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, create_worktree),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, remove_worktree),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, release_worktree),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, list_terminals),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: WatchTerminalsRequest, responder, cx: ConnectionTo<HostClient>| {
                let connection = Arc::clone(&on_watch_terminals);
                let client = cx.clone();
                cx.spawn(async move {
                    let watched = connection.watch_terminals(request).await;
                    match watched {
                        Ok((terminals, scope)) => {
                            terminals.watch(connection.id, client, &scope, |list| {
                                responder.respond(TerminalsResponse {
                                    scope: scope.clone(),
                                    terminals: list,
                                })
                            })
                        }
                        Err(error) => responder.respond_with_error(error),
                    }
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, unwatch_terminals),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, new_terminal),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, close_terminal),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, set_terminal_label),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, write_terminal),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, format_terminal),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, attach_terminal),
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
                                false,
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
                                request.observe,
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
            answer!(connection, add_queued),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, remove_queued),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, resume_queue),
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

    /// The WebSocket's count of what waits to be sent, which an attach tells of its replay; the
    /// Unix socket has none.
    fn backlog(&self) -> Option<Arc<dyn Backlog>> {
        match &self.peer {
            Peer::Local => None,
            Peer::Remote(link) => Some(Arc::clone(link) as Arc<dyn Backlog>),
        }
    }

    fn hello_info(&self) -> Result<Hello, Error> {
        lock(&self.hello)
            .clone()
            .ok_or_else(|| errors::unauthenticated("say host/hello first"))
    }

    /// The client's hello, if it's local: remote clients may not administer the Host.
    /// `host/drain`: start no new turns, and with `wait` answer once no turn runs but
    /// `except`'s, or the drain timeout passes.
    async fn drain(&self, request: DrainRequest) -> Result<DrainResponse, Error> {
        self.local_hello()?;
        self.shared.begin_drain(request.except, Some(self.id));
        let running = self
            .shared
            .wait_for_turns(request.wait, self.shared.config.drain_timeout)
            .await;
        Ok(DrainResponse {
            running: u32::try_from(running).unwrap_or(u32::MAX),
        })
    }

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

    /// This client, as the origin of what it starts or changes.
    fn origin(&self, hello: &Hello) -> TurnOrigin {
        TurnOrigin::Client {
            name: hello.client.name.clone(),
            id: self.client_id(),
            device: self.device_name(),
        }
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
                WORKTREES_FEATURE.to_owned(),
                QUEUE_FEATURE.to_owned(),
                REQUEST_KEYS_FEATURE.to_owned(),
                GET_FEATURE.to_owned(),
                TURN_IDS_FEATURE.to_owned(),
                DRAIN_FEATURE.to_owned(),
                OBSERVE_FEATURE.to_owned(),
            ]
            .into_iter()
            .chain(
                self.shared
                    .terminals
                    .is_some()
                    .then(|| TERMINALS_FEATURE.to_owned()),
            )
            .collect(),
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
        list_agents(&self.shared, request).await
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

    /// `agents/update`, remote clients' too: it can only take the agent to its newest version.
    async fn update_agent(
        &self,
        request: UpdateAgentRequest,
    ) -> Result<UpdateAgentResponse, Error> {
        self.hello_info()?;
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
        list_sessions(&self.shared, request).await
    }

    async fn get_session(&self, request: GetSessionRequest) -> Result<GetSessionResponse, Error> {
        self.hello_info()?;
        get_session(&self.shared, request).await
    }

    /// `worktrees/list`: the repository's worktrees and the sessions in each.
    async fn list_worktrees(
        &self,
        request: ListWorktreesRequest,
    ) -> Result<ListWorktreesResponse, Error> {
        self.hello_info()?;
        let git = &self.shared.git;
        let repository = git.repository(&request.repo).await?;
        let default = git.default_branch(&repository).await;
        let mut worktrees = git.worktrees(&repository, default.as_ref()).await;
        let mut sessions = self.shared.session_directories();
        sessions.sort_by_key(|(_, _, last_activity)| std::cmp::Reverse(*last_activity));
        for (session_id, dir, _) in sessions {
            // The deepest worktree it's in, as one can sit inside another.
            if let Some(worktree) = worktrees
                .iter_mut()
                .filter(|worktree| dir.starts_with(&worktree.path))
                .max_by_key(|worktree| worktree.path.components().count())
            {
                worktree.sessions.push(session_id);
            }
        }
        Ok(ListWorktreesResponse {
            repo: repository.primary,
            remote: repository.remote.map(|(_, identity)| identity),
            default_branch: default.map(|default| default.name),
            worktrees,
        })
    }

    /// `worktrees/create`: a new worktree beside the repository.
    async fn create_worktree(
        &self,
        request: CreateWorktreeRequest,
    ) -> Result<CreateWorktreeResponse, Error> {
        self.hello_info()?;
        let git = &self.shared.git;
        let repository = git.repository(&request.repo).await?;
        git.create(&repository, &request.branch, request.base.as_deref())
            .await
    }

    /// `worktrees/remove`: refused while a session in it is busy, or when it has changes
    /// unless forced; otherwise its sessions close and it goes, with its branch when merged.
    async fn remove_worktree(
        &self,
        request: RemoveWorktreeRequest,
    ) -> Result<RemoveWorktreeResponse, Error> {
        self.hello_info()?;
        let git = &self.shared.git;
        let path = git::canonical(&request.path);
        let repository = git.repository(&path).await?;
        let Some(index) = repository
            .entries
            .iter()
            .position(|entry| entry.path == path)
        else {
            return Err(Error::invalid_params().data(format!(
                "{} isn't the top directory of one of the repository's worktrees",
                path.display()
            )));
        };
        if index == 0 {
            return Err(Error::invalid_params().data(format!(
                "{} is the repository's primary worktree, which can't be removed",
                path.display()
            )));
        }
        if !request.force && git.has_changes(&path).await? {
            return Err(errors::uncommitted_changes(&path));
        }
        let closed = self.shared.release(&path).await?;
        git.remove(&repository, &path, request.force).await?;
        let branch = repository.entries[index].branch.clone();
        let branch_deleted = match &branch {
            Some(branch) => {
                git.delete_branch(&repository, branch, request.delete_branch)
                    .await
            }
            None => false,
        };
        Ok(RemoveWorktreeResponse {
            closed,
            branch,
            branch_deleted,
        })
    }

    /// `worktrees/release`, which `weave worktrees pre-remove` asks for.
    async fn release_worktree(
        &self,
        request: ReleaseWorktreeRequest,
    ) -> Result<ReleaseWorktreeResponse, Error> {
        self.hello_info()?;
        let closed = self.shared.release(&git::canonical(&request.path)).await?;
        Ok(ReleaseWorktreeResponse { closed })
    }

    /// The Host's terminals, found, for a client that said hello.
    async fn terminals(&self) -> Result<Arc<Terminals>, Error> {
        self.hello_info()?;
        let terminals = self.shared.terminals.clone().ok_or_else(|| {
            errors::terminal_unavailable(
                "this Host has no terminals: weave-holder isn't installed beside it",
            )
        })?;
        terminals.ready().await;
        Ok(terminals)
    }

    /// The scope a directory's terminals belong to: the deepest worktree it's in, or the
    /// directory itself outside a repository, with symlinks resolved.
    async fn scope_of(&self, directory: &Path) -> Result<PathBuf, Error> {
        if !directory.is_absolute() || !directory.is_dir() {
            return Err(Error::invalid_params().data(serde_json::json!(format!(
                "{} isn't a directory",
                directory.display()
            ))));
        }
        Ok(self
            .shared
            .git
            .locate(directory)
            .await
            .map_or_else(|| git::canonical(directory), |location| location.worktree))
    }

    async fn list_terminals(
        &self,
        request: ListTerminalsRequest,
    ) -> Result<TerminalsResponse, Error> {
        let terminals = self.terminals().await?;
        let scope = self.scope_of(&request.directory).await?;
        Ok(TerminalsResponse {
            terminals: terminals.list(&scope),
            scope,
        })
    }

    async fn watch_terminals(
        &self,
        request: WatchTerminalsRequest,
    ) -> Result<(Arc<Terminals>, PathBuf), Error> {
        let terminals = self.terminals().await?;
        let scope = self.scope_of(&request.directory).await?;
        Ok((terminals, scope))
    }

    async fn unwatch_terminals(&self, request: UnwatchTerminalsRequest) -> Result<Empty, Error> {
        self.terminals().await?.unwatch(self.id, &request.scope);
        Ok(Empty {})
    }

    async fn new_terminal(&self, request: NewTerminalRequest) -> Result<TerminalResponse, Error> {
        let terminals = self.terminals().await?;
        let scope = self.scope_of(&request.directory).await?;
        let start = terminals::Start {
            id: terminals::new_id(),
            directory: request.directory,
            scope,
            label: request.label,
            opened_from: request.opened_from,
            command: request.command.filter(|command| !command.is_empty()),
            size: request.size.unwrap_or(terminals::DEFAULT_SIZE),
            env: self.shared.config.environment.vars.clone(),
        };
        let terminal = terminals.start(start).await?;
        Ok(TerminalResponse { terminal })
    }

    async fn close_terminal(&self, request: CloseTerminalRequest) -> Result<Empty, Error> {
        self.terminals().await?.close(&request.id).await?;
        Ok(Empty {})
    }

    async fn set_terminal_label(
        &self,
        request: SetTerminalLabelRequest,
    ) -> Result<TerminalResponse, Error> {
        let label = request.label.filter(|label| !label.trim().is_empty());
        let terminal = self
            .terminals()
            .await?
            .set_label(&request.id, label)
            .await?;
        Ok(TerminalResponse { terminal })
    }

    async fn write_terminal(&self, request: WriteTerminalRequest) -> Result<Empty, Error> {
        self.terminals()
            .await?
            .write(&request.id, &request.text)
            .await?;
        Ok(Empty {})
    }

    async fn format_terminal(
        &self,
        request: FormatTerminalRequest,
    ) -> Result<FormatTerminalResponse, Error> {
        let content = self
            .terminals()
            .await?
            .format(&request.id, request.format, request.history, request.trim)
            .await?;
        Ok(FormatTerminalResponse { content })
    }

    /// A ticket for the terminal's stream, to the device this client proved, if any.
    async fn attach_terminal(
        &self,
        request: AttachTerminalRequest,
    ) -> Result<AttachTerminalResponse, Error> {
        let terminals = self.terminals().await?;
        let device = lock(&self.device).as_ref().map(|device| device.id.clone());
        let (ticket, expires_at) = terminals.ticket(&request.id, device)?;
        Ok(AttachTerminalResponse { ticket, expires_at })
    }

    /// `agent_id`'s sessions: the Host's own in the directory first, open ones and then ones
    /// a stopped Host left open within the idle grace of their last activity; then the
    /// agent's own listing, paged by its cursor.
    async fn create(&self, request: CreateSessionRequest) -> Result<Ready, Error> {
        self.hello_info()?;
        let agent = self.shared.resolve(&request.agent_id).await?;
        let (instance, git) = tokio::join!(
            self.shared
                .instance(&agent, &request.cwd, interactive(agent.options)),
            self.shared.git.locate(&request.cwd),
        );
        let instance = instance?;
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
            Origin::New { started_by: None },
            binding,
            git,
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
        // An observer follows a session that's open; it never opens one.
        if request.observe {
            return Err(errors::session_not_open(&session_id.to_string()));
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
        let (instance, git) = tokio::join!(
            self.shared
                .instance(&agent, &cwd, interactive(agent.options)),
            self.shared.git.locate(&cwd),
        );
        let instance = instance?;
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
            git,
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
        observer: bool,
        reply: AttachReply,
    ) {
        let session_id = ready.session.summary().session_id;
        lock(&self.attached).insert(session_id);
        let command = Command::Attach {
            client: self.id,
            link: Box::new(ClientLink {
                cx,
                client_tools: self.client_tools(),
                backlog: self.backlog(),
                observer,
            }),
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
        live(&self.shared, session_id)
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
        let origin = self.origin(&hello);
        let digest = admissions::digest(&StartTurnRequest {
            key: None,
            ..request.clone()
        });
        let StartTurnRequest {
            session_id,
            prompt,
            key,
        } = request;
        let root = self.shared.registry().root(&session_id);
        keyed(
            &self.shared,
            key,
            "turn/start",
            digest,
            Some(&root),
            |work| {
                work.started.then_some(StartTurnResponse {
                    seq: work.seq,
                    turn_id: work.turn_id,
                })
            },
            StartTurnResponse::clone,
            async |key| {
                let session = self.live(&session_id)?;
                let (reply, started) = oneshot::channel();
                session.send(Command::Prompt {
                    origin,
                    session_id,
                    prompt,
                    key,
                    reply,
                })?;
                let (seq, turn_id) = started.await.map_err(|_| session::ended())??;
                Ok(StartTurnResponse {
                    seq,
                    turn_id: Some(turn_id),
                })
            },
        )
        .await
    }

    async fn add_queued(&self, request: AddQueuedRequest) -> Result<AddQueuedResponse, Error> {
        let hello = self.hello_info()?;
        add_queued(&self.shared, request, self.origin(&hello)).await
    }

    async fn remove_queued(
        &self,
        request: RemoveQueuedRequest,
    ) -> Result<RemoveQueuedResponse, Error> {
        let hello = self.hello_info()?;
        let session = self.live(&request.session_id)?;
        let (reply, removed) = oneshot::channel();
        session.send(Command::Unqueue {
            queued_id: request.queued_id,
            by: self.origin(&hello),
            reply,
        })?;
        removed.await.map_err(|_| session::ended())
    }

    async fn resume_queue(&self, request: ResumeQueueRequest) -> Result<Empty, Error> {
        let hello = self.hello_info()?;
        let session = self.live(&request.session_id)?;
        let by = self.origin(&hello);
        session
            .finish(|done| Command::ResumeQueue { by, done })
            .await?;
        Ok(Empty {})
    }

    async fn steer_turn(&self, request: SteerTurnRequest) -> Result<SteerTurnResponse, Error> {
        let hello = self.hello_info()?;
        steer_turn(&self.shared, request, self.origin(&hello)).await
    }

    async fn cancel_turn(&self, request: CancelTurnRequest) -> Result<Empty, Error> {
        self.hello_info()?;
        cancel_turn(&self.shared, request)
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
            let backlog = self.backlog();
            (
                self.id,
                ClientLink {
                    cx,
                    client_tools,
                    backlog,
                    observer: false,
                },
            )
        });
        let attaching = link.is_some();
        let answer = run(&self.shared, request, link).await?;
        if attaching {
            lock(&self.attached).insert(answer.session_id.clone());
        }
        Ok(answer)
    }
}

/// `agents/list`, for a client or a Host tool: presets and configured agents, described as
/// their configuration describes them, and registry agents when asked.
pub(crate) async fn list_agents(
    shared: &Arc<Shared>,
    request: ListAgentsRequest,
) -> Result<ListAgentsResponse, Error> {
    let config = shared.load_config()?;
    let mut agents: Vec<AgentSummary> = Vec::new();
    let local = |id: &str, source| AgentSummary {
        id: id.to_owned(),
        name: id.to_owned(),
        source,
        version: None,
        installed: true,
        description: config
            .agents
            .get(id)
            .and_then(|agent| agent.description.clone()),
    };
    for id in shared.config.agents.keys() {
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
        let cache = shared.registry_cache()?;
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

/// `queue/add` from `origin`, for a client or a Host tool.
pub(crate) async fn add_queued(
    shared: &Arc<Shared>,
    request: AddQueuedRequest,
    origin: TurnOrigin,
) -> Result<AddQueuedResponse, Error> {
    let digest = admissions::digest(&AddQueuedRequest {
        key: None,
        ..request.clone()
    });
    let AddQueuedRequest {
        session_id,
        prompt,
        key,
    } = request;
    keyed(
        shared,
        key,
        "queue/add",
        digest,
        Some(&session_id),
        |work| {
            Some(AddQueuedResponse {
                queued_id: work.queued_id?,
                seq: work.seq,
                started: work.started,
            })
        },
        AddQueuedResponse::clone,
        async |key| {
            let session = live(shared, &session_id)?;
            if session.summary().session_id != session_id {
                return Err(Error::invalid_params()
                    .data("a subagent thread has no queue: add to its parent's"));
            }
            let (reply, added) = oneshot::channel();
            session.send(Command::Enqueue {
                origin,
                prompt,
                key,
                reply,
            })?;
            added.await.map_err(|_| session::ended())?
        },
    )
    .await
}

/// `turn/steer` from `origin`, for a client or a Host tool.
pub(crate) async fn steer_turn(
    shared: &Arc<Shared>,
    request: SteerTurnRequest,
    origin: TurnOrigin,
) -> Result<SteerTurnResponse, Error> {
    let session = live(shared, &request.session_id)?;
    let (reply, answered) = oneshot::channel();
    session.send(Command::Steer(Steer {
        origin,
        session_id: request.session_id,
        prompt: request.prompt,
        reply,
    }))?;
    answered.await.map_err(|_| session::ended())?
}

/// `turn/cancel`, for a client or a Host tool.
pub(crate) fn cancel_turn(
    shared: &Arc<Shared>,
    request: CancelTurnRequest,
) -> Result<Empty, Error> {
    let session = live(shared, &request.session_id)?;
    session.send(Command::Cancel {
        session_id: request.session_id,
    })?;
    Ok(Empty {})
}

/// The open session `session_id` is, or belongs to as a subagent.
pub(crate) fn live(shared: &Shared, session_id: &SessionId) -> Result<SessionHandle, Error> {
    shared
        .registry()
        .live(session_id)
        .ok_or_else(|| errors::session_not_open(&session_id.to_string()))
}

/// `sessions/list`, for a client or a Host tool.
pub(crate) async fn list_sessions(
    shared: &Arc<Shared>,
    request: ListSessionsRequest,
) -> Result<ListSessionsResponse, Error> {
    match request.agent_id.clone() {
        None => {
            let repo = match &request.repo {
                Some(dir) => Some(shared.git.repository(dir).await?.primary),
                None => None,
            };
            let mut sessions = shared.listings(request.cwd.as_deref(), repo.as_deref());
            if let Some(activity) = request.activity {
                sessions.retain(|listing| listing.activity == Some(activity));
            }
            Ok(ListSessionsResponse {
                sessions,
                next_cursor: None,
            })
        }
        Some(_) if request.repo.is_some() => {
            Err(Error::invalid_params()
                .data("sessions/list takes a repository only without an agent"))
        }
        Some(_) if request.activity.is_some() => {
            Err(Error::invalid_params()
                .data("sessions/list takes an activity only without an agent"))
        }
        Some(agent_id) => agent_sessions(shared, &agent_id, request).await,
    }
}

/// `sessions/list` for one agent: the Host's own sessions of it in the directory first, then the
/// agent's own listing.
async fn agent_sessions(
    shared: &Arc<Shared>,
    agent_id: &str,
    request: ListSessionsRequest,
) -> Result<ListSessionsResponse, Error> {
    let agent = shared.resolve(agent_id).await?;
    let cwd = request.cwd.clone().unwrap_or_else(home);
    let handle = shared
        .agent_handle(&agent, &cwd, interactive(agent.options))
        .await?;
    let listed = handle
        .list_sessions(request.cwd.clone(), request.cursor.clone())
        .await?;
    let in_scope = |dir: &Path| request.cwd.as_deref().is_none_or(|cwd| cwd == dir);
    let grace_ms = u64::try_from(shared.config.idle_grace.as_millis()).unwrap_or(u64::MAX);
    let (open, blank, known) = {
        let registry = shared.registry();
        let (blank, open): (Vec<&SessionHandle>, Vec<&SessionHandle>) = registry
            .sessions
            .values()
            .partition(|session| session.is_blank());
        let blank: HashSet<SessionId> = blank
            .into_iter()
            .map(|session| session.summary().session_id)
            .collect();
        let open: Vec<session::Summary> = open.into_iter().map(SessionHandle::summary).collect();
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
    // An agent may list more than `cwd` asks: Claude's lists the repository's other worktrees.
    agents_own.retain(|info| !blank.contains(&info.session_id) && in_scope(&info.cwd));
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
                git: known
                    .get(&info.session_id)
                    .and_then(|recorded| recorded.git.clone()),
                started_by: known
                    .get(&info.session_id)
                    .and_then(|recorded| recorded.started_by.clone()),
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

/// `sessions/get`, for a client or a Host tool: the session as it lists, with its latest turn
/// from its journal, without opening it.
pub(crate) async fn get_session(
    shared: &Arc<Shared>,
    request: GetSessionRequest,
) -> Result<GetSessionResponse, Error> {
    let unknown = || errors::unknown_session(&request.session_id.to_string());
    let (live, recorded) = {
        let registry = shared.registry();
        (
            registry.sessions.get(&request.session_id).cloned(),
            registry.known.get(&request.session_id).cloned(),
        )
    };
    if let Some(session) = live {
        if session.is_blank() {
            return Err(unknown());
        }
        let (reply, latest) = oneshot::channel();
        session.send(Command::LatestTurn {
            turn_id: request.turn_id.clone(),
            reply,
        })?;
        let latest_turn = latest.await.map_err(|_| session::ended())?;
        return Ok(GetSessionResponse {
            session: session.summary().listing(),
            latest_turn: asked_for(&request, latest_turn)?,
        });
    }
    let recorded = recorded.ok_or_else(unknown)?;
    let agent_id = recorded.agent_id().ok_or_else(unknown)?.to_owned();
    let records = shared
        .config
        .journals
        .as_ref()
        .and_then(|dir| journal::read(&journal::path_for(dir, &request.session_id)).ok())
        .unwrap_or_default();
    let mut session = dormant(&request.session_id, &agent_id, &recorded);
    session.info.title = journal::shown_title(&records);
    let latest_turn = journal::turn(&records, &request.session_id, request.turn_id.as_deref());
    Ok(GetSessionResponse {
        latest_turn: asked_for(&request, latest_turn)?,
        session,
    })
}

/// The turn `sessions/get` found: an error when it asked for one by id and there's none.
fn asked_for(
    request: &GetSessionRequest,
    found: Option<LatestTurn>,
) -> Result<Option<LatestTurn>, Error> {
    match (&request.turn_id, found) {
        (Some(turn_id), None) => Err(errors::unknown_turn(
            &request.session_id.to_string(),
            turn_id,
        )),
        (_, found) => Ok(found),
    }
}

/// A session a stopped Host left, or one closed since, as listings show it.
pub(crate) fn dormant(
    session_id: &SessionId,
    agent_id: &str,
    recorded: &Recorded,
) -> SessionListing {
    let mut info = SessionInfo::new(session_id.clone(), recorded.cwd.clone());
    info.title.clone_from(&recorded.title);
    SessionListing {
        info,
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
        git: recorded.git.clone(),
        started_by: recorded.started_by.clone(),
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

/// `work`, done under the request key `key` when there is one (feature `requestKeys`): a
/// repeat gets the answer the first got, `remembered` from it, and starts nothing. A key a
/// stopped Host admitted without answering is looked for first in the journal of `session_id`,
/// or every journal without one, where `recover` makes the answer from the work it finds.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn keyed<T, W>(
    shared: &Arc<Shared>,
    key: Option<String>,
    method: &str,
    digest: String,
    session_id: Option<&SessionId>,
    recover: impl FnOnce(journal::KeyedWork) -> Option<T>,
    remembered: impl FnOnce(&T) -> T,
    work: impl FnOnce(Option<String>) -> W,
) -> Result<T, Error>
where
    T: Serialize + DeserializeOwned,
    W: Future<Output = Result<T, Error>>,
{
    let Some(key) = key else {
        return work(None).await;
    };
    let ticket = match shared.admissions.admit::<T>(key, method, digest).await? {
        Admitted::Answered(answer) => return Ok(answer),
        Admitted::Act(ticket) => ticket,
    };
    if ticket.unsettled()
        && let Some(dir) = &shared.config.journals
        && let Some(answer) = admissions::find_work(dir, session_id, ticket.key()).and_then(recover)
    {
        ticket.settle(&answer);
        return Ok(answer);
    }
    let answer = work(Some(ticket.key().to_owned())).await?;
    ticket.settle(&remembered(&answer));
    Ok(answer)
}

/// Open `session_id`, which the Host doesn't have open, with no client: as `session/run` does
/// before its turn, and as a Host starting does for a headless session whose queue waits.
pub(crate) async fn take_up(
    shared: &Arc<Shared>,
    agent_id: &str,
    cwd: PathBuf,
    session_id: SessionId,
    policy: PermissionPolicy,
) -> Result<SessionHandle, Error> {
    let agent = shared.resolve(agent_id).await?;
    let (session, _notices) =
        take_up_with(shared, &agent, cwd, session_id, Vec::new(), policy).await?;
    Ok(session)
}

/// [`take_up`], with `agent` resolved already; with what's worth telling the client.
async fn take_up_with(
    shared: &Arc<Shared>,
    agent: &Agent,
    cwd: PathBuf,
    session_id: SessionId,
    additional_directories: Vec<PathBuf>,
    policy: PermissionPolicy,
) -> Result<(SessionHandle, Vec<String>), Error> {
    let (instance, git) = tokio::join!(
        shared.instance(agent, &cwd, headless(agent.options)),
        shared.git.locate(&cwd),
    );
    let instance = instance?;
    let (setup, notices, binding) = setup(shared, agent, &instance, cwd, additional_directories);
    match reopen(
        shared, instance, session_id, setup, binding, agent, policy, false, git,
    )
    .await
    {
        Ok(session) => Ok((session, notices)),
        Err((error, instance)) => {
            if let Some(instance) = instance {
                instance.connection.shutdown().await;
            }
            Err(error)
        }
    }
}

/// Open `request`'s session and start its turn; see [`crate::Daemon::run`]. `link` is the
/// requesting client, attached before the prompt goes out so it sees the whole turn. Under a
/// request key, a repeat answers with the session alone, attaching nobody.
pub(crate) async fn run(
    shared: &Arc<Shared>,
    request: RunRequest,
    link: Option<(ClientId, ClientLink)>,
) -> Result<RunResponse, Error> {
    run_as(shared, request, link, TurnOrigin::Run {}, None).await
}

/// [`run`], its turn from `origin`; a new session is a delegated session of `started_by`'s when
/// a session's agent starts it (ADR 0020).
pub(crate) async fn run_as(
    shared: &Arc<Shared>,
    request: RunRequest,
    link: Option<(ClientId, ClientLink)>,
    origin: TurnOrigin,
    started_by: Option<SessionId>,
) -> Result<RunResponse, Error> {
    let digest = admissions::digest(&RunRequest {
        key: None,
        ..request.clone()
    });
    let session_id = request.session_id.clone();
    let key = request.key.clone();
    keyed(
        shared,
        key,
        "session/run",
        digest,
        session_id.as_ref(),
        |work| {
            Some(RunResponse {
                session_id: work.session_id,
                turn_id: work.turn_id,
                state: None,
            })
        },
        |answer: &RunResponse| RunResponse {
            state: None,
            ..answer.clone()
        },
        async |key| run_now(shared, request, link, key, origin, started_by).await,
    )
    .await
}

/// [`run_as`], under `key` when there is one.
async fn run_now(
    shared: &Arc<Shared>,
    request: RunRequest,
    link: Option<(ClientId, ClientLink)>,
    key: Option<String>,
    origin: TurnOrigin,
    started_by: Option<SessionId>,
) -> Result<RunResponse, Error> {
    if shared.draining() {
        return Err(errors::host_stopping());
    }
    let RunRequest {
        agent_id,
        cwd,
        session_id,
        additional_directories,
        prompt,
        policy,
        attach: _,
        trace,
        key: _,
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
            let (session, more) = take_up_with(
                shared,
                &agent,
                cwd,
                session_id,
                additional_directories,
                policy,
            )
            .await?;
            notices = more;
            session
        }
        (None, None) => {
            let (instance, git) = tokio::join!(
                shared.instance(&agent, &cwd, options),
                shared.git.locate(&cwd),
            );
            let instance = instance?;
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
                Origin::New { started_by },
                binding,
                git,
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
                link: Box::new(link),
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
        origin,
        session_id: root.clone(),
        prompt,
        key,
        reply,
    })?;
    let (_, turn_id) = started.await.map_err(|_| session::ended())??;
    Ok(RunResponse {
        session_id: root,
        turn_id: Some(turn_id),
        state: state.map(Box::new),
    })
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
    git: Option<GitLocation>,
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
        Err(Error::method_not_found().data("the agent can't reopen threads"))
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
    // A title the Host kept and a queue outlive the journal: a closed session's new one begins
    // with them.
    let closed = match &recovered {
        Some(_) => None,
        None => shared
            .config
            .journals
            .as_ref()
            .and_then(|dir| journal::read(&journal::path_for(dir, &session_id)).ok()),
    };
    let earlier = recovered
        .as_ref()
        .map(|(_, records)| records.as_slice())
        .or(closed.as_deref());
    let title = earlier.and_then(journal::kept_title);
    let agent_title = earlier.and_then(journal::agent_title);
    let last_activity_ms = earlier.and_then(journal::last_activity);
    let mut queue = earlier.map(Queue::from_records).unwrap_or_default();
    let started_by = earlier.and_then(journal::started_by);
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
            if interrupt(&mut queue, &policy) {
                journal.append(Entry::QueuePaused {
                    reason: QueuePause::Interrupted,
                });
            }
            (Some(journal), policy)
        }
        None => {
            // The new journal's header carries the queue, paused or not.
            interrupt(&mut queue, &policy);
            (None, policy)
        }
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
        Origin::Reopened {
            journal,
            title,
            agent_title,
            last_activity_ms,
            queue,
            started_by,
        },
        binding,
        git,
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

/// An interactive session taken up again with prompts waiting has its queue paused, for a
/// person to resume; a headless session's carries on. Whether it paused now.
fn interrupt(queue: &mut Queue, policy: &PermissionPolicy) -> bool {
    if !queue.is_ready() || policy.is_headless() {
        return false;
    }
    queue.paused = Some(QueuePause::Interrupted);
    true
}

fn recoverable(shared: &Shared, session_id: &SessionId) -> Option<(PathBuf, Vec<journal::Record>)> {
    let path = journal::path_for(shared.config.journals.as_ref()?, session_id);
    let records = journal::read(&path).ok()?;
    (!records.is_empty() && !journal::is_closed(&records)).then_some((path, records))
}

/// Where a session [`open`] starts came from.
enum Origin {
    /// `session/create` or a new run: the session is blank until it's prompted. A delegated
    /// session names the session that started it.
    New { started_by: Option<SessionId> },
    /// The agent's session reopened, with the journal a stopped Host left, if there is one,
    /// and the title and queue the Host kept for it, the last title its agent gave it, and when
    /// it was last active.
    Reopened {
        journal: Option<Journal>,
        title: Option<String>,
        agent_title: Option<String>,
        last_activity_ms: Option<u64>,
        queue: Queue,
        started_by: Option<SessionId>,
    },
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
    git: Option<GitLocation>,
) -> Result<SessionHandle, Error> {
    let (journal, blank, title, agent_title, last_activity_ms, queue, started_by) = match origin {
        Origin::New { started_by } => (None, true, None, None, None, Queue::default(), started_by),
        Origin::Reopened {
            journal,
            title,
            agent_title,
            last_activity_ms,
            queue,
            started_by,
        } => (
            journal,
            false,
            title,
            agent_title,
            last_activity_ms,
            queue,
            started_by,
        ),
    };
    let journal = match journal {
        Some(journal) => journal,
        None => {
            let mut header = Entry::header(
                session_id.clone(),
                agent.spec.clone(),
                &agent.id,
                cwd.clone(),
                policy.clone(),
                title.clone(),
                git.clone(),
            );
            if let Entry::Header {
                queue: carried,
                queue_paused,
                started_by: starter,
                ..
            } = &mut header
            {
                carried.extend(queue.prompts.iter().cloned());
                *queue_paused = queue.paused;
                starter.clone_from(&started_by);
            }
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
            agent_title,
            last_activity_ms,
            git,
            queue,
            started_by,
        },
    ))
}

fn journal_error(error: &std::io::Error) -> Error {
    Error::internal_error().data(format!("the thread journal: {error}"))
}
