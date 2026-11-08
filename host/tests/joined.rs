//! The connection a Host opens to the Dispatcher it joined (ADR 0030), seen from the Dispatcher's
//! end: a fake Dispatcher on a Unix socket in the test, which the Host joins with a code, and
//! which then says hello with its key and asks what a service may (ADR 0027). The Dispatcher's
//! own tests (`dispatcher/tests/`) run the real one; these check what a Host lets it do, and that
//! the Host's socket takes nothing meant for it. And the Tailscale Serve entry a Host made for
//! remote clients before they reached it through the Dispatcher (WVE-197), which it removes, here
//! through a fake Serve, so no test runs `tailscale`.

#![allow(clippy::expect_used)]

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use agent_client_protocol::Channel;
use agent_client_protocol::Error;
use agent_client_protocol::UntypedMessage;
use futures::future::BoxFuture;
use pretty_assertions::assert_eq;
use tokio::net::UnixListener;
use tokio::net::UnixStream;
use tokio::sync::mpsc::UnboundedReceiver;
use weave_acp_core::AgentConnection;
use weave_acp_core::ClientOptions;
use weave_acp_core::schema::ContentBlock;
use weave_agents::environment::Environment;
use weave_fake_agent::FakeAgentConfig;
use weave_host::Daemon;
use weave_host::DaemonConfig;
use weave_host::DaemonPaths;
use weave_host::DispatcherSettings;
use weave_host::FormerServe;
use weave_host::Launch;
use weave_host::Launcher;
use weave_host::RemoteConfig;
use weave_host::Serve;
use weave_host::Withheld;
use weave_host_client::ConnectError;
use weave_host_client::Credentials;
use weave_host_client::HostConnection;
use weave_host_client::HostEvent;
use weave_host_client::remote::DeviceKey;
use weave_host_client::remote::messages;
use weave_host_protocol::HostClient;
use weave_host_protocol::agents::ListAgentsRequest;
use weave_host_protocol::dispatcher::ConnectHostRequest;
use weave_host_protocol::dispatcher::DISPATCHER_HOST_SUBPROTOCOL;
use weave_host_protocol::dispatcher::DispatcherAddress;
use weave_host_protocol::dispatcher::DispatcherChallenge;
use weave_host_protocol::dispatcher::HostConnected;
use weave_host_protocol::dispatcher::JoinDispatcherRequest;
use weave_host_protocol::dispatcher::LeaveDispatcherRequest;
use weave_host_protocol::errors;
use weave_host_protocol::events::ThreadEvent;
use weave_host_protocol::hello::ChallengeRequest;
use weave_host_protocol::hello::ClientCapabilities;
use weave_host_protocol::hello::ClientInfo;
use weave_host_protocol::host::Service;
use weave_host_protocol::host::StatusRequest;
use weave_host_protocol::policy::PermissionPolicy;
use weave_host_protocol::queue::AddQueuedRequest;
use weave_host_protocol::threads::AttachThreadRequest;
use weave_host_protocol::threads::CreateThreadRequest;
use weave_host_protocol::threads::GetThreadRequest;
use weave_host_protocol::threads::ListThreadsRequest;
use weave_host_protocol::threads::OtherThread;
use weave_host_protocol::threads::RenameThreadRequest;
use weave_host_protocol::threads::RunRequest;
use weave_host_protocol::threads::ServiceOrigin;
use weave_host_protocol::threads::ThreadId;
use weave_host_protocol::threads::TurnOrigin;
use weave_host_protocol::threads::WatchThreadsRequest;
use weave_host_protocol::tools::AnswerToolRequest;
use weave_host_protocol::tools::ClientToolResult;
use weave_host_protocol::tools::DeclareToolsRequest;
use weave_host_protocol::tools::Tool;
use weave_host_protocol::turns::SteerTurnRequest;
use weave_remote::preamble;
use weave_remote::websocket::WebSocketStream;

const WAIT: Duration = Duration::from_secs(10);

/// The fake Dispatcher's id and name, which the Host keeps when it joins.
const DISPATCHER: &str = "D-test";
const DISPATCHER_NAME: &str = "Dispatcher";

