//! Launching a Host on a machine a provider makes (WVE-238): a machine whose Host joins with
//! the code it was given, one whose Host never does, and a name that is taken.

#![cfg(feature = "machines")]
#![allow(clippy::expect_used)]

mod common;

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use futures::future::BoxFuture;
use pretty_assertions::assert_eq;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use weave_dispatcher::Dispatcher;
use weave_dispatcher::machines::ENV_DISPATCHER_URL;
use weave_dispatcher::machines::ENV_HOST_NAME;
use weave_dispatcher::machines::ENV_JOIN_CODE;
use weave_dispatcher::machines::ENV_TAILSCALE_KEY;
use weave_dispatcher::machines::Launch;
use weave_dispatcher::machines::LaunchError;
use weave_dispatcher::machines::Machine;
use weave_dispatcher::machines::MachineError;
use weave_dispatcher::machines::MachineSpec;
use weave_dispatcher::machines::MachineState;
use weave_dispatcher::machines::Machines;
use weave_dispatcher::machines::launch;
use weave_dispatcher::socket;
use weave_host_protocol::dispatcher::DispatcherAddress;
use weave_host_protocol::dispatcher::JoinDispatcherRequest;
use weave_remote::access::RemoteSettings;
use weave_remote::access::Serve;

use crate::common::World;
use crate::common::dispatcher_config;

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

/// A provider that makes nothing: it hands each machine it's asked for to the test, which
/// plays the machine's part, and remembers what it was asked to destroy.
struct FakeMachines {
    made: mpsc::UnboundedSender<MachineSpec>,
    destroyed: Mutex<Vec<String>>,
}

impl FakeMachines {
    fn new() -> (Self, mpsc::UnboundedReceiver<MachineSpec>) {
        let (made, specs) = mpsc::unbounded_channel();
        let machines = Self {
            made,
            destroyed: Mutex::new(Vec::new()),
        };
        (machines, specs)
    }

    fn destroyed(&self) -> Vec<String> {
        self.destroyed.lock().expect("the lock").clone()
    }
}

fn machine(name: &str, state: MachineState) -> Machine {
    Machine {
        id: format!("m-{name}"),
        name: name.to_owned(),
        state,
    }
}

impl Machines for FakeMachines {
    async fn create(&self, spec: &MachineSpec) -> Result<Machine, MachineError> {
        self.made.send(spec.clone()).expect("the test is listening");
        Ok(machine(&spec.name, MachineState::Starting))
    }

    async fn list(&self) -> Result<Vec<Machine>, MachineError> {
        Ok(Vec::new())
    }

    async fn get(&self, id: &str) -> Result<Machine, MachineError> {
        Ok(machine(id.trim_start_matches("m-"), MachineState::Running))
    }

    async fn start(&self, _id: &str) -> Result<(), MachineError> {
        Ok(())
    }

    async fn stop(&self, _id: &str) -> Result<(), MachineError> {
        Ok(())
    }

    async fn destroy(&self, id: &str) -> Result<(), MachineError> {
        self.destroyed.lock().expect("the lock").push(id.to_owned());
        Ok(())
    }
}

/// A Dispatcher whose WebSocket Hosts elsewhere can join over, on loopback.
fn start(dir: &std::path::Path) -> (Dispatcher, JoinHandle<()>) {
    let mut remote = RemoteSettings::new(
        "127.0.0.1:0".parse().expect("an address"),
        Arc::new(FakeServe) as Arc<dyn Serve>,
    );
    remote.offer_lifetime = Duration::from_secs(5);
    let config = weave_dispatcher::DispatcherConfig {
        remote: Some(remote),
        ..dispatcher_config(dir)
    };
    let listening = socket::listen(&config.paths).expect("its socket");
    let dispatcher = Dispatcher::open(config).expect("opened");
    let serving = {
        let dispatcher = dispatcher.clone();
        tokio::spawn(async move { dispatcher.serve(listening.listener).await })
    };
    (dispatcher, serving)
}

fn quick(name: &str, wait: Duration) -> Launch {
    Launch {
        tailscale_key: Some("tskey-once".to_owned()),
        wait,
        poll: Duration::from_millis(20),
        ..Launch::new(name, "registry.example/weave-host:test")
    }
}

/// What a machine's entrypoint does with its environment: join the Dispatcher there.
async fn boot(world: &World, spec: &MachineSpec) {
    world
        .daemon
        .join_dispatcher(JoinDispatcherRequest {
            address: DispatcherAddress::Url(spec.env[ENV_DISPATCHER_URL].clone()),
            code: spec.env[ENV_JOIN_CODE].clone(),
            name: Some(spec.env[ENV_HOST_NAME].clone()),
        })
        .await
        .expect("joined over the WebSocket");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_launched_machines_host_joins_with_the_code_it_was_given() {
    let cloud = World::new().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let (dispatcher, serving) = start(dir.path());
    let (machines, mut specs) = FakeMachines::new();

    let (launched, spec) = tokio::join!(
        launch(
            &dispatcher,
            &machines,
            quick("cloud", Duration::from_secs(10))
        ),
        async {
            let spec = specs.recv().await.expect("a machine was asked for");
            boot(&cloud, &spec).await;
            spec
        }
    );
    let launched = launched.expect("launched");
    assert_eq!(launched.machine.id, "m-cloud");
    assert_eq!(launched.host.name, "cloud");
    assert!(launched.host.connected);
    assert!(!launched.host.here);
    assert_eq!(launched.host.host_id, cloud.host_id().await);
    assert_eq!(spec.image, "registry.example/weave-host:test");
    assert_eq!(spec.env[ENV_TAILSCALE_KEY], "tskey-once");
    assert_eq!(machines.destroyed(), Vec::<String>::new());

    dispatcher.stop().await;
    serving.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_machine_whose_host_never_joins_is_destroyed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (dispatcher, serving) = start(dir.path());
    let (machines, _specs) = FakeMachines::new();

    let failed = launch(
        &dispatcher,
        &machines,
        quick("cloud", Duration::from_millis(300)),
    )
    .await
    .expect_err("nothing joined");
    let LaunchError::NeverJoined { machine, left, .. } = failed else {
        panic!("its Host never joined: {failed}");
    };
    assert_eq!(machine.id, "m-cloud");
    assert_eq!(left, None);
    assert_eq!(machines.destroyed(), vec!["m-cloud".to_owned()]);
    assert_eq!(dispatcher.hosts().expect("hosts"), Vec::new());

    dispatcher.stop().await;
    serving.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_name_a_host_already_has_makes_no_machine() {
    let cloud = World::new().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let (dispatcher, serving) = start(dir.path());
    cloud.join(&dispatcher, dir.path(), "cloud").await;
    let (machines, mut specs) = FakeMachines::new();

    let refused = launch(
        &dispatcher,
        &machines,
        quick("Cloud", Duration::from_secs(1)),
    )
    .await
    .expect_err("the name is taken");
    assert!(
        matches!(&refused, LaunchError::Refused(why) if why.contains("already")),
        "{refused}"
    );
    assert!(specs.try_recv().is_err(), "no machine was asked for");

    dispatcher.stop().await;
    serving.abort();
}
