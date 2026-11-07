//! `weave dispatcher connect` (WVE-176) against a Dispatcher in the test, on a loopback
//! WebSocket with a fake Tailscale Serve, as a Dispatcher on another computer: then `weave hosts`
//! and `weave schedules` reach it through the pairing, and `disconnect` forgets it. With a Host
//! on this computer, also in the test, `connect` offers to pair the Dispatcher with it too.

#![allow(clippy::expect_used)]

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::process::Output;
use std::sync::Arc;

use futures::future::BoxFuture;
use pretty_assertions::assert_eq;
use tokio::runtime::Runtime;
use weave_dispatcher::Dispatcher;
use weave_dispatcher::DispatcherConfig;
use weave_dispatcher::DispatcherPaths;
use weave_dispatcher::client::DispatcherConnection;
use weave_dispatcher::socket;
use weave_host::Daemon;
use weave_host::DaemonConfig;
use weave_host_client::HostConnection;
use weave_host_protocol::devices::Device;
use weave_host_protocol::devices::ListDevicesRequest;
use weave_host_protocol::devices::OfferDeviceRequest;
use weave_host_protocol::devices::RevokeDeviceRequest;
use weave_host_protocol::hello::ClientCapabilities;
use weave_host_protocol::hello::ClientInfo;
use weave_remote::access::RemoteSettings;
use weave_remote::access::Serve;

/// A Serve that hands out `ws://` URLs to the listener itself.
struct FakeServe;

impl Serve for FakeServe {
    fn ensure(&self, listen: SocketAddr) -> BoxFuture<'_, Result<String, String>> {
        Box::pin(async move { Ok(format!("ws://{listen}")) })
    }

    fn remove(&self, _listen: SocketAddr) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}

/// A Dispatcher in a directory of its own, as on another computer, and a computer's state for
/// `weave` apart from it.
struct World {
    dir: tempfile::TempDir,
    paths: DispatcherPaths,
    dispatcher: Dispatcher,
    /// This computer's Host, when the test runs one.
    host: Option<Daemon>,
    runtime: Runtime,
}

impl World {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = DispatcherPaths::in_dir(dir.path().join("elsewhere/dispatcher"));
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let mut remote = RemoteSettings::new(Arc::new(FakeServe));
        remote.listen = "127.0.0.1:0".parse().expect("an address");
        let config = DispatcherConfig {
            name: "Dispatcher".to_owned(),
            secure_enclave: false,
            remote: Some(remote),
            ..DispatcherConfig::new(paths.clone())
        };
        let dispatcher = runtime.block_on(async {
            let listening = socket::listen(&config.paths).expect("its socket");
            let dispatcher = Dispatcher::open(config).expect("opened");
            let serving = dispatcher.clone();
            tokio::spawn(async move { serving.serve(listening.listener).await });
            dispatcher
        });
        Self {
            dir,
            paths,
            dispatcher,
            host: None,
            runtime,
        }
    }

    /// Run a Host on this computer, where `weave` finds it, whose offers turn on a WebSocket of
    /// its own the Dispatcher pairs with.
    fn start_host(&mut self) {
        let paths = weave_host::DaemonPaths::in_dir(self.dir.path().join("here/host"));
        let mut remote = RemoteSettings::new(Arc::new(FakeServe));
        remote.listen = "127.0.0.1:0".parse().expect("an address");
        let mut config = DaemonConfig::in_process(None);
        config.devices = Some(paths.devices());
        config.traces = self.dir.path().join("here/traces");
        config.remote = Some(remote);
        let host = self.runtime.block_on(async {
            let listening = weave_host::socket::listen(&paths).expect("the Host's socket");
            let host = Daemon::new(config);
            let serving = host.clone();
            tokio::spawn(async move {
                let listener = listening.listener;
                serving.serve(listener, None).await;
            });
            host
        });
        self.host = Some(host);
    }

    /// The devices this computer's Host is paired with.
    fn host_devices(&self) -> Vec<Device> {
        let host = self.host.as_ref().expect("a Host here");
        self.runtime.block_on(async {
            let (connection, _events) = HostConnection::connect(
                host.connect_in_process(),
                ClientInfo {
                    name: "test".to_owned(),
                    version: "0".to_owned(),
                },
                ClientCapabilities::default(),
            )
            .await
            .expect("hello");
            let devices = connection
                .send(ListDevicesRequest {})
                .await
                .expect("devices/list")
                .devices;
            connection.shutdown().await;
            devices
        })
    }

    /// The Dispatcher's own CLI, on its socket.
    fn local(&self) -> DispatcherConnection {
        self.runtime.block_on(async {
            DispatcherConnection::connect(
                socket::connect(&self.paths.socket())
                    .await
                    .expect("the socket"),
                ClientInfo {
                    name: "test".to_owned(),
                    version: "0".to_owned(),
                },
            )
            .await
            .expect("hello")
        })
    }

    /// A code from the Dispatcher's computer, and the URL to pair at.
    fn offer(&self) -> (String, String) {
        let local = self.local();
        let offer = self.runtime.block_on(async {
            let offer = local
                .send(OfferDeviceRequest { name: None })
                .await
                .expect("devices/offer");
            local.shutdown().await;
            offer
        });
        (offer.url.expect("a URL"), offer.code)
    }

    /// This computer's state, where its pairing goes; no Dispatcher runs from it.
    fn state(&self) -> PathBuf {
        self.dir.path().join("here/state")
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_weave"));
        command
            .args(args)
            .env("XDG_STATE_HOME", self.state())
            .env("XDG_CONFIG_HOME", self.dir.path().join("here/config"))
            .env("WEAVE_DAEMON_DIR", self.dir.path().join("here/host"))
            .env_remove("WEAVE_DISPATCHER_DIR")
            .env_remove("WEAVE_AGENT_PROCESS")
            .env_remove("RUST_LOG");
        command
    }

    fn weave(&self, args: &[&str]) -> Output {
        self.command(args).output().expect("run weave")
    }
}