struct World {
    dir: tempfile::TempDir,
}

impl World {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("config.toml"),
            "[agents.fake]\ncommand = \"fake-agent\"\n",
        )
        .expect("config");
        Self { dir }
    }

    fn daemon(&self) -> Daemon {
        Daemon::new(self.config())
    }

    fn devices(&self) -> PathBuf {
        self.dir.path().join("devices.json")
    }

    fn config(&self) -> DaemonConfig {
        let state: PathBuf = self.dir.path().join("agent-state.json");
        let launcher: Launcher = Arc::new(move |_launch: &Launch, options: ClientOptions, _| {
            // MCP over ACP, which reaches the Host's own MCP server without a bridge process.
            let config = FakeAgentConfig {
                state_path: Some(state.clone()),
                mcp_over_acp: true,
                ..FakeAgentConfig::default()
            };
            Box::pin(async move {
                let (client, agent) = Channel::duplex();
                tokio::spawn(weave_fake_agent::serve_with(agent, config));
                AgentConnection::connect(client, options)
                    .await
                    .map_err(|error| Error::internal_error().data(error.to_string()))
            })
        });
        DaemonConfig {
            journals: None,
            idle_grace: Duration::from_secs(60),
            drain_timeout: weave_host::DEFAULT_DRAIN_TIMEOUT,
            blank_grace: Duration::from_secs(60),
            launcher,
            config_file: Some(self.dir.path().join("config.toml")),
            registry_cache: Some(self.dir.path().join("cache")),
            agents: Default::default(),
            withheld: Withheld::default(),
            environment: Environment::default(),
            service: Service::InProcess,
            traces: self.dir.path().join("traces"),
            devices: Some(self.devices()),
            upstream: Arc::new(weave_agents::update::Offline),
            mcp_socket: None,
            mcp_bridge: vec!["weave-mcp-bridge".to_owned()],
            former_serve: None,
            terminals: None,
            home: None,
            retired: Vec::new(),
            dispatcher: Some(DispatcherSettings {
                secure_enclave: false,
                timeout: Duration::from_secs(2),
                retry: Duration::from_millis(100),
                retry_most: Duration::from_millis(500),
                websocket: RemoteConfig::default(),
                ..DispatcherSettings::in_dir(&DaemonPaths::in_dir(self.dir.path().to_path_buf()))
            }),
        }
    }
}

fn info(name: &str) -> ClientInfo {
    ClientInfo {
        name: name.to_owned(),
        version: "0".to_owned(),
    }
}

async fn local(daemon: &Daemon) -> (HostConnection, UnboundedReceiver<HostEvent>) {
    HostConnection::connect(
        daemon.connect_in_process(),
        info("weave"),
        ClientCapabilities::default(),
    )
    .await
    .expect("a local client")
}

async fn next(events: &mut UnboundedReceiver<HostEvent>) -> HostEvent {
    tokio::time::timeout(WAIT, events.recv())
        .await
        .expect("an event in time")
        .expect("the connection is open")
}

/// A Dispatcher in the test, listening on a Unix socket where the Host joins it.
struct FakeDispatcher {
    key: DeviceKey,
    path: PathBuf,
    listener: UnixListener,
}

impl FakeDispatcher {
    fn new(world: &World) -> Self {
        let path = world.dir.path().join("d.sock");
        let listener = UnixListener::bind(&path).expect("the Dispatcher's socket");
        Self {
            key: DeviceKey::generate(),
            path,
            listener,
        }
    }

