//! Launching a Host on a machine a provider makes (ADR 0036, WVE-238, WVE-239): a machine whose
//! Host joins with the code it was given, one whose Host never does, a name that is taken, and
//! the Dispatcher's `machines/*` API reading Fly and Tailscale tokens from its encrypted
//! credential store and syncing agent sign-ins to the newly joined cloud Host.

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
        image: None,
    }
}

impl Machines for FakeMachines {
    async fn create(&self, spec: &MachineSpec) -> Result<Machine, MachineError> {
        self.made.send(spec.clone()).expect("the test is listening");
        Ok(Machine {
            image: Some(spec.image.clone()),
            ..machine(&spec.name, MachineState::Starting)
        })
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

    async fn update_image(&self, id: &str, image: &str) -> Result<Machine, MachineError> {
        Ok(Machine {
            image: Some(image.to_owned()),
            ..machine(id.trim_start_matches("m-"), MachineState::Running)
        })
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

mod dispatcher_api {
    use std::collections::BTreeMap;
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::time::Duration;

    use futures::future::BoxFuture;
    use pretty_assertions::assert_eq;
    use tokio::sync::mpsc;
    use weave_dispatcher::Dispatcher;
    use weave_dispatcher::machines::DynMachines;
    use weave_dispatcher::machines::ENV_TAILSCALE_KEY;
    use weave_dispatcher::machines::Machine;
    use weave_dispatcher::machines::MachineBackend;
    use weave_dispatcher::machines::MachineError;
    use weave_dispatcher::machines::MachineSpec;
    use weave_dispatcher::machines::MachineState;
    use weave_dispatcher::machines::Machines;
    use weave_dispatcher::machines::fly::FlyConfig;
    use weave_dispatcher::machines::tailscale::TailscaleClient;
    use weave_dispatcher::socket;
    use weave_host_protocol::dispatcher::CredentialKind;
    use weave_host_protocol::dispatcher::DestroyMachineRequest;
    use weave_host_protocol::dispatcher::GetMachineSettingsRequest;
    use weave_host_protocol::dispatcher::LaunchMachineRequest;
    use weave_host_protocol::dispatcher::ListMachinesRequest;
    use weave_host_protocol::dispatcher::MACHINES_FEATURE;
    use weave_host_protocol::dispatcher::UpdateMachineRequest;
    use weave_host_protocol::dispatcher::UpdateMachineSettingsRequest;
    use weave_host_protocol::errors;
    use weave_remote::access::RemoteSettings;
    use weave_remote::access::Serve;

    use super::FakeServe;
    use super::boot;
    use super::machine;
    use crate::common::World;
    use crate::common::ask;
    use crate::common::dispatcher_config;

    const PASSPHRASE: &str = "correct horse battery staple";
    const FLY_TOKEN: &str = "FlyV1_secret_token_never_echoed";
    const TS_SECRET: &str = "tskey-client-k123456CNTRL-secret_never_echoed";
    const CLAUDE: &str = r#"{"claudeAiOauth":{"accessToken":"claude-cloud-access","refreshToken":"claude-renewal","expiresAt":4102444800000}}"#;

    #[derive(Clone)]
    struct RecordedMachines {
        made: mpsc::UnboundedSender<MachineSpec>,
        updated: mpsc::UnboundedSender<(String, String)>,
        live: Arc<Mutex<Vec<Machine>>>,
        destroyed: Arc<Mutex<Vec<String>>>,
    }

    impl Machines for RecordedMachines {
        async fn create(&self, spec: &MachineSpec) -> Result<Machine, MachineError> {
            let created = Machine {
                image: Some(spec.image.clone()),
                ..machine(&spec.name, MachineState::Running)
            };
            self.live.lock().expect("live").push(created.clone());
            self.made.send(spec.clone()).expect("receiver");
            Ok(created)
        }

        async fn list(&self) -> Result<Vec<Machine>, MachineError> {
            Ok(self.live.lock().expect("live").clone())
        }

        async fn get(&self, id: &str) -> Result<Machine, MachineError> {
            if let Some(found) = self
                .live
                .lock()
                .expect("live")
                .iter()
                .find(|machine| machine.id == id)
                .cloned()
            {
                return Ok(found);
            }
            Ok(machine(id.trim_start_matches("m-"), MachineState::Running))
        }

        async fn start(&self, _id: &str) -> Result<(), MachineError> {
            Ok(())
        }

        async fn stop(&self, _id: &str) -> Result<(), MachineError> {
            Ok(())
        }

        async fn destroy(&self, id: &str) -> Result<(), MachineError> {
            self.live.lock().expect("live").retain(|m| m.id != id);
            self.destroyed
                .lock()
                .expect("destroyed")
                .push(id.to_owned());
            Ok(())
        }

        async fn update_image(&self, id: &str, image: &str) -> Result<Machine, MachineError> {
            let mut live = self.live.lock().expect("live");
            let entry = live
                .iter_mut()
                .find(|machine| machine.id == id)
                .ok_or_else(|| MachineError(format!("unknown machine {id}")))?;
            entry.image = Some(image.to_owned());
            let updated = entry.clone();
            drop(live);
            self.updated
                .send((id.to_owned(), image.to_owned()))
                .expect("receiver");
            Ok(updated)
        }
    }

    struct FakeBackend {
        fly_tokens: Mutex<Vec<(String, String, String, String)>>,
        tailscale_calls: Mutex<Vec<(String, String, String, String)>>,
        machines: RecordedMachines,
    }

    impl FakeBackend {
        fn new() -> (
            Arc<Self>,
            mpsc::UnboundedReceiver<MachineSpec>,
            mpsc::UnboundedReceiver<(String, String)>,
        ) {
            let (made, specs) = mpsc::unbounded_channel();
            let (updated, updates) = mpsc::unbounded_channel();
            let backend = Arc::new(Self {
                fly_tokens: Mutex::new(Vec::new()),
                tailscale_calls: Mutex::new(Vec::new()),
                machines: RecordedMachines {
                    made,
                    updated,
                    live: Arc::new(Mutex::new(Vec::new())),
                    destroyed: Arc::new(Mutex::new(Vec::new())),
                },
            });
            (backend, specs, updates)
        }
    }

    impl MachineBackend for FakeBackend {
        fn machines(&self, config: &FlyConfig) -> Result<Box<dyn DynMachines>, MachineError> {
            self.fly_tokens.lock().expect("tokens").push((
                config.token.clone(),
                config.app.clone(),
                config.org.clone(),
                config.region.clone(),
            ));
            Ok(Box::new(self.machines.clone()))
        }

        fn mint_tailscale_key<'a>(
            &'a self,
            client: &'a TailscaleClient,
            description: &'a str,
        ) -> BoxFuture<'a, Result<String, MachineError>> {
            self.tailscale_calls.lock().expect("ts").push((
                client.client_id.clone(),
                client.client_secret.clone(),
                client.tag.clone(),
                description.to_owned(),
            ));
            Box::pin(async move { Ok("tskey-minted-ephemeral".to_owned()) })
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn dispatcher_launches_lists_and_destroys_using_stored_credentials() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (backend, mut specs, mut updates) = FakeBackend::new();
        let mut remote = RemoteSettings::new(
            "127.0.0.1:0".parse().expect("addr"),
            Arc::new(FakeServe) as Arc<dyn Serve>,
        );
        remote.offer_lifetime = Duration::from_secs(10);
        let mut config = dispatcher_config(dir.path());
        config.remote = Some(remote);
        config.machines = Arc::clone(&backend) as Arc<dyn MachineBackend>;
        config.machine_poll = Duration::from_millis(20);
        let listening = socket::listen(&config.paths).expect("socket");
        let dispatcher = Dispatcher::open(config).expect("opened");
        let serving = {
            let dispatcher = dispatcher.clone();
            tokio::spawn(async move { dispatcher.serve(listening.listener).await })
        };

        let client = ask(dir.path()).await;
        assert!(client.hello().offers(MACHINES_FEATURE));

        // Configuring non-secret settings works while credentials are locked.
        let configured = client
            .send(UpdateMachineSettingsRequest {
                fly_app: Some(Some("weave-hosts".to_owned())),
                fly_region: Some(Some("jnb".to_owned())),
                image: Some(Some("registry.fly.io/weave-hosts:test".to_owned())),
                tailscale_client_id: Some(Some("k123456CNTRL".to_owned())),
                ..UpdateMachineSettingsRequest::default()
            })
            .await
            .expect("configured")
            .settings;
        assert_eq!(configured.fly_app.as_deref(), Some("weave-hosts"));
        let read_back = client
            .send(GetMachineSettingsRequest {})
            .await
            .expect("read")
            .settings;
        assert_eq!(read_back, configured);

        // Launching, listing, and destroying fail with credentialsLocked while locked.
        for locked_err in [
            client
                .send(ListMachinesRequest {})
                .await
                .expect_err("list locked"),
            client
                .send(LaunchMachineRequest {
                    name: "cloud-1".to_owned(),
                    image: None,
                    cpus: None,
                    memory_mb: None,
                    state_gb: None,
                    wait_secs: Some(5),
                })
                .await
                .expect_err("launch locked"),
            client
                .send(UpdateMachineRequest {
                    machine: "cloud-1".to_owned(),
                    image: None,
                    wait_secs: Some(5),
                })
                .await
                .expect_err("update locked"),
            client
                .send(DestroyMachineRequest {
                    machine: "cloud-1".to_owned(),
                })
                .await
                .expect_err("destroy locked"),
        ] {
            assert!(
                errors::is(&locked_err, errors::CREDENTIALS_LOCKED),
                "{locked_err}"
            );
        }

        // Unlock and store fly, tailscale, and claude credentials.
        dispatcher
            .unlock_credentials(PASSPHRASE.to_owned(), true)
            .await
            .expect("unlocked");
        // Missing fly credential gives a clear message.
        let missing = client
            .send(ListMachinesRequest {})
            .await
            .expect_err("missing fly");
        assert!(
            missing.message.contains("no credential called fly"),
            "{missing}"
        );
        dispatcher
            .set_credential("fly", CredentialKind::Token, None, FLY_TOKEN)
            .expect("fly token");
        dispatcher
            .set_credential("tailscale", CredentialKind::Token, None, TS_SECRET)
            .expect("ts secret");
        dispatcher
            .set_credential("claude", CredentialKind::SignIn, Some("claude"), CLAUDE)
            .expect("claude");

        // Launch a cloud machine; simulate the cloud Host booting and joining over WebSocket.
        let mut cloud = World::new().await;
        let (launched, spec) = tokio::join!(
            client.send(LaunchMachineRequest {
                name: "cloud-1".to_owned(),
                image: None,
                cpus: Some(2),
                memory_mb: Some(2048),
                state_gb: Some(2),
                wait_secs: Some(10),
            }),
            async {
                let spec = specs.recv().await.expect("machine spec");
                boot(&cloud, &spec).await;
                spec
            }
        );
        let launched = launched.expect("launched");
        assert_eq!(launched.machine.id, "m-cloud-1");
        assert_eq!(launched.host.name, "cloud-1");
        assert!(launched.host.connected);
        assert_eq!(spec.image, "registry.fly.io/weave-hosts:test");
        assert_eq!(spec.cpus, 2);
        assert_eq!(spec.memory_mb, 2048);
        assert_eq!(spec.state_gb, 2);
        assert_eq!(spec.env[ENV_TAILSCALE_KEY], "tskey-minted-ephemeral");

        // Backend received the exact decrypted tokens from the Dispatcher's store.
        assert_eq!(
            backend.fly_tokens.lock().expect("fly").last().cloned(),
            Some((
                FLY_TOKEN.to_owned(),
                "weave-hosts".to_owned(),
                "personal".to_owned(),
                "jnb".to_owned(),
            ))
        );
        assert_eq!(
            backend.tailscale_calls.lock().expect("ts").clone(),
            vec![(
                "k123456CNTRL".to_owned(),
                TS_SECRET.to_owned(),
                "tag:weave-host".to_owned(),
                "weave host cloud-1".to_owned(),
            )]
        );

        // The newly joined cloud Host automatically received the Dispatcher's Claude sign-in.
        tokio::time::timeout(crate::common::WAIT, async {
            loop {
                if cloud.daemon.credential_environment("claude")
                    == BTreeMap::from([(
                        "CLAUDE_CODE_OAUTH_TOKEN".to_owned(),
                        "claude-cloud-access".to_owned(),
                    )])
                {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("cloud Host received synced Claude credential");

        // List, update in place (keeping the same Host identity), and destroy via the API;
        // verify no secrets appear in any serialized response.
        let listed = client.send(ListMachinesRequest {}).await.expect("listed");
        assert_eq!(listed.machines.len(), 1);
        assert_eq!(listed.machines[0].name, "cloud-1");
        assert_eq!(
            listed.machines[0].image.as_deref(),
            Some("registry.fly.io/weave-hosts:test")
        );

        let (updated, (updated_id, updated_image)) = tokio::join!(
            client.send(UpdateMachineRequest {
                machine: "cloud-1".to_owned(),
                image: Some("registry.fly.io/weave-hosts:v2".to_owned()),
                wait_secs: Some(10),
            }),
            async {
                let change = updates.recv().await.expect("machine update");
                cloud.restart().await;
                change
            }
        );
        let updated = updated.expect("updated");
        assert_eq!(updated_id, "m-cloud-1");
        assert_eq!(updated_image, "registry.fly.io/weave-hosts:v2");
        assert_eq!(updated.machine.id, "m-cloud-1");
        assert_eq!(
            updated.machine.image.as_deref(),
            Some("registry.fly.io/weave-hosts:v2")
        );
        assert_eq!(updated.host.host_id, launched.host.host_id);
        assert!(updated.host.connected);

        let destroyed = client
            .send(DestroyMachineRequest {
                machine: "cloud-1".to_owned(),
            })
            .await
            .expect("destroyed");
        assert_eq!(destroyed.machine.id, "m-cloud-1");
        assert!(destroyed.host_removed);
        assert_eq!(dispatcher.hosts().expect("hosts"), Vec::new());

        for payload in [
            serde_json::to_string(&configured).expect("json"),
            serde_json::to_string(&launched).expect("json"),
            serde_json::to_string(&listed).expect("json"),
            serde_json::to_string(&updated).expect("json"),
            serde_json::to_string(&destroyed).expect("json"),
        ] {
            assert!(!payload.contains(FLY_TOKEN), "{payload}");
            assert!(!payload.contains(TS_SECRET), "{payload}");
            assert!(!payload.contains("claude-cloud-access"), "{payload}");
        }

        client.shutdown().await;
        dispatcher.stop().await;
        serving.abort();
    }
}
