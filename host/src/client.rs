//! One client's connection: the Host protocol's requests, answered against the Host's
//! threads and agents.
//!
//! Thread work goes to the open thread's task. Requests that need an agent outside any
//! thread (`agents/get`, sign-in, listing, deleting) use an open thread's agent or a spare
//! one, which the next thread for that agent and directory takes.

use std::collections::HashSet;
use std::future::Future;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::Ordering;

use agent_client_protocol::Builder;
use agent_client_protocol::ConnectTo;
use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use agent_client_protocol::Handled;
use agent_client_protocol::Responder;
use agent_client_protocol::UntypedMessage;
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
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::CurrentModeUpdate;
use weave_acp_core::schema::InitializeRequest;
use weave_acp_core::schema::InitializeResponse;
use weave_acp_core::schema::McpServer;
use weave_acp_core::schema::Meta;
use weave_acp_core::schema::SessionInfo;
use weave_acp_core::schema::SessionNotification;
use weave_acp_core::schema::SessionUpdate;
use weave_acp_core::schema::SetSessionConfigOptionResponse;
use weave_agents::config::ConfiguredMcpServer;
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
use weave_host_protocol::devices::DeviceInfo;
use weave_host_protocol::dispatcher::CARRY_FEATURE;
use weave_host_protocol::dispatcher::CarryRequest;
use weave_host_protocol::dispatcher::JoinDispatcherRequest;
use weave_host_protocol::dispatcher::JoinDispatcherResponse;
use weave_host_protocol::dispatcher::LeaveDispatcherRequest;
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
use weave_host_protocol::host::HostStatus;
use weave_host_protocol::host::ShutdownRequest;
use weave_host_protocol::host::StatusRequest;
use weave_host_protocol::mcp::FEATURE as MCP_SERVERS_FEATURE;
use weave_host_protocol::pending::AnswerPendingRequest;
use weave_host_protocol::policy::PermissionPolicy;
use weave_host_protocol::queue::AddQueuedRequest;
use weave_host_protocol::queue::AddQueuedResponse;
use weave_host_protocol::queue::FEATURE as QUEUE_FEATURE;
use weave_host_protocol::queue::QueuePause;
use weave_host_protocol::queue::RemoveQueuedRequest;
use weave_host_protocol::queue::RemoveQueuedResponse;
use weave_host_protocol::queue::ResumeQueueRequest;
use weave_host_protocol::sessions::ADD_FEATURE as SESSIONS_ADD_FEATURE;
use weave_host_protocol::sessions::AddToSessionRequest;
use weave_host_protocol::sessions::END_FEATURE as SESSIONS_END_FEATURE;
use weave_host_protocol::sessions::EndSessionRequest;
use weave_host_protocol::sessions::FEATURE as SESSIONS_FEATURE;
use weave_host_protocol::sessions::GetSessionRequest;
use weave_host_protocol::sessions::ListSessionsRequest;
use weave_host_protocol::sessions::ListSessionsResponse;
use weave_host_protocol::sessions::SessionResponse;
use weave_host_protocol::sessions::SetSessionRequest;
use weave_host_protocol::sessions::UnwatchSessionsRequest;
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
use weave_host_protocol::threads::AttachThreadRequest;
use weave_host_protocol::threads::CONTEXT_FEATURE;
use weave_host_protocol::threads::CloseThreadRequest;
use weave_host_protocol::threads::CloseWhen;
use weave_host_protocol::threads::CreateThreadRequest;
use weave_host_protocol::threads::DeleteThreadRequest;
use weave_host_protocol::threads::DetachThreadRequest;
use weave_host_protocol::threads::GET_FEATURE;
use weave_host_protocol::threads::GetThreadRequest;
use weave_host_protocol::threads::GetThreadResponse;
use weave_host_protocol::threads::LABELS_FEATURE;
use weave_host_protocol::threads::LabelThreadRequest;
use weave_host_protocol::threads::LabelThreadResponse;
use weave_host_protocol::threads::LatestTurn;
use weave_host_protocol::threads::ListThreadsRequest;
use weave_host_protocol::threads::ListThreadsResponse;
use weave_host_protocol::threads::MAX_LABELS;
use weave_host_protocol::threads::OBSERVE_FEATURE;
use weave_host_protocol::threads::OTHER_HOSTS_FEATURE;
use weave_host_protocol::threads::OtherThread;
use weave_host_protocol::threads::RENAME_FEATURE;
use weave_host_protocol::threads::RenameThreadRequest;
use weave_host_protocol::threads::ReopenThreadRequest;
use weave_host_protocol::threads::ReopenThreadResponse;
use weave_host_protocol::threads::ReportThreadRequest;
use weave_host_protocol::threads::RunRequest;
use weave_host_protocol::threads::RunResponse;
use weave_host_protocol::threads::SUCCESSORS_FEATURE;
use weave_host_protocol::threads::ServiceOrigin;
use weave_host_protocol::threads::SetConfigOptionRequest;
use weave_host_protocol::threads::SetModeRequest;
use weave_host_protocol::threads::SetSuccessorRequest;
use weave_host_protocol::threads::ThreadId;
use weave_host_protocol::threads::ThreadListing;
use weave_host_protocol::threads::ThreadStatus;
use weave_host_protocol::threads::TurnOrigin;
use weave_host_protocol::threads::UnwatchThreadsRequest;
use weave_host_protocol::threads::WATCH_FEATURE;
use weave_host_protocol::threads::WatchThreadsRequest;
use weave_host_protocol::threads::WatchThreadsResponse;
use weave_host_protocol::threads::check_label;
use weave_host_protocol::tools::AnswerToolRequest;
use weave_host_protocol::tools::CLIENT_TOOLS_FEATURE;
use weave_host_protocol::tools::DeclareToolsRequest;
use weave_host_protocol::tools::DeclareToolsResponse;
use weave_host_protocol::tools::SERVICE_TOOLS_FEATURE;
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
use weave_host_protocol::websocket::CLOSE_UNAUTHENTICATED;
use weave_host_protocol::worktrees::CreateWorktreeRequest;
use weave_host_protocol::worktrees::CreateWorktreeResponse;
use weave_host_protocol::worktrees::FEATURE as WORKTREES_FEATURE;
use weave_host_protocol::worktrees::GitLocation;
use weave_host_protocol::worktrees::InitRepositoryRequest;
use weave_host_protocol::worktrees::InitRepositoryResponse;
use weave_host_protocol::worktrees::ListWorktreesRequest;
use weave_host_protocol::worktrees::ListWorktreesResponse;
use weave_host_protocol::worktrees::REPOS_INIT_FEATURE;
use weave_host_protocol::worktrees::ReleaseWorktreeRequest;
use weave_host_protocol::worktrees::ReleaseWorktreeResponse;
use weave_host_protocol::worktrees::RemoveWorktreeRequest;
use weave_host_protocol::worktrees::RemoveWorktreeResponse;
use weave_remote::websocket::Link;

use crate::Agent;
use crate::MAX_SUCCESSORS;
use crate::Shared;
use crate::admissions;
use crate::admissions::Admitted;
use crate::files;
use crate::git;
use crate::instance::Instance;
use crate::journal;
use crate::journal::CarriedUsage;
use crate::journal::Entry;
use crate::journal::Journal;
use crate::journal::Recorded;
use crate::journal::Usage;
use crate::journal::now_ms;
use crate::mcp::Servers;
use crate::modes;
use crate::queue::Queue;
use crate::repos;
use crate::service_tools;
use crate::terminals;
use crate::terminals::Terminals;
use crate::thread;
use crate::thread::Answer;
use crate::thread::AttachReply;
use crate::thread::Backlog;
use crate::thread::ClientId;
use crate::thread::ClientLink;
use crate::thread::Command;
use crate::thread::Continuation;
use crate::thread::Opened;
use crate::thread::ReplayFrom;
use crate::thread::Snapshot;
use crate::thread::Steer;
use crate::thread::ThreadHandle;
use crate::thread::lock;
use crate::updates;

/// What a client said at `host/hello`.
#[derive(Clone)]
struct Hello {
    client: ClientInfo,
    capabilities: ClientCapabilities,
}

/// Where a connection comes from. A Host listens for nothing but its socket: the person's devices
/// pair with the Dispatcher and reach the Host through it (ADR 0030, WVE-197).
enum Peer {
    /// The Unix socket, whose peers are checked when they connect, or the same process.
    Local,
    /// The connection the Host opened to the Dispatcher it joined (ADR 0030), whose hello takes
    /// only that Dispatcher's key.
    Joined(Arc<Link>),
    /// A connection the Host opened to the Dispatcher it joined to carry a device's (WVE-195),
    /// whose hello takes only `auth: dispatcher`, for the device the Dispatcher named.
    Carried { link: Arc<Link>, device: DeviceInfo },
}

struct Connection {
    id: ClientId,
    shared: Arc<Shared>,
    peer: Peer,
    hello: Mutex<Option<Hello>>,
    /// Who a remote client is, as its hello settled: the Dispatcher the Host joined, on the
    /// connection to it, or the device it named, on one it carries.
    device: Mutex<Option<DeviceInfo>>,
    /// Open threads this client is attached to.
    attached: Mutex<HashSet<ThreadId>>,
}

/// A thread opened for a client, ready to attach it to.
struct Ready {
    thread: ThreadHandle,
    notices: Vec<String>,
    trace: Option<PathBuf>,
}

/// Serve one local client until it disconnects, then detach it from its threads.
pub(crate) async fn serve(
    shared: Arc<Shared>,
    transport: impl ConnectTo<Host> + 'static,
) -> Result<(), Error> {
    serve_as(shared, transport, Peer::Local, true).await
}

/// Serve a local client that runs beside the Host in its own process, as `weave daemon`'s
/// follower of threads for Rex does: it doesn't keep an idle Host running.
pub(crate) async fn serve_beside(
    shared: Arc<Shared>,
    transport: impl ConnectTo<Host> + 'static,
) -> Result<(), Error> {
    serve_as(shared, transport, Peer::Local, false).await
}

/// Serve the Dispatcher the Host joined over the connection the Host opened to it
/// ([`crate::dispatcher`]): it proves its key at hello.
pub(crate) async fn serve_joined(
    shared: Arc<Shared>,
    transport: impl ConnectTo<Host> + 'static,
    link: Arc<Link>,
) -> Result<(), Error> {
    serve_as(shared, transport, Peer::Joined(link), true).await
}

