//! The person's devices reaching their Hosts through the Dispatcher (ADR 0030, WVE-195): a
//! paired device on the Dispatcher's loopback WebSocket asks for a Host, the Host opens a
//! connection of its own for it, and the Dispatcher passes the Host protocol through. Two Hosts
//! join over the Dispatcher's socket, each through its relay, as in the other tests; a relay
//! pointed elsewhere stands in for something else answering at the Dispatcher's address.

#![allow(clippy::expect_used)]

mod common;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::UntypedMessage;
use futures::SinkExt as _;
use futures::StreamExt as _;
use futures::future::BoxFuture;
use pretty_assertions::assert_eq;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::PermissionOptionId;
use weave_acp_core::schema::RequestPermissionOutcome;
use weave_acp_core::schema::RequestPermissionResponse;
use weave_acp_core::schema::SelectedPermissionOutcome;
use weave_dispatcher::Dispatcher;
use weave_dispatcher::client::DispatcherConnection;
use weave_dispatcher::socket;
use weave_host::RemoteConfig;
use weave_host_client::Credentials;
use weave_host_client::HostConnection;
use weave_host_client::HostEvent;
use weave_host_client::carry;
use weave_host_client::carry::Carried;
use weave_host_client::carry::CarryError;
use weave_host_client::carry::Reached;
use weave_host_client::carry::Via;
use weave_host_client::remote::DeviceKey;
use weave_host_client::remote::connect_websocket_as;
use weave_host_protocol::agents::LogoutAgentRequest;
use weave_host_protocol::agents::UpdateAgentRequest;
use weave_host_protocol::devices::DeviceInfo;
use weave_host_protocol::devices::OfferDeviceRequest;
use weave_host_protocol::devices::RevokeDeviceRequest;
use weave_host_protocol::dispatcher::CARRY_FEATURE;
use weave_host_protocol::dispatcher::CarriedStream;
use weave_host_protocol::dispatcher::CarryRequest;
use weave_host_protocol::dispatcher::DISPATCHER_HOST_SUBPROTOCOL;
use weave_host_protocol::dispatcher::DISPATCHER_SUBPROTOCOL;
use weave_host_protocol::dispatcher::DispatcherChallenge;
use weave_host_protocol::dispatcher::DispatcherStatusRequest;
use weave_host_protocol::dispatcher::HostCarried;
use weave_host_protocol::dispatcher::HostCarryRequest;
use weave_host_protocol::dispatcher::LOCAL_DEVICE;
use weave_host_protocol::dispatcher::LeaveDispatcherRequest;
use weave_host_protocol::dispatcher::Reachability;
use weave_host_protocol::dispatcher::carry_message;
use weave_host_protocol::errors;
use weave_host_protocol::events::ThreadEvent;
use weave_host_protocol::files::ListFilesRequest;
use weave_host_protocol::hello::ClientCapabilities;
use weave_host_protocol::host::ShutdownRequest;
use weave_host_protocol::host::StatusRequest;
use weave_host_protocol::pending::AnswerPendingRequest;
use weave_host_protocol::queue::AddQueuedRequest;
use weave_host_protocol::terminals::AttachTerminalRequest;
use weave_host_protocol::terminals::NewTerminalRequest;
use weave_host_protocol::terminals::stream::INPUT;
use weave_host_protocol::terminals::stream::OUTPUT;
use weave_host_protocol::terminals::stream::Open;
use weave_host_protocol::terminals::stream::Opened;
use weave_host_protocol::terminals::stream::RESTORE;
use weave_host_protocol::threads::AttachThreadRequest;
use weave_host_protocol::threads::CreateThreadRequest;
use weave_host_protocol::threads::GetThreadRequest;
use weave_host_protocol::threads::JournalPosition;
use weave_host_protocol::threads::ListThreadsRequest;
use weave_host_protocol::threads::ThreadId;
use weave_host_protocol::threads::ThreadState;
use weave_host_protocol::threads::TurnOrigin;
use weave_host_protocol::threads::WatchThreadsRequest;
use weave_host_protocol::turns::StartTurnRequest;
use weave_host_protocol::websocket::CLOSE_REVOKED;
use weave_host_protocol::websocket::CLOSE_UNAUTHENTICATED;
use weave_remote::access::RemoteSettings;
use weave_remote::access::Serve;
use weave_remote::preamble;