    /// Have `daemon` join this Dispatcher, and say hello on the connection it opened, as the
    /// Dispatcher does: its end of that connection.
    async fn join(&self, daemon: &Daemon) -> (HostConnection, UnboundedReceiver<HostEvent>) {
        let request = JoinDispatcherRequest {
            address: DispatcherAddress::Socket(self.path.clone()),
            code: "c0de".to_owned(),
            name: Some("studio".to_owned()),
        };
        let (joined, socket) = tokio::join!(daemon.join_dispatcher(request), self.accept());
        let joined = joined.expect("joined");
        assert_eq!(joined.id, DISPATCHER);
        let (transport, _) = messages::<HostClient, _>(socket);
        HostConnection::connect_with(
            transport,
            info("weave-dispatcher"),
            ClientCapabilities::default(),
            Credentials::Device {
                device_id: DISPATCHER.to_owned(),
                key: self.key.clone(),
                host_id: None,
            },
        )
        .await
        .expect("the Dispatcher's hello")
    }

    /// The Host's connection, through its challenge and joining with the code.
    async fn accept(&self) -> WebSocketStream<UnixStream> {
        let (stream, _) = tokio::time::timeout(WAIT, self.listener.accept())
            .await
            .expect("the Host connects in time")
            .expect("accepted");
        let Some((_, mut socket)) =
            weave_remote::websocket::upgrade(stream, &[], &[DISPATCHER_HOST_SUBPROTOCOL]).await
        else {
            panic!("the Host's upgrade");
        };
        let asked = preamble::next_request(&mut socket)
            .await
            .expect("its challenge");
        assert_eq!(asked.method, "dispatcher/challenge");
        let challenge = DispatcherChallenge {
            dispatcher_id: DISPATCHER.to_owned(),
            nonce: "n".to_owned(),
            expires_at: u64::MAX,
        };
        assert!(preamble::answer(&mut socket, asked.id, Ok(challenge)).await);
        let asked = preamble::next_request(&mut socket).await.expect("its key");
        assert_eq!(asked.method, "hosts/connect");
        let connect: ConnectHostRequest = asked.params().expect("hosts/connect");
        assert_eq!(connect.join.map(|join| join.code).as_deref(), Some("c0de"));
        let connected = HostConnected {
            dispatcher_id: DISPATCHER.to_owned(),
            dispatcher_name: DISPATCHER_NAME.to_owned(),
            public_key: self.key.jwk(),
            name: "studio".to_owned(),
        };
        assert!(preamble::answer(&mut socket, asked.id, Ok(connected)).await);
        socket
    }
}

#[tokio::test]
async fn the_socket_takes_no_device_pairing_or_dispatcher_and_gives_no_challenges() {
    let world = World::new();
    let daemon = world.daemon();
    let (local, _events) = local(&daemon).await;
    let challenge = local
        .send(ChallengeRequest {})
        .await
        .expect_err("no challenge for a local client");
    assert!(
        errors::is(&challenge, errors::UNAUTHENTICATED),
        "{challenge}"
    );
    // The Host pairs with nothing: devices pair with the Dispatcher (WVE-197).
    for (credentials, said) in [
        (
            Credentials::Pair {
                code: "x".to_owned(),
                name: "iPad".to_owned(),
                key: DeviceKey::generate(),
                service: false,
            },
            "pair with the Dispatcher",
        ),
        (Credentials::Dispatcher, "only a connection the Host opened"),
    ] {
        let refused = HostConnection::connect_with(
            daemon.connect_in_process(),
            info("weave"),
            ClientCapabilities::default(),
            credentials,
        )
        .await
        .err()
        .expect("refused");
        assert!(matches!(refused, ConnectError::Refused(_)), "{refused}");
        assert!(refused.to_string().contains(said), "{refused}");
    }
    // Nor does it offer, list or revoke devices, or say it does.
    assert!(!local.hello().features.iter().any(|f| f == "devices"));
    for method in ["devices/offer", "devices/list", "devices/revoke"] {
        let request = UntypedMessage::new(method, serde_json::json!({})).expect("a request");
        let error = local.send(request).await.expect_err(method);
        assert_eq!(
            error.code,
            Error::method_not_found().code,
            "{method}: {error}"
        );
    }
}