impl Drop for World {
    fn drop(&mut self) {
        let dispatcher = self.dispatcher.clone();
        self.runtime
            .block_on(async move { dispatcher.stop().await });
        if let Some(host) = &self.host {
            host.stop();
        }
    }
}

fn said(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn json(output: &Output) -> serde_json::Value {
    assert!(output.status.success(), "{}", said(output));
    serde_json::from_slice(&output.stdout).expect("JSON")
}

#[test]
fn a_computer_paired_with_the_dispatcher_asks_it_from_there() {
    let world = World::new();
    let (url, code) = world.offer();
    let connected = world.weave(&["dispatcher", "connect", &url, &code, "--name", "laptop"]);
    assert!(connected.status.success(), "{}", said(&connected));
    assert!(
        said(&connected).contains("Paired this computer"),
        "{}",
        said(&connected)
    );
    assert!(
        said(&connected).contains("No weave Host runs here"),
        "{}",
        said(&connected)
    );

    let local = world.local();
    let devices = world.runtime.block_on(async {
        local
            .send(ListDevicesRequest {})
            .await
            .expect("devices/list")
            .devices
    });
    assert_eq!(
        devices
            .iter()
            .map(|device| device.name.as_str())
            .collect::<Vec<_>>(),
        vec!["laptop"]
    );
    let device_id = devices[0].id.clone();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        for file in ["dispatcher.json", "key.json"] {
            let path = world.state().join("weave/client").join(file);
            let mode = std::fs::metadata(&path).expect(file).permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "{file}");
        }
    }

    // No Dispatcher runs here, so commands reach the paired one.
    assert_eq!(
        json(&world.weave(&["hosts", "list", "--json"])),
        serde_json::json!([])
    );
    assert_eq!(
        json(&world.weave(&["schedules", "list", "--json"])),
        serde_json::json!([])
    );
    let status = json(&world.weave(&["dispatcher", "status", "--json"]));
    assert_eq!(status["paired"]["deviceId"], serde_json::json!(device_id));
    assert_eq!(status["status"]["devices"], serde_json::json!(1));
    let shown = world.weave(&["dispatcher"]);
    assert!(
        said(&shown).contains("which this computer is paired with"),
        "{}",
        said(&shown)
    );

    // What only the Dispatcher's own computer does is refused from here.
    let start = world.weave(&["dispatcher", "start"]);
    assert!(!start.status.success());
    assert!(
        said(&start).contains("is for that computer"),
        "{}",
        said(&start)
    );
    let devices = world.weave(&["dispatcher", "devices"]);
    assert!(!devices.status.success());
    assert!(
        said(&devices).contains("managed there"),
        "{}",
        said(&devices)
    );

    // A development Dispatcher directory never reaches the paired one.
    let development = world
        .command(&["hosts"])
        .env("WEAVE_DISPATCHER_DIR", world.dir.path().join("here/dev"))
        .output()
        .expect("run weave");
    assert!(!development.status.success(), "{}", said(&development));
    assert!(
        said(&development).contains("isn't running"),
        "{}",
        said(&development)
    );

    // Revoked there, it's refused, and says where it tried.
    world.runtime.block_on(async {
        local
            .send(RevokeDeviceRequest {
                device_id: device_id.clone(),
            })
            .await
            .expect("devices/revoke");
    });
    let revoked = world.weave(&["hosts"]);
    assert!(!revoked.status.success());
    assert!(
        said(&revoked).contains("didn't answer"),
        "{}",
        said(&revoked)
    );

    // Forgotten here, commands look for a Dispatcher here only.
    let disconnected = world.weave(&["dispatcher", "disconnect"]);
    assert!(disconnected.status.success(), "{}", said(&disconnected));
    assert!(
        said(&disconnected).contains("devices revoke"),
        "{}",
        said(&disconnected)
    );
    assert!(!world.state().join("weave/client/dispatcher.json").exists());
    let alone = world.weave(&["hosts"]);
    assert!(said(&alone).contains("isn't running"), "{}", said(&alone));
    world.runtime.block_on(local.shutdown());
}