use crate::common::WAIT;
use crate::common::World;
use crate::common::ask;
use crate::common::dispatcher_config;
use crate::common::host_until;
use crate::common::info;

/// A Tailscale Serve that hands out `ws://` URLs to the listener.
struct FakeServe;

impl Serve for FakeServe {
    fn ensure(&self, listen: SocketAddr) -> BoxFuture<'_, Result<String, String>> {
        Box::pin(async move { Ok(format!("ws://{listen}")) })
    }

    fn remove(&self, _listen: SocketAddr) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}

/// A Dispatcher with two Hosts that joined it, studio and mini, and a device paired with it.
struct Hub {
    dir: tempfile::TempDir,
    dispatcher: Dispatcher,
    serving: JoinHandle<()>,
    /// Its CLI, on its socket.
    cli: DispatcherConnection,
    studio: World,
    mini: World,
    device: DeviceInfo,
    via: Via,
}

impl Hub {
    async fn new() -> Self {
        Self::with(World::new().await, World::new().await).await
    }

    async fn with(studio: World, mini: World) -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let remote = RemoteSettings::new(
            "127.0.0.1:0".parse().expect("an address"),
            Arc::new(FakeServe),
        );
        let config = weave_dispatcher::DispatcherConfig {
            remote: Some(remote),
            ..dispatcher_config(dir.path())
        };
        let listening = socket::listen(&config.paths).expect("its socket");
        let dispatcher = Dispatcher::open(config).expect("opened");
        let serving = {
            let dispatcher = dispatcher.clone();
            tokio::spawn(async move { dispatcher.serve(listening.listener).await })
        };
        studio.join(&dispatcher, dir.path(), "studio").await;
        mini.join(&dispatcher, dir.path(), "mini").await;
        for world in [&studio, &mini] {
            host_until(&dispatcher, &world.host_id().await, |host| host.connected).await;
        }
        let cli = ask(dir.path()).await;
        let (device, via) = pair(&cli, "laptop").await;
        Self {
            dir,
            dispatcher,
            serving,
            cli,
            studio,
            mini,
            device,
            via,
        }
    }

    /// Another device paired with the Dispatcher, and how it reaches the Hosts.
    async fn pair(&self, name: &str) -> (DeviceInfo, Via) {
        pair(&self.cli, name).await
    }

    /// A connection to `host` through the Dispatcher, said hello to.
    async fn reach(&self, host: &str) -> Reached {
        self.try_reach(host).await.expect("reached the Host")
    }

    async fn try_reach(&self, host: &str) -> Result<Reached, CarryError> {
        carry::reach(
            &self.via,
            info("weave-test"),
            ClientCapabilities::default(),
            host,
            WAIT,
        )
        .await
    }

    async fn stop(self) {
        self.cli.shutdown().await;
        self.dispatcher.stop().await;
        self.serving.abort();
    }
}

/// Pair a device called `name` with the Dispatcher `cli` asks: it, and how it reaches the Hosts.
async fn pair(cli: &DispatcherConnection, name: &str) -> (DeviceInfo, Via) {
    let offer = cli
        .send(OfferDeviceRequest {
            name: Some(name.to_owned()),
        })
        .await
        .expect("devices/offer");
    let url = offer.url.expect("a URL");
    let key = DeviceKey::generate();
    let (transport, _) = connect_websocket_as(&url, DISPATCHER_SUBPROTOCOL)
        .await
        .expect("the WebSocket");
    let paired = DispatcherConnection::connect_with(
        transport,
        info("weave-cli"),
        Credentials::Pair {
            code: offer.code,
            name: name.to_owned(),
            key: key.clone(),
            service: false,
        },
    )
    .await
    .expect("paired");
    let device = paired.hello().device.clone().expect("its device");
    let dispatcher_id = paired.hello().id.clone();
    paired.shutdown().await;
    let via = Via::Paired {
        url,
        dispatcher_id,
        device_id: device.id.clone(),
        key,
    };
    (device, via)
}

async fn next(events: &mut UnboundedReceiver<HostEvent>) -> HostEvent {
    tokio::time::timeout(WAIT, events.recv())
        .await
        .expect("an event in time")
        .expect("the connection")
}

/// Wait for the connection to end.
async fn disconnected(events: &mut UnboundedReceiver<HostEvent>) {
    tokio::time::timeout(WAIT, async {
        while let Some(event) = events.recv().await {
            if matches!(event, HostEvent::Disconnected(_)) {
                return;
            }
        }
    })
    .await
    .expect("disconnected in time");
}