#[tokio::test]
async fn the_dispatcher_may_only_start_and_follow_threads() {
    let world = World::new();
    let daemon = world.daemon();
    let fake = FakeDispatcher::new(&world);
    let (service, _events) = fake.join(&daemon).await;
    let hello = service.hello();
    let device = hello.device.clone().expect("the Dispatcher");
    assert_eq!(
        (device.id.as_str(), device.name.as_str(), device.service),
        (DISPATCHER, DISPATCHER_NAME, true)
    );

    // Every method but its own, and attaching or running as a client of a thread, is refused
    // before any handler sees it.
    let refused = [
        "agents/authenticate",
        "agents/get",
        "agents/logout",
        "agents/terminalSignIn",
        "agents/update",
        "dispatcher/join",
        "dispatcher/leave",
        "files/list",
        "host/drain",
        "host/shutdown",
        "pending/answer",
        "queue/remove",
        "queue/resume",
        "thread/close",
        "thread/create",
        "thread/delete",
        "thread/reopen",
        "thread/setConfigOption",
        "thread/setMode",
        "terminals/attach",
        "terminals/close",
        "terminals/format",
        "terminals/list",
        "terminals/new",
        "terminals/setLabel",
        "terminals/unwatch",
        "terminals/watch",
        "terminals/write",
        "turn/start",
        "worktrees/create",
        "worktrees/list",
        "worktrees/release",
        "worktrees/remove",
    ]
    .map(|method| (method, serde_json::json!({})))
    .into_iter()
    .chain([
        ("thread/attach", serde_json::json!({"threadId": "s-1"})),
        (
            "thread/run",
            serde_json::json!({"agentId": "fake", "cwd": "/", "prompt": [], "attach": true}),
        ),
    ]);
    for (method, params) in refused {
        let request = UntypedMessage::new(method, params).expect("a request");
        let error = service.send(request).await.expect_err(method);
        assert!(errors::is(&error, errors::FORBIDDEN), "{method}: {error}");
        assert!(error.to_string().contains("a service"), "{method}: {error}");
    }

    // What starting and following threads needs, it may.
    service.send(StatusRequest {}).await.expect("host/status");
    service
        .send(ListAgentsRequest::default())
        .await
        .expect("agents/list");
    service
        .send(WatchThreadsRequest::default())
        .await
        .expect("threads/watch");
    let run = || RunRequest {
        agent_id: "fake".to_owned(),
        cwd: world.dir.path().to_path_buf(),
        remote: None,
        thread_id: None,
        additional_directories: Vec::new(),
        mode: None,
        prompt: vec![ContentBlock::from("hello".to_owned())],
        policy: PermissionPolicy::ask(),
        attach: false,
        trace: false,
        key: Some("daily-review@1760180000000".to_owned()),
        caller: None,
        origin: None,
        labels: Vec::new(),
    };
    let started = service.send(run()).await.expect("thread/run");
    let again = service.send(run()).await.expect("the same key again");
    assert_eq!(again.thread_id, started.thread_id);
    assert_eq!(again.turn_id, started.turn_id);
    service
        .send(RenameThreadRequest {
            thread_id: started.thread_id.clone(),
            title: "Daily review".to_owned(),
        })
        .await
        .expect("thread/rename");
    let got = service
        .send(GetThreadRequest {
            thread_id: started.thread_id.clone(),
            turn_id: None,
        })
        .await
        .expect("threads/get");
    assert_eq!(got.thread.info.title.as_deref(), Some("Daily review"));
    service
        .send(AttachThreadRequest {
            thread_id: started.thread_id.clone(),
            after: None,
            agent_id: None,
            cwd: None,
            trace: false,
            observe: true,
        })
        .await
        .expect("observing");
    let listed = service
        .send(ListThreadsRequest::default())
        .await
        .expect("threads/list");
    assert!(
        listed
            .threads
            .iter()
            .any(|listed| listed.info.session_id == started.thread_id)
    );
    service.shutdown().await;
    daemon.shutdown().await;
}

