//! `weave dispatcher connect` (WVE-176) against a Dispatcher in the test, on a loopback
//! WebSocket with a fake Tailscale Serve, as a Dispatcher on another computer: then `weave hosts`
//! and `weave schedules` reach it through the pairing, and `disconnect` forgets it. With a Host
//! on this computer, also in the test, `connect` offers to have it join the Dispatcher too, and
//! `weave hosts add` has it join, here, over SSH, or with a code (ADR 0030). With a Host on
//! another computer that joined it, `weave run`, `weave threads` and the TUI reach that Host
//! through the Dispatcher with `--host` (WVE-195). `weave projects` registers directories on
//! both (WVE-189), and `weave bots` keeps Bots on both, whose Hosts make their homes (WVE-118,
//! WVE-178).

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
use weave_host_protocol::devices::Device;
use weave_host_protocol::devices::ListDevicesRequest;
use weave_host_protocol::devices::OfferDeviceRequest;
use weave_host_protocol::devices::RevokeDeviceRequest;
use weave_host_protocol::dispatcher::DispatcherAddress;
use weave_host_protocol::dispatcher::JoinDispatcherRequest;
use weave_host_protocol::dispatcher::JoinedDispatcher;
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
        let remote = RemoteSettings::new(
            "127.0.0.1:0".parse().expect("an address"),
            Arc::new(FakeServe),
        );
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
        let mut config = DaemonConfig::in_process(Some(dir.join("config.toml")));
        config.devices = Some(paths.devices());
        config.traces = dir.join("traces");
        config.launcher = fake_agent(dir.join("agent-state.json"));
        config.home = Some(dir.join("home"));
        isolate_git(&mut config);
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

    /// Run a Host on this computer, where `weave` finds it, which can join the Dispatcher, and
    /// whose agent `fake` is the fake agent and whose home is `here/home`, as [`Self::home`]
    /// gives it to `weave`.
    fn start_host(&mut self) {
        let dir = self.dir.path().join("here");
        std::fs::create_dir_all(dir.join("home")).expect("its home");
        std::fs::write(
            dir.join("config.toml"),
            "[agents.fake]\ncommand = \"fake-agent\"\n",
        )
        .expect("its config");
        let paths = weave_host::DaemonPaths::in_dir(dir.join("host"));
        let mut config = DaemonConfig::in_process(Some(dir.join("config.toml")));
        config.devices = Some(paths.devices());
        config.traces = dir.join("traces");
        config.launcher = fake_agent(dir.join("agent-state.json"));
        config.home = Some(self.home());
        isolate_git(&mut config);
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

    /// This computer's home directory, for what `weave` puts under `~`.
    fn home(&self) -> PathBuf {
        self.dir.path().join("here/home")
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

    /// Wait until the Dispatcher is connected to every Host that joined it. A Host that has
    /// just joined is connected a moment later, once it has answered the Dispatcher's hello.
    fn hosts_connected(&self) {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            let hosts = json(&self.weave(&["hosts", "list", "--json"]));
            let hosts = hosts.as_array().expect("the Hosts");
            if !hosts.is_empty() && hosts.iter().all(|host| host["connected"] == true) {
                return;
            }
            assert!(std::time::Instant::now() < deadline, "{hosts:?}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// `weave args…` on the Dispatcher's own computer.
    fn weave_there(&self, args: &[&str]) -> Output {
        self.command(args)
            .env("WEAVE_DISPATCHER_DIR", &self.paths.dir)
            .output()
            .expect("run weave")
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

/// A launcher of the fake agent, which keeps its state in `state`.
fn fake_agent(state: PathBuf) -> weave_host::Launcher {
    Arc::new(move |_, options, _| {
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
    })
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
    for asked in [
        &["devices"][..],
        &["pair"],
        &["devices", "revoke", &device_id],
    ] {
        let refused = world.weave(asked);
        assert!(!refused.status.success(), "{asked:?}");
        assert!(
            said(&refused).contains("managed there"),
            "{asked:?}: {}",
            said(&refused)
        );
    }

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
fn pair_and_devices_are_the_dispatchers_on_its_computer() {
    let world = World::new();
    let offered = json(&world.weave_there(&["pair", "--json"]));
    let url = offered["url"].as_str().expect("a URL");
    let code = offered["code"].as_str().expect("a code");
    assert!(offered["expiresAt"].as_u64().is_some(), "{offered}");
    let connected = world.weave(&["dispatcher", "connect", url, code, "--name", "laptop"]);
    assert!(connected.status.success(), "{}", said(&connected));

    let devices: Vec<Device> =
        serde_json::from_value(json(&world.weave_there(&["devices", "list", "--json"])))
            .expect("the Dispatcher's Devices");
    assert_eq!(
        devices
            .iter()
            .map(|device| device.name.as_str())
            .collect::<Vec<_>>(),
        vec!["laptop"]
    );
    let listed = world.weave_there(&["devices"]);
    assert!(said(&listed).contains("laptop"), "{}", said(&listed));
    let revoked = world.weave_there(&["devices", "revoke", &devices[0].id]);
    assert!(revoked.status.success(), "{}", said(&revoked));
    assert!(said(&revoked).contains("Revoked"), "{}", said(&revoked));
    let none = world.weave_there(&["devices"]);
    assert!(
        said(&none).contains("No device is paired"),
        "{}",
        said(&none)
    );
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

/// A git repository at `dir`, with one commit and `remote` as its origin, away from the
/// configuration of whoever runs the tests.
fn repository(dir: &std::path::Path, remote: &str) {
    std::fs::create_dir_all(dir).expect("its directory");
    for args in [
        &["init", "-q", "-b", "main"][..],
        &["remote", "add", "origin", remote],
        &["commit", "-q", "--allow-empty", "-m", "start"],
    ] {
        let status = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.com")
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?}");
    }
}

/// `output`'s stdout as `T`, the protocol type `--json` claims to print.
fn parsed<T: serde::de::DeserializeOwned>(output: &Output) -> T {
    assert!(output.status.success(), "{}", said(output));
    serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|error| panic!("{error}: {}", String::from_utf8_lossy(&output.stdout)))
}

fn same_place(left: &std::path::Path, right: &std::path::Path) -> bool {
    left.canonicalize().ok() == right.canonicalize().ok()
}

/// `weave projects` (WVE-189) against a Dispatcher in the test, through this computer's
/// pairing: a repository on another computer's Host registered there with `--host`, a clone of
/// it here offered to it and joined with `--to`, a plain directory, renaming, removing a
/// location and a Project; `--project` on `weave run` and `weave threads`, and refused where the
/// Project has no location; and the last listing, while the Dispatcher is away.
#[test]
fn projects_name_directories_on_your_hosts() {
    use weave_host_protocol::Empty;
    use weave_host_protocol::dispatcher::Project;
    use weave_host_protocol::dispatcher::ProjectKind;
    use weave_host_protocol::threads::ThreadListing;

    let mut world = World::new();
    world.start_host();
    world.start_host_elsewhere("studio");
    let (url, code) = world.offer();
    let paired = world.weave(&[
        "dispatcher",
        "connect",
        &url,
        &code,
        "--name",
        "laptop",
        "--host",
    ]);
    assert!(paired.status.success(), "{}", said(&paired));
    let elsewhere = world.dir.path().join("elsewhere/home");
    repository(&elsewhere.join("odin"), "https://github.com/j/odin.git");
    std::fs::create_dir_all(elsewhere.join("notes")).expect("notes there");
    let here = world.dir.path().join("here/code/odin");
    repository(&here, "git@github.com:j/odin.git");
    std::fs::create_dir_all(here.join("src")).expect("a directory in the clone");
    let weave_in = |cwd: &std::path::Path, args: &[&str]| {
        world
            .command(args)
            .current_dir(cwd)
            .output()
            .expect("run weave")
    };

    // None yet.
    let none = world.weave(&["projects"]);
    assert!(none.status.success(), "{}", said(&none));
    assert!(
        said(&none).contains("You have no Projects"),
        "{}",
        said(&none)
    );

    // A repository on studio, registered from here, by its primary worktree there.
    let odin: Project =
        parsed(&world.weave(&["projects", "add", "--host", "studio", "~/odin", "--json"]));
    assert_eq!(
        (odin.name.as_str(), odin.kind, odin.remote.as_deref()),
        ("odin", ProjectKind::Git, Some("github.com/j/odin"))
    );
    assert_eq!(odin.locations.len(), 1);
    assert!(
        same_place(&odin.locations[0].path, &elsewhere.join("odin")),
        "{odin:?}"
    );
    let notes: Project = parsed(&world.weave(&[
        "projects", "add", "--host", "studio", "~/notes", "--name", "Notes", "--json",
    ]));
    assert_eq!(notes.kind, ProjectKind::Directory);
    assert_eq!(notes.locations[0].path, elsewhere.join("notes"));

    // Its clone here, from a directory in it: with nobody to ask, it says how; with --to, it
    // joins, by its primary worktree here.
    let unasked = weave_in(&here.join("src"), &["projects", "add"]);
    assert!(!unasked.status.success());
    assert!(
        said(&unasked)
            .contains("odin has this repository on studio: `weave projects add --to odin`"),
        "{}",
        said(&unasked)
    );
    let joined: Project = parsed(&weave_in(
        &here.join("src"),
        &["projects", "add", "--to", "ODIN", "--json"],
    ));
    assert_eq!(joined.id, odin.id);
    assert_eq!(joined.locations.len(), 2);
    assert!(same_place(&joined.locations[1].path, &here), "{joined:?}");
    let again = weave_in(&here, &["projects", "add"]);
    assert!(again.status.success(), "{}", said(&again));
    assert!(
        said(&again).contains("is odin's already"),
        "{}",
        said(&again)
    );
    // A second location on one Host, and a directory for a git Project, are refused.
    let second = weave_in(
        world.dir.path(),
        &[
            "projects", "add", "--host", "studio", "~/notes", "--to", "odin",
        ],
    );
    assert!(!second.status.success());
    assert!(
        said(&second).contains("on studio already"),
        "{}",
        said(&second)
    );

    let listed: Vec<Project> = parsed(&world.weave(&["projects", "list", "--json"]));
    assert_eq!(
        listed
            .iter()
            .map(|project| project.name.as_str())
            .collect::<Vec<_>>(),
        vec!["Notes", "odin"]
    );
    let shown = world.weave(&["projects"]);
    assert!(
        said(&shown).contains("odin  git, github.com/j/odin"),
        "{}",
        said(&shown)
    );
    assert!(said(&shown).contains("  studio  "), "{}", said(&shown));
    let one: Project = parsed(&world.weave(&["projects", "show", "odin", "--json"]));
    assert_eq!(one, joined);

    // --project: the Project's location on the Host in question, and never another's.
    let ran = weave_in(
        world.dir.path(),
        &[
            "run",
            "--host",
            "studio",
            "--project",
            "odin",
            "--agent",
            "fake",
            "--detach",
            "hi",
        ],
    );
    assert!(ran.status.success(), "{}", said(&ran));
    let in_notes = weave_in(
        world.dir.path(),
        &[
            "run",
            "--host",
            "studio",
            "--project",
            "notes",
            "--agent",
            "fake",
            "--detach",
            "hi",
        ],
    );
    assert!(in_notes.status.success(), "{}", said(&in_notes));
    let odin_thread = String::from_utf8_lossy(&ran.stdout).trim().to_owned();
    let threads: Vec<ThreadListing> = parsed(&world.weave(&[
        "threads",
        "--host",
        "studio",
        "list",
        "--project",
        "odin",
        "--json",
    ]));
    assert_eq!(
        threads
            .iter()
            .map(|thread| thread.info.session_id.to_string())
            .collect::<Vec<_>>(),
        vec![odin_thread]
    );
    assert!(same_place(&threads[0].info.cwd, &elsewhere.join("odin")));
    let nowhere = weave_in(
        world.dir.path(),
        &["run", "--project", "notes", "--agent", "fake", "hi"],
    );
    assert!(!nowhere.status.success());
    assert!(
        said(&nowhere).contains("Notes has no location on laptop: it's on studio")
            && said(&nowhere).contains("`weave projects add --to Notes <dir>`"),
        "{}",
        said(&nowhere)
    );
    let refused = world.weave(&["threads", "read", "s-1", "--project", "odin"]);
    assert!(!refused.status.success(), "--project only lists");
    // A schedule runs in the Project's location on its Host.
    let scheduled = world.weave(&[
        "schedules",
        "add",
        "daily",
        "--cron",
        "0 9 * * *",
        "--host",
        "studio",
        "--agent",
        "fake",
        "--project",
        "odin",
        "--",
        "hi",
    ]);
    assert!(scheduled.status.success(), "{}", said(&scheduled));
    let schedules: Vec<weave_host_protocol::dispatcher::Schedule> =
        parsed(&world.weave(&["schedules", "list", "--json"]));
    assert!(
        same_place(&schedules[0].run.cwd, &elsewhere.join("odin")),
        "{schedules:?}"
    );

    // Renaming, removing a location, and removing a Project.
    let renamed: Project =
        parsed(&world.weave(&["projects", "rename", "notes", "journal", "--json"]));
    assert_eq!(
        (renamed.id.as_str(), renamed.name.as_str()),
        (notes.id.as_str(), "journal")
    );
    let left: Project = parsed(&world.weave(&[
        "projects",
        "update",
        "odin",
        "--remove-host",
        "laptop",
        "--json",
    ]));
    assert_eq!(left.locations.len(), 1);
    let removed: Empty = parsed(&world.weave(&["projects", "remove", "journal", "--json"]));
    assert_eq!(removed, Empty {});

    // While the Dispatcher is away, the last listing, and how old it is; --project too.
    let dispatcher = world.dispatcher.clone();
    world
        .runtime
        .block_on(async move { dispatcher.stop().await });
    let away = world.weave(&["projects"]);
    assert!(away.status.success(), "{}", said(&away));
    assert!(
        String::from_utf8_lossy(&away.stderr)
            .contains("The Dispatcher didn't answer, so these are the Projects it listed"),
        "{}",
        said(&away)
    );
    assert!(
        String::from_utf8_lossy(&away.stdout).contains("odin  git"),
        "{}",
        said(&away)
    );
    let away: Vec<Project> = parsed(&world.weave(&["projects", "list", "--json"]));
    assert_eq!(away, vec![left]);
    let threads_here = world.weave(&["threads", "list", "--project", "odin", "--json"]);
    let listed: Vec<ThreadListing> = parsed(&threads_here);
    assert_eq!(listed, Vec::new(), "odin has no location here any more");
    assert!(
        String::from_utf8_lossy(&threads_here.stderr)
            .contains("The Dispatcher didn't answer, so this goes by the Projects it listed"),
        "{}",
        said(&threads_here)
    );
}

/// `command` as the person runs it here: with `world`'s home directory as theirs, and git
/// knowing them only from what's given here, as `identity` says, never from the computer's own
/// configuration.
/// A Host in the test runs git as the person would, away from the configuration of whoever runs
/// the tests, as `Test`.
fn isolate_git(config: &mut DaemonConfig) {
    for (name, value) in [
        ("GIT_CONFIG_GLOBAL", "/dev/null"),
        ("GIT_CONFIG_NOSYSTEM", "1"),
        ("GIT_AUTHOR_NAME", "Test"),
        ("GIT_AUTHOR_EMAIL", "test@example.com"),
        ("GIT_COMMITTER_NAME", "Test"),
        ("GIT_COMMITTER_EMAIL", "test@example.com"),
    ] {
        config
            .environment
            .vars
            .insert(name.to_owned(), value.to_owned());
    }
}

fn as_person(mut command: Command, home: &std::path::Path, identity: bool) -> Command {
    command
        .env("HOME", home)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1");
    for name in [
        "GIT_AUTHOR_NAME",
        "GIT_AUTHOR_EMAIL",
        "GIT_COMMITTER_NAME",
        "GIT_COMMITTER_EMAIL",
        "EMAIL",
        "GIT_DIR",
        "GIT_WORK_TREE",
    ] {
        command.env_remove(name);
    }
    if identity {
        command
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.com");
    }
    command
}

/// `git args…` in `dir`.
fn git_in(dir: &std::path::Path, args: &[&str]) -> Output {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("git")
}

/// What `git args…` in `dir` prints.
fn git_says(dir: &std::path::Path, args: &[&str]) -> String {
    let output = git_in(dir, args);
    assert!(output.status.success(), "git {args:?}: {}", said(&output));
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// The Bot `bot` once it's as `wanted`, as `weave bots show` gives it.
fn bot_until(
    weave: &dyn Fn(&[&str]) -> Output,
    bot: &str,
    wanted: impl Fn(&weave_host_protocol::dispatcher::Bot) -> bool,
) -> weave_host_protocol::dispatcher::Bot {
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        let shown: weave_host_protocol::dispatcher::Bot =
            parsed(&weave(&["bots", "show", bot, "--json"]));
        if wanted(&shown) {
            return shown;
        }
        assert!(std::time::Instant::now() < deadline, "{shown:?}");
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// `weave bots` (WVE-118) against a Dispatcher in the test, through this computer's pairing: a
/// Bot on this computer's Host and one on another computer's, whose Hosts make their homes
/// (WVE-178); listing, showing and changing them; the first prompt starting a
/// Bot's thread in its home, the next going into it, and a new thread taking over; schedules
/// prompting a Bot, at a cron expression's times and once; and removing them.
#[test]
fn bots_keep_a_home_and_work_in_one_thread_at_a_time() {
    use weave_acp_core::schema::ToolKind;
    use weave_host_protocol::Empty;
    use weave_host_protocol::dispatcher::Bot;
    use weave_host_protocol::dispatcher::Schedule;
    use weave_host_protocol::dispatcher::SentToBot;
    use weave_host_protocol::policy::PermissionPolicy;
    use weave_host_protocol::policy::Unapproved;
    use weave_host_protocol::threads::ThreadListing;

    let mut world = World::new();
    world.start_host();
    world.start_host_elsewhere("studio");
    let (url, code) = world.offer();
    let paired = world.weave(&[
        "dispatcher",
        "connect",
        &url,
        &code,
        "--name",
        "laptop",
        "--host",
    ]);
    assert!(paired.status.success(), "{}", said(&paired));
    let weave = |args: &[&str]| {
        as_person(world.command(args), &world.home(), true)
            .output()
            .expect("run weave")
    };

    let none = weave(&["bots"]);
    assert!(none.status.success(), "{}", said(&none));
    assert!(said(&none).contains("You have no Bots"), "{}", said(&none));

    // On this computer's Host, as it is by default, its home is made under ~/bots.
    let odin: Bot = parsed(&weave(&[
        "bots",
        "add",
        "odin",
        "--agent",
        "fake",
        "--approve",
        "read,edit",
        "--new-thread-at",
        "4:00",
        "--zone",
        "UTC",
        "--pause-after",
        "6h",
        "--job",
        "Keep an eye on the builds.",
        "--json",
    ]));
    let home = world.home().join("bots/odin");
    assert!(same_place(&odin.home, &home), "{odin:?}");
    assert_eq!(
        (
            odin.host_name.as_str(),
            odin.agent_id.as_str(),
            odin.thread.as_ref()
        ),
        ("laptop", "fake", None)
    );
    assert_eq!(
        odin.policy,
        PermissionPolicy {
            approve: vec![ToolKind::Read, ToolKind::Edit],
            otherwise: Unapproved::Ask,
        }
    );
    assert_eq!(
        (
            odin.new_thread_at.as_deref(),
            odin.zone.as_str(),
            odin.pause_after
        ),
        (Some("04:00"), "UTC", 6 * 3_600_000)
    );
    let agents = std::fs::read_to_string(home.join("AGENTS.md")).expect("its AGENTS.md");
    assert!(
        agents.contains("This directory is the home of the Bot named odin")
            && agents.contains("\n## Your job\n\nKeep an eye on the builds.\n")
            && agents.ends_with("## What I know\n"),
        "{agents}"
    );
    assert_eq!(
        std::fs::read_to_string(home.join("CLAUDE.md")).expect("its CLAUDE.md"),
        "@AGENTS.md\n"
    );
    assert_eq!(
        git_says(&home, &["log", "--format=%s"]),
        "Start odin's home\n"
    );
    assert_eq!(
        git_says(&home, &["show", "--name-only", "--format="]),
        "AGENTS.md\nCLAUDE.md\n"
    );
    let taken = weave(&["bots", "add", "ODIN", "--agent", "fake"]);
    assert!(!taken.status.success());
    assert!(
        said(&taken).contains("there's a Bot called odin already"),
        "{}",
        said(&taken)
    );

    // On another computer's Host, that Host makes its home there, and nothing is made here.
    let mimir = weave(&[
        "bots", "add", "mimir", "--agent", "fake", "--host", "studio",
    ]);
    assert!(mimir.status.success(), "{}", said(&mimir));
    let mimirs = world
        .dir
        .path()
        .join("elsewhere/home/bots/mimir")
        .canonicalize()
        .expect("mimir's home, on studio");
    for words in [
        format!("Made mimir's home, {}, a git repository.", mimirs.display()),
        "Its first memory files, AGENTS.md and CLAUDE.md, are committed there.".to_owned(),
        format!(
            "Added the Bot mimir, with fake on studio, at home in {}.",
            mimirs.display()
        ),
    ] {
        assert!(said(&mimir).contains(&words), "{words}: {}", said(&mimir));
    }
    assert_eq!(
        git_says(&mimirs, &["log", "--format=%s"]),
        "Start mimir's home\n"
    );
    assert!(!world.home().join("bots/mimir").exists());

    // Listed and shown.
    let listed: Vec<Bot> = parsed(&weave(&["bots", "list", "--json"]));
    assert_eq!(
        listed
            .iter()
            .map(|bot| bot.name.as_str())
            .collect::<Vec<_>>(),
        vec!["mimir", "odin"]
    );
    let lines = weave(&["bots"]);
    for line in [
        "mimir  idle  fake on studio  no thread yet\n",
        "odin   idle  fake on laptop  no thread yet\n",
    ] {
        assert!(said(&lines).contains(line), "{line}: {}", said(&lines));
    }
    let shown = weave(&["bots", "show", "odin"]);
    for line in [
        "odin  idle\n",
        "  approve        read,edit; it asks you about the rest\n",
        "  new thread at  04:00 every day\n",
        "  pause after    6h\n",
        "  threads        none yet",
        "  schedules      none",
    ] {
        assert!(said(&shown).contains(line), "{line}: {}", said(&shown));
    }
    let one: Bot = parsed(&weave(&["bots", "show", "ODIN", "--json"]));
    assert_eq!(one, odin);

    // Changed, and changed back.
    let changed: Bot = parsed(&weave(&[
        "bots",
        "update",
        "odin",
        "--name",
        "Odin",
        "--no-approve",
        "--mode",
        "plan",
        "--json",
    ]));
    assert_eq!(
        (
            changed.name.as_str(),
            &changed.policy,
            changed.mode.as_deref()
        ),
        ("Odin", &PermissionPolicy::ask(), Some("plan"))
    );
    let cleared = weave(&["bots", "update", "odin", "--no-mode", "--no-new-thread-at"]);
    assert!(cleared.status.success(), "{}", said(&cleared));
    assert!(
        said(&cleared).contains("Changed Odin."),
        "{}",
        said(&cleared)
    );
    let cleared: Bot = parsed(&weave(&["bots", "show", "odin", "--json"]));
    assert_eq!((cleared.mode, cleared.new_thread_at), (None, None));
    let nothing = weave(&["bots", "update", "odin"]);
    assert!(!nothing.status.success());
    assert!(
        said(&nothing).contains("nothing to change"),
        "{}",
        said(&nothing)
    );

    // The first prompt starts its thread, in its home, as its own.
    let sent = weave(&["bots", "send", "odin", "hello", "there"]);
    assert!(sent.status.success(), "{}", said(&sent));
    assert!(
        said(&sent).contains("Sent to Odin, which has no thread yet: it starts its first"),
        "{}",
        said(&sent)
    );
    let started = bot_until(&weave, "odin", |bot| bot.thread.is_some());
    let thread = started.thread.clone().expect("its thread");
    assert_eq!(started.threads.len(), 1);
    let threads: Vec<ThreadListing> = parsed(&weave(&["threads", "list", "--json"]));
    let listing = threads
        .iter()
        .find(|listing| listing.info.session_id.to_string() == thread.to_string())
        .expect("its thread, on this computer's Host");
    assert!(same_place(&listing.info.cwd, &home), "{listing:?}");
    assert!(
        listing.labels.contains(&format!("bot:{}", odin.id)),
        "{listing:?}"
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        let read = weave(&["threads", "read", &thread.to_string()]);
        if String::from_utf8_lossy(&read.stdout).contains("You said: hello there") {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "{}", said(&read));
        std::thread::sleep(Duration::from_millis(100));
    }
    let lines = weave(&["bots"]);
    assert!(
        said(&lines).contains(&format!("fake on laptop  thread {thread}\n")),
        "{}",
        said(&lines)
    );

    // The next goes into that thread; a key sends it once.
    let again = weave(&["bots", "send", "odin", "again"]);
    assert!(
        said(&again).contains(&format!("Sent to Odin, into its thread {thread}")),
        "{}",
        said(&again)
    );
    let keyed: SentToBot = parsed(&weave(&[
        "bots", "send", "odin", "--key", "k-1", "--json", "once",
    ]));
    let repeated: SentToBot = parsed(&weave(&[
        "bots", "send", "odin", "--key", "k-1", "--json", "once",
    ]));
    assert_eq!(keyed.delivery_id, repeated.delivery_id);
    assert_eq!(keyed.bot.thread.as_ref(), Some(&thread));

    // A new thread: the one it has saves what it knows first, then the new one takes over.
    let renewing = weave(&["bots", "new-thread", "odin"]);
    assert!(renewing.status.success(), "{}", said(&renewing));
    assert!(
        said(&renewing).contains("Odin is starting a new thread")
            && said(&renewing).contains("it saves what it knows to"),
        "{}",
        said(&renewing)
    );
    let renewed = bot_until(&weave, "odin", |bot| {
        bot.thread.as_ref().is_some_and(|now| *now != thread) && !bot.starting_thread
    });
    assert_eq!(
        renewed
            .threads
            .iter()
            .map(|listed| (listed.thread_id.clone(), listed.ended_at.is_some()))
            .collect::<Vec<_>>(),
        vec![
            (thread.clone(), true),
            (renewed.thread.clone().expect("its new thread"), false)
        ]
    );
    let shown = weave(&["bots", "show", "odin"]);
    assert!(
        said(&shown).contains(&format!("  threads        {thread}  "))
            && said(&shown).contains(", its thread now\n"),
        "{}",
        said(&shown)
    );

    // Schedules prompting it, at a cron expression's times and once.
    let tick = weave(&[
        "schedules",
        "add",
        "tick",
        "--bot",
        "odin",
        "--cron",
        "0 9 * * *",
        "--zone",
        "UTC",
        "--",
        "tick",
    ]);
    assert!(tick.status.success(), "{}", said(&tick));
    let later = weave(&[
        "schedules",
        "add",
        "later",
        "--bot",
        "odin",
        "--at",
        "2099-01-01 09:00",
        "--zone",
        "UTC",
        "--",
        "later",
    ]);
    assert!(later.status.success(), "{}", said(&later));
    assert!(
        said(&later).contains("Added later, once at Thu 1 Jan 2099 09:00 UTC (in "),
        "{}",
        said(&later)
    );
    let schedules: Vec<Schedule> = parsed(&weave(&["schedules", "list", "--json"]));
    let once = schedules
        .iter()
        .find(|schedule| schedule.name == "later")
        .expect("the one-off");
    assert_eq!(
        (once.at, once.bot_id.as_deref(), once.cron.as_str()),
        (Some(4_070_941_200_000), Some(odin.id.as_str()), "")
    );
    let listing = weave(&["schedules"]);
    assert!(
        said(&listing).contains("tick, 0 9 * * * in UTC, next ")
            && said(&listing).contains("\n  bot Odin\n"),
        "{}",
        said(&listing)
    );
    let shown = weave(&["bots", "show", "odin"]);
    assert!(
        said(&shown).contains("  schedules      later, once at Thu 1 Jan 2099 09:00 UTC (in ")
            && said(&shown).contains("tick, 0 9 * * * in UTC, next "),
        "{}",
        said(&shown)
    );
    let past = weave(&[
        "schedules",
        "add",
        "past",
        "--bot",
        "odin",
        "--at",
        "2020-01-01T09:00:00Z",
        "--",
        "hi",
    ]);
    assert!(!past.status.success());
    assert!(
        said(&past).contains("--at 2020-01-01T09:00:00Z has passed"),
        "{}",
        said(&past)
    );
    for refused in [
        &["--bot", "odin", "--host", "studio", "--cron", "0 9 * * *"][..],
        &["--bot", "odin", "--approve", "read", "--cron", "0 9 * * *"],
        &["--bot", "odin"],
        &[
            "--bot",
            "odin",
            "--cron",
            "0 9 * * *",
            "--at",
            "2099-01-01 09:00",
        ],
    ] {
        let mut line = vec!["schedules", "add", "x"];
        line.extend_from_slice(refused);
        line.extend_from_slice(&["--", "hi"]);
        let output = weave(&line);
        assert_eq!(
            output.status.code(),
            Some(2),
            "{refused:?}: {}",
            said(&output)
        );
    }
    let conflict = weave(&[
        "schedules",
        "add",
        "x",
        "--bot",
        "odin",
        "--host",
        "studio",
        "--cron",
        "0 9 * * *",
        "--",
        "hi",
    ]);
    assert!(
        said(&conflict).contains("'--bot <BOT>' cannot be used with '--host <HOST>'"),
        "{}",
        said(&conflict)
    );
    let timeless = weave(&["schedules", "add", "x", "--bot", "odin", "--", "hi"]);
    assert!(
        said(&timeless).contains("<--cron <CRON>|--at <TIME>>"),
        "{}",
        said(&timeless)
    );

    // Removed, a Bot's schedules go, and its threads and home stay.
    let removed = weave(&["bots", "remove", "mimir"]);
    assert!(removed.status.success(), "{}", said(&removed));
    assert!(
        said(&removed).contains(&format!(
            "Removed the Bot mimir and its schedules. Its home, {}, stays on studio as it was.",
            mimirs.display()
        )),
        "{}",
        said(&removed)
    );
    let removed: Empty = parsed(&weave(&["bots", "remove", "odin", "--json"]));
    assert_eq!(removed, Empty {});
    assert!(home.join("AGENTS.md").exists());
    let schedules: Vec<Schedule> = parsed(&weave(&["schedules", "list", "--json"]));
    assert_eq!(schedules, Vec::new());
    let threads: Vec<ThreadListing> = parsed(&weave(&["threads", "list", "--json"]));
    assert!(
        threads
            .iter()
            .any(|listing| listing.info.session_id.to_string() == thread.to_string()),
        "{threads:?}"
    );
}

/// A Bot's home keeps what was there: an `AGENTS.md` of the person's own, and a repository's
/// commits and what's staged in it, committing only the memory files its Host writes; a home
/// given relative to this directory is that directory; and one inside another repository is
/// refused, adding no Bot. (Without anybody git knows to commit as, the Host's own tests check.)
#[test]
fn a_bots_home_keeps_what_was_there() {
    let mut world = World::new();
    world.start_host();
    let (url, code) = world.offer();
    let paired = world.weave(&["dispatcher", "connect", &url, &code, "--host"]);
    assert!(paired.status.success(), "{}", said(&paired));
    world.hosts_connected();
    let weave = |identity: bool, args: &[&str]| {
        as_person(world.command(args), &world.home(), identity)
            .output()
            .expect("run weave")
    };

    // An AGENTS.md of the person's own stays as it was, beside no CLAUDE.md, in what's a
    // repository now, with nothing committed.
    let kept = world.home().join("bots/keep");
    std::fs::create_dir_all(&kept).expect("its home");
    std::fs::write(kept.join("AGENTS.md"), "mine\n").expect("an AGENTS.md");
    let added = weave(true, &["bots", "add", "keep", "--agent", "fake"]);
    assert!(added.status.success(), "{}", said(&added));
    assert!(
        said(&added).contains("a git repository. Its AGENTS.md was there already"),
        "{}",
        said(&added)
    );
    assert_eq!(
        std::fs::read_to_string(kept.join("AGENTS.md")).expect("its AGENTS.md"),
        "mine\n"
    );
    assert!(!kept.join("CLAUDE.md").exists());
    assert!(git_says(&kept, &["rev-parse", "--is-inside-work-tree"]) == "true\n");
    assert!(
        !git_in(&kept, &["rev-parse", "--verify", "HEAD"])
            .status
            .success()
    );

    // A repository of the person's own keeps its commits and what's staged; only the memory
    // files go into the commit made.
    let notes = world.dir.path().join("here/code/notes");
    repository(&notes, "https://github.com/j/notes.git");
    std::fs::write(notes.join("draft.md"), "draft\n").expect("a draft");
    assert!(git_in(&notes, &["add", "draft.md"]).status.success());
    let added = weave(
        true,
        &[
            "bots",
            "add",
            "notes",
            "--agent",
            "fake",
            "--home",
            notes.to_str().expect("a path"),
        ],
    );
    assert!(added.status.success(), "{}", said(&added));
    assert!(
        said(&added).contains("is a git repository already. Its first memory files"),
        "{}",
        said(&added)
    );
    assert_eq!(
        git_says(&notes, &["log", "--format=%s"]),
        "Start notes's home\nstart\n"
    );
    assert_eq!(
        git_says(&notes, &["show", "--name-only", "--format="]),
        "AGENTS.md\nCLAUDE.md\n"
    );
    assert_eq!(
        git_says(&notes, &["diff", "--cached", "--name-only"]),
        "draft.md\n"
    );

    // Relative to this directory, on this computer's Host.
    let relative = as_person(
        world.command(&[
            "bots", "add", "rel", "--agent", "fake", "--home", "rel-home", "--json",
        ]),
        &world.home(),
        true,
    )
    .current_dir(world.home())
    .output()
    .expect("run weave");
    let rel: weave_host_protocol::dispatcher::Bot = parsed(&relative);
    assert!(
        same_place(&rel.home, &world.home().join("rel-home")),
        "{rel:?}"
    );
    assert!(
        String::from_utf8_lossy(&relative.stderr).contains("Made rel's home, "),
        "{}",
        said(&relative)
    );

    // Inside another repository: refused, with no Bot added.
    let inside = notes.join("inner");
    let refused = weave(
        true,
        &[
            "bots",
            "add",
            "inner",
            "--agent",
            "fake",
            "--home",
            inside.to_str().expect("a path"),
        ],
    );
    assert!(!refused.status.success());
    assert!(
        said(&refused).contains("a repository of its own"),
        "{}",
        said(&refused)
    );
    assert!(!inside.exists());
    let listed = weave(true, &["bots"]);
    assert!(!said(&listed).contains("inner"), "{}", said(&listed));
}