/// Serve a device's connection that the Dispatcher the Host joined carries
/// ([`crate::dispatcher::carry`]), the Host's end of which the Host opened itself: its hello
/// takes the Dispatcher's word that it is `device`.
pub(crate) async fn serve_carried(
    shared: Arc<Shared>,
    transport: impl ConnectTo<Host> + 'static,
    link: Arc<Link>,
    device: DeviceInfo,
) -> Result<(), Error> {
    serve_as(shared, transport, Peer::Carried { link, device }, true).await
}

/// `counted`: the client keeps an idle Host running while it's connected.
async fn serve_as(
    shared: Arc<Shared>,
    transport: impl ConnectTo<Host> + 'static,
    peer: Peer,
    counted: bool,
) -> Result<(), Error> {
    let connection = Arc::new(Connection {
        id: shared.next_client.fetch_add(1, Ordering::Relaxed),
        shared: Arc::clone(&shared),
        peer,
        hello: Mutex::new(None),
        device: Mutex::new(None),
        attached: Mutex::new(HashSet::new()),
    });
    if counted {
        shared.registry().clients += 1;
    }
    let result = handlers(&connection, transport).await;
    if counted {
        shared.registry().clients -= 1;
    }
    shared.unwatch(connection.id);
    shared.sessions.forget(connection.id);
    if let Some(terminals) = &shared.terminals {
        terminals.forget(connection.id);
    }
    shared.lapse_drain(connection.id);
    shared.service_tools.disconnected(connection.id);
    let attached: Vec<ThreadId> = lock(&connection.attached).drain().collect();
    for thread_id in attached {
        if let Some(thread) = shared.registry().live(&thread_id) {
            thread.traces.remove(connection.id);
            let _ = thread.send(Command::Detach {
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
    let on_shutdown = Arc::clone(connection);
    let on_create = Arc::clone(connection);
    let on_watch = Arc::clone(connection);
    let on_unwatch = Arc::clone(connection);
    let on_declare = Arc::clone(connection);
    let on_attach = Arc::clone(connection);
    let on_watch_terminals = Arc::clone(connection);
    let on_watch_sessions = Arc::clone(connection);
    let on_any = Arc::clone(connection);
    Builder::new(Host)
        .name("weave-host")
        // A service asks only what starting and following threads needs (ADR 0027), refused
        // here before any handler sees the rest.
        .on_receive_request(
            async move |request: UntypedMessage, responder: Responder<serde_json::Value>, _cx| {
                match on_any.refusal(&request) {
                    Some(error) => {
                        responder.respond_with_error(error)?;
                        Ok(Handled::Yes)
                    }
                    None => Ok(Handled::No {
                        message: (request, responder),
                        retry: false,
                    }),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
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
            answer!(connection, status),
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
            answer!(connection, join_dispatcher),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, leave_dispatcher),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, carry),
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
            answer!(connection, list_threads),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, list_files),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, get_thread),
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
            answer!(connection, init_repository),
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
            answer!(connection, list_sessions),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, get_session),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, set_session),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, end_session),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, add_to_session),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: WatchSessionsRequest, responder, cx: ConnectionTo<HostClient>| {
                let connection = Arc::clone(&on_watch_sessions);
                let client = cx.clone();
                cx.spawn(async move {
                    let directory = match connection.watched_session(request).await {
                        Ok(directory) => directory,
                        Err(error) => return responder.respond_with_error(error),
                    };
                    let shared = &connection.shared;
                    shared.sessions.watch(
                        connection.id,
                        client,
                        directory.as_deref(),
                        &|directory, threads, terminals| {
                            shared.session_contents(directory, threads, terminals)
                        },
                        |sessions| {
                            responder.respond(WatchSessionsResponse {
                                directory: directory.clone(),
                                sessions,
                            })
                        },
                    )
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, unwatch_sessions),
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
            async move |request: WatchThreadsRequest, responder, cx: ConnectionTo<HostClient>| {
                if let Err(error) = on_watch.hello_info() {
                    return responder.respond_with_error(error);
                }
                on_watch
                    .shared
                    .watch(on_watch.id, cx, request.labels, |threads| {
                        responder.respond(WatchThreadsResponse { threads })
                    })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: DeclareToolsRequest, responder, cx: ConnectionTo<HostClient>| {
                match on_declare.declare_tools(request, cx) {
                    Ok(declared) => responder.respond(declared),
                    Err(error) => responder.respond_with_error(error),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, answer_tool),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: UnwatchThreadsRequest, responder, _cx| {
                on_unwatch.shared.unwatch(on_unwatch.id);
                responder.respond(Empty {})
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: CreateThreadRequest, responder, cx: ConnectionTo<HostClient>| {
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
            async move |request: AttachThreadRequest, responder, cx: ConnectionTo<HostClient>| {
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
            answer!(connection, reopen_thread),
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
            answer!(connection, rename_thread),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, label_thread),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, set_successor),
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            answer!(connection, report_thread),
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

/// The methods a service may ask (ADR 0027): its hello, and what starting headless turns,
/// following threads, naming the ones it starts, serving tools and reaching the person's other
/// Hosts for this Host's agents (ADR 0029) need; carrying the person's devices' connections,
/// which only the Dispatcher the Host joined may ask (ADR 0030); and making a Bot's home, a
/// repository of its own (`repos/init`, WVE-178).
const FOR_SERVICES: [&str; 22] = [
    "host/hello",
    "host/challenge",
    "host/status",
    "agents/list",
    "threads/list",
    "threads/get",
    "threads/watch",
    "threads/unwatch",
    "thread/run",
    "thread/attach",
    "thread/detach",
    "thread/rename",
    "thread/setSuccessor",
    "thread/label",
    "thread/report",
    "service/declareTools",
    "service/answerTool",
    "queue/add",
    "turn/steer",
    "turn/cancel",
    "dispatcher/carry",
    "repos/init",
];

/// What in `request` a client allowed only `methods` may not ask, if anything: another method,
/// or attaching as anything but an observer, which would make it a client of the thread.
fn not_allowed(request: &UntypedMessage, methods: &[&str]) -> Option<String> {
    let method = request.method.as_str();
    let flag = |name: &str| {
        request
            .params
            .get(name)
            .and_then(serde_json::Value::as_bool)
    };
    if !methods.contains(&method) {
        Some(method.to_owned())
    } else if method == "thread/attach" && flag("observe") != Some(true) {
        Some("thread/attach without observe".to_owned())
    } else if method == "thread/run" && flag("attach") == Some(true) {
        Some("thread/run with attach".to_owned())
    } else {
        None
    }
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

/// The services an interactive thread's agent is offered: a local client can run its
/// command for terminal sign-in.
fn interactive(options: ClientOptions) -> ClientOptions {
    ClientOptions {
        terminal_auth: true,
        ..options
    }
}

/// Nobody can sign in at a terminal for a headless thread.
fn headless(options: ClientOptions) -> ClientOptions {
    ClientOptions {
        terminal_auth: false,
        ..options
    }
}

/// Where agents asked things outside any thread start.
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
            Peer::Joined(link) | Peer::Carried { link, .. } => {
                Some(Arc::clone(link) as Arc<dyn Backlog>)
            }
        }
    }

    fn hello_info(&self) -> Result<Hello, Error> {
        lock(&self.hello)
            .clone()
            .ok_or_else(|| errors::unauthenticated("say host/hello first"))
    }

    /// `host/status`. A local client asking while the Host couldn't remove the Serve entry it
    /// made for remote clients before has it look again first (WVE-197).
    async fn status(&self, _request: StatusRequest) -> Result<HostStatus, Error> {
        self.hello_info()?;
        if matches!(self.peer, Peer::Local) {
            self.shared.serve_entry.recheck(&self.shared.devices).await;
        }
        Ok(self.shared.status())
    }

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

    /// `dispatcher/join`: join the Dispatcher with the code it gave (ADR 0030).
    async fn join_dispatcher(
        &self,
        request: JoinDispatcherRequest,
    ) -> Result<JoinDispatcherResponse, Error> {
        self.local_hello()?;
        crate::dispatcher::join(&self.shared, request)
            .await
            .map(|dispatcher| JoinDispatcherResponse { dispatcher })
    }

    /// `dispatcher/leave`: forget the Dispatcher the Host joined.
    async fn leave_dispatcher(&self, _request: LeaveDispatcherRequest) -> Result<Empty, Error> {
        self.local_hello()?;
        crate::dispatcher::leave(&self.shared).map(|()| Empty {})
    }

    /// `dispatcher/carry`: open a connection to the Dispatcher for a device's, which only the
    /// Dispatcher the Host joined may ask, over the connection the Host opened to it.
    async fn carry(&self, request: CarryRequest) -> Result<Empty, Error> {
        self.hello_info()?;
        if !matches!(self.peer, Peer::Joined(_)) {
            return Err(Error::new(
                errors::FORBIDDEN,
                "only the Dispatcher this Host joined carries devices' connections to it",
            ));
        }
        crate::dispatcher::carry(&self.shared, request)
            .await
            .map(|()| Empty {})
    }

    /// The client's hello, if it's local: remote clients may not administer the Host.
    fn local_hello(&self) -> Result<Hello, Error> {
        let hello = self.hello_info()?;
        match self.peer {
            Peer::Local => Ok(hello),
            Peer::Joined(_) | Peer::Carried { .. } => Err(errors::forbidden()),
        }
    }

    /// The name of the device a remote client is, for its turns' origins.
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

    /// The error `request` gets when this client may not ask it: a service may ask only its
    /// own methods.
    fn refusal(&self, request: &UntypedMessage) -> Option<Error> {
        let device = lock(&self.device);
        let device = device.as_ref()?;
        if device.service {
            not_allowed(request, &FOR_SERVICES).map(|asked| errors::not_for_services(&asked))
        } else {
            None
        }
    }

    /// The name of the service this client proved at hello, if it's one.
    fn service_name(&self) -> Option<String> {
        lock(&self.device)
            .as_ref()
            .filter(|device| device.service)
            .map(|device| device.name.clone())
    }

    /// The origin of a turn or steer this client sends for `caller`, the thread on another
    /// Host whose agent asks, or with `origin`, what started it, which only a service names;
    /// otherwise this client's, or `otherwise` when given.
    fn origin_for(
        &self,
        hello: &Hello,
        caller: Option<OtherThread>,
        origin: Option<ServiceOrigin>,
        otherwise: Option<TurnOrigin>,
    ) -> Result<TurnOrigin, Error> {
        match (caller, origin) {
            (Some(_), Some(_)) => {
                Err(Error::invalid_params().data("a turn names a caller or an origin, not both"))
            }
            (Some(caller), None) => {
                self.service_name().ok_or_else(|| {
                    Error::invalid_params()
                        .data("only a service names a thread on another Host that asks")
                })?;
                if caller.host == self.shared.devices.host_id() {
                    return Err(Error::invalid_params()
                        .data("a caller on another Host names another Host than this one"));
                }
                Ok(TurnOrigin::Thread {
                    thread_id: caller.thread_id,
                    host: Some(caller.host),
                    host_name: caller.host_name,
                    report: false,
                })
            }
            (None, Some(ServiceOrigin { label, id })) => {
                let name = self.service_name().ok_or_else(|| {
                    Error::invalid_params().data("only a service names what started a turn")
                })?;
                Ok(TurnOrigin::Service { name, label, id })
            }
            (None, None) => Ok(otherwise.unwrap_or_else(|| self.origin(hello))),
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
        // The Dispatcher, or a device of the Dispatcher's, which the Dispatcher revokes: the Host
        // keeps no record of it, and its connection closes when the Dispatcher closes the
        // device's end.
        if let (Some(device), Peer::Joined(link) | Peer::Carried { link, .. }) =
            (&device, &self.peer)
        {
            // Only local clients may run a sign-in command on the Host's computer.
            capabilities.terminal_sign_in = false;
            link.proved();
            *lock(&self.device) = Some(device.clone());
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
                UPDATES_FEATURE.to_owned(),
                CLIENT_TOOLS_FEATURE.to_owned(),
                WATCH_FEATURE.to_owned(),
                LIST_FILES_FEATURE.to_owned(),
                RENAME_FEATURE.to_owned(),
                SUCCESSORS_FEATURE.to_owned(),
                LABELS_FEATURE.to_owned(),
                CONTEXT_FEATURE.to_owned(),
                SERVICE_TOOLS_FEATURE.to_owned(),
                WORKTREES_FEATURE.to_owned(),
                REPOS_INIT_FEATURE.to_owned(),
                QUEUE_FEATURE.to_owned(),
                REQUEST_KEYS_FEATURE.to_owned(),
                GET_FEATURE.to_owned(),
                TURN_IDS_FEATURE.to_owned(),
                DRAIN_FEATURE.to_owned(),
                OBSERVE_FEATURE.to_owned(),
                OTHER_HOSTS_FEATURE.to_owned(),
                MCP_SERVERS_FEATURE.to_owned(),
                CARRY_FEATURE.to_owned(),
                SESSIONS_FEATURE.to_owned(),
                SESSIONS_END_FEATURE.to_owned(),
                SESSIONS_ADD_FEATURE.to_owned(),
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
                unstable: vec!["subagents".to_owned()],
            },
            device,
        })
    }

    /// Who the connection is, by where it comes from and what it says: nobody in particular
    /// for a local client; the Dispatcher the Host joined, proving its key, on the connection the
    /// Host opened to it; and the device the Dispatcher named, on one it carries. A Host pairs
    /// with nothing (WVE-197): devices pair with the Dispatcher and reach the Host through it, so
    /// it refuses `pair` everywhere, and `token`, which stays reserved. A connection to the
    /// Dispatcher that proves nothing is closed after the error.
    fn identify(&self, auth: Auth) -> Result<Option<DeviceInfo>, Error> {
        match &self.peer {
            Peer::Local => match auth {
                Auth::Local => Ok(None),
                Auth::Token { .. } => Err(errors::unauthenticated("tokens aren't accepted")),
                Auth::Device { .. } | Auth::Pair { .. } => Err(errors::unauthenticated(
                    "devices pair with the Dispatcher and reach this Host through it",
                )),
                Auth::Dispatcher => Err(errors::unauthenticated(
                    "only a connection the Host opened for the Dispatcher takes its word for a \
                     device",
                )),
            },
            Peer::Joined(link) => {
                let dispatcher = match auth {
                    Auth::Device {
                        device_id,
                        signature,
                    } => link.take_challenge().and_then(|nonce| {
                        self.shared.devices.verify(&device_id, &nonce, &signature)
                    }),
                    Auth::Local | Auth::Token { .. } | Auth::Pair { .. } | Auth::Dispatcher => None,
                };
                if dispatcher.is_none() {
                    tracing::info!(
                        "refused a hello on the connection to the Dispatcher that didn't prove its key"
                    );
                    link.close_after_next(CLOSE_UNAUTHENTICATED);
                    return Err(errors::unauthenticated(
                        "this device couldn't be authenticated",
                    ));
                }
                Ok(dispatcher)
            }
            Peer::Carried { link, device } => {
                if matches!(auth, Auth::Dispatcher) {
                    return Ok(Some(device.clone()));
                }
                tracing::info!("refused a carried connection's hello that wasn't the Dispatcher's");
                link.close_after_next(CLOSE_UNAUTHENTICATED);
                Err(errors::unauthenticated(
                    "a connection the Dispatcher carries says auth: dispatcher, for the device it \
                     named",
                ))
            }
        }
    }

    /// `host/challenge`, for the Dispatcher the Host joined to sign at hello, on the connection
    /// the Host opened to it.
    fn challenge(&self) -> Result<ChallengeResponse, Error> {
        let link = match &self.peer {
            Peer::Joined(link) => link,
            Peer::Carried { .. } => {
                return Err(errors::unauthenticated(
                    "a carried connection signs nothing: it says auth: dispatcher",
                ));
            }
            Peer::Local => {
                return Err(errors::unauthenticated(
                    "challenges are for the Dispatcher this Host joined",
                ));
            }
        };
        let (nonce, expires_at) = link.challenge();
        Ok(ChallengeResponse {
            host_id: self.shared.devices.host_id(),
            nonce,
            expires_at,
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

    /// The agents to sign in: the spare ones of `agent`, which the next threads take, or one
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

    /// `files/list`, off the dispatch loop's thread: a slow disk shouldn't hold it up. Its home
    /// is the one a `~/` directory lands in (`under_home`), so a client on another computer
    /// can tell where that is (WVE-189).
    async fn list_files(&self, request: ListFilesRequest) -> Result<ListFilesResponse, Error> {
        self.hello_info()?;
        let home = self.shared.home();
        tokio::task::spawn_blocking(move || files::list(&request, &home))
            .await
            .map_err(|error| Error::internal_error().data(error.to_string()))?
    }

    async fn list_threads(
        &self,
        request: ListThreadsRequest,
    ) -> Result<ListThreadsResponse, Error> {
        self.hello_info()?;
        list_threads(&self.shared, request).await
    }

    async fn get_thread(&self, request: GetThreadRequest) -> Result<GetThreadResponse, Error> {
        self.hello_info()?;
        get_thread(&self.shared, request).await
    }

    /// `worktrees/list`: the repository's worktrees and the threads in each.
    async fn list_worktrees(
        &self,
        request: ListWorktreesRequest,
    ) -> Result<ListWorktreesResponse, Error> {
        self.hello_info()?;
        let git = &self.shared.git;
        let repository = git.repository(&request.repo).await?;
        let default = git.default_branch(&repository).await;
        let mut worktrees = git.worktrees(&repository, default.as_ref()).await;
        let mut threads = self.shared.thread_directories();
        threads.sort_by_key(|(_, _, last_activity)| std::cmp::Reverse(*last_activity));
        for (thread_id, dir, _) in threads {
            // The deepest worktree it's in, as one can sit inside another.
            if let Some(worktree) = worktrees
                .iter_mut()
                .filter(|worktree| dir.starts_with(&worktree.path))
                .max_by_key(|worktree| worktree.path.components().count())
            {
                worktree.threads.push(thread_id);
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

    /// `worktrees/remove`: refused while a thread in it is busy, or when it has changes
    /// unless forced; otherwise its threads close and it goes, with its branch when merged.
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
        self.shared.sessions.end_inside(&path);
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
        let path = git::canonical(&request.path);
        let closed = self.shared.release(&path).await?;
        // Whatever asked is about to remove it.
        self.shared.sessions.end_inside(&path);
        Ok(ReleaseWorktreeResponse { closed })
    }

    /// `repos/init`: a repository of its own, with the client's first files committed there.
    async fn init_repository(
        &self,
        request: InitRepositoryRequest,
    ) -> Result<InitRepositoryResponse, Error> {
        self.hello_info()?;
        repos::init(&self.shared, request).await
    }

    /// `sessions/list`: every Session, as the Host reads where each is again, but those whose
    /// directory is gone, which end.
    async fn list_sessions(
        &self,
        _request: ListSessionsRequest,
    ) -> Result<ListSessionsResponse, Error> {
        self.hello_info()?;
        let shared = &self.shared;
        shared.sessions.end_gone();
        for directory in shared.sessions.directories() {
            let git = shared.git.locate(&directory).await;
            shared.sessions.located(&directory, git);
        }
        Ok(ListSessionsResponse {
            sessions: shared.sessions.list(&|directory, threads, terminals| {
                shared.session_contents(directory, threads, terminals)
            }),
        })
    }

    /// `sessions/get`: the Session the directory is in, with its layout.
    async fn get_session(&self, request: GetSessionRequest) -> Result<SessionResponse, Error> {
        self.hello_info()?;
        let shared = &self.shared;
        let (directory, git) = shared.session_scope(&request.directory).await?;
        shared.sessions.located(&directory, git);
        let session = shared
            .sessions
            .get(&directory, &|directory, threads, terminals| {
                shared.session_contents(directory, threads, terminals)
            })
            .ok_or_else(|| errors::no_session(&directory))?;
        Ok(SessionResponse { session })
    }

    /// `sessions/set`: a new layout for the Session the directory is in; the newest write wins.
    async fn set_session(&self, request: SetSessionRequest) -> Result<SessionResponse, Error> {
        self.hello_info()?;
        let shared = &self.shared;
        let (directory, git) = shared.session_scope(&request.directory).await?;
        let session = shared.sessions.set(
            &directory,
            request.layout,
            request.if_revision,
            git,
            &|directory, threads, terminals| shared.session_contents(directory, threads, terminals),
        )?;
        Ok(SessionResponse { session })
    }

    /// `sessions/add`: threads and terminals in the Session's directory are the Session's from
    /// now on, which is made first if the directory has none.
    async fn add_to_session(&self, request: AddToSessionRequest) -> Result<SessionResponse, Error> {
        self.hello_info()?;
        let shared = &self.shared;
        let (directory, git) = shared.session_scope(&request.directory).await?;
        shared
            .in_directory(&directory, &request.threads, &request.terminals)
            .await?;
        let session = shared.sessions.add(
            &directory,
            &request.threads,
            &request.terminals,
            git,
            &|directory, threads, terminals| shared.session_contents(directory, threads, terminals),
        );
        Ok(SessionResponse { session })
    }

    /// `sessions/end`: end the Session the directory is in, for good, unless something of its
    /// is busy: its threads close, its terminals end, and it's forgotten.
    async fn end_session(&self, request: EndSessionRequest) -> Result<Empty, Error> {
        self.hello_info()?;
        let shared = &self.shared;
        // A directory that's gone is its own Session's, if it has one.
        let directory = match shared.session_scope(&request.directory).await {
            Ok((directory, _)) => directory,
            Err(_) => git::canonical(&request.directory),
        };
        if !shared.sessions.has(&directory) {
            return Err(errors::no_session(&directory));
        }
        shared.close_session(&directory).await?;
        shared.sessions.end(&directory);
        Ok(Empty {})
    }

    /// The directory `sessions/watch` watches, as the Host resolves it; none for every Session.
    async fn watched_session(
        &self,
        request: WatchSessionsRequest,
    ) -> Result<Option<PathBuf>, Error> {
        self.hello_info()?;
        match request.directory {
            Some(directory) => Ok(Some(self.shared.session_scope(&directory).await?.0)),
            None => Ok(None),
        }
    }

    async fn unwatch_sessions(&self, request: UnwatchSessionsRequest) -> Result<Empty, Error> {
        self.hello_info()?;
        self.shared
            .sessions
            .unwatch(self.id, request.directory.as_deref());
        Ok(Empty {})
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
        Ok(self.shared.session_scope(directory).await?.0)
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
        let (scope, _) = self.shared.session_scope(&request.directory).await?;
        let opened_from = request.opened_from.clone();
        let start = terminals::Start {
            id: terminals::new_id(),
            directory: request.directory,
            scope: scope.clone(),
            label: request.label,
            opened_from: request.opened_from,
            command: request.command.filter(|command| !command.is_empty()),
            size: request.size.unwrap_or(terminals::DEFAULT_SIZE),
            env: self.shared.config.environment.vars.clone(),
        };
        let terminal = terminals.start(start).await?;
        // One opened from a Session's thread is that Session's (WVE-203).
        if let Some(by) = &opened_from {
            self.shared
                .started_in_session(&scope, by, None, Some(&terminal.id));
        }
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

    /// `agent_id`'s threads: the Host's own in the directory first, open ones and then ones
    /// a stopped Host left open within the idle grace of their last activity; then the
    /// agent's own listing, paged by its cursor.
    async fn create(&self, request: CreateThreadRequest) -> Result<Ready, Error> {
        self.hello_info()?;
        check_labels(&request.labels)?;
        let cwd = under_home(&self.shared, request.cwd);
        directory_here(&cwd)?;
        let agent = self.shared.resolve(&request.agent_id).await?;
        let (instance, git) = tokio::join!(
            self.shared
                .instance(&agent, &cwd, interactive(agent.options)),
            self.shared.git.locate(&cwd),
        );
        let instance = instance?;
        let additional_directories = request
            .additional_directories
            .into_iter()
            .map(|dir| under_home(&self.shared, dir))
            .collect();
        let (setup, mut notices, servers) =
            setup(&self.shared, &agent, &instance, cwd, additional_directories);
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
        let thread = open(
            &self.shared,
            response.session_id,
            instance,
            &agent,
            setup.cwd,
            setup.additional_directories,
            request.policy.unwrap_or_default(),
            snapshot,
            Origin::New {
                started_by: None,
                started_by_host: None,
                labels: request.labels,
            },
            servers,
            git,
        )?;
        thread.opened_by(self.origin(&self.hello_info()?));
        let trace = self.trace(&thread, request.trace)?;
        updates::look_for_update(&self.shared, &thread);
        Ok(Ready {
            thread,
            notices,
            trace,
        })
    }

    /// Open a thread the client named: attach to it if it's open, otherwise open it in its
    /// agent (from its journal, if a stopped Host left it open).
    async fn open_existing(&self, request: &AttachThreadRequest) -> Result<Ready, Error> {
        self.hello_info()?;
        let thread_id = &request.thread_id;
        let (live, known) = {
            let registry = self.shared.registry();
            let live = registry.live(thread_id);
            let root = live
                .as_ref()
                .map_or_else(|| thread_id.clone(), |thread| thread.summary().thread_id);
            (live, registry.known.get(&root).cloned())
        };
        // A thread belongs to the agent it was started with.
        let recorded_agent = live
            .as_ref()
            .map(|thread| thread.agent_id.clone())
            .or_else(|| {
                known
                    .as_ref()
                    .and_then(Recorded::agent_id)
                    .map(str::to_owned)
            });
        if let (Some(recorded), Some(asked)) = (&recorded_agent, &request.agent_id)
            && recorded != asked
        {
            return Err(errors::wrong_agent(&thread_id.to_string(), recorded));
        }
        if let Some(thread) = live {
            let trace = self.trace(&thread, request.trace)?;
            updates::look_for_update(&self.shared, &thread);
            return Ok(Ready {
                thread,
                notices: Vec::new(),
                trace,
            });
        }
        // An observer follows a thread that's open; it never opens one.
        if request.observe {
            return Err(errors::thread_not_open(&thread_id.to_string()));
        }
        let agent_id = recorded_agent
            .or_else(|| request.agent_id.clone())
            .ok_or_else(|| errors::unknown_thread(&thread_id.to_string()))?;
        let cwd = known
            .as_ref()
            .map(|recorded| recorded.cwd.clone())
            .or_else(|| request.cwd.clone().map(|cwd| under_home(&self.shared, cwd)))
            .ok_or_else(|| errors::unknown_thread(&thread_id.to_string()))?;
        let agent = self.shared.resolve(&agent_id).await?;
        let (instance, git) = tokio::join!(
            self.shared
                .instance(&agent, &cwd, interactive(agent.options)),
            self.shared.git.locate(&cwd),
        );
        let instance = instance?;
        let (setup, notices, servers) = setup(&self.shared, &agent, &instance, cwd, Vec::new());
        match reopen(
            &self.shared,
            instance,
            thread_id.clone(),
            setup,
            servers,
            &agent,
            PermissionPolicy::ask(),
            true,
            git,
        )
        .await
        {
            Ok(thread) => {
                thread.opened_by(self.origin(&self.hello_info()?));
                let trace = self.trace(&thread, request.trace)?;
                updates::look_for_update(&self.shared, &thread);
                Ok(Ready {
                    thread,
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

    /// Trace the thread's agent for this client, when it asked.
    fn trace(&self, thread: &ThreadHandle, wanted: bool) -> Result<Option<PathBuf>, Error> {
        if !wanted {
            return Ok(None);
        }
        let path = self.shared.trace_path(&thread.summary().thread_id)?;
        let trace = ProtocolTrace::create(&path).map_err(|error| {
            Error::internal_error().data(format!(
                "creating the protocol trace {}: {error}",
                path.display()
            ))
        })?;
        thread.traces.add(self.id, trace);
        Ok(Some(path))
    }

    /// Attach this client to `ready`'s thread, answering through `reply` before its replay.
    fn attach_to(
        &self,
        ready: Ready,
        cx: ConnectionTo<HostClient>,
        from: ReplayFrom,
        observer: bool,
        reply: AttachReply,
    ) {
        let thread_id = ready.thread.summary().thread_id;
        lock(&self.attached).insert(thread_id);
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
            ready.thread.commands.send(command)
        {
            reply.fail(thread::ended());
        }
    }

    async fn detach(&self, request: DetachThreadRequest) -> Result<Empty, Error> {
        self.hello_info()?;
        let live = self.shared.registry().live(&request.thread_id);
        if let Some(thread) = live
            && lock(&self.attached).remove(&thread.summary().thread_id)
        {
            thread.traces.remove(self.id);
            let client = self.id;
            match request.close {
                CloseWhen::Never => thread.send(Command::Detach { client })?,
                CloseWhen::IfUnused => {
                    thread
                        .finish(|done| Command::Close { client, done })
                        .await?;
                }
            }
        }
        Ok(Empty {})
    }

    async fn close(&self, request: CloseThreadRequest) -> Result<Empty, Error> {
        let hello = self.hello_info()?;
        let thread = self.live(&request.thread_id)?;
        let by = Some(self.origin(&hello));
        thread
            .finish(|done| Command::End {
                reason: "closed by a client".to_owned(),
                by,
                done,
            })
            .await?;
        Ok(Empty {})
    }

    /// `thread/reopen`: answered once the thread runs in its new process, after any turn.
    async fn reopen_thread(
        &self,
        request: ReopenThreadRequest,
    ) -> Result<ReopenThreadResponse, Error> {
        self.hello_info()?;
        let thread = self.live(&request.thread_id)?;
        let (reply, reopened) = oneshot::channel();
        thread.send(Command::Reopen { reply })?;
        reopened.await.map_err(|_| thread::ended())?
    }

    async fn delete(&self, request: DeleteThreadRequest) -> Result<Empty, Error> {
        let hello = self.hello_info()?;
        let thread_id = request.thread_id;
        let live = self.shared.registry().live(&thread_id);
        let known = self.shared.registry().known.get(&thread_id).cloned();
        let agent_id = live
            .as_ref()
            .map(|thread| thread.agent_id.clone())
            .or_else(|| {
                known
                    .as_ref()
                    .and_then(Recorded::agent_id)
                    .map(str::to_owned)
            })
            .or(request.agent_id)
            .ok_or_else(|| errors::unknown_thread(&thread_id.to_string()))?;
        if let Some(thread) = live {
            let by = Some(self.origin(&hello));
            let _ = thread
                .finish(|done| Command::End {
                    reason: "deleted".to_owned(),
                    by,
                    done,
                })
                .await;
        }
        let cwd = known
            .as_ref()
            .map_or_else(home, |recorded| recorded.cwd.clone());
        // The agent's part runs it in the thread's directory. One that's gone, as a removed
        // worktree, leaves the agent its own history of the thread; the Host forgets it anyway.
        if cwd.is_dir() {
            self.delete_in_agent(&agent_id, &cwd, &thread_id).await?;
        } else {
            tracing::info!(%thread_id, cwd = %cwd.display(), "deleting a thread whose directory is gone; its agent keeps its history");
        }
        self.shared.registry().known.remove(&thread_id);
        if let Some(dir) = &self.shared.config.journals {
            let _ = std::fs::remove_file(journal::path_for(dir, &thread_id));
        }
        self.shared.tell_removed(thread_id);
        Ok(Empty {})
    }

    /// Delete a thread in its agent, run in `cwd`, when the agent can delete threads; one that
    /// can't keeps its own history of it.
    async fn delete_in_agent(
        &self,
        agent_id: &str,
        cwd: &Path,
        thread_id: &ThreadId,
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
            handle.delete_session(thread_id.clone()).await?;
        }
        Ok(())
    }

    fn live(&self, thread_id: &ThreadId) -> Result<ThreadHandle, Error> {
        live(&self.shared, thread_id)
    }

    /// `thread/rename`: a title of the Host's, which the thread keeps.
    async fn rename_thread(&self, request: RenameThreadRequest) -> Result<Empty, Error> {
        let hello = self.hello_info()?;
        let title =
            thread::title(&request.title).map_err(|why| Error::invalid_params().data(why))?;
        let thread = self.live(&request.thread_id)?;
        let by = TurnOrigin::Client {
            name: hello.client.name,
            id: self.client_id(),
            device: self.device_name(),
        };
        thread
            .finish(|done| Command::Rename {
                title,
                by: Some(by),
                done,
            })
            .await?;
        Ok(Empty {})
    }

    /// The paired service this client proved at hello, if it's one.
    fn service(&self) -> Result<DeviceInfo, Error> {
        lock(&self.device)
            .clone()
            .filter(|device| device.service)
            .ok_or_else(|| {
                Error::new(
                    errors::FORBIDDEN,
                    "only a service paired as one declares and answers tools",
                )
            })
    }

    /// `service/declareTools`: the tools this service serves, from this connection (WVE-171).
    fn declare_tools(
        &self,
        request: DeclareToolsRequest,
        cx: ConnectionTo<HostClient>,
    ) -> Result<DeclareToolsResponse, Error> {
        self.hello_info()?;
        let service = self.service()?;
        let names = self
            .shared
            .devices
            .declare_tools(&service.id, request.tools, request.hosts)
            .map_err(|why| Error::invalid_params().data(why))?;
        self.shared.service_tools.serve(&service.id, self.id, cx);
        Ok(DeclareToolsResponse { names })
    }

    /// `service/answerTool`: this service's answer to a call made to it.
    async fn answer_tool(&self, request: AnswerToolRequest) -> Result<Empty, Error> {
        self.hello_info()?;
        let service = self.service()?;
        self.shared
            .service_tools
            .answer(&service.id, &request.call_id, request.result)?;
        Ok(Empty {})
    }

    /// `thread/report`: a service's report on a thread on another Host to the thread whose
    /// agent began a turn there (ADR 0029), told as the Host tells its own threads' reports.
    async fn report_thread(&self, request: ReportThreadRequest) -> Result<Empty, Error> {
        self.hello_info()?;
        self.service()?;
        let digest = admissions::digest(&ReportThreadRequest {
            key: None,
            ..request.clone()
        });
        let ReportThreadRequest {
            thread_id,
            about,
            text,
            key,
        } = request;
        if about.host == self.shared.devices.host_id() {
            return Err(Error::invalid_params().data("a report is on a thread on another Host"));
        }
        let shared = Arc::clone(&self.shared);
        let told = thread_id.clone();
        keyed(
            &self.shared,
            key,
            "thread/report",
            digest,
            Some(&told),
            |_| Some(Empty {}),
            Empty::clone,
            async |_key| {
                let host = Some((about.host, about.host_name));
                crate::host_tools::tell(shared, thread_id, about.thread_id, host, text)
                    .await
                    .map(|()| Empty {})
                    .map_err(|why| Error::invalid_params().data(why))
            },
        )
        .await
    }

    /// `thread/label`: add labels to an open thread and take others off (WVE-173).
    async fn label_thread(
        &self,
        request: LabelThreadRequest,
    ) -> Result<LabelThreadResponse, Error> {
        let hello = self.hello_info()?;
        let LabelThreadRequest {
            thread_id,
            add,
            remove,
        } = request;
        check_labels(&add)?;
        let thread = self.live(&thread_id)?;
        let labels = thread
            .finish(|done| Command::Label {
                add,
                remove,
                by: Some(self.origin(&hello)),
                done,
            })
            .await??;
        Ok(LabelThreadResponse { labels })
    }

    /// `thread/setSuccessor`: name the thread an open one's work goes on in (WVE-168).
    async fn set_successor(&self, request: SetSuccessorRequest) -> Result<Empty, Error> {
        let hello = self.hello_info()?;
        let SetSuccessorRequest {
            thread_id,
            successor,
        } = request;
        let thread = self.live(&thread_id)?;
        if successor == thread_id {
            return Err(Error::invalid_params().data("a thread can't continue in itself"));
        }
        {
            let registry = self.shared.registry();
            if !registry.known.contains_key(&successor) {
                return Err(errors::unknown_thread(&successor.to_string()));
            }
            // Its successors mustn't lead back here, or following them would never end.
            let mut next = Some(successor.clone());
            for _ in 0..MAX_SUCCESSORS {
                let Some(at) = next else { break };
                if at == thread_id {
                    return Err(Error::invalid_params().data(format!(
                        "{successor} already continues, through its successors, in this thread"
                    )));
                }
                next = registry
                    .known
                    .get(&at)
                    .and_then(|recorded| recorded.successor.clone());
            }
        }
        thread
            .finish(|done| Command::SetSuccessor {
                successor,
                by: Some(self.origin(&hello)),
                done,
            })
            .await??;
        Ok(Empty {})
    }

    async fn set_mode(&self, request: SetModeRequest) -> Result<Empty, Error> {
        self.hello_info()?;
        let thread = self.live(&request.thread_id)?;
        thread
            .agent
            .set_mode(request.thread_id.clone(), request.mode_id.clone())
            .await?;
        let update = SessionUpdate::CurrentModeUpdate(CurrentModeUpdate::new(request.mode_id));
        thread.send(Command::Changed {
            notification: Box::new(SessionNotification::new(request.thread_id, update)),
        })?;
        Ok(Empty {})
    }

    async fn set_config_option(
        &self,
        request: SetConfigOptionRequest,
    ) -> Result<SetSessionConfigOptionResponse, Error> {
        self.hello_info()?;
        let thread = self.live(&request.thread_id)?;
        let options = thread
            .agent
            .set_config_option(request.thread_id.clone(), request.config_id, request.value)
            .await?;
        let update = SessionUpdate::ConfigOptionUpdate(ConfigOptionUpdate::new(options.clone()));
        thread.send(Command::Changed {
            notification: Box::new(SessionNotification::new(request.thread_id, update)),
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
            thread_id,
            prompt,
            key,
        } = request;
        let root = self.shared.registry().root(&thread_id);
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
                let thread = self.live(&thread_id)?;
                let (reply, started) = oneshot::channel();
                thread.send(Command::Prompt {
                    origin,
                    thread_id,
                    prompt,
                    key,
                    reply,
                })?;
                let (seq, turn_id) = started.await.map_err(|_| thread::ended())??;
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
        let origin =
            self.origin_for(&hello, request.caller.clone(), request.origin.clone(), None)?;
        add_queued(&self.shared, request, origin).await
    }

    async fn remove_queued(
        &self,
        request: RemoveQueuedRequest,
    ) -> Result<RemoveQueuedResponse, Error> {
        let hello = self.hello_info()?;
        let thread = self.live(&request.thread_id)?;
        let (reply, removed) = oneshot::channel();
        thread.send(Command::Unqueue {
            queued_id: request.queued_id,
            by: self.origin(&hello),
            reply,
        })?;
        removed.await.map_err(|_| thread::ended())
    }

    async fn resume_queue(&self, request: ResumeQueueRequest) -> Result<Empty, Error> {
        let hello = self.hello_info()?;
        let thread = self.live(&request.thread_id)?;
        let by = self.origin(&hello);
        thread
            .finish(|done| Command::ResumeQueue { by, done })
            .await?;
        Ok(Empty {})
    }

    async fn steer_turn(&self, request: SteerTurnRequest) -> Result<SteerTurnResponse, Error> {
        let hello = self.hello_info()?;
        let origin =
            self.origin_for(&hello, request.caller.clone(), request.origin.clone(), None)?;
        steer_turn(&self.shared, request, origin).await
    }

    async fn cancel_turn(&self, request: CancelTurnRequest) -> Result<Empty, Error> {
        self.hello_info()?;
        cancel_turn(&self.shared, request)
    }

    async fn answer_pending(&self, request: AnswerPendingRequest) -> Result<Empty, Error> {
        self.hello_info()?;
        let thread = self.live(&request.thread_id)?;
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
        thread.send(Command::Answer {
            pending_id: request.pending_id,
            by: self.client_id(),
            answer,
            reply,
        })?;
        answered.await.map_err(|_| thread::ended())??;
        Ok(Empty {})
    }

    async fn run(
        &self,
        request: RunRequest,
        cx: ConnectionTo<HostClient>,
    ) -> Result<RunResponse, Error> {
        let hello = self.hello_info()?;
        // Another Host's agent starting a thread here, through a service: the thread is a
        // delegated thread of the one there that asks.
        let origin = self.origin_for(
            &hello,
            request.caller.clone(),
            request.origin.clone(),
            Some(TurnOrigin::Run {}),
        )?;
        let started_by = request
            .caller
            .as_ref()
            .map(|caller| caller.thread_id.clone());
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
        let answer = run_as(&self.shared, request, link, origin, started_by).await?;
        if attaching {
            lock(&self.attached).insert(answer.thread_id.clone());
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
        thread_id,
        prompt,
        key,
        caller: _,
        origin: _,
    } = request;
    keyed(
        shared,
        key,
        "queue/add",
        digest,
        Some(&thread_id),
        |work| {
            Some(AddQueuedResponse {
                queued_id: work.queued_id?,
                seq: work.seq,
                started: work.started,
            })
        },
        AddQueuedResponse::clone,
        async |key| {
            let thread = live(shared, &thread_id)?;
            if thread.summary().thread_id != thread_id {
                return Err(Error::invalid_params()
                    .data("a subagent thread has no queue: add to its parent's"));
            }
            let (reply, added) = oneshot::channel();
            thread.send(Command::Enqueue {
                origin,
                prompt,
                key,
                reply,
            })?;
            added.await.map_err(|_| thread::ended())?
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
    let thread = live(shared, &request.thread_id)?;
    let (reply, answered) = oneshot::channel();
    thread.send(Command::Steer(Steer {
        origin,
        thread_id: request.thread_id,
        prompt: request.prompt,
        reply,
    }))?;
    answered.await.map_err(|_| thread::ended())?
}

/// `turn/cancel`, for a client or a Host tool.
pub(crate) fn cancel_turn(
    shared: &Arc<Shared>,
    request: CancelTurnRequest,
) -> Result<Empty, Error> {
    let thread = live(shared, &request.thread_id)?;
    thread.send(Command::Cancel {
        thread_id: request.thread_id,
    })?;
    Ok(Empty {})
}

/// The open thread `thread_id` is, or belongs to as a subagent.
pub(crate) fn live(shared: &Shared, thread_id: &ThreadId) -> Result<ThreadHandle, Error> {
    shared
        .registry()
        .live(thread_id)
        .ok_or_else(|| errors::thread_not_open(&thread_id.to_string()))
}

/// `threads/list`, for a client or a Host tool.
pub(crate) async fn list_threads(
    shared: &Arc<Shared>,
    mut request: ListThreadsRequest,
) -> Result<ListThreadsResponse, Error> {
    request.cwd = request.cwd.map(|cwd| under_home(shared, cwd));
    match request.agent_id.clone() {
        None => {
            let repo = match &request.repo {
                Some(dir) => Some(shared.git.repository(dir).await?.primary),
                None => None,
            };
            let mut threads = shared.listings(request.cwd.as_deref(), repo.as_deref());
            if let Some(activity) = request.activity {
                threads.retain(|listing| listing.activity == Some(activity));
            }
            threads.retain(|listing| labelled(listing, &request.labels));
            Ok(ListThreadsResponse {
                threads,
                next_cursor: None,
            })
        }
        Some(_) if request.repo.is_some() => {
            Err(Error::invalid_params()
                .data("threads/list takes a repository only without an agent"))
        }
        Some(_) if request.activity.is_some() => {
            Err(Error::invalid_params()
                .data("threads/list takes an activity only without an agent"))
        }
        Some(_) if !request.labels.is_empty() => {
            Err(Error::invalid_params().data("threads/list takes labels only without an agent"))
        }
        Some(agent_id) => agent_threads(shared, &agent_id, request).await,
    }
}

/// Whether `listing` carries every one of `labels`.
pub(crate) fn labelled(listing: &ThreadListing, labels: &[String]) -> bool {
    labels.iter().all(|label| listing.labels.contains(label))
}

/// `threads/list` for one agent: the Host's own threads of it in the directory first, then the
/// agent's own listing.
async fn agent_threads(
    shared: &Arc<Shared>,
    agent_id: &str,
    request: ListThreadsRequest,
) -> Result<ListThreadsResponse, Error> {
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
        let (blank, open): (Vec<&ThreadHandle>, Vec<&ThreadHandle>) = registry
            .threads
            .values()
            .partition(|thread| thread.is_blank());
        let blank: HashSet<ThreadId> = blank
            .into_iter()
            .map(|thread| thread.summary().thread_id)
            .collect();
        let open: Vec<thread::Summary> = open.into_iter().map(ThreadHandle::summary).collect();
        (open, blank, registry.known.clone())
    };
    let mut leading: Vec<ThreadListing> = open
        .iter()
        .filter(|summary| summary.agent_id == agent.id && in_scope(&summary.cwd))
        .map(thread::Summary::listing)
        .collect();
    leading.sort_by_key(|listing| std::cmp::Reverse(listing.last_activity_at));
    let mut dormant_here: Vec<ThreadListing> = known
        .iter()
        .filter(|(thread_id, recorded)| {
            !recorded.closed
                && now_ms().saturating_sub(recorded.last_activity_ms) < grace_ms
                && in_scope(&recorded.cwd)
                && recorded.agent_id() == Some(agent.id.as_str())
                && !blank.contains(*thread_id)
                && !open.iter().any(|summary| summary.thread_id == **thread_id)
        })
        .map(|(thread_id, recorded)| dormant(thread_id, &agent.id, recorded))
        .collect();
    dormant_here.sort_by_key(|listing| std::cmp::Reverse(listing.last_activity_at));
    leading.extend(dormant_here);

    let mut threads = Vec::new();
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
                // one the thread was renamed to is the thread's.
                if title.is_some() {
                    listing.info.title = title;
                }
            }
            threads.push(listing);
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
            Some(recorded) if !recorded.closed => ThreadStatus::Suspended,
            _ => ThreadStatus::Closed,
        };
        let open = open
            .iter()
            .find(|summary| summary.thread_id == info.session_id);
        let listing = match open {
            Some(summary) => ThreadListing {
                info,
                ..summary.listing()
            },
            None => ThreadListing {
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
                started_by_host: known
                    .get(&info.session_id)
                    .and_then(|recorded| recorded.started_by_host.clone()),
                continued_in: known
                    .get(&info.session_id)
                    .and_then(|recorded| recorded.successor.clone()),
                labels: known
                    .get(&info.session_id)
                    .map(|recorded| recorded.labels.clone())
                    .unwrap_or_default(),
                context: known
                    .get(&info.session_id)
                    .and_then(|recorded| recorded.usage.context),
                last_compaction: known
                    .get(&info.session_id)
                    .and_then(|recorded| recorded.usage.last_compaction),
                opened_by: None,
                opened_at: None,
                info,
                agent_id: agent.id.clone(),
                state,
                activity: None,
                clients: 0,
            },
        };
        threads.push(listing);
    }
    Ok(ListThreadsResponse {
        threads,
        next_cursor: listed.next_cursor,
    })
}

/// `threads/get`, for a client or a Host tool: the thread as it lists, with its latest turn
/// from its journal, without opening it.
pub(crate) async fn get_thread(
    shared: &Arc<Shared>,
    request: GetThreadRequest,
) -> Result<GetThreadResponse, Error> {
    let unknown = || errors::unknown_thread(&request.thread_id.to_string());
    let (live, recorded) = {
        let registry = shared.registry();
        (
            registry.threads.get(&request.thread_id).cloned(),
            registry.known.get(&request.thread_id).cloned(),
        )
    };
    if let Some(thread) = live {
        if thread.is_blank() {
            return Err(unknown());
        }
        let (reply, latest) = oneshot::channel();
        thread.send(Command::LatestTurn {
            turn_id: request.turn_id.clone(),
            reply,
        })?;
        let latest_turn = latest.await.map_err(|_| thread::ended())?;
        return Ok(GetThreadResponse {
            thread: thread.summary().listing(),
            latest_turn: asked_for(&request, latest_turn)?,
        });
    }
    let recorded = recorded.ok_or_else(unknown)?;
    let agent_id = recorded.agent_id().ok_or_else(unknown)?.to_owned();
    let records = shared
        .config
        .journals
        .as_ref()
        .and_then(|dir| journal::read(&journal::path_for(dir, &request.thread_id)).ok())
        .unwrap_or_default();
    let mut thread = dormant(&request.thread_id, &agent_id, &recorded);
    thread.info.title = journal::shown_title(&records);
    let latest_turn = journal::turn(&records, &request.thread_id, request.turn_id.as_deref());
    Ok(GetThreadResponse {
        latest_turn: asked_for(&request, latest_turn)?,
        thread,
    })
}

/// The turn `threads/get` found: an error when it asked for one by id and there's none.
fn asked_for(
    request: &GetThreadRequest,
    found: Option<LatestTurn>,
) -> Result<Option<LatestTurn>, Error> {
    match (&request.turn_id, found) {
        (Some(turn_id), None) => Err(errors::unknown_turn(
            &request.thread_id.to_string(),
            turn_id,
        )),
        (_, found) => Ok(found),
    }
}

/// A thread a stopped Host left, or one closed since, as listings show it.
pub(crate) fn dormant(thread_id: &ThreadId, agent_id: &str, recorded: &Recorded) -> ThreadListing {
    let mut info = SessionInfo::new(thread_id.clone(), recorded.cwd.clone());
    info.title.clone_from(&recorded.title);
    ThreadListing {
        info,
        agent_id: agent_id.to_owned(),
        state: if recorded.closed {
            ThreadStatus::Closed
        } else {
            ThreadStatus::Suspended
        },
        activity: None,
        clients: 0,
        headless: recorded.policy.is_headless(),
        last_activity_at: Some(recorded.last_activity_ms),
        git: recorded.git.clone(),
        started_by: recorded.started_by.clone(),
        started_by_host: recorded.started_by_host.clone(),
        continued_in: recorded.successor.clone(),
        opened_by: None,
        opened_at: None,
        labels: recorded.labels.clone(),
        context: recorded.usage.context,
        last_compaction: recorded.usage.last_compaction,
    }
}

/// How a thread in `cwd` is set up for `instance`'s agent: the configured MCP servers it
/// accepts, the Host MCP server, and `additional_directories` if it accepts those; with a
/// notice for each left out, and the MCP servers for the thread to keep: the Host MCP
/// server's declaration, and every server's status.
pub(crate) fn setup(
    shared: &Arc<Shared>,
    agent: &Agent,
    instance: &Instance,
    cwd: PathBuf,
    mut additional_directories: Vec<PathBuf>,
) -> (SessionSetup, Vec<String>, Servers) {
    let capabilities = instance
        .init()
        .map(|init| init.agent_capabilities.clone())
        .unwrap_or_default();
    let configured = agent
        .config
        .configured_mcp_servers(&capabilities.mcp_capabilities);
    let mut notices: Vec<String> = configured
        .iter()
        .filter_map(ConfiguredMcpServer::warning)
        .collect();
    let mut mcp_servers: Vec<McpServer> = configured
        .iter()
        .filter_map(|server| server.server.as_ref().ok().cloned())
        .collect();
    let declared = match shared.mcp.declare(
        client_tools(agent),
        host_tools(agent),
        service_tools(shared, agent),
        &capabilities.mcp_capabilities,
        &shared.config.mcp_bridge,
    ) {
        Ok((server, binding)) => {
            mcp_servers.push(server);
            Ok(binding)
        }
        Err(why) => {
            notices.push(format!("weave's tools are unavailable: {why}"));
            Err(why)
        }
    };
    let servers = Servers::new(declared, &configured);
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
        servers,
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

/// The services' tools `agent` is offered: all they declared, less what its configuration's
/// `host_tools` leaves out (WVE-171).
fn service_tools(shared: &Shared, agent: &Agent) -> Vec<service_tools::Offered> {
    let chosen = agent.config.host_tools(&agent.id);
    shared
        .devices
        .service_tools()
        .into_iter()
        .filter(|offered| chosen.is_none_or(|names| names.contains(&offered.tool.name)))
        .collect()
}

/// `work`, done under the request key `key` when there is one (feature `requestKeys`): a
/// repeat gets the answer the first got, `remembered` from it, and starts nothing. A key a
/// stopped Host admitted without answering is looked for first in the journal of `thread_id`,
/// or every journal without one, where `recover` makes the answer from the work it finds.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn keyed<T, W>(
    shared: &Arc<Shared>,
    key: Option<String>,
    method: &str,
    digest: String,
    thread_id: Option<&ThreadId>,
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
        && let Some(answer) = admissions::find_work(dir, thread_id, ticket.key()).and_then(recover)
    {
        ticket.settle(&answer);
        return Ok(answer);
    }
    let answer = work(Some(ticket.key().to_owned())).await?;
    ticket.settle(&remembered(&answer));
    Ok(answer)
}

/// Open `thread_id`, which the Host doesn't have open, with no client: as `thread/run` does
/// before its turn, and as a Host starting does for a headless thread whose queue waits.
pub(crate) async fn take_up(
    shared: &Arc<Shared>,
    agent_id: &str,
    cwd: PathBuf,
    thread_id: ThreadId,
    policy: PermissionPolicy,
) -> Result<ThreadHandle, Error> {
    let agent = shared.resolve(agent_id).await?;
    let (thread, _notices) =
        take_up_with(shared, &agent, cwd, thread_id, Vec::new(), policy).await?;
    Ok(thread)
}

/// [`take_up`], with `agent` resolved already; with what's worth telling the client.
async fn take_up_with(
    shared: &Arc<Shared>,
    agent: &Agent,
    cwd: PathBuf,
    thread_id: ThreadId,
    additional_directories: Vec<PathBuf>,
    policy: PermissionPolicy,
) -> Result<(ThreadHandle, Vec<String>), Error> {
    let (instance, git) = tokio::join!(
        shared.instance(agent, &cwd, headless(agent.options)),
        shared.git.locate(&cwd),
    );
    let instance = instance?;
    let (setup, notices, servers) = setup(shared, agent, &instance, cwd, additional_directories);
    match reopen(
        shared, instance, thread_id, setup, servers, agent, policy, false, git,
    )
    .await
    {
        Ok(thread) => Ok((thread, notices)),
        Err((error, instance)) => {
            if let Some(instance) = instance {
                instance.connection.shutdown().await;
            }
            Err(error)
        }
    }
}

/// Open `request`'s thread and start its turn; see [`crate::Daemon::run`]. `link` is the
/// requesting client, attached before the prompt goes out so it sees the whole turn. Under a
/// request key, a repeat answers with the thread alone, attaching nobody.
pub(crate) async fn run(
    shared: &Arc<Shared>,
    request: RunRequest,
    link: Option<(ClientId, ClientLink)>,
) -> Result<RunResponse, Error> {
    run_as(shared, request, link, TurnOrigin::Run {}, None).await
}

/// [`run`], its turn from `origin`; a new thread is a delegated thread of `started_by`'s when
/// a thread's agent starts it (ADR 0020), on the other Host `origin` names when it's one's.
pub(crate) async fn run_as(
    shared: &Arc<Shared>,
    request: RunRequest,
    link: Option<(ClientId, ClientLink)>,
    origin: TurnOrigin,
    started_by: Option<ThreadId>,
) -> Result<RunResponse, Error> {
    let digest = admissions::digest(&RunRequest {
        key: None,
        ..request.clone()
    });
    let thread_id = request.thread_id.clone();
    let key = request.key.clone();
    keyed(
        shared,
        key,
        "thread/run",
        digest,
        thread_id.as_ref(),
        |work| {
            Some(RunResponse {
                thread_id: work.thread_id,
                turn_id: work.turn_id,
                state: None,
                policy: None,
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

/// `cwd`, under the Host's home when it starts with `~`, as another Host's agent, or a client on
/// another computer through the Dispatcher (WVE-195), names the directory it works in on its
/// own.
fn under_home(shared: &Shared, cwd: PathBuf) -> PathBuf {
    match cwd.strip_prefix("~") {
        Ok(rest) if rest.as_os_str().is_empty() => shared.home(),
        Ok(rest) => shared.home().join(rest),
        Err(_) => cwd,
    }
}

/// A new thread's directory has to be one on this Host's computer, which a client on another
/// computer may not know.
fn directory_here(cwd: &Path) -> Result<(), Error> {
    if cwd.is_dir() {
        return Ok(());
    }
    let mut error = Error::invalid_params();
    error.message = format!("{} isn't a directory on this Host", cwd.display());
    Err(error)
}

/// Where `thread/run` runs: `cwd`, under the Host's home when it starts with `~`, and a
/// checkout of `remote` when one is named, as another Host's agent asks for the directory it
/// works in on its own Host.
async fn place(shared: &Shared, cwd: PathBuf, remote: Option<&str>) -> Result<PathBuf, Error> {
    let cwd = under_home(shared, cwd);
    let Some(remote) = remote else {
        return Ok(cwd);
    };
    let shown = cwd.display();
    let refused = |why: String| Err(Error::invalid_params().data(why));
    if !cwd.is_dir() {
        return refused(format!(
            "{shown} isn't a directory on this Host, so it holds no checkout of {remote}"
        ));
    }
    match shared.git.locate(&cwd).await {
        Some(GitLocation {
            remote: Some(found),
            ..
        }) if found.eq_ignore_ascii_case(remote) => Ok(cwd),
        Some(GitLocation {
            remote: Some(found),
            ..
        }) => refused(format!(
            "{shown} on this Host is a checkout of {found}, not {remote}"
        )),
        Some(_) => refused(format!(
            "{shown} on this Host is a repository without a remote, not a checkout of {remote}"
        )),
        None => refused(format!(
            "{shown} on this Host isn't in a git repository, so it isn't a checkout of {remote}"
        )),
    }
}

/// [`run_as`], under `key` when there is one.
async fn run_now(
    shared: &Arc<Shared>,
    request: RunRequest,
    link: Option<(ClientId, ClientLink)>,
    key: Option<String>,
    origin: TurnOrigin,
    started_by: Option<ThreadId>,
) -> Result<RunResponse, Error> {
    if shared.draining() {
        return Err(errors::host_stopping());
    }
    let RunRequest {
        agent_id,
        cwd,
        remote,
        thread_id,
        additional_directories,
        mode,
        prompt,
        policy,
        attach: _,
        trace,
        key: _,
        caller: _,
        origin: _,
        labels,
    } = request;
    check_labels(&labels)?;
    let cwd = place(shared, cwd, remote.as_deref()).await?;
    let additional_directories: Vec<PathBuf> = additional_directories
        .into_iter()
        .map(|dir| under_home(shared, dir))
        .collect();
    let started_by_host = match &origin {
        TurnOrigin::Thread { host, .. } if started_by.is_some() => host.clone(),
        _ => None,
    };
    let agent = shared.resolve(&agent_id).await?;
    let options = headless(agent.options);
    let live = thread_id
        .as_ref()
        .and_then(|thread_id| shared.registry().live(thread_id));
    let mut notices = Vec::new();
    let opening = live.is_none();
    let thread = match (live, thread_id) {
        // An open thread keeps its own policy.
        (Some(thread), _) => thread,
        (None, Some(thread_id)) => {
            let (thread, more) = take_up_with(
                shared,
                &agent,
                cwd,
                thread_id,
                additional_directories,
                policy,
            )
            .await?;
            notices = more;
            thread
        }
        (None, None) => {
            directory_here(&cwd)?;
            let (instance, git) = tokio::join!(
                shared.instance(&agent, &cwd, options),
                shared.git.locate(&cwd),
            );
            let instance = instance?;
            let (setup, more, servers) =
                setup(shared, &agent, &instance, cwd, additional_directories);
            notices = more;
            let response = match instance.connection.new_session(&setup).await {
                Ok(response) => response,
                Err(error) => {
                    instance.connection.shutdown().await;
                    return Err(error);
                }
            };
            let mut snapshot = Snapshot {
                modes: response.modes,
                config_options: response.config_options.unwrap_or_default(),
            };
            // As `thread/create` starts one, so a headless run is in the mode the person set.
            if let Some(mode) = mode.or_else(|| agent.mode.clone()) {
                let handle = instance.connection.handle();
                if let Err(notice) =
                    modes::start_in(&handle, &response.session_id, &mut snapshot, &mode).await
                {
                    notices.push(notice);
                }
            }
            open(
                shared,
                response.session_id,
                instance,
                &agent,
                setup.cwd,
                setup.additional_directories,
                policy,
                snapshot,
                Origin::New {
                    started_by,
                    started_by_host,
                    labels,
                },
                servers,
                git,
            )?
        }
    };
    // A service's run opened it for what started it, as listings say.
    if opening && let TurnOrigin::Service { .. } = &origin {
        thread.opened_by(origin.clone());
    }
    let root = thread.summary().thread_id;
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
        thread.traces.add(owner, trace);
        Some(path)
    } else {
        None
    };
    let state = match link {
        Some((client, link)) => {
            let (reply, attached) = oneshot::channel();
            thread.send(Command::Attach {
                client,
                link: Box::new(link),
                from: ReplayFrom::Now,
                notices,
                trace,
                reply: AttachReply::Run(reply),
            })?;
            Some(attached.await.map_err(|_| thread::ended())?)
        }
        None => None,
    };
    let (reply, started) = oneshot::channel();
    thread.send(Command::Prompt {
        origin,
        thread_id: root.clone(),
        prompt,
        key,
        reply,
    })?;
    let (_, turn_id) = started.await.map_err(|_| thread::ended())??;
    Ok(RunResponse {
        thread_id: root,
        turn_id: Some(turn_id),
        state: state.map(Box::new),
        policy: Some(thread.summary().policy),
    })
}

/// Open a thread the Host doesn't have open in `instance`: resume it from the journal a
/// stopped Host left, or reopen it in the agent, loading it when `replay` asks for its
/// history and there's no journal to show instead. On failure the agent comes back, unless
/// it's gone.
#[allow(clippy::too_many_arguments)]
async fn reopen(
    shared: &Arc<Shared>,
    mut instance: Instance,
    thread_id: ThreadId,
    setup: SessionSetup,
    servers: Servers,
    agent: &Agent,
    policy: PermissionPolicy,
    replay: bool,
    git: Option<GitLocation>,
) -> Result<ThreadHandle, (Error, Option<Instance>)> {
    // Nothing closes the journal while it's taken up (`Daemon::close_unclaimed`).
    let _taking_up = TakingUp::new(shared, &thread_id);
    let recovered = recoverable(shared, &thread_id);
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
            .load_session(thread_id.clone(), &setup)
            .await
            .map(|response| (response.modes, response.config_options))
    } else if can_resume {
        instance
            .connection
            .resume_session(thread_id.clone(), &setup)
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
    // A title the Host kept and a queue outlive the journal: a closed thread's new one begins
    // with them.
    let closed = match &recovered {
        Some(_) => None,
        None => shared
            .config
            .journals
            .as_ref()
            .and_then(|dir| journal::read(&journal::path_for(dir, &thread_id)).ok()),
    };
    let earlier = recovered
        .as_ref()
        .map(|(_, records)| records.as_slice())
        .or(closed.as_deref());
    let title = earlier.and_then(journal::kept_title);
    let agent_title = earlier.and_then(journal::agent_title);
    let last_activity_ms = earlier.and_then(journal::last_activity);
    let mut queue = earlier.map(Queue::from_records).unwrap_or_default();
    let (started_by, started_by_host) = earlier.map(journal::started_by).unwrap_or_default();
    let successor = earlier.and_then(journal::successor);
    let labels = earlier.map(journal::labels).unwrap_or_default();
    let usage = earlier.map(journal::usage).unwrap_or_default();
    let mut continuation = None;
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
            let mut interrupted = None;
            let mut journal = match Journal::reopen(&path, records) {
                Ok(journal) => journal,
                Err(error) => return Err((journal_error(&error), Some(instance))),
            };
            // A turn the stopped Host was running was cut off with it (WVE-144). A headless
            // thread continues its own once, unless that turn was a continuation already, so a
            // turn that brings the Host down can't do it again and again.
            for open in open_turns {
                journal.append(Entry::turn_ended(
                    open.thread_id.clone(),
                    &Err(errors::interrupted()),
                ));
                if open.thread_id == thread_id
                    && policy.is_headless()
                    && open.continues.is_none()
                    && let Some(turn_id) = open.turn_id
                {
                    interrupted = Some((open.origin, turn_id));
                }
            }
            // The continuation starts with the interrupted turn's end, in the journal, before
            // the agent is prompted (WVE-168): nobody reading it finds one without the other.
            continuation = interrupted.map(|(origin, continues)| {
                let turn_id = crate::queue::new_id();
                let (_, started_ms) = journal.append(Entry::TurnStarted {
                    thread_id: thread_id.clone(),
                    at_ms: now_ms(),
                    prompt: vec![ContentBlock::from(thread::CONTINUE.to_owned())],
                    origin: Some(origin.clone()),
                    queued_id: None,
                    turn_id: Some(turn_id.clone()),
                    key: None,
                    continues: Some(continues),
                });
                Box::new(Continuation {
                    origin,
                    turn_id,
                    started_ms,
                })
            });
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
        thread_id,
        instance,
        agent,
        setup.cwd,
        setup.additional_directories,
        policy,
        snapshot,
        Origin::Reopened {
            journal: journal.map(Box::new),
            title,
            agent_title,
            last_activity_ms,
            queue,
            started_by,
            started_by_host,
            successor,
            labels,
            usage,
            continuation,
        },
        servers,
        git,
    ) {
        Ok(thread) => Ok(thread),
        Err(error) => Err((error, None)),
    }
}

/// The journal a stopped Host left for `thread_id` while it was open.
/// A thread being taken up from its journal, until dropped.
struct TakingUp<'a> {
    shared: &'a Shared,
    thread_id: ThreadId,
}

impl<'a> TakingUp<'a> {
    fn new(shared: &'a Shared, thread_id: &ThreadId) -> Self {
        shared.registry().taking_up.insert(thread_id.clone());
        Self {
            shared,
            thread_id: thread_id.clone(),
        }
    }
}

impl Drop for TakingUp<'_> {
    fn drop(&mut self) {
        self.shared.registry().taking_up.remove(&self.thread_id);
    }
}

/// An interactive thread taken up again with prompts waiting has its queue paused, for a
/// person to resume; a headless thread's carries on. Whether it paused now.
fn interrupt(queue: &mut Queue, policy: &PermissionPolicy) -> bool {
    if !queue.is_ready() || policy.is_headless() {
        return false;
    }
    queue.paused = Some(QueuePause::Interrupted);
    true
}

fn recoverable(shared: &Shared, thread_id: &ThreadId) -> Option<(PathBuf, Vec<journal::Record>)> {
    let path = journal::path_for(shared.config.journals.as_ref()?, thread_id);
    let records = journal::read(&path).ok()?;
    (!records.is_empty() && !journal::is_closed(&records)).then_some((path, records))
}

/// Where a thread [`open`] starts came from.
enum Origin {
    /// `thread/create` or a new run: the thread is blank until it's prompted. A delegated
    /// thread names the thread that started it, and the other Host that one is on.
    New {
        started_by: Option<ThreadId>,
        started_by_host: Option<String>,
        labels: Vec<String>,
    },
    /// The agent's thread reopened, with the journal a stopped Host left, if there is one,
    /// and the title and queue the Host kept for it, the last title its agent gave it, and when
    /// it was last active.
    Reopened {
        journal: Option<Box<Journal>>,
        title: Option<String>,
        agent_title: Option<String>,
        last_activity_ms: Option<u64>,
        queue: Queue,
        started_by: Option<ThreadId>,
        started_by_host: Option<String>,
        /// The thread its work goes on in.
        successor: Option<ThreadId>,
        labels: Vec<String>,
        usage: Usage,
        /// The turn the stopped Host cut off, for a headless thread to continue.
        continuation: Option<Box<Continuation>>,
    },
}

#[allow(clippy::too_many_arguments)]
fn open(
    shared: &Arc<Shared>,
    thread_id: ThreadId,
    instance: Instance,
    agent: &Agent,
    cwd: PathBuf,
    additional_directories: Vec<PathBuf>,
    policy: PermissionPolicy,
    snapshot: Snapshot,
    origin: Origin,
    servers: Servers,
    git: Option<GitLocation>,
) -> Result<ThreadHandle, Error> {
    let (journal, blank, title, agent_title, last_activity_ms, queue, starter) = match origin {
        Origin::New {
            started_by,
            started_by_host,
            labels,
        } => (
            None,
            true,
            None,
            None,
            None,
            Queue::default(),
            (
                started_by,
                started_by_host,
                None,
                labels,
                Usage::default(),
                None,
            ),
        ),
        Origin::Reopened {
            journal,
            title,
            agent_title,
            last_activity_ms,
            queue,
            started_by,
            started_by_host,
            successor,
            labels,
            usage,
            continuation,
        } => (
            journal,
            false,
            title,
            agent_title,
            last_activity_ms,
            queue,
            (
                started_by,
                started_by_host,
                successor,
                labels,
                usage,
                continuation.map(|continuation| *continuation),
            ),
        ),
    };
    let (started_by, started_by_host, successor, labels, usage, continuation) = starter;
    let journal = match journal {
        Some(journal) => *journal,
        None => {
            let mut header = Entry::header(
                thread_id.clone(),
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
                started_by_host: starter_host,
                successor: carried_successor,
                labels: carried_labels,
                usage: carried_usage,
                ..
            } = &mut header
            {
                carried_labels.clone_from(&labels);
                *carried_usage =
                    (usage.context.is_some() || usage.last_compaction.is_some()).then(|| {
                        Box::new(CarriedUsage {
                            context: usage.context,
                            last_compaction: usage.last_compaction,
                        })
                    });
                carried.extend(queue.prompts.iter().cloned());
                *queue_paused = queue.paused;
                starter.clone_from(&started_by);
                starter_host.clone_from(&started_by_host);
                carried_successor.clone_from(&successor);
            }
            match &shared.config.journals {
                Some(dir) => Journal::create(dir, &thread_id, header)
                    .map_err(|error| journal_error(&error))?,
                None => Journal::memory(header),
            }
        }
    };
    let initialize = instance
        .init()
        .cloned()
        .unwrap_or_else(|| InitializeResponse::new(ProtocolVersion::V1));
    Ok(thread::start(
        shared,
        Opened {
            thread_id,
            instance,
            agent: agent.thread_agent(initialize),
            resolved: agent.clone(),
            journal,
            policy,
            snapshot,
            cwd,
            additional_directories,
            blank,
            servers,
            title,
            agent_title,
            last_activity_ms,
            git,
            queue,
            started_by,
            started_by_host,
            successor,
            labels,
            usage,
            continuation,
        },
    ))
}

/// Whether `labels` may start a thread: each a label, and not too many (WVE-173).
fn check_labels(labels: &[String]) -> Result<(), Error> {
    for label in labels {
        check_label(label).map_err(|why| Error::invalid_params().data(why))?;
    }
    if labels.len() > MAX_LABELS {
        return Err(Error::invalid_params().data(format!(
            "a thread carries at most {MAX_LABELS} labels, not {}",
            labels.len()
        )));
    }
    Ok(())
}

fn journal_error(error: &std::io::Error) -> Error {
    Error::internal_error().data(format!("the thread journal: {error}"))
}