#[tokio::test]
async fn the_dispatchers_turns_name_what_started_them() {
    let world = World::new();
    let daemon = world.daemon();
    let (local, mut local_events) = local(&daemon).await;
    let fake = FakeDispatcher::new(&world);
    let (service, _events) = fake.join(&daemon).await;
    let origin = |label: &str, id: &str| ServiceOrigin {
        label: label.to_owned(),
        id: id.to_owned(),
    };
    let named = |label: &str, id: &str| TurnOrigin::Service {
        name: DISPATCHER_NAME.to_owned(),
        label: label.to_owned(),
        id: id.to_owned(),
    };

    // A schedule's turn, long enough to queue a message behind.
    let started = service
        .send(RunRequest {
            agent_id: "fake".to_owned(),
            cwd: world.dir.path().to_path_buf(),
            remote: None,
            thread_id: None,
            additional_directories: Vec::new(),
            mode: None,
            prompt: vec![ContentBlock::from("/slow 5".to_owned())],
            policy: PermissionPolicy::ask(),
            attach: false,
            trace: false,
            key: Some("daily-review@1".to_owned()),
            caller: None,
            origin: Some(origin("schedule daily-review", "o-1")),
            labels: Vec::new(),
        })
        .await
        .expect("thread/run");
    let thread_id = started.thread_id.clone();
    local
        .send(AttachThreadRequest {
            thread_id: thread_id.clone(),
            after: None,
            agent_id: None,
            cwd: None,
            trace: false,
            observe: true,
        })
        .await
        .expect("observing");
    loop {
        if let HostEvent::Event(notification) = next(&mut local_events).await
            && let ThreadEvent::TurnStarted { origin, .. } = notification.event
        {
            assert_eq!(origin, named("schedule daily-review", "o-1"));
            break;
        }
    }
    let got = service
        .send(GetThreadRequest {
            thread_id: thread_id.clone(),
            turn_id: None,
        })
        .await
        .expect("threads/get");
    assert_eq!(
        got.thread.opened_by,
        Some(named("schedule daily-review", "o-1"))
    );

    // A message for the thread waits behind it, and starts when it ends.
    service
        .send(AddQueuedRequest {
            thread_id: thread_id.clone(),
            prompt: vec![ContentBlock::from("And the open ones?".to_owned())],
            key: Some("m-7".to_owned()),
            caller: None,
            origin: Some(origin("your message from iPhone", "m-7")),
        })
        .await
        .expect("queue/add");
    loop {
        if let HostEvent::Event(notification) = next(&mut local_events).await
            && let ThreadEvent::Queued { origin, .. } = notification.event
        {
            assert_eq!(origin, named("your message from iPhone", "m-7"));
            break;
        }
    }
    loop {
        if let HostEvent::Event(notification) = next(&mut local_events).await
            && let ThreadEvent::TurnStarted { origin, .. } = notification.event
        {
            assert_eq!(origin, named("your message from iPhone", "m-7"));
            break;
        }
    }

    // Nor may it name a caller as well, and a client that isn't a service names nothing.
    let both = service
        .send(SteerTurnRequest {
            thread_id: thread_id.clone(),
            prompt: vec![ContentBlock::from("also".to_owned())],
            caller: Some(OtherThread {
                thread_id: "s-0".into(),
                host: "h-other".to_owned(),
                host_name: None,
            }),
            origin: Some(origin("schedule daily-review", "o-2")),
        })
        .await
        .expect_err("a caller and an origin");
    assert_eq!(both.code, Error::invalid_params().code, "{both}");
    let refused = local
        .send(AddQueuedRequest {
            thread_id,
            prompt: vec![ContentBlock::from("hello".to_owned())],
            key: None,
            caller: None,
            origin: Some(origin("schedule daily-review", "o-3")),
        })
        .await
        .expect_err("only a service names what started a turn");
    assert_eq!(refused.code, Error::invalid_params().code, "{refused}");
    service.shutdown().await;
    daemon.shutdown().await;
}

