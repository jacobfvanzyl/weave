//! The person's devices and the Dispatcher (WVE-176): pairing with a code over its loopback
//! WebSocket, proving a device at every hello, what a device may ask, revoking it, and the Serve
//! entry pairing makes and the last revoke removes.

#![allow(clippy::expect_used)]

mod common;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Role as _;
use futures::future::BoxFuture;
use pretty_assertions::assert_eq;
use weave_dispatcher::Dispatcher;
use weave_dispatcher::client::DispatcherConnection;
use weave_dispatcher::socket;
use weave_host_client::Credentials;
use weave_host_client::remote::CloseReason;
use weave_host_client::remote::DeviceKey;
use weave_host_client::remote::connect_websocket;
use weave_host_client::remote::connect_websocket_as;
use weave_host_protocol::Dispatcher as DispatcherRole;
use weave_host_protocol::DispatcherClient;
use weave_host_protocol::devices::DeviceInfo;
use weave_host_protocol::devices::ListDevicesRequest;
use weave_host_protocol::devices::OfferDeviceRequest;
use weave_host_protocol::devices::RevokeDeviceRequest;
use weave_host_protocol::devices::auth_message;
use weave_host_protocol::dispatcher::DISPATCHER_PROTOCOL;
use weave_host_protocol::dispatcher::DISPATCHER_SUBPROTOCOL;
use weave_host_protocol::dispatcher::DispatcherAddress;
use weave_host_protocol::dispatcher::DispatcherChallengeRequest;
use weave_host_protocol::dispatcher::DispatcherHelloRequest;
use weave_host_protocol::dispatcher::DispatcherStatusRequest;
use weave_host_protocol::dispatcher::ListHostsRequest;
use weave_host_protocol::dispatcher::ListSchedulesRequest;
use weave_host_protocol::dispatcher::OfferHostRequest;
use weave_host_protocol::dispatcher::dispatcher_auth_message;
use weave_host_protocol::errors;
use weave_host_protocol::hello::Auth;
use weave_host_protocol::websocket::CLOSE_REVOKED;
use weave_host_protocol::websocket::CLOSE_UNAUTHENTICATED;
use weave_remote::access::RemoteSettings;
use weave_remote::access::Serve;

use crate::common::WAIT;
use crate::common::World;
use crate::common::ask;
use crate::common::dispatcher_config;
use crate::common::info;

/// A Tailscale Serve that records what the Dispatcher asks of it, and hands out `ws://` URLs.
#[derive(Default)]
struct FakeServe {
    calls: std::sync::Mutex<Vec<String>>,
}

impl FakeServe {
    fn calls(&self) -> Vec<String> {
        self.calls.lock().expect("calls").clone()
    }
}

impl Serve for FakeServe {
    fn ensure(&self, listen: SocketAddr) -> BoxFuture<'_, Result<String, String>> {
        Box::pin(async move {
            self.calls.lock().expect("calls").push("ensure".to_owned());
            Ok(format!("ws://{listen}"))
        })
    }

    fn remove(&self, _listen: SocketAddr) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.calls.lock().expect("calls").push("remove".to_owned());
            Ok(())
        })
    }
}

/// A Dispatcher from `dir` that serves devices once one pairs, with `serve` for its entry.
fn start(
    dir: &std::path::Path,
    serve: Arc<FakeServe>,
) -> (Dispatcher, tokio::task::JoinHandle<()>) {
    let mut remote = RemoteSettings::new(serve);
    remote.listen = "127.0.0.1:0".parse().expect("an address");
    let config = weave_dispatcher::DispatcherConfig {
        remote: Some(remote),
        ..dispatcher_config(dir)
    };
    let listening = socket::listen(&config.paths).expect("its socket");
    let dispatcher = Dispatcher::open(config).expect("opened");
    let serving = dispatcher.clone();
    let task = tokio::spawn(async move { serving.serve(listening.listener).await });
    (dispatcher, task)
}

/// A code from the Dispatcher's own computer, and the URL a device connects to.
async fn offer(cli: &DispatcherConnection) -> (String, String) {
    let offer = cli
        .send(OfferDeviceRequest {
            name: Some("Mac".to_owned()),
        })
        .await
        .expect("devices/offer");
    (offer.url.expect("a URL"), offer.code)
}