/// Events of `thread_id` until its turn ends, from `after`: the turn's origin, and the last
/// position seen.
async fn until_turn_ends(
    events: &mut UnboundedReceiver<HostEvent>,
    thread_id: &ThreadId,
    mut answer: impl FnMut(&HostEvent),
) -> (Option<TurnOrigin>, u64) {
    let mut origin = None;
    loop {
        let event = next(events).await;
        answer(&event);
        let HostEvent::Event(notification) = event else {
            continue;
        };
        if notification.thread_id != *thread_id {
            continue;
        }
        match notification.event {
            ThreadEvent::TurnStarted {
                origin: started, ..
            } => origin = Some(started),
            ThreadEvent::TurnEnded { .. } => return (origin, notification.seq),
            _ => {}
        }
    }
}

async fn create(connection: &HostConnection, cwd: &str) -> ThreadState {
    connection
        .send(CreateThreadRequest {
            agent_id: "fake".to_owned(),
            cwd: cwd.into(),
            additional_directories: Vec::new(),
            mode: None,
            policy: None,
            trace: false,
            labels: Vec::new(),
        })
        .await
        .expect("thread/create")
}

async fn prompt(connection: &HostConnection, thread_id: &ThreadId, text: &str) {
    connection
        .send(StartTurnRequest {
            thread_id: thread_id.clone(),
            prompt: vec![ContentBlock::from(text.to_owned())],
            key: None,
        })
        .await
        .expect("turn/start");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_device_works_on_each_host_through_the_dispatcher() {
    let hub = Hub::new().await;
    for (world, name) in [(&hub.studio, "studio"), (&hub.mini, "mini")] {
        let host_id = world.host_id().await;
        let Reached {
            connection,
            mut events,
            host,
            ..
        } = hub.reach(name).await;
        assert_eq!(
            (host.host_id.as_str(), host.name.as_str()),
            (host_id.as_str(), name)
        );
        let hello = connection.hello().clone();
        assert_eq!(hello.host.id, host_id, "the Host's own hello");
        assert_eq!(
            hello.device.as_ref(),
            Some(&hub.device),
            "the Dispatcher's device"
        );
        assert!(
            hello
                .features
                .iter()
                .any(|feature| feature == CARRY_FEATURE)
        );

        // It lists, and opens a thread in the same directory under the home there.
        let listed = connection
            .send(ListThreadsRequest::default())
            .await
            .expect("threads/list");
        assert!(listed.threads.is_empty());
        let state = create(&connection, "~").await;
        assert_eq!(state.cwd, world.home());
        let missing = connection
            .send(CreateThreadRequest {
                agent_id: "fake".to_owned(),
                cwd: "~/nowhere".into(),
                additional_directories: Vec::new(),
                mode: None,
                policy: None,
                trace: false,
                labels: Vec::new(),
            })
            .await
            .expect_err("no such directory there");
        assert!(
            missing.message.contains("isn't a directory on this Host"),
            "{missing}"
        );

        // It prompts, and the turn's origin names the device, as the journal keeps it.
        prompt(&connection, &state.thread_id, "hello").await;
        let (origin, _) = until_turn_ends(&mut events, &state.thread_id, |_| {}).await;
        let Some(TurnOrigin::Client { device, .. }) = origin else {
            panic!("a client's turn: {origin:?}");
        };
        assert_eq!(device.as_deref(), Some("laptop"));

        // It answers a pending request there.
        let target = world.home().join("note.txt");
        prompt(
            &connection,
            &state.thread_id,
            &format!("write {} hello there", target.display()),
        )
        .await;
        let asked = loop {
            if let HostEvent::PendingAdded(added) = next(&mut events).await {
                break added.pending.id.clone();
            }
        };
        connection
            .send(AnswerPendingRequest {
                thread_id: state.thread_id.clone(),
                pending_id: asked,
                permission: Some(RequestPermissionResponse::new(
                    RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                        PermissionOptionId::new("allow"),
                    )),
                )),
                elicitation: None,
                client_tool: None,
            })
            .await
            .expect("pending/answer");
        let (_, seen) = until_turn_ends(&mut events, &state.thread_id, |_| {}).await;
        assert_eq!(
            std::fs::read_to_string(&target).expect("written").trim(),
            "hello there"
        );

        // The connection drops; a turn happens meanwhile, and reconnecting catches up after the
        // last position seen, with nothing missing or repeated.
        connection.shutdown().await;
        let local = world.local().await;
        local
            .send(AddQueuedRequest {
                thread_id: state.thread_id.clone(),
                prompt: vec![ContentBlock::from("meanwhile".to_owned())],
                key: None,
                caller: None,
                origin: None,
            })
            .await
            .expect("queue/add");
        tokio::time::timeout(WAIT, async {
            loop {
                let got = local
                    .send(GetThreadRequest {
                        thread_id: state.thread_id.clone(),
                        turn_id: None,
                    })
                    .await
                    .expect("threads/get");
                let local_turn = |turn: &weave_host_protocol::threads::LatestTurn| {
                    matches!(turn.origin, TurnOrigin::Client { device: None, .. })
                };
                if got
                    .latest_turn
                    .is_some_and(|turn| turn.state.is_over() && local_turn(&turn))
                {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the turn meanwhile ended");
        local.shutdown().await;

        let Reached {
            connection,
            mut events,
            ..
        } = hub.reach(name).await;
        let attached = connection
            .send(AttachThreadRequest {
                thread_id: state.thread_id.clone(),
                after: Some(JournalPosition {
                    journal: state.journal.id.clone(),
                    seq: seen,
                }),
                agent_id: None,
                cwd: None,
                trace: false,
                observe: false,
            })
            .await
            .expect("thread/attach");
        assert_eq!(
            (attached.replay.from, attached.replay.reset),
            (seen + 1, false)
        );
        let mut caught_up = Vec::new();
        let (origin, _) = until_turn_ends(&mut events, &state.thread_id, |event| {
            if let HostEvent::Event(notification) = event {
                caught_up.push(notification.seq);
            }
        })
        .await;
        assert_eq!(caught_up.first(), Some(&(seen + 1)), "nothing missing");
        assert!(
            caught_up.windows(2).all(|pair| pair[1] == pair[0] + 1),
            "nothing repeated: {caught_up:?}"
        );
        assert!(
            matches!(origin, Some(TurnOrigin::Client { device: None, .. })),
            "the local client's turn: {origin:?}"
        );
        connection.shutdown().await;
    }
    hub.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn revoking_a_device_closes_its_carried_connections() {
    let hub = Hub::new().await;
    // Another device keeps the WebSocket on, and its connection stays.
    let (_, other) = hub.pair("phone").await;
    let phone = carry::reach(
        &other,
        info("weave-test"),
        ClientCapabilities::default(),
        "studio",
        WAIT,
    )
    .await
    .expect("the other device");
    let Reached {
        connection,
        mut events,
        closed,
        ..
    } = hub.reach("studio").await;
    let Reached {
        connection: _mini,
        events: mut mini_events,
        closed: mini_closed,
        ..
    } = hub.reach("mini").await;
    connection
        .send(ListThreadsRequest::default())
        .await
        .expect("threads/list");

    hub.cli
        .send(RevokeDeviceRequest {
            device_id: hub.device.id.clone(),
        })
        .await
        .expect("devices/revoke");
    disconnected(&mut events).await;
    disconnected(&mut mini_events).await;
    assert_eq!(closed.get().map(|(code, _)| code), Some(CLOSE_REVOKED));
    assert_eq!(mini_closed.get().map(|(code, _)| code), Some(CLOSE_REVOKED));

    phone
        .connection
        .send(ListThreadsRequest::default())
        .await
        .expect("the other device's connection stays");

    // And it's refused from then on.
    let refused = hub.try_reach("studio").await.err().expect("refused");
    assert!(matches!(refused, CarryError::Refused(_)), "{refused}");
    assert!(!refused.may_pass());
    phone.connection.shutdown().await;
    hub.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_host_the_dispatcher_is_not_connected_to_answers_at_once() {
    let hub = Hub::new().await;
    let mini_id = hub.mini.host_id().await;
    hub.mini.relay.cut();
    let listed = host_until(&hub.dispatcher, &mini_id, |host| {
        !host.connected && host.status == Reachability::Unreachable
    })
    .await;

    let started = std::time::Instant::now();
    let error = hub.try_reach("mini").await.err().expect("unreachable");
    assert!(started.elapsed() < Duration::from_secs(2), "at once");
    let CarryError::Unavailable(unavailable) = &error else {
        panic!("unavailable: {error}");
    };
    assert_eq!(unavailable.status, listed.status);
    assert_eq!(unavailable.status, Reachability::Unreachable);
    assert!(
        unavailable
            .why
            .contains(listed.why.as_deref().expect("why")),
        "{unavailable:?} {listed:?}"
    );
    assert!(error.may_pass(), "it may come back");

    // A Host that never joined isn't one to wait for.
    let unknown = hub.try_reach("nowhere").await.err().expect("no such Host");
    assert!(matches!(unknown, CarryError::Refusal(_)), "{unknown}");
    assert!(!unknown.may_pass());

    // The other is reached as ever.
    hub.reach("studio").await.connection.shutdown().await;
    hub.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_host_takes_the_dispatchers_word_only_on_connections_it_opened() {
    let hub = Hub::new().await;
    // A local client may not say it, nor ask the Host to carry a connection.
    let refused = HostConnection::connect_with(
        hub.studio.daemon.connect_in_process(),
        info("weave"),
        ClientCapabilities::default(),
        Credentials::Dispatcher,
    )
    .await
    .err()
    .expect("refused");
    assert!(
        refused
            .to_string()
            .contains("only a connection the Host opened"),
        "{refused}"
    );
    let local = hub.studio.local().await;
    let forbidden = local
        .send(CarryRequest {
            token: "made-up".to_owned(),
            device: hub.device.clone(),
            stream: CarriedStream::Host,
        })
        .await
        .expect_err("not the Dispatcher it joined");
    assert!(errors::is(&forbidden, errors::FORBIDDEN), "{forbidden}");
    local.shutdown().await;

    // And a carried connection takes nothing else.
    let (carried, _) = carry::open(&hub.via, &info("weave-test"), "studio", CarriedStream::Host)
        .await
        .expect("carried");
    let (transport, _) = carried.transport();
    let refused = HostConnection::connect_with(
        transport,
        info("weave"),
        ClientCapabilities::default(),
        Credentials::Local,
    )
    .await
    .err()
    .expect("refused");
    assert!(
        refused.to_string().contains("auth: dispatcher"),
        "{refused}"
    );
    hub.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn removing_a_host_closes_what_is_carried_to_it() {
    let hub = Hub::new().await;
    let Reached {
        connection: _studio,
        mut events,
        ..
    } = hub.reach("studio").await;
    let Reached {
        connection: mini,
        events: mut mini_events,
        ..
    } = hub.reach("mini").await;
    hub.dispatcher.remove_host("studio").await.expect("removed");
    disconnected(&mut events).await;
    // What's carried to the other stays.
    mini.send(ListThreadsRequest::default())
        .await
        .expect("still carried");
    assert!(mini_events.try_recv().is_err());
    let gone = hub
        .try_reach("studio")
        .await
        .err()
        .expect("no such Host now");
    assert!(matches!(gone, CarryError::Refusal(_)), "{gone}");
    mini.shutdown().await;
    hub.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_on_the_dispatchers_computer_goes_through_its_socket() {
    let hub = Hub::new().await;
    let via = Via::Socket(dispatcher_config(hub.dir.path()).paths.socket());
    let Reached {
        connection,
        mut events,
        host,
        ..
    } = carry::reach(
        &via,
        info("weave-test"),
        ClientCapabilities::default(),
        "mini",
        WAIT,
    )
    .await
    .expect("carried over the socket");
    assert_eq!(host.name, "mini");
    let device = connection.hello().device.clone().expect("a device");
    assert_eq!(
        (device.id.as_str(), device.name),
        (LOCAL_DEVICE, weave_dispatcher::computer_name())
    );
    let state = create(&connection, "~").await;
    prompt(&connection, &state.thread_id, "hello").await;
    let (origin, _) = until_turn_ends(&mut events, &state.thread_id, |_| {}).await;
    assert!(
        matches!(&origin, Some(TurnOrigin::Client { device: Some(name), .. }) if *name == weave_dispatcher::computer_name()),
        "{origin:?}"
    );
    connection.shutdown().await;

    // Its socket carries text, so not a terminal's stream.
    let refused = carry::open(&via, &info("weave-test"), "mini", CarriedStream::Terminal)
        .await
        .err()
        .expect("refused");
    assert!(refused.to_string().contains("WebSocket"), "{refused}");

    // The API on the socket answers as before.
    let status = ask(hub.dir.path())
        .await
        .send(DispatcherStatusRequest {})
        .await
        .expect("dispatcher/status");
    assert_eq!(status.devices, 1);
    hub.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_terminals_stream_goes_through_the_dispatcher() {
    let hub = Hub::with(World::with_terminals().await, World::new().await).await;
    let Reached { connection, .. } = hub.reach("studio").await;
    let terminal = connection
        .send(NewTerminalRequest {
            directory: hub.studio.home(),
            ..NewTerminalRequest::default()
        })
        .await
        .expect("terminals/new")
        .terminal;
    let ticket = connection
        .send(AttachTerminalRequest {
            id: terminal.id.clone(),
        })
        .await
        .expect("terminals/attach")
        .ticket;

    // Another device's ticket isn't this one's.
    let (carried, _) = carry::open(
        &hub.via,
        &info("weave-test"),
        "studio",
        CarriedStream::Terminal,
    )
    .await
    .expect("carried");
    let Carried::WebSocket(mut socket) = carried else {
        panic!("a WebSocket");
    };
    let local = hub.studio.local().await;
    let local_ticket = local
        .send(AttachTerminalRequest {
            id: terminal.id.clone(),
        })
        .await
        .expect("a local client's ticket")
        .ticket;
    local.shutdown().await;
    let open = |ticket: &str| Open {
        ticket: ticket.to_owned(),
        size: weave_host_protocol::terminals::TerminalSize { cols: 80, rows: 24 },
        codec: "x".to_owned(),
        history: false,
    };
    socket
        .send(Message::text(
            serde_json::to_string(&open(&local_ticket)).expect("json"),
        ))
        .await
        .expect("sent");
    let closed = loop {
        match tokio::time::timeout(WAIT, socket.next())
            .await
            .expect("in time")
        {
            Some(Ok(Message::Close(frame))) => break frame.map(|frame| u16::from(frame.code)),
            Some(Ok(_)) => {}
            _ => break None,
        }
    };
    assert_eq!(
        closed,
        Some(weave_host_protocol::terminals::stream::CLOSE_TICKET)
    );

    // The device's own ticket opens it, and its frames pass through both ways.
    let (carried, _) = carry::open(
        &hub.via,
        &info("weave-test"),
        "studio",
        CarriedStream::Terminal,
    )
    .await
    .expect("carried");
    let Carried::WebSocket(mut socket) = carried else {
        panic!("a WebSocket");
    };
    socket
        .send(Message::text(
            serde_json::to_string(&open(&ticket)).expect("json"),
        ))
        .await
        .expect("sent");
    let mut opened = None;
    let mut restore = Vec::new();
    while restore.is_empty() {
        match tokio::time::timeout(WAIT, socket.next())
            .await
            .expect("in time")
        {
            Some(Ok(Message::Text(text))) if opened.is_none() => {
                opened = Some(serde_json::from_str::<Opened>(&text).expect("opened"));
            }
            Some(Ok(Message::Binary(bytes))) if bytes.first() == Some(&RESTORE) => {
                restore.extend_from_slice(&bytes[1..]);
            }
            Some(Ok(_)) => {}
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(opened.expect("opened").terminal.id, terminal.id);
    assert_eq!(restore, b"fake");
    socket
        .send(Message::binary([&[INPUT][..], b"echo hi\r"].concat()))
        .await
        .expect("typed");
    let output = loop {
        match tokio::time::timeout(WAIT, socket.next())
            .await
            .expect("in time")
        {
            Some(Ok(Message::Binary(bytes))) if bytes.first() == Some(&OUTPUT) => {
                break bytes[1..].to_vec();
            }
            Some(Ok(_)) => {}
            other => panic!("{other:?}"),
        }
    };
    assert_eq!(output, b"echo hi\r");

    // Revoking the device closes its stream too.
    hub.cli
        .send(RevokeDeviceRequest {
            device_id: hub.device.id.clone(),
        })
        .await
        .expect("devices/revoke");
    let closed = loop {
        match tokio::time::timeout(WAIT, socket.next())
            .await
            .expect("in time")
        {
            Some(Ok(Message::Close(frame))) => break frame.map(|frame| u16::from(frame.code)),
            Some(Ok(_)) => {}
            _ => break None,
        }
    };
    assert_eq!(closed, Some(CLOSE_REVOKED));
    connection.shutdown().await;
    hub.stop().await;
}

/// How something answering at the Dispatcher's address, without its key, answers `hosts/carry`.
#[derive(Clone, Copy, Debug)]
enum Impostor {
    /// Signs as the Dispatcher would, with a key of its own.
    OtherKey,
    /// Takes the token without signing anything.
    NoSignature,
}

/// What the Host did once an impostor answered `hosts/carry`: the answer to a hello sent then,
/// if it served one, and the code it closed with.
#[derive(Debug)]
struct Served {
    answer: Option<String>,
    closed: Option<u16>,
}

/// Answer one connection a Host opens at the Dispatcher's address as the Dispatcher `id` would,
/// but without its key: what the Host does then, and whether it answers a hello there after.
async fn impostor(
    stream: tokio::net::UnixStream,
    id: String,
    host_id: String,
    how: Impostor,
) -> Served {
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
        dispatcher_id: id.clone(),
        nonce: "n".to_owned(),
        expires_at: u64::MAX,
    };
    assert!(preamble::answer(&mut socket, asked.id, Ok(challenge)).await);
    let asked = preamble::next_request(&mut socket)
        .await
        .expect("its token");
    assert_eq!(asked.method, "hosts/carry");
    let carry: HostCarryRequest = asked.params().expect("a token and a nonce");
    assert!(!carry.nonce.is_empty(), "a nonce of the Host's own");
    match how {
        Impostor::OtherKey => {
            let message = carry_message(&id, &host_id, &carry.token, &carry.nonce);
            let signature = DeviceKey::generate().sign(&message).expect("signed");
            preamble::answer(&mut socket, asked.id, Ok(HostCarried { signature })).await;
        }
        Impostor::NoSignature => {
            preamble::answer(&mut socket, asked.id, Ok(serde_json::json!({}))).await;
        }
    }
    // The Host closes the connection on its own, sending nothing else first.
    let mut served = Served {
        answer: None,
        closed: None,
    };
    loop {
        match tokio::time::timeout(WAIT, socket.next()).await {
            Ok(Some(Ok(Message::Close(frame)))) => {
                served.closed = frame.map(|frame| u16::from(frame.code));
                break;
            }
            Ok(Some(Ok(Message::Text(text)))) => served.answer = Some(text.to_string()),
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_)) | None) | Err(_) => break,
        }
    }
    // And a hello there now gets no answer.
    let hello = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "host/hello",
        "params": {
            "protocol": {"min": 3, "max": 3},
            "client": {"name": "impostor", "version": "0"},
            "auth": {"method": "dispatcher"},
        },
    });
    if socket.send(Message::text(hello.to_string())).await.is_ok() {
        while let Ok(Some(Ok(frame))) =
            tokio::time::timeout(Duration::from_millis(500), socket.next()).await
        {
            if let Message::Text(text) = frame {
                served.answer = Some(text.to_string());
            }
        }
    }
    served
}

#[tokio::test(flavor = "multi_thread")]
async fn a_host_serves_nothing_where_the_dispatcher_proves_no_key() {
    let hub = Hub::new().await;
    let id = hub.dispatcher.status().expect("status").id;
    let host_id = hub.studio.host_id().await;
    // The Host's own connection stays the Dispatcher's; what it opens from now on reaches
    // something else, which knows the Dispatcher's id and nothing more.
    let elsewhere = hub.dir.path().join("impostor.sock");
    let listener = tokio::net::UnixListener::bind(&elsewhere).expect("a socket");
    hub.studio.relay.point(&elsewhere);
    for how in [Impostor::OtherKey, Impostor::NoSignature] {
        let answering = async {
            let (stream, _) = tokio::time::timeout(WAIT, listener.accept())
                .await
                .expect("the Host connected there")
                .expect("accepted");
            impostor(stream, id.clone(), host_id.clone(), how).await
        };
        let (served, reached) = tokio::join!(answering, hub.try_reach("studio"));
        assert_eq!(served.answer, None, "{how:?}: it served nothing");
        assert_eq!(served.closed, Some(CLOSE_UNAUTHENTICATED), "{how:?}");
        let error = reached.err().expect("nothing carried");
        let CarryError::Unavailable(unavailable) = &error else {
            panic!("{how:?}: {error}");
        };
        let why = match how {
            Impostor::OtherKey => "didn't prove the key of the Dispatcher this Host joined",
            Impostor::NoSignature => "signature",
        };
        assert!(unavailable.why.contains(why), "{how:?}: {unavailable:?}");
    }

    // Where the Dispatcher answers again, the Host serves the device.
    hub.studio
        .relay
        .point(&dispatcher_config(hub.dir.path()).paths.hosts_socket());
    hub.reach("studio").await.connection.shutdown().await;
    hub.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_carried_device_does_everything_but_administer_the_host() {
    let hub = Hub::new().await;
    let Reached { connection, .. } = hub.reach("studio").await;
    for refused in [
        connection.send(ShutdownRequest {}).await.map(|_| ()),
        connection.send(LeaveDispatcherRequest {}).await.map(|_| ()),
        connection
            .send(LogoutAgentRequest {
                agent_id: "fake".to_owned(),
            })
            .await
            .map(|_| ()),
    ] {
        let error = refused.expect_err("forbidden");
        assert!(errors::is(&error, errors::FORBIDDEN), "{error}");
    }
    // The Host pairs no devices of its own (WVE-197).
    let devices = UntypedMessage::new("devices/list", serde_json::json!({})).expect("a request");
    let error = connection.send(devices).await.expect_err("no devices/list");
    assert_eq!(
        error.code,
        agent_client_protocol::Error::method_not_found().code
    );
    // Updating an agent isn't administering the Host: it only takes the agent to its newest
    // version. This one runs the command its configuration gives, so that's the person's to do.
    let update = connection
        .send(UpdateAgentRequest {
            agent_id: "fake".to_owned(),
        })
        .await
        .expect_err("a configured agent");
    assert!(!errors::is(&update, errors::FORBIDDEN), "{update}");
    assert!(update.to_string().contains("yours to do"), "{update}");
    // Nor is asking how it is, watching its threads or listing a directory.
    let status = connection
        .send(StatusRequest {})
        .await
        .expect("host/status");
    assert_eq!(status.serve_entry, None);
    connection
        .send(WatchThreadsRequest::default())
        .await
        .expect("threads/watch");
    let listed = connection
        .send(ListFilesRequest {
            path: Some(hub.studio.home()),
            hidden: false,
        })
        .await
        .expect("files/list");
    assert_eq!(listed.path, hub.studio.home());
    connection.shutdown().await;
    hub.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_replay_many_times_the_limit_arrives_whole_through_the_dispatcher() {
    let limit = 64 * 1024;
    let studio = World::with_websocket(RemoteConfig {
        behind_limit: limit,
        ..RemoteConfig::default()
    })
    .await;
    let hub = Hub::with(studio, World::new().await).await;

    // A thread with a long journal: each prompt and the agent's echo of it are twice the limit.
    let (local, mut local_events) = HostConnection::connect(
        hub.studio.daemon.connect_in_process(),
        info("weave"),
        ClientCapabilities::default(),
    )
    .await
    .expect("a local client");
    let state = create(&local, &hub.studio.home().display().to_string()).await;
    for _ in 0..4 {
        local
            .send(StartTurnRequest {
                thread_id: state.thread_id.clone(),
                prompt: vec![ContentBlock::from("x".repeat(limit * 2))],
                key: None,
            })
            .await
            .expect("turn/start");
        until_turn_ends(&mut local_events, &state.thread_id, |_| {}).await;
    }

    // A phone opening it through the Dispatcher gets all of it, though it all waits to be sent
    // from the Host at once.
    let Reached {
        connection,
        mut events,
        closed,
        ..
    } = hub.reach("studio").await;
    let attached = connection
        .send(AttachThreadRequest {
            thread_id: state.thread_id.clone(),
            after: None,
            agent_id: None,
            cwd: None,
            trace: false,
            observe: false,
        })
        .await
        .expect("thread/attach");
    let head = attached.state.journal.head;
    let mut replayed = 0;
    loop {
        match next(&mut events).await {
            HostEvent::Event(notification) => {
                replayed += serde_json::to_vec(&notification).expect("JSON").len();
                if notification.seq == head {
                    break;
                }
            }
            HostEvent::Disconnected(_) => panic!("closed: {:?}", closed.get()),
            _ => {}
        }
    }
    assert!(replayed > 8 * limit, "{replayed} bytes replayed");
    connection
        .send(StatusRequest {})
        .await
        .expect("still connected");
    assert_eq!(closed.get(), None);
    connection.shutdown().await;
    local.shutdown().await;
    hub.stop().await;
}