/// Prompt `thread_id` through `local` and give what the agent said.
async fn reply(
    local: &HostConnection,
    events: &mut UnboundedReceiver<HostEvent>,
    thread_id: &ThreadId,
    prompt: &str,
) -> String {
    local
        .send(AddQueuedRequest {
            thread_id: thread_id.clone(),
            prompt: vec![ContentBlock::from(prompt.to_owned())],
            key: None,
            caller: None,
            origin: None,
        })
        .await
        .expect("queue/add");
    let mut said = String::new();
    loop {
        let HostEvent::Event(event) = next(events).await else {
            continue;
        };
        match event.event {
            ThreadEvent::Update { notification } if notification.session_id == *thread_id => {
                if let weave_acp_core::schema::SessionUpdate::AgentMessageChunk(chunk) =
                    notification.update
                    && let ContentBlock::Text(text) = chunk.content
                {
                    said.push_str(&text.text);
                }
            }
            ThreadEvent::TurnEnded {
                thread_id: ended, ..
            } if ended == *thread_id => {
                return said;
            }
            _ => {}
        }
    }
}

/// A new thread, opened through `local`.
async fn new_thread(local: &HostConnection, world: &World) -> ThreadId {
    local
        .send(CreateThreadRequest {
            agent_id: "fake".to_owned(),
            cwd: world.dir.path().to_path_buf(),
            additional_directories: Vec::new(),
            mode: None,
            policy: None,
            trace: false,
            labels: Vec::new(),
        })
        .await
        .expect("thread/create")
        .thread_id
}

fn add_schedule() -> Tool {
    Tool {
        name: "add_schedule".to_owned(),
        title: "Add a schedule".to_owned(),
        description: "Start a turn at the times a cron expression gives.".to_owned(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {"cron": {"type": "string"}},
        }),
    }
}

#[tokio::test]
async fn the_dispatcher_declares_tools_that_threads_agents_call() {
    let world = World::new();
    let daemon = world.daemon();
    let (local, mut local_events) = local(&daemon).await;
    let fake = FakeDispatcher::new(&world);
    let (service, mut service_events) = fake.join(&daemon).await;

    // Only a service declares tools, under names that are names.
    let refused = local
        .send(DeclareToolsRequest {
            tools: vec![add_schedule()],
            hosts: false,
        })
        .await
        .expect_err("not a service");
    assert!(errors::is(&refused, errors::FORBIDDEN), "{refused:?}");
    let bad = service
        .send(DeclareToolsRequest {
            tools: vec![Tool {
                name: "add schedule".to_owned(),
                ..add_schedule()
            }],
            hosts: false,
        })
        .await
        .expect_err("not a name");
    assert_eq!(bad.code, Error::invalid_params().code, "{bad:?}");
    let declared = service
        .send(DeclareToolsRequest {
            tools: vec![add_schedule()],
            hosts: false,
        })
        .await
        .expect("service/declareTools");
    assert_eq!(declared.names, ["dispatcher__add_schedule"]);

    // A thread set up from now on offers it beside the Host's own.
    let thread_id = new_thread(&local, &world).await;
    let listed = reply(&local, &mut local_events, &thread_id, "tools").await;
    assert!(listed.contains("dispatcher__add_schedule"), "{listed}");
    assert!(listed.contains("list_threads"), "{listed}");

    // A call reaches the Dispatcher, which answers it, naming the thread that called.
    let answering = tokio::spawn(async move {
        loop {
            if let HostEvent::ToolCall(call) = next(&mut service_events).await {
                service
                    .send(AnswerToolRequest {
                        call_id: call.call_id.clone(),
                        result: ClientToolResult::text("Scheduled every day at nine."),
                    })
                    .await
                    .expect("service/answerTool");
                let again = service
                    .send(AnswerToolRequest {
                        call_id: call.call_id.clone(),
                        result: ClientToolResult::text("twice"),
                    })
                    .await
                    .expect_err("answered once");
                assert_eq!(again.code, Error::invalid_params().code);
                return (service, call);
            }
        }
    });
    let said = reply(
        &local,
        &mut local_events,
        &thread_id,
        r#"tool dispatcher__add_schedule {"cron": "0 9 * * *"}"#,
    )
    .await;
    assert!(said.contains("Scheduled every day at nine."), "{said}");
    let (service, call) = answering.await.expect("answered");
    assert_eq!(call.tool, "add_schedule");
    assert_eq!(
        call.arguments.get("cron"),
        Some(&serde_json::json!("0 9 * * *"))
    );
    assert_eq!(call.caller.thread_id, thread_id);
    assert_eq!(call.caller.agent_id, "fake");
    assert_eq!(call.caller.policy, PermissionPolicy::ask());

    // Another client can't answer for it.
    let not_it = local
        .send(AnswerToolRequest {
            call_id: call.call_id,
            result: ClientToolResult::text("me"),
        })
        .await
        .expect_err("not the Dispatcher");
    assert!(errors::is(&not_it, errors::FORBIDDEN), "{not_it:?}");

    // With the Dispatcher away, a call fails at once saying so; the tool is still offered.
    service.shutdown().await;
    drop(fake);
    let away = new_thread(&local, &world).await;
    let listed = reply(&local, &mut local_events, &away, "tools").await;
    assert!(listed.contains("dispatcher__add_schedule"), "{listed}");
    let said = reply(
        &local,
        &mut local_events,
        &away,
        r#"tool dispatcher__add_schedule {}"#,
    )
    .await;
    assert!(said.contains("Dispatcher isn't connected"), "{said}");
    local.shutdown().await;
    daemon.shutdown().await;

    // The Host keeps them across a restart, and forgets them when it leaves the Dispatcher.
    let daemon = world.daemon();
    let (local, mut local_events) = self::local(&daemon).await;
    let restarted = new_thread(&local, &world).await;
    let listed = reply(&local, &mut local_events, &restarted, "tools").await;
    assert!(listed.contains("dispatcher__add_schedule"), "{listed}");
    local
        .send(LeaveDispatcherRequest {})
        .await
        .expect("dispatcher/leave");
    let left = new_thread(&local, &world).await;
    let listed = reply(&local, &mut local_events, &left, "tools").await;
    assert!(!listed.contains("dispatcher__"), "{listed}");
    local.shutdown().await;
    daemon.shutdown().await;
}

