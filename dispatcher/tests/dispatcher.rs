//! The Dispatcher against in-process Hosts on loopback WebSockets: pairing as a service through
//! its socket, reconnecting after a Host restarts, and starting work once across its own
//! restarts.

#![allow(clippy::expect_used)]

mod common;

use std::time::Duration;

use pretty_assertions::assert_eq;
use weave_host_protocol::devices::ListDevicesRequest;
use weave_host_protocol::devices::RevokeDeviceRequest;
use weave_host_protocol::dispatcher::AddHostRequest;
use weave_host_protocol::dispatcher::DispatcherStatusRequest;
use weave_host_protocol::dispatcher::ListHostsRequest;
use weave_host_protocol::peers::PeerStatus;

use crate::common::WAIT;
use crate::common::World;
use crate::common::ask;
use crate::common::delivered;
use crate::common::dispatcher_config;
use crate::common::host_until;
use crate::common::run;
use crate::common::sessions;
use crate::common::start;

#[tokio::test(flavor = "multi_thread")]
async fn the_dispatcher_starts_work_on_each_host_once_across_restarts() {
    let mut studio = World::new().await;
    let mut mini = World::new().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let (dispatcher, serving) = start(dir.path());

    // Paired through its socket, as a service of each Host.
    let cli = ask(dir.path()).await;
    let mut added = Vec::new();
    for (world, name) in [(&studio, "studio"), (&mini, "mini")] {
        let host = cli
            .send(AddHostRequest {
                url: world.url(),
                code: world.offer().await,
                name: Some(name.to_owned()),
            })
            .await
            .expect("hosts/add")
            .host;
        assert_eq!(host.name, name);
        added.push(host.host_id);
    }
    let (studio_id, mini_id) = (added[0].clone(), added[1].clone());
    let local = studio.local().await;
    let devices = local
        .send(ListDevicesRequest {})
        .await
        .expect("devices/list")
        .devices;
    assert_eq!(
        devices
            .iter()
            .map(|device| (device.name.as_str(), device.service))
            .collect::<Vec<_>>(),
        vec![("Dispatcher", true)]
    );
    local.shutdown().await;
    for host_id in [&studio_id, &mini_id] {
        host_until(&dispatcher, host_id, |host| host.connected).await;
    }
    let listed = cli.send(ListHostsRequest {}).await.expect("hosts/list");
    assert_eq!(listed.hosts.len(), 2);

    // A headless turn on each.
    let first = dispatcher
        .deliver(&studio_id, run(&studio, "hello"))
        .expect("written down");
    let on_mini = dispatcher
        .deliver(&mini_id, run(&mini, "hello"))
        .expect("written down");
    let started = delivered(&dispatcher, &first.id).await;
    delivered(&dispatcher, &on_mini.id).await;
    tokio::time::timeout(WAIT, async {
        while !dispatcher
            .threads(&studio_id)
            .iter()
            .any(|thread| thread.info.session_id == started.session_id)
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the thread it started, watched");

    // One Host restarts: the Dispatcher connects again, and work waiting for it gets there.
    let before = host_until(&dispatcher, &mini_id, |host| host.connected)
        .await
        .connected_at;
    mini.restart().await;
    host_until(&dispatcher, &mini_id, |host| {
        host.connected && host.connected_at > before
    })
    .await;
    let after = dispatcher
        .deliver(&mini_id, run(&mini, "after the restart"))
        .expect("written down");
    delivered(&dispatcher, &after.id).await;

    // The Dispatcher stops after the Host took the work but before it wrote that down, as a
    // crash would: started again, it sends it again, and the Host starts nothing twice.
    cli.shutdown().await;
    dispatcher.stop().await;
    serving.abort();
    let _ = serving.await;
    let database = dispatcher_config(dir.path()).paths.database();
    rusqlite::Connection::open(&database)
        .expect("the database")
        .execute(
            "UPDATE deliveries SET state = 'pending', answer = NULL WHERE id = ?1",
            [&first.id],
        )
        .expect("as though never answered");
    let (dispatcher, serving) = start(dir.path());
    let again = delivered(&dispatcher, &first.id).await;
    assert_eq!(again.session_id, started.session_id);
    assert_eq!(again.turn_id, started.turn_id);
    assert_eq!(sessions(&studio).await, 1);
    let status = ask(dir.path())
        .await
        .send(DispatcherStatusRequest {})
        .await
        .expect("dispatcher/status");
    assert_eq!(status.pending, 0);

    dispatcher.stop().await;
    serving.abort();
    studio.restart().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_host_that_revokes_the_dispatcher_is_left_until_paired_again() {
    let studio = World::new().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let (dispatcher, serving) = start(dir.path());
    let host = dispatcher
        .add_host(AddHostRequest {
            url: studio.url(),
            code: studio.offer().await,
            name: None,
        })
        .await
        .expect("paired");
    host_until(&dispatcher, &host.host_id, |host| host.connected).await;

    let local = studio.local().await;
    local
        .send(RevokeDeviceRequest {
            device_id: host.device_id.clone(),
        })
        .await
        .expect("devices/revoke");
    local.shutdown().await;
    let refused = host_until(&dispatcher, &host.host_id, |host| {
        host.status == PeerStatus::Refused
    })
    .await;
    assert!(!refused.connected);
    assert_eq!(refused.why.as_deref(), Some("it revoked the Dispatcher"));

    // A refusal stands across a restart, and work waits for the Host meanwhile.
    dispatcher.stop().await;
    serving.abort();
    let _ = serving.await;
    let (dispatcher, serving) = start(dir.path());
    let waiting = dispatcher
        .deliver(&host.host_id, run(&studio, "hello"))
        .expect("written down");
    let still = host_until(&dispatcher, &host.host_id, |host| {
        host.status == PeerStatus::Refused
    })
    .await;
    assert_eq!(still.pending, 1);

    // Pairing again is the way back, and the waiting work gets there.
    dispatcher
        .add_host(AddHostRequest {
            url: studio.url(),
            code: studio.offer().await,
            name: None,
        })
        .await
        .expect("paired again");
    delivered(&dispatcher, &waiting.id).await;
    dispatcher.stop().await;
    serving.abort();
}
