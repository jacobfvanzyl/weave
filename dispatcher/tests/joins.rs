//! Hosts joining the Dispatcher (ADR 0030, WVE-194): a code that works once, keys proved both
//! ways on every connection, a Host removed while connected or away, a Host paired before Hosts
//! joined, and a Host on another computer joining over the WebSocket.

#![allow(clippy::expect_used)]

mod common;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use pretty_assertions::assert_eq;
use weave_dispatcher::Dispatcher;
use weave_dispatcher::socket;
use weave_host_protocol::dispatcher::DispatcherAddress;
use weave_host_protocol::dispatcher::JoinDispatcherRequest;
use weave_host_protocol::dispatcher::Reachability;
use weave_host_protocol::errors;
use weave_remote::access::RemoteSettings;
use weave_remote::access::Serve;

use crate::common::WAIT;
use crate::common::World;
use crate::common::delivered;
use crate::common::dispatcher_config;
use crate::common::host_until;
use crate::common::run;
use crate::common::start;

/// Wait until `world`'s Host has forgotten the Dispatcher it joined.
async fn forgotten(world: &World) {
    tokio::time::timeout(WAIT, async {
        while world.daemon.dispatcher().is_some() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("forgotten in time");
    assert!(
        !world.dir.path().join("dispatcher.json").exists(),
        "its record is gone too"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_host_joins_with_a_code_once() {
    let studio = World::new().await;
    let mini = World::new().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let (dispatcher, serving) = start(dir.path());
    let code = dispatcher.offer_host(true).await.expect("a code").code;
    let joined = studio
        .join_with(dir.path(), code.clone(), "studio")
        .await
        .expect("joined");
    assert_eq!(joined.host_name, "studio");
    assert_eq!(
        studio.daemon.status().dispatcher.map(|joined| joined.id),
        Some(dispatcher.status().expect("status").id)
    );

    let refused = mini
        .join_with(dir.path(), code, "mini")
        .await
        .expect_err("a used code");
    assert!(errors::is(&refused, errors::UNAUTHENTICATED), "{refused}");
    assert!(
        refused.message.contains("expired or been used"),
        "{refused}"
    );
    assert_eq!(mini.daemon.dispatcher(), None);
    assert_eq!(
        dispatcher
            .hosts()
            .expect("hosts")
            .into_iter()
            .map(|host| host.name)
            .collect::<Vec<_>>(),
        vec!["studio"]
    );
    dispatcher.stop().await;
    serving.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wrong_key_either_way_closes_the_connection() {
    let studio = World::new().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let (dispatcher, serving) = start(dir.path());
    studio.join(&dispatcher, dir.path(), "studio").await;
    let host_id = studio.host_id().await;
    host_until(&dispatcher, &host_id, |host| host.connected).await;

    // The Dispatcher's key isn't the one the Host learned when it joined: the Host refuses its
    // hello, and keeps trying.
    dispatcher.stop().await;
    serving.abort();
    let _ = serving.await;
    std::fs::remove_file(dispatcher_config(dir.path()).paths.key()).expect("its key");
    let (dispatcher, serving) = start(dir.path());
    let refused = host_until(&dispatcher, &host_id, |host| {
        host.status == Reachability::Refused
    })
    .await;
    assert!(!refused.connected);
    assert!(
        refused
            .why
            .as_deref()
            .is_some_and(|why| why.starts_with("it refused the Dispatcher's hello")),
        "{refused:?}"
    );
    assert!(studio.daemon.dispatcher().is_some(), "the Host keeps it");

    // The Host's key isn't the one it joined with: the Dispatcher refuses it, and the Host
    // forgets it.
    let other = tempfile::tempdir().expect("tempdir");
    let (dispatcher, serving) = {
        dispatcher.stop().await;
        serving.abort();
        let _ = serving.await;
        start(other.path())
    };
    studio.join(&dispatcher, other.path(), "studio").await;
    host_until(&dispatcher, &host_id, |host| host.connected).await;
    std::fs::remove_file(studio.dir.path().join("key.json")).expect("the Host's key");
    studio.relay.cut();
    studio.relay.resume();
    forgotten(&studio).await;
    dispatcher.stop().await;
    serving.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_removed_host_forgets_the_dispatcher() {
    let studio = World::new().await;
    let mini = World::new().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let (dispatcher, serving) = start(dir.path());
    studio.join(&dispatcher, dir.path(), "studio").await;
    mini.join(&dispatcher, dir.path(), "mini").await;
    let mini_id = mini.host_id().await;
    host_until(&dispatcher, &mini_id, |host| host.connected).await;

    // Connected, it's told as its connection closes.
    dispatcher.remove_host("studio").await.expect("removed");
    forgotten(&studio).await;

    // Away, it's refused when it next connects.
    mini.relay.cut();
    host_until(&dispatcher, &mini_id, |host| !host.connected).await;
    dispatcher.remove_host(&mini_id).await.expect("removed");
    mini.relay.resume();
    forgotten(&mini).await;

    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(dispatcher.hosts().expect("hosts").is_empty());
    dispatcher.stop().await;
    serving.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_host_paired_before_hosts_joined_carries_on_once_it_joins() {
    let studio = World::new().await;
    let host_id = studio.host_id().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let (dispatcher, serving) = start(dir.path());
    dispatcher.stop().await;
    serving.abort();
    let _ = serving.await;
    rusqlite::Connection::open(dispatcher_config(dir.path()).paths.database())
        .expect("the database")
        .execute(
            "INSERT INTO hosts (host_id, name, url, device_id, paired_at) \
             VALUES (?1, 'studio', 'wss://studio.example.ts.net:7341', 'd-old', 1)",
            [&host_id],
        )
        .expect("paired the old way");
    let (dispatcher, serving) = start(dir.path());
    let old = host_until(&dispatcher, &host_id, |_| true).await;
    assert_eq!(old.status, Reachability::Unjoined);
    let waiting = dispatcher
        .deliver(&host_id, run(&studio, "hello"))
        .expect("work for it, as a schedule naming it writes down");

    studio.join(&dispatcher, dir.path(), "studio").await;
    let joined = host_until(&dispatcher, &host_id, |host| host.connected).await;
    assert_eq!((joined.paired_at, joined.url.as_str()), (1, ""));
    assert!(joined.joined_at.is_some());
    delivered(&dispatcher, &waiting.id).await;
    dispatcher.stop().await;
    serving.abort();
}

/// A Tailscale Serve that hands out `ws://` URLs to the listener, and records removing it.
#[derive(Default)]
struct FakeServe {
    removed: std::sync::atomic::AtomicBool,
}

impl Serve for FakeServe {
    fn ensure(&self, listen: SocketAddr) -> BoxFuture<'_, Result<String, String>> {
        Box::pin(async move { Ok(format!("ws://{listen}")) })
    }

    fn remove(&self, _listen: SocketAddr) -> BoxFuture<'_, Result<(), String>> {
        self.removed
            .store(true, std::sync::atomic::Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_host_elsewhere_joins_over_the_websocket_which_stays_on_for_it() {
    let studio = World::new().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let serve = Arc::new(FakeServe::default());
    let mut remote = RemoteSettings::new(
        "127.0.0.1:0".parse().expect("an address"),
        Arc::clone(&serve) as Arc<dyn Serve>,
    );
    remote.offer_lifetime = Duration::from_millis(200);
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

    let offer = dispatcher.offer_host(false).await.expect("a code");
    let DispatcherAddress::Url(url) = &offer.address else {
        panic!("a URL for a Host elsewhere: {offer:?}");
    };
    assert!(url.starts_with("ws://127.0.0.1:"), "{url}");
    studio
        .daemon
        .join_dispatcher(JoinDispatcherRequest {
            address: offer.address.clone(),
            code: offer.code,
            name: Some("studio".to_owned()),
        })
        .await
        .expect("joined over the WebSocket");
    let host_id = studio.host_id().await;
    let joined = host_until(&dispatcher, &host_id, |host| host.connected).await;
    assert!(!joined.here);

    // The code expires, and the WebSocket stays on for the Host that joined over it.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(dispatcher.status().expect("status").remote.is_some());
    assert!(!serve.removed.load(std::sync::atomic::Ordering::SeqCst));

    // Removing it, the last, turns the WebSocket off.
    dispatcher.remove_host("studio").await.expect("removed");
    forgotten(&studio).await;
    assert!(dispatcher.status().expect("status").remote.is_none());
    assert!(serve.removed.load(std::sync::atomic::Ordering::SeqCst));
    dispatcher.stop().await;
    serving.abort();
}