// The Serve entry the Host made for remote clients before WVE-197.

/// A Tailscale Serve that records which entries the Host removes, or refuses to.
#[derive(Default)]
struct FakeServe {
    removed: Mutex<Vec<SocketAddr>>,
    /// Why removing fails, while it should.
    refuse: Mutex<Option<String>>,
}

impl FakeServe {
    fn removed(&self) -> Vec<SocketAddr> {
        self.removed.lock().expect("removed").clone()
    }

    fn refuse(&self, why: Option<&str>) {
        *self.refuse.lock().expect("refuse") = why.map(str::to_owned);
    }
}

impl Serve for FakeServe {
    fn ensure(&self, listen: SocketAddr) -> BoxFuture<'_, Result<String, String>> {
        panic!("a Host makes no Serve entry, as for {listen}");
    }

    fn remove(&self, listen: SocketAddr) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.removed.lock().expect("removed").push(listen);
            match self.refuse.lock().expect("refuse").clone() {
                Some(why) => Err(why),
                None => Ok(()),
            }
        })
    }
}

/// Where a Host listened for remote clients before, as `weave daemon run` says it did.
fn listened() -> SocketAddr {
    "127.0.0.1:7341".parse().expect("an address")
}

impl World {
    /// A Host that removes the Serve entry it made through `serve`.
    fn daemon_with_serve(&self, serve: &Arc<FakeServe>) -> Daemon {
        Daemon::new(DaemonConfig {
            former_serve: Some(FormerServe {
                // Each status a local client asks for looks again.
                recheck_after: Duration::ZERO,
                ..FormerServe::new(listened(), Arc::clone(serve) as Arc<dyn Serve>)
            }),
            ..self.config()
        })
    }

    /// `devices.json` as a Host before WVE-197 left it, an iPad and the Dispatcher it joined in
    /// it.
    fn served_remote_clients(&self) {
        let jwk = DeviceKey::generate().jwk();
        let file = serde_json::json!({
            "hostId": "h-1",
            "devices": [
                {"id": "d-ipad", "name": "iPad", "publicKey": jwk, "pairedAt": 1},
                {"id": DISPATCHER, "name": DISPATCHER_NAME, "publicKey": jwk, "pairedAt": 1,
                 "service": true, "joined": true}
            ]
        });
        std::fs::write(self.devices(), file.to_string()).expect("devices.json");
    }