#[test]
fn a_code_pairs_one_computer_once_and_a_failed_pairing_keeps_the_last() {
    let world = World::new();
    let (url, code) = world.offer();
    let first = world.weave(&["dispatcher", "connect", &url, &code]);
    assert!(first.status.success(), "{}", said(&first));
    let again = world.weave(&["dispatcher", "connect", &url, &code]);
    assert!(!again.status.success());
    assert!(
        said(&again).contains("couldn't be authenticated"),
        "{}",
        said(&again)
    );
    // The pairing that failed leaves the one before it working.
    assert_eq!(
        json(&world.weave(&["hosts", "list", "--json"])),
        serde_json::json!([])
    );
}

/// A stand-in for `ssh` that runs the command it's given here, as on the Dispatcher's computer:
/// `weave` is this build, and its Dispatcher is the test's.
fn fake_ssh(world: &World) -> PathBuf {
    let bin = world.dir.path().join("bin");
    std::fs::create_dir_all(&bin).expect("bin");
    #[cfg(unix)]
    std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_weave"), bin.join("weave")).expect("weave");
    let script = bin.join("fake-ssh");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\n# -o BatchMode=yes <destination> <command>\nexport PATH='{}':\"$PATH\"\n\
             export WEAVE_DISPATCHER_DIR='{}'\neval \"$4\"\n",
            bin.display(),
            world.paths.dir.display()
        ),
    )
    .expect("the script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("mode");
    }
    script
}

#[test]
fn connect_pairs_over_ssh_with_the_code_pair_shows_there() {
    let world = World::new();
    let connected = world
        .command(&["dispatcher", "connect", "me@homelab"])
        .env("WEAVE_SSH", fake_ssh(&world))
        .output()
        .expect("run weave");
    assert!(connected.status.success(), "{}", said(&connected));
    assert!(
        said(&connected).contains("the Dispatcher on homelab"),
        "{}",
        said(&connected)
    );
    let status = json(&world.weave(&["dispatcher", "status", "--json"]));
    assert_eq!(status["paired"]["computer"], serde_json::json!("homelab"));
}

#[test]
fn connect_offers_to_pair_the_dispatcher_with_this_computers_host_too() {
    let mut world = World::new();
    world.start_host();
    let names = |world: &World| {
        world
            .dispatcher
            .hosts()
            .expect("its Hosts")
            .into_iter()
            .map(|host| host.name)
            .collect::<Vec<_>>()
    };

    // With no terminal to ask in, it only says how.
    let (url, code) = world.offer();
    let asked = world.weave(&["dispatcher", "connect", &url, &code, "--name", "laptop"]);
    assert!(asked.status.success(), "{}", said(&asked));
    assert!(
        said(&asked).contains("`weave hosts add` pairs the Dispatcher with this computer's Host"),
        "{}",
        said(&asked)
    );
    assert!(names(&world).is_empty());

    // Told to, it pairs the Dispatcher with this computer's Host, by the same name, which lists
    // the Dispatcher as a service.
    let (url, code) = world.offer();
    let both = world.weave(&[
        "dispatcher",
        "connect",
        &url,
        &code,
        "--name",
        "laptop",
        "--host",
    ]);
    assert!(both.status.success(), "{}", said(&both));
    assert!(
        said(&both).contains("Paired the Dispatcher with this computer's Host as laptop"),
        "{}",
        said(&both)
    );
    assert_eq!(names(&world), vec!["laptop"]);
    let device_id = world.dispatcher.hosts().expect("its Hosts")[0]
        .device_id
        .clone();
    let services = world
        .host_devices()
        .into_iter()
        .filter(|device| device.service)
        .map(|device| device.id)
        .collect::<Vec<_>>();
    assert_eq!(services, vec![device_id]);

    // Paired already, it leaves it.
    let (url, code) = world.offer();
    let again = world.weave(&["dispatcher", "connect", &url, &code, "--host"]);
    assert!(again.status.success(), "{}", said(&again));
    assert!(
        said(&again).contains("already starts work on this computer's Host, as laptop"),
        "{}",
        said(&again)
    );

    // `weave hosts add` alone pairs it with this computer's Host, through the pairing.
    let removed = world.weave(&["hosts", "remove", "laptop"]);
    assert!(removed.status.success(), "{}", said(&removed));
    let added = json(&world.weave(&["hosts", "add", "--name", "studio", "--json"]));
    assert_eq!(added["name"], serde_json::json!("studio"));
    assert_eq!(names(&world), vec!["studio"]);
}