async fn connect(
    url: &str,
    credentials: Credentials,
) -> (
    Result<DispatcherConnection, agent_client_protocol::Error>,
    CloseReason,
) {
    let (transport, closed) = connect_websocket_as(url, DISPATCHER_SUBPROTOCOL)
        .await
        .expect("the WebSocket");
    let connected =
        DispatcherConnection::connect_with(transport, info("weave-cli"), credentials).await;
    (connected, closed)
}

/// Pair a new device with `code`, giving the connection it pairs on, its device and its key.
async fn pair(url: &str, code: &str) -> (DispatcherConnection, DeviceInfo, DeviceKey) {
    let key = DeviceKey::generate();
    let (connected, _) = connect(
        url,
        Credentials::Pair {
            code: code.to_owned(),
            name: "laptop".to_owned(),
            key: key.clone(),
            service: false,
        },
    )
    .await;
    let connection = connected.expect("paired");
    let device = connection.hello().device.clone().expect("its device");
    (connection, device, key)
}

fn device(device: &DeviceInfo, key: &DeviceKey, dispatcher_id: Option<String>) -> Credentials {
    Credentials::Device {
        device_id: device.id.clone(),
        key: key.clone(),
        host_id: dispatcher_id,
    }
}

/// Wait for the Dispatcher to close a connection, giving its close code.
async fn closed(reason: &CloseReason) -> u16 {
    tokio::time::timeout(WAIT, async {
        loop {
            if let Some((code, _)) = reason.get() {
                return code;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("closed in time")
}

/// A raw client over the WebSocket, to send what the client wouldn't.
async fn raw(url: &str) -> (ConnectionTo<DispatcherRole>, tokio::task::JoinHandle<()>) {
    let (transport, _) = connect_websocket_as(url, DISPATCHER_SUBPROTOCOL)
        .await
        .expect("the WebSocket");
    let (cx_tx, cx_rx) = tokio::sync::oneshot::channel();
    let driver = tokio::spawn(async move {
        let _ = DispatcherClient
            .builder()
            .connect_with(transport, async move |cx: ConnectionTo<DispatcherRole>| {
                let _ = cx_tx.send(cx.clone());
                cx.incoming_closed().await;
                Ok(())
            })
            .await;
    });
    (cx_rx.await.expect("connected"), driver)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_device_pairs_once_then_proves_its_key_and_asks_the_dispatcher() {
    let world = World::new().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let serve = Arc::new(FakeServe::default());
    let (dispatcher, _serving) = start(dir.path(), Arc::clone(&serve));
    let mut cli = ask(dir.path()).await;
    world.join(&dispatcher, dir.path(), "studio").await;
    let host_id = world.host_id().await;
    let status = cli.send(DispatcherStatusRequest {}).await.expect("status");
    assert_eq!((status.remote, status.devices), (None, 0));

    let (url, code) = offer(&cli).await;
    assert_eq!(serve.calls(), vec!["ensure"]);
    let (paired, device, key) = pair(&url, &code).await;
    assert_eq!(device.name, "Mac", "the offer named it");
    assert_eq!(paired.hello().id, status.id);
    let told = tokio::time::timeout(WAIT, cli.paired())
        .await
        .expect("told in time")
        .expect("a device");
    assert_eq!(told.id, device.id);
    paired.shutdown().await;

    // The code works once.
    let (again, closed_again) = connect(
        &url,
        Credentials::Pair {
            code: code.clone(),
            name: "another".to_owned(),
            key: DeviceKey::generate(),
            service: false,
        },
    )
    .await;
    let refused = again.err().expect("a used code");
    assert!(errors::is(&refused, errors::UNAUTHENTICATED), "{refused}");
    assert_eq!(closed(&closed_again).await, CLOSE_UNAUTHENTICATED);

    // From then on it proves its key, and asks what the CLI asks.
    let (connected, _) = connect(&url, self::device(&device, &key, Some(status.id.clone()))).await;
    let remote = connected.expect("proved its key");
    let hosts = remote
        .send(ListHostsRequest {})
        .await
        .expect("hosts/list")
        .hosts;
    assert_eq!(
        hosts
            .iter()
            .map(|host| host.host_id.clone())
            .collect::<Vec<_>>(),
        vec![host_id]
    );
    // It may ask for a code a Host elsewhere joins with, but not for the socket here.
    let offered = remote
        .send(OfferHostRequest { here: false })
        .await
        .expect("hosts/offer");
    assert!(
        matches!(offered.address, DispatcherAddress::Url(_)),
        "{offered:?}"
    );
    let here = remote
        .send(OfferHostRequest { here: true })
        .await
        .expect_err("only the Dispatcher's computer gets its socket");
    assert!(errors::is(&here, errors::FORBIDDEN), "{here}");
    let schedules = remote
        .send(ListSchedulesRequest {})
        .await
        .expect("schedules/list");
    assert!(schedules.schedules.is_empty());
    let status = remote
        .send(DispatcherStatusRequest {})
        .await
        .expect("status");
    assert_eq!(status.devices, 1);
    assert!(status.remote.is_some());
    let listed = cli
        .send(ListDevicesRequest {})
        .await
        .expect("devices/list")
        .devices;
    assert_eq!(listed.len(), 1);
    assert_eq!(
        (listed[0].id.clone(), listed[0].connections),
        (device.id.clone(), 1)
    );
    remote.shutdown().await;
    cli.shutdown().await;
    dispatcher.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_device_that_cant_prove_itself_is_refused_and_closed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let serve = Arc::new(FakeServe::default());
    let (dispatcher, _serving) = start(dir.path(), serve);
    let cli = ask(dir.path()).await;
    let (url, code) = offer(&cli).await;
    let (paired, device, key) = pair(&url, &code).await;
    let dispatcher_id = paired.hello().id.clone();
    paired.shutdown().await;

    let refusals = [
        (
            "another key",
            self::device(&device, &DeviceKey::generate(), None),
        ),
        (
            "an unknown device",
            Credentials::Device {
                device_id: "d-nobody".to_owned(),
                key: key.clone(),
                host_id: None,
            },
        ),
    ];
    for (what, credentials) in refusals {
        let (connected, reason) = connect(&url, credentials).await;
        let refused = connected
            .err()
            .unwrap_or_else(|| panic!("{what} connected"));
        assert!(
            errors::is(&refused, errors::UNAUTHENTICATED),
            "{what}: {refused}"
        );
        assert_eq!(closed(&reason).await, CLOSE_UNAUTHENTICATED, "{what}");
    }

    // Another Dispatcher's id: the device won't sign for it.
    let (connected, _) = connect(&url, self::device(&device, &key, Some("other".to_owned()))).await;
    assert!(connected.is_err(), "a device signs only for its Dispatcher");

    // A challenge is good for one hello, and a Host's message is no Dispatcher's.
    let (cx, driver) = raw(&url).await;
    let challenge = cx
        .send_request(DispatcherChallengeRequest {})
        .block_task()
        .await
        .expect("dispatcher/challenge");
    assert_eq!(challenge.dispatcher_id, dispatcher_id);
    let hello = |message: String| DispatcherHelloRequest {
        protocol: DISPATCHER_PROTOCOL,
        client: info("raw"),
        auth: Some(Auth::Device {
            device_id: device.id.clone(),
            signature: key.sign(&message).expect("signed"),
        }),
    };
    let as_host = cx
        .send_request(hello(auth_message(
            &challenge.dispatcher_id,
            &device.id,
            &challenge.nonce,
        )))
        .block_task()
        .await
        .expect_err("a Host's message");
    assert!(errors::is(&as_host, errors::UNAUTHENTICATED), "{as_host}");
    driver.abort();
    let (cx, driver) = raw(&url).await;
    let challenge = cx
        .send_request(DispatcherChallengeRequest {})
        .block_task()
        .await
        .expect("dispatcher/challenge");
    let signed = hello(dispatcher_auth_message(
        &challenge.dispatcher_id,
        &device.id,
        &challenge.nonce,
    ));
    cx.send_request(signed.clone())
        .block_task()
        .await
        .expect("the first hello");
    let replayed = cx
        .send_request(signed)
        .block_task()
        .await
        .expect_err("the same signature again");
    assert!(errors::is(&replayed, errors::UNAUTHENTICATED), "{replayed}");
    driver.abort();

    // Before hello, a WebSocket client is asked nothing else.
    let (cx, driver) = raw(&url).await;
    let early = cx
        .send_request(ListHostsRequest {})
        .block_task()
        .await
        .expect_err("before hello");
    assert!(errors::is(&early, errors::UNAUTHENTICATED), "{early}");
    driver.abort();

    // The socket gives no challenges and takes no device's hello.
    let challenge = cli
        .send(DispatcherChallengeRequest {})
        .await
        .expect_err("no challenge on the socket");
    assert!(
        errors::is(&challenge, errors::UNAUTHENTICATED),
        "{challenge}"
    );
    let socket = dispatcher_config(dir.path()).paths.socket();
    let as_device = DispatcherConnection::connect_with(
        socket::connect(&socket).await.expect("the socket"),
        info("weave-cli"),
        self::device(&device, &key, None),
    )
    .await;
    assert!(as_device.is_err(), "devices connect over the WebSocket");

    // And a client asking for the Host's subprotocol isn't upgraded.
    assert!(connect_websocket(&url).await.is_err());
    cli.shutdown().await;
    dispatcher.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn devices_are_managed_only_on_the_dispatchers_computer_and_revoking_one_closes_it() {
    let dir = tempfile::tempdir().expect("tempdir");
    let serve = Arc::new(FakeServe::default());
    let (dispatcher, serving) = start(dir.path(), Arc::clone(&serve));
    let cli = ask(dir.path()).await;
    let (url, code) = offer(&cli).await;
    let (paired, device, key) = pair(&url, &code).await;
    paired.shutdown().await;
    let (connected, reason) = connect(&url, self::device(&device, &key, None)).await;
    let remote = connected.expect("connected");
    for refused in [
        remote.send(OfferDeviceRequest { name: None }).await.err(),
        remote.send(ListDevicesRequest {}).await.err(),
        remote
            .send(RevokeDeviceRequest {
                device_id: device.id.clone(),
            })
            .await
            .err(),
    ] {
        let refused = refused.expect("refused");
        assert!(errors::is(&refused, errors::FORBIDDEN), "{refused}");
    }

    // Paired devices outlive the Dispatcher, and so does the WebSocket they keep on.
    remote.shutdown().await;
    dispatcher.stop().await;
    serving.abort();
    let _ = serving.await;
    let (dispatcher, _serving) = start(dir.path(), Arc::clone(&serve));
    let cli = ask(dir.path()).await;
    let url = format!(
        "ws://{}",
        cli.send(DispatcherStatusRequest {})
            .await
            .expect("status")
            .remote
            .expect("remote access is back on")
    );
    let (connected, reason_after) = connect(&url, self::device(&device, &key, None)).await;
    let remote = connected.expect("connected again");
    drop(reason);

    // Revoking it closes its connections, its key is refused, and with the last device gone
    // the Serve entry goes too.
    cli.send(RevokeDeviceRequest {
        device_id: device.id.clone(),
    })
    .await
    .expect("devices/revoke");
    assert_eq!(closed(&reason_after).await, CLOSE_REVOKED);
    remote.shutdown().await;
    assert_eq!(serve.calls().last().map(String::as_str), Some("remove"));
    let status = cli.send(DispatcherStatusRequest {}).await.expect("status");
    assert_eq!((status.remote, status.devices), (None, 0));
    assert!(
        connect_websocket_as::<DispatcherClient>(&url, DISPATCHER_SUBPROTOCOL)
            .await
            .is_err(),
        "nothing listens once the last device is revoked"
    );
    cli.shutdown().await;
    dispatcher.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_offer_nobody_takes_turns_remote_access_off_again() {
    let dir = tempfile::tempdir().expect("tempdir");
    let serve = Arc::new(FakeServe::default());
    let mut remote = RemoteSettings::new(Arc::clone(&serve) as Arc<dyn Serve>);
    remote.listen = "127.0.0.1:0".parse().expect("an address");
    remote.offer_lifetime = Duration::from_millis(100);
    let config = weave_dispatcher::DispatcherConfig {
        remote: Some(remote),
        ..dispatcher_config(dir.path())
    };
    let listening = socket::listen(&config.paths).expect("its socket");
    let dispatcher = Dispatcher::open(config).expect("opened");
    let serving = dispatcher.clone();
    let _serving = tokio::spawn(async move { serving.serve(listening.listener).await });
    let cli = ask(dir.path()).await;
    offer(&cli).await;
    tokio::time::timeout(WAIT, async {
        while serve.calls() != ["ensure", "remove"] {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("turned off once the offer expired");
    let status = cli.send(DispatcherStatusRequest {}).await.expect("status");
    assert_eq!(status.remote, None);
    cli.shutdown().await;
    dispatcher.stop().await;
}