    fn written(&self) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(self.devices()).expect("devices.json")).expect("JSON")
    }
}

#[tokio::test]
async fn a_host_in_a_new_directory_never_touches_serve() {
    let world = World::new();
    let serve = Arc::new(FakeServe::default());
    let daemon = world.daemon_with_serve(&serve);
    daemon.remove_serve_entry().await;
    let (local, _events) = local(&daemon).await;
    let status = local.send(StatusRequest {}).await.expect("host/status");
    assert_eq!(status.serve_entry, None);
    assert_eq!(serve.removed(), Vec::new());
    assert_eq!(world.written().get("serveEntryLeft"), None);
    local.shutdown().await;
    daemon.shutdown().await;

    // Nor does one that only joined a Dispatcher.
    let daemon = world.daemon_with_serve(&serve);
    let fake = FakeDispatcher::new(&world);
    let (dispatcher, _events) = fake.join(&daemon).await;
    dispatcher.shutdown().await;
    daemon.shutdown().await;
    let daemon = world.daemon_with_serve(&serve);
    daemon.remove_serve_entry().await;
    assert_eq!(serve.removed(), Vec::new());
    daemon.shutdown().await;
}

#[tokio::test]
async fn a_host_that_served_remote_clients_forgets_their_devices_and_removes_its_entry_once() {
    let world = World::new();
    world.served_remote_clients();
    let serve = Arc::new(FakeServe::default());
    let daemon = world.daemon_with_serve(&serve);

    // Loading, it drops the iPad and keeps the Dispatcher it joined, noting the entry is left.
    let written = world.written();
    assert_eq!(written["hostId"], "h-1");
    assert_eq!(written["devices"].as_array().map(Vec::len), Some(1));
    assert_eq!(written["devices"][0]["id"], DISPATCHER);
    assert_eq!(written["serveEntryLeft"], true);

    daemon.remove_serve_entry().await;
    assert_eq!(serve.removed(), vec![listened()]);
    assert_eq!(world.written().get("serveEntryLeft"), None);
    let (local, _events) = local(&daemon).await;
    let status = local.send(StatusRequest {}).await.expect("host/status");
    assert_eq!(status.serve_entry, None);
    local.shutdown().await;
    daemon.shutdown().await;

    // Once.
    let daemon = world.daemon_with_serve(&serve);
    daemon.remove_serve_entry().await;
    assert_eq!(serve.removed(), vec![listened()]);
    daemon.shutdown().await;
}

#[tokio::test]
async fn a_host_that_cant_remove_its_entry_says_how_and_looks_again_when_asked() {
    let world = World::new();
    world.served_remote_clients();
    let serve = Arc::new(FakeServe::default());
    serve.refuse(Some("only root may"));
    let daemon = world.daemon_with_serve(&serve);
    daemon.remove_serve_entry().await;
    let (local, _events) = local(&daemon).await;
    let status = local.send(StatusRequest {}).await.expect("host/status");
    let left = status.serve_entry.expect("the entry left");
    assert_eq!(left.port, 7341);
    assert_eq!(left.command, "sudo tailscale serve --https=7341 off");
    assert_eq!(left.why, "only root may");
    // A local client's status looked again.
    assert_eq!(serve.removed().len(), 2);
    local.shutdown().await;
    daemon.shutdown().await;

    // It tries again when it starts, and once the person has removed it, it's gone.
    let daemon = world.daemon_with_serve(&serve);
    daemon.remove_serve_entry().await;
    assert_eq!(serve.removed().len(), 3);
    serve.refuse(None);
    let (local, _events) = self::local(&daemon).await;
    let status = local.send(StatusRequest {}).await.expect("host/status");
    assert_eq!(status.serve_entry, None);
    assert_eq!(world.written().get("serveEntryLeft"), None);
    local.shutdown().await;
    daemon.shutdown().await;
}
