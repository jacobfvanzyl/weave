//! `weave dispatcher connect` (WVE-176) against a Dispatcher in the test, on a loopback
//! WebSocket with a fake Tailscale Serve, as a Dispatcher on another computer: then `weave hosts`
//! and `weave schedules` reach it through the pairing, and `disconnect` forgets it. With a Host
//! on this computer, also in the test, `connect` offers to have it join the Dispatcher too, and
//! `weave hosts add` has it join, here, over SSH, or with a code (ADR 0030). With a Host on
//! another computer that joined it, `weave run`, `weave threads` and the TUI reach that Host
//! through the Dispatcher with `--host` (WVE-195).

#![allow(clippy::expect_used)]

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::process::Output;
use std::sync::Arc;
use std::time::Duration;

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
use weave_host::DispatcherSettings;
use weave_host_client::HostConnection;
use weave_host_protocol::devices::Device;
use weave_host_protocol::devices::ListDevicesRequest;
use weave_host_protocol::devices::OfferDeviceRequest;
use weave_host_protocol::devices::RevokeDeviceRequest;
use weave_host_protocol::dispatcher::DispatcherAddress;
use weave_host_protocol::dispatcher::JoinDispatcherRequest;
use weave_host_protocol::dispatcher::JoinedDispatcher;
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
    /// A Host on another computer, with the fake agent, when the test runs one.
    elsewhere: Option<Daemon>,
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
            elsewhere: None,
            runtime,
        }
    }

    /// Run a Host as on another computer, whose agent `fake` is the fake agent and whose home
    /// is `elsewhere/home`, and have it join the Dispatcher as `name`.
    fn start_host_elsewhere(&mut self, name: &str) {
        let dir = self.dir.path().join("elsewhere");
        std::fs::create_dir_all(dir.join("home/work")).expect("its home");
        std::fs::write(
            dir.join("config.toml"),
            "[agents.fake]\ncommand = \"fake-agent\"\n",
        )
        .expect("its config");
        let paths = weave_host::DaemonPaths::in_dir(dir.join("host"));
        paths.prepare().expect("its directory");
        let state = dir.join("agent-state.json");
        let launcher: weave_host::Launcher = Arc::new(move |_, options, _| {
            let config = weave_fake_agent::FakeAgentConfig {
                state_path: Some(state.clone()),
                ..weave_fake_agent::FakeAgentConfig::default()
            };
            Box::pin(async move {
                let (client, agent) = agent_client_protocol::Channel::duplex();
                tokio::spawn(weave_fake_agent::serve_with(agent, config));
                weave_acp_core::AgentConnection::connect(client, options)
                    .await
                    .map_err(|error| {
                        agent_client_protocol::Error::internal_error().data(error.to_string())
                    })
            })
        });
        let mut config = DaemonConfig::in_process(Some(dir.join("config.toml")));
        config.devices = Some(paths.devices());
        config.traces = dir.join("traces");
        config.launcher = launcher;
        config.home = Some(dir.join("home"));
        config.dispatcher = Some(DispatcherSettings {
            secure_enclave: false,
            ..DispatcherSettings::in_dir(&paths)
        });
        let host = Daemon::new(config);
        let hosts_socket = self.paths.hosts_socket();
        self.runtime.block_on(async {
            let code = self
                .dispatcher
                .offer_host(true)
                .await
                .expect("hosts/offer")
                .code;
            host.join_dispatcher(JoinDispatcherRequest {
                address: DispatcherAddress::Socket(hosts_socket),
                code,
                name: Some(name.to_owned()),
            })
            .await
            .expect("joined");
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !self
            .dispatcher
            .hosts()
            .expect("its Hosts")
            .iter()
            .any(|host| host.name == name && host.connected)
        {
            assert!(std::time::Instant::now() < deadline, "connected in time");
            std::thread::sleep(Duration::from_millis(20));
        }
        self.elsewhere = Some(host);
    }

    /// Run a Host on this computer, where `weave` finds it, which can join the Dispatcher.
    fn start_host(&mut self) {
        let paths = weave_host::DaemonPaths::in_dir(self.dir.path().join("here/host"));
        let mut config = DaemonConfig::in_process(None);
        config.devices = Some(paths.devices());
        config.traces = self.dir.path().join("here/traces");
        config.dispatcher = Some(DispatcherSettings {
            secure_enclave: false,
            ..DispatcherSettings::in_dir(&paths)
        });
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

    /// The Dispatcher this computer's Host joined.
    fn joined(&self) -> Option<JoinedDispatcher> {
        self.host.as_ref().expect("a Host here").dispatcher()
    }

    /// Wait until this computer's Host has forgotten the Dispatcher.
    fn forgotten(&self) {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while self.joined().is_some() {
            assert!(std::time::Instant::now() < deadline, "forgotten in time");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// The names of the Hosts that joined the Dispatcher.
    fn names(&self) -> Vec<String> {
        self.dispatcher
            .hosts()
            .expect("its Hosts")
            .into_iter()
            .map(|host| host.name)
            .collect()
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
        if let Some(host) = &self.elsewhere {
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
fn connect_offers_to_have_this_computers_host_join_too() {
    let mut world = World::new();
    world.start_host();

    // With no terminal to ask in, it only says how.
    let (url, code) = world.offer();
    let asked = world.weave(&["dispatcher", "connect", &url, &code, "--name", "laptop"]);
    assert!(asked.status.success(), "{}", said(&asked));
    assert!(
        said(&asked).contains("`weave hosts add` has this computer's Host join the Dispatcher"),
        "{}",
        said(&asked)
    );
    assert!(world.names().is_empty());

    // Told to, this computer's Host joins, by the same name, over the Dispatcher's WebSocket.
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
        said(&both).contains("This computer's Host joined the Dispatcher as laptop"),
        "{}",
        said(&both)
    );
    assert_eq!(world.names(), vec!["laptop"]);
    let joined = world.joined().expect("joined");
    assert_eq!(joined.host_name, "laptop");
    assert!(
        world.host_devices().is_empty(),
        "the Dispatcher it joined isn't one of its devices"
    );

    // Joined already, it leaves it.
    let (url, code) = world.offer();
    let again = world.weave(&["dispatcher", "connect", &url, &code, "--host"]);
    assert!(again.status.success(), "{}", said(&again));
    assert!(
        said(&again).contains("already joined the Dispatcher, as laptop"),
        "{}",
        said(&again)
    );

    // Removed, it forgets the Dispatcher; `weave hosts add` alone has it join again, through
    // the pairing.
    let removed = world.weave(&["hosts", "remove", "laptop"]);
    assert!(removed.status.success(), "{}", said(&removed));
    world.forgotten();
    let added = json(&world.weave(&["hosts", "add", "--name", "studio", "--json"]));
    assert_eq!(added["hostName"], serde_json::json!("studio"));
    assert_eq!(world.names(), vec!["studio"]);
}

#[test]
fn hosts_add_joins_a_host_with_a_code_or_over_ssh() {
    let mut world = World::new();
    world.start_host();
    let (url, code) = world.offer();
    let paired = world.weave(&["dispatcher", "connect", &url, &code, "--no-host"]);
    assert!(paired.status.success(), "{}", said(&paired));

    // A code for a computer SSH doesn't reach, which `weave hosts add` there takes.
    let shown = world.weave(&["hosts", "add", "--code"]);
    assert!(shown.status.success(), "{}", said(&shown));
    assert!(
        said(&shown).contains("weave hosts add ws://127.0.0.1:"),
        "{}",
        said(&shown)
    );
    let offer = json(&world.weave(&["hosts", "add", "--code", "--json"]));
    let joined = json(&world.weave(&[
        "hosts",
        "add",
        offer["address"]["url"].as_str().expect("a URL"),
        offer["code"].as_str().expect("a code"),
        "--name",
        "mini",
        "--json",
    ]));
    assert_eq!(joined["hostName"], serde_json::json!("mini"));
    assert_eq!(world.names(), vec!["mini"]);
    let refused = world.weave(&[
        "hosts",
        "add",
        offer["address"]["url"].as_str().expect("a URL"),
        offer["code"].as_str().expect("a code"),
    ]);
    assert!(!refused.status.success(), "a code joins once");

    // Over SSH, it runs that there with a code of its own.
    let removed = world.weave(&["hosts", "remove", "mini"]);
    assert!(removed.status.success(), "{}", said(&removed));
    world.forgotten();
    let over_ssh = world
        .command(&["hosts", "add", "me@studio"])
        .env("WEAVE_SSH", fake_ssh(&world))
        .output()
        .expect("run weave");
    assert!(over_ssh.status.success(), "{}", said(&over_ssh));
    assert!(
        said(&over_ssh).contains("me@studio's Host joined the Dispatcher as studio"),
        "{}",
        said(&over_ssh)
    );
    assert_eq!(world.names(), vec!["studio"]);
}

#[test]
fn weave_reaches_a_host_elsewhere_through_the_dispatcher() {
    let mut world = World::new();
    world.start_host_elsewhere("studio");
    let (url, code) = world.offer();
    let paired = world.weave(&["dispatcher", "connect", &url, &code, "--name", "laptop"]);
    assert!(paired.status.success(), "{}", said(&paired));
    let home = world.dir.path().join("here/home");
    std::fs::create_dir_all(home.join("work")).expect("this computer's home");
    let weave = |cwd: &std::path::Path, args: &[&str]| {
        world
            .command(args)
            .current_dir(cwd)
            .env("HOME", &home)
            .output()
            .expect("run weave")
    };

    // A run there works in this directory's counterpart under the home there.
    let ran = weave(
        &home.join("work"),
        &[
            "run", "--host", "studio", "--agent", "fake", "hello", "there",
        ],
    );
    assert!(ran.status.success(), "{}", said(&ran));
    assert!(
        String::from_utf8_lossy(&ran.stdout).contains("You said: hello there"),
        "{}",
        said(&ran)
    );
    assert!(
        said(&ran).contains("weave --host studio --agent fake --resume"),
        "{}",
        said(&ran)
    );

    // A run left running there lists there, in the same directory, and reads.
    let detached = weave(
        &home.join("work"),
        &[
            "run", "--host", "studio", "--agent", "fake", "--detach", "again",
        ],
    );
    assert!(detached.status.success(), "{}", said(&detached));
    let thread_id = String::from_utf8_lossy(&detached.stdout).trim().to_owned();
    assert!(
        said(&detached).contains("weave threads --host studio follow"),
        "{}",
        said(&detached)
    );
    let listed = json(&weave(
        &home,
        &["threads", "--host", "studio", "list", "--json"],
    ));
    let threads = listed.as_array().expect("a list");
    assert_eq!(threads.len(), 1, "{listed}");
    assert_eq!(
        threads[0]["info"]["sessionId"].as_str(),
        Some(thread_id.as_str())
    );
    assert_eq!(
        threads[0]["info"]["cwd"]
            .as_str()
            .map(std::path::PathBuf::from),
        Some(world.dir.path().join("elsewhere/home/work"))
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let read = weave(&home, &["threads", "read", &thread_id, "--host", "studio"]);
        assert!(read.status.success(), "{}", said(&read));
        if String::from_utf8_lossy(&read.stdout).contains("You said: again") {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "{}", said(&read));
        std::thread::sleep(Duration::from_millis(100));
    }

    // `--cwd` names a directory there; one that isn't there, the Host says so.
    let missing = weave(
        &home,
        &[
            "run",
            "--host",
            "studio",
            "--agent",
            "fake",
            "--cwd",
            "~/nowhere",
            "hi",
        ],
    );
    assert!(!missing.status.success());
    assert!(
        said(&missing).contains("isn't a directory on this Host"),
        "{}",
        said(&missing)
    );
    // Outside the home, a directory has no counterpart there.
    let outside = weave(
        world.dir.path(),
        &["run", "--host", "studio", "--agent", "fake", "hi"],
    );
    assert!(!outside.status.success());
    assert!(
        said(&outside).contains("outside your home"),
        "{}",
        said(&outside)
    );
    // A Host that never joined.
    let unknown = weave(&home, &["threads", "--host", "nowhere"]);
    assert!(!unknown.status.success());
    assert!(
        said(&unknown).contains("no Host called nowhere"),
        "{}",
        said(&unknown)
    );
}
