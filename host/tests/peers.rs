//! Peer Hosts end to end (ADR 0017, ADR 0024, WVE-109): two or three Hosts in this process, each
//! with its own directory and home, reaching each other over loopback WebSockets, their agents
//! the fake agent calling Host tools with its `tool` script. The spec is the Host protocol's Peer
//! Hosts section.

#![allow(clippy::expect_used)]

use std::net::SocketAddr;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::Channel;
use agent_client_protocol::Error;
use futures::future::BoxFuture;
use pretty_assertions::assert_eq;
use tokio::io::AsyncReadExt as _;
use tokio::io::AsyncWriteExt as _;
use tokio::sync::mpsc::UnboundedReceiver;
use weave_acp_core::AgentConnection;
use weave_acp_core::ClientOptions;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::PermissionOptionId;
use weave_acp_core::schema::RequestPermissionOutcome;
use weave_acp_core::schema::RequestPermissionResponse;
use weave_acp_core::schema::SelectedPermissionOutcome;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::SessionUpdate;
use weave_acp_core::schema::StopReason;
use weave_acp_core::schema::ToolKind;
use weave_agents::environment::Environment;
use weave_fake_agent::FakeAgentConfig;
use weave_host::Daemon;
use weave_host::DaemonConfig;
use weave_host::Launch;
use weave_host::Launcher;
use weave_host::PeerSettings;
use weave_host::RemoteSettings;
use weave_host::Serve;
use weave_host::Withheld;
use weave_host_client::Credentials;
use weave_host_client::HostConnection;
use weave_host_client::HostEvent;
use weave_host_client::remote::DeviceKey;
use weave_host_client::remote::connect_websocket;
use weave_host_protocol::agents::ListAgentsRequest;
use weave_host_protocol::devices::ListDevicesRequest;
use weave_host_protocol::devices::OfferDeviceRequest;
use weave_host_protocol::devices::RevokeDeviceRequest;
use weave_host_protocol::errors;
use weave_host_protocol::events::SessionEvent;
use weave_host_protocol::files::ListFilesRequest;
use weave_host_protocol::hello::ClientCapabilities;
use weave_host_protocol::hello::ClientInfo;
use weave_host_protocol::host::Service;
use weave_host_protocol::peers::AddPeerRequest;
use weave_host_protocol::peers::ListPeersRequest;
use weave_host_protocol::peers::Peer;
use weave_host_protocol::peers::PeerStatus;
use weave_host_protocol::pending::AnswerPendingRequest;
use weave_host_protocol::policy::PermissionPolicy;
use weave_host_protocol::policy::Unapproved;
use weave_host_protocol::queue::AddQueuedRequest;
use weave_host_protocol::sessions::AttachSessionRequest;
use weave_host_protocol::sessions::CreateSessionRequest;
use weave_host_protocol::sessions::GetSessionRequest;
use weave_host_protocol::sessions::GetSessionResponse;
use weave_host_protocol::sessions::ListSessionsRequest;
use weave_host_protocol::sessions::RenameSessionRequest;
use weave_host_protocol::sessions::RunRequest;
use weave_host_protocol::sessions::TurnOrigin;
use weave_host_protocol::terminals::ListTerminalsRequest;
use weave_host_protocol::turns::StartTurnRequest;
use weave_host_protocol::worktrees::ListWorktreesRequest;

const WAIT: Duration = Duration::from_secs(10);

/// Git for a test's repositories, away from the configuration of whoever runs the tests.
const ISOLATED_GIT: &[(&str, &str)] = &[
    ("GIT_CONFIG_GLOBAL", "/dev/null"),
    ("GIT_CONFIG_NOSYSTEM", "1"),
    ("GIT_AUTHOR_NAME", "Test"),
    ("GIT_AUTHOR_EMAIL", "test@example.com"),
    ("GIT_COMMITTER_NAME", "Test"),
    ("GIT_COMMITTER_EMAIL", "test@example.com"),
];

/// One computer: a directory for a Host's files, with a home of its own beneath it.
struct World {
    dir: tempfile::TempDir,
}

impl World {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        // Deep enough for a thread a peer started to start one of its own, which one hop
        // has to keep from the peers too.
        std::fs::write(
            dir.path().join("config.toml"),
            "[agents.fake]\ncommand = \"fake-agent\"\n\n[delegation]\ndepth = 3\n",
        )
        .expect("config");
        std::fs::create_dir_all(dir.path().join("home")).expect("home");
        Self { dir }
    }

    fn home(&self) -> PathBuf {
        self.dir.path().join("home")
    }

    /// A Host that pairs with peers, keeping them and its key in memory, as `name`, with
    /// remote access when `serve` is given, so others pair with it.
    fn daemon(&self, name: &str, serve: Option<Arc<FakeServe>>) -> Daemon {
        Daemon::new(self.config(name, serve))
    }

    /// [`Self::daemon`] keeping its journals, peers and key in its directory, as the per-user
    /// Host does, so that another Host there takes up where it left off.
    fn daemon_keeping(&self, name: &str) -> Daemon {
        let mut config = self.config(name, None);
        config.journals = Some(self.dir.path().join("sessions"));
        config.peers = config.peers.map(|settings| PeerSettings {
            file: Some(self.peers_file()),
            key: Some(self.dir.path().join("host-key.json")),
            ..settings
        });
        Daemon::new(config)
    }

    fn peers_file(&self) -> PathBuf {
        self.dir.path().join("peers.json")
    }

    /// `peers.json`, as a stopped Host left it.
    fn peers_json(&self) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(self.peers_file()).expect("peers.json"))
            .expect("JSON")
    }

    fn write_peers_json(&self, json: &serde_json::Value) {
        std::fs::write(
            self.peers_file(),
            serde_json::to_vec_pretty(json).expect("JSON"),
        )
        .expect("peers.json");
    }

    fn config(&self, name: &str, serve: Option<Arc<FakeServe>>) -> DaemonConfig {
        let state: PathBuf = self.dir.path().join("agent-state.json");
        let launcher: Launcher = Arc::new(move |_launch: &Launch, options: ClientOptions, _| {
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
        let remote = serve.map(|serve| {
            let mut settings = RemoteSettings::new(serve);
            settings.listen = "127.0.0.1:0".parse().expect("an address");
            settings
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
            environment: Environment {
                vars: ISOLATED_GIT
                    .iter()
                    .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
                    .collect(),
                ..Environment::default()
            },
            service: Service::InProcess,
            traces: self.dir.path().join("traces"),
            devices: Some(self.dir.path().join("devices.json")),
            upstream: Arc::new(weave_agents::update::Offline),
            mcp_socket: None,
            mcp_bridge: vec!["weave-mcp-bridge".to_owned()],
            remote,
            terminals: None,
            peers: Some(PeerSettings {
                secure_enclave: false,
                name: name.to_owned(),
                reach_timeout: Duration::from_secs(5),
                retry: Duration::from_millis(50),
                home: Some(self.home()),
                ..PeerSettings::new(None, None)
            }),
        }
    }
}

/// A Tailscale Serve that hands out `ws://` URLs.
#[derive(Default)]
struct FakeServe;

impl Serve for FakeServe {
    fn ensure(&self, listen: SocketAddr) -> BoxFuture<'_, Result<String, String>> {
        Box::pin(async move { Ok(format!("ws://{listen}")) })
    }

    fn remove(&self, _listen: SocketAddr) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move { Ok(()) })
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

/// A Host with remote access that another pairs with, and the offer it made for that.
async fn offering(world: &World, name: &str) -> (Daemon, HostConnection, String, String) {
    let daemon = world.daemon(name, Some(Arc::new(FakeServe)));
    let (local, _events) = local(&daemon).await;
    let (url, code) = offer(&local).await;
    (daemon, local, url, code)
}

/// A new offer from `local`'s Host: its URL and code.
async fn offer(local: &HostConnection) -> (String, String) {
    let offer = local
        .send(OfferDeviceRequest { name: None })
        .await
        .expect("devices/offer");
    (offer.url.expect("a URL"), offer.code)
}

/// Pair `local`'s Host with the one at `url`, calling it `name`.
async fn add_peer(local: &HostConnection, url: &str, code: String, name: &str) -> Peer {
    local
        .send(AddPeerRequest {
            url: url.to_owned(),
            code,
            name: Some(name.to_owned()),
        })
        .await
        .expect("peers/add")
        .peer
}

async fn peers(local: &HostConnection, check: bool) -> Vec<Peer> {
    local
        .send(ListPeersRequest { check })
        .await
        .expect("peers/list")
        .peers
}

async fn new_session(local: &HostConnection, cwd: &Path) -> SessionId {
    local
        .send(CreateSessionRequest {
            agent_id: "fake".to_owned(),
            cwd: cwd.to_path_buf(),
            additional_directories: Vec::new(),
            mode: None,
            policy: None,
            trace: false,
        })
        .await
        .expect("session/create")
        .session_id
}

async fn next(events: &mut UnboundedReceiver<HostEvent>) -> HostEvent {
    tokio::time::timeout(WAIT, events.recv())
        .await
        .expect("an event in time")
        .expect("the connection is open")
}

/// Prompt `session_id` with `text`, behind whatever runs there, and wait for that turn to end:
/// what its agent said in it. The Host's reports start turns of their own, before or after it.
async fn said(
    local: &HostConnection,
    events: &mut UnboundedReceiver<HostEvent>,
    session_id: &SessionId,
    text: String,
) -> String {
    let queued = local
        .send(AddQueuedRequest {
            session_id: session_id.clone(),
            prompt: vec![ContentBlock::from(text)],
            key: None,
            caller: None,
        })
        .await
        .expect("queue/add")
        .queued_id;
    let mut mine = false;
    let mut said = String::new();
    loop {
        let HostEvent::Event(notification) = next(events).await else {
            continue;
        };
        match notification.event {
            SessionEvent::TurnStarted {
                session_id: started,
                turn_id,
                ..
            } if started == *session_id => mine = turn_id.as_ref() == Some(&queued),
            SessionEvent::Update {
                notification: update,
            } if mine && update.session_id == *session_id => {
                if let SessionUpdate::AgentMessageChunk(chunk) = update.update
                    && let ContentBlock::Text(text) = chunk.content
                {
                    said.push_str(&text.text);
                }
            }
            SessionEvent::TurnEnded {
                session_id: ended, ..
            } if mine && ended == *session_id => return said,
            _ => {}
        }
    }
}

/// Have `caller`'s agent call `tool` with `arguments`: what the tool answered as JSON, or
/// panics with what the agent said when the tool failed.
async fn call(
    local: &HostConnection,
    events: &mut UnboundedReceiver<HostEvent>,
    caller: &SessionId,
    tool: &str,
    arguments: serde_json::Value,
) -> serde_json::Value {
    let said = said(local, events, caller, format!("tool {tool} {arguments}")).await;
    tool_answer(&said, tool)
}

/// What the tool failed with, from what `caller`'s agent said.
async fn call_fails(
    local: &HostConnection,
    events: &mut UnboundedReceiver<HostEvent>,
    caller: &SessionId,
    tool: &str,
    arguments: serde_json::Value,
) -> String {
    let said = said(local, events, caller, format!("tool {tool} {arguments}")).await;
    let marker = format!("{tool} failed: ");
    let at = said
        .find(&marker)
        .unwrap_or_else(|| panic!("{tool} failed in {said:?}"));
    said[at + marker.len()..].to_owned()
}

/// What a tool answered in an agent's text (`<tool> answered: <JSON>`), as JSON.
fn tool_answer(said: &str, tool: &str) -> serde_json::Value {
    let marker = format!("{tool} answered: ");
    let at = said
        .rfind(&marker)
        .unwrap_or_else(|| panic!("{tool} answered in {said:?}"));
    serde_json::Deserializer::from_str(&said[at + marker.len()..])
        .into_iter::<serde_json::Value>()
        .next()
        .and_then(Result::ok)
        .unwrap_or_else(|| panic!("JSON after {marker:?} in {said:?}"))
}

fn text_of(prompt: &[ContentBlock]) -> String {
    prompt
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text(text) => Some(text.text.as_str()),
            _ => None,
        })
        .collect()
}

/// The first of the Host's reports to `session_id` on `daemon` whose text has `needle`: its
/// origin and text. Reads the session's journal from its start, as an observer, so a report
/// that came while the test looked elsewhere, steered into a running turn or queued, counts.
async fn heard(daemon: &Daemon, session_id: &SessionId, needle: &str) -> (TurnOrigin, String) {
    let (observer, mut events) = local(daemon).await;
    // A session that isn't open, as after a restart, is until a report takes it up.
    let deadline = tokio::time::Instant::now() + WAIT;
    while let Err(error) = observer
        .send(AttachSessionRequest {
            session_id: session_id.clone(),
            after: None,
            agent_id: None,
            cwd: None,
            trace: false,
            observe: true,
        })
        .await
    {
        assert!(
            errors::is(&error, errors::SESSION_NOT_OPEN) && tokio::time::Instant::now() < deadline,
            "session/attach: {error:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let mut reports = Vec::new();
    let found = tokio::time::timeout(WAIT, async {
        loop {
            let Some(HostEvent::Event(notification)) = events.recv().await else {
                continue;
            };
            if let SessionEvent::TurnStarted {
                session_id: started,
                prompt,
                origin,
                ..
            }
            | SessionEvent::TurnSteered {
                session_id: started,
                prompt,
                origin,
            } = notification.event
                && started == *session_id
                && matches!(origin, TurnOrigin::Session { report: true, .. })
            {
                let text = text_of(&prompt);
                if text.contains(needle) {
                    return (origin, text);
                }
                reports.push(text);
            }
        }
    })
    .await;
    observer.shutdown().await;
    found.unwrap_or_else(|_| panic!("no report with {needle:?} in time; heard {reports:#?}"))
}

async fn get(local: &HostConnection, session_id: &SessionId) -> GetSessionResponse {
    local
        .send(GetSessionRequest {
            session_id: session_id.clone(),
            turn_id: None,
        })
        .await
        .expect("sessions/get")
}

fn session_id(value: &serde_json::Value) -> SessionId {
    SessionId::new(value["sessionId"].as_str().expect("a thread id").to_owned())
}

/// Run git in `dir`; what it printed.
fn git(dir: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .envs(ISOLATED_GIT.iter().copied())
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

/// A repository at `dir` whose `origin` is `remote`, with a commit.
fn repository(dir: &Path, remote: &str) {
    std::fs::create_dir_all(dir).expect("the repository's directory");
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["remote", "add", "origin", remote]);
    git(dir, &["commit", "-q", "--allow-empty", "-m", "first"]);
}

#[tokio::test]
async fn an_agent_starts_a_thread_on_a_peer_host_and_hears_how_its_turn_ended() {
    let studio = World::new();
    let (b, b_local, url, code) = offering(&studio, "studio").await;
    let b_id = b_local.hello().host.id.clone();
    let mini = World::new();
    let a = mini.daemon("mini", None);
    let (a_local, mut a_events) = local(&a).await;
    let a_id = a_local.hello().host.id.clone();

    // A pairs with B, which lists A as a peer Host beside its devices.
    let peer = add_peer(&a_local, &url, code, "studio").await;
    assert_eq!(peer.host_id, b_id);
    assert_eq!(peer.status, PeerStatus::Reachable);
    let devices = b_local
        .send(ListDevicesRequest {})
        .await
        .expect("devices/list")
        .devices;
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].name, "mini");
    assert_eq!(devices[0].host.as_deref(), Some(a_id.as_str()));

    // A's agent sees B among its Hosts, and what agents B runs.
    let caller = new_session(&a_local, mini.dir.path()).await;
    let hosts = call(
        &a_local,
        &mut a_events,
        &caller,
        "list_hosts",
        serde_json::json!({}),
    )
    .await;
    assert_eq!(hosts["hostId"], a_id);
    assert_eq!(hosts["peers"][0]["name"], "studio");
    assert_eq!(hosts["peers"][0]["status"], "reachable");
    let agents = call(
        &a_local,
        &mut a_events,
        &caller,
        "list_agents",
        serde_json::json!({"host": "studio"}),
    )
    .await;
    assert!(agents.to_string().contains("\"fake\""), "{agents}");

    // It starts a thread there whose agent asks permission.
    let target = studio.dir.path().join("out.txt");
    let started = call(
        &a_local,
        &mut a_events,
        &caller,
        "start_session",
        serde_json::json!({
            "host": "studio",
            "agentId": "fake",
            "cwd": studio.dir.path(),
            "prompt": format!("write {} hello", target.display()),
        }),
    )
    .await;
    assert_eq!(started["host"], b_id);
    let delegated = session_id(&started);

    // B runs it: its journal has the turn, whose origin names A's thread and A.
    let got = get(&b_local, &delegated).await;
    assert_eq!(got.session.started_by.as_ref(), Some(&caller));
    assert_eq!(got.session.started_by_host.as_deref(), Some(a_id.as_str()));
    assert_eq!(
        got.latest_turn.expect("a turn").origin,
        TurnOrigin::Session {
            session_id: caller.clone(),
            host: Some(a_id.clone()),
            host_name: Some("mini".to_owned()),
            report: false,
        }
    );

    // A's agent hears that it waits on a person, whom B's clients reach.
    let (origin, text) = heard(&a, &caller, "waiting on a person").await;
    assert_eq!(
        origin,
        TurnOrigin::Session {
            session_id: delegated.clone(),
            host: Some(b_id.clone()),
            host_name: Some("studio".to_owned()),
            report: true,
        }
    );
    assert!(
        text.contains("on studio is waiting on a person") && text.contains("connected to studio"),
        "{text}"
    );
    let attached = b_local
        .send(AttachSessionRequest {
            session_id: delegated.clone(),
            after: None,
            agent_id: None,
            cwd: None,
            trace: false,
            observe: false,
        })
        .await
        .expect("session/attach");
    let pending = attached.state.pending.first().expect("a pending request");
    b_local
        .send(AnswerPendingRequest {
            session_id: delegated.clone(),
            pending_id: pending.id.clone(),
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

    // Its turn ends on B, and A's agent hears how.
    let (_, text) = heard(&a, &caller, "finished its turn").await;
    assert!(text.contains("on studio finished its turn"), "{text}");
    assert_eq!(
        std::fs::read_to_string(&target)
            .expect("written")
            .trim_end(),
        "hello"
    );

    // And reads the thread there.
    let read = call(
        &a_local,
        &mut a_events,
        &caller,
        "read_session",
        serde_json::json!({"host": "studio", "sessionId": delegated}),
    )
    .await;
    assert_eq!(read["session"]["startedByHost"], a_id);
    a_local.shutdown().await;
    b_local.shutdown().await;
    drop((a, b));
}

#[tokio::test]
async fn an_agent_prompts_and_cancels_threads_on_a_peer_host() {
    let studio = World::new();
    let (b, b_local, url, code) = offering(&studio, "studio").await;
    let mini = World::new();
    let a = mini.daemon("mini", None);
    let (a_local, mut a_events) = local(&a).await;
    add_peer(&a_local, &url, code, "studio").await;
    let caller = new_session(&a_local, mini.dir.path()).await;

    // A thread the person runs on B, which A's agent finds and prompts.
    let (b_client, mut b_events) = local(&b).await;
    let theirs = new_session(&b_client, studio.dir.path()).await;
    said(&b_client, &mut b_events, &theirs, "hello".to_owned()).await;
    let listed = call(
        &a_local,
        &mut a_events,
        &caller,
        "list_sessions",
        serde_json::json!({"host": "studio"}),
    )
    .await;
    assert!(listed.to_string().contains(&theirs.to_string()), "{listed}");
    let queued = call(
        &a_local,
        &mut a_events,
        &caller,
        "prompt_session",
        serde_json::json!({"host": "studio", "sessionId": theirs, "prompt": "from mini"}),
    )
    .await;
    assert!(queued["queuedId"].is_string(), "{queued}");
    let (_, text) = heard(&a, &caller, "You said: from mini").await;
    assert!(text.contains("on studio finished its turn"), "{text}");
    let got = get(&b_local, &theirs).await;
    assert_eq!(got.session.started_by, None, "prompting starts nothing");

    // One it starts there runs long, until it cancels the turn.
    let started = call(
        &a_local,
        &mut a_events,
        &caller,
        "start_session",
        serde_json::json!({
            "host": "studio",
            "agentId": "fake",
            "cwd": studio.dir.path(),
            "prompt": "slow 200",
        }),
    )
    .await;
    let long = session_id(&started);
    call(
        &a_local,
        &mut a_events,
        &caller,
        "cancel_session_turn",
        serde_json::json!({"host": "studio", "sessionId": long}),
    )
    .await;
    let (_, text) = heard(&a, &caller, "had its turn cancelled").await;
    assert!(text.contains("on studio had its turn cancelled"), "{text}");
    let latest = get(&b_local, &long).await.latest_turn.expect("a turn");
    assert_eq!(
        latest.response.map(|response| response.stop_reason),
        Some(StopReason::Cancelled)
    );
    drop((a, b));
}

#[tokio::test]
async fn a_thread_started_on_a_peer_without_a_directory_works_in_the_same_checkout_there() {
    let studio = World::new();
    let (b, b_local, url, code) = offering(&studio, "studio").await;
    let mini = World::new();
    let a = mini.daemon("mini", None);
    let (a_local, mut a_events) = local(&a).await;
    add_peer(&a_local, &url, code, "studio").await;

    // The same repository under both homes, by HTTPS here and SSH there; this Host's thread
    // works in another worktree of it, on a branch the other Host doesn't have.
    let app = mini.home().join("src/app");
    repository(&app, "https://github.com/jaco/app.git");
    let feature = mini.home().join("src/app.feature");
    git(
        &app,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feature",
            feature.to_str().expect("UTF-8"),
        ],
    );
    std::fs::create_dir_all(feature.join("ui")).expect("a subdirectory");
    let there = studio.home().join("src/app");
    repository(&there, "git@github.com:jaco/app.git");
    std::fs::create_dir_all(there.join("ui")).expect("a subdirectory there");

    let caller = new_session(&a_local, &feature.join("ui")).await;
    let started = call(
        &a_local,
        &mut a_events,
        &caller,
        "start_session",
        serde_json::json!({"host": "studio", "agentId": "fake", "prompt": "hello"}),
    )
    .await;
    let got = get(&b_local, &session_id(&started)).await;
    assert_eq!(
        std::fs::canonicalize(&got.session.info.cwd).expect("its directory"),
        std::fs::canonicalize(there.join("ui")).expect("the checkout there")
    );

    // A directory there that's another repository's checkout won't do.
    let other = mini.home().join("src/other");
    repository(&other, "https://github.com/jaco/other.git");
    repository(
        &studio.home().join("src/other"),
        "https://github.com/someone/else.git",
    );
    let elsewhere = new_session(&a_local, &other).await;
    let refused = call_fails(
        &a_local,
        &mut a_events,
        &elsewhere,
        "start_session",
        serde_json::json!({"host": "studio", "agentId": "fake", "prompt": "hello"}),
    )
    .await;
    assert!(
        refused.contains("is a checkout of github.com/someone/else, not github.com/jaco/other"),
        "{refused}"
    );

    // Nor one that isn't there at all.
    let lonely = mini.home().join("src/lonely");
    repository(&lonely, "https://github.com/jaco/lonely.git");
    let alone = new_session(&a_local, &lonely).await;
    let refused = call_fails(
        &a_local,
        &mut a_events,
        &alone,
        "start_session",
        serde_json::json!({"host": "studio", "agentId": "fake", "prompt": "hello"}),
    )
    .await;
    assert!(
        refused.contains("isn't a directory on this Host"),
        "{refused}"
    );

    // A thread outside the home has no counterpart, and names a directory there itself.
    let outside = new_session(&a_local, mini.dir.path()).await;
    let refused = call_fails(
        &a_local,
        &mut a_events,
        &outside,
        "start_session",
        serde_json::json!({"host": "studio", "agentId": "fake", "prompt": "hello"}),
    )
    .await;
    assert!(refused.contains("outside its home"), "{refused}");
    let named = call(
        &a_local,
        &mut a_events,
        &outside,
        "start_session",
        serde_json::json!({
            "host": "studio",
            "agentId": "fake",
            "cwd": "~/src/other",
            "prompt": "hello",
        }),
    )
    .await;
    let got = get(&b_local, &session_id(&named)).await;
    assert_eq!(
        std::fs::canonicalize(&got.session.info.cwd).expect("its directory"),
        std::fs::canonicalize(studio.home().join("src/other")).expect("the directory there")
    );
    drop((a, b));
}

#[tokio::test]
async fn a_peer_host_may_only_do_what_the_host_tools_need() {
    let studio = World::new();
    let (b, b_local, url, code) = offering(&studio, "studio").await;
    let (b_client, mut b_events) = local(&b).await;
    let theirs = new_session(&b_client, studio.dir.path()).await;
    said(&b_client, &mut b_events, &theirs, "hello".to_owned()).await;

    // A Host pairs as a device that names its Host id.
    let key = DeviceKey::generate();
    let (transport, _) = connect_websocket(&url).await.expect("the WebSocket");
    let (paired, _) = HostConnection::connect_with(
        transport,
        info("weave-host"),
        ClientCapabilities::default(),
        Credentials::Pair {
            code,
            name: "mini".to_owned(),
            key: key.clone(),
            host: Some("h-mini".to_owned()),
        },
    )
    .await
    .expect("paired");
    let device = paired.hello().device.clone().expect("a device");
    paired.shutdown().await;
    let (transport, _) = connect_websocket(&url).await.expect("the WebSocket");
    let (peer, _peer_events) = HostConnection::connect_with(
        transport,
        info("weave-host"),
        ClientCapabilities::default(),
        Credentials::Device {
            device_id: device.id.clone(),
            key: key.clone(),
            host_id: None,
        },
    )
    .await
    .expect("connected");

    // What the Host tools and following a turn need, it may.
    peer.send(ListSessionsRequest::default())
        .await
        .expect("sessions/list");
    peer.send(ListAgentsRequest::default())
        .await
        .expect("agents/list");
    get(&peer, &theirs).await;
    peer.send(AttachSessionRequest {
        session_id: theirs.clone(),
        after: None,
        agent_id: None,
        cwd: None,
        trace: false,
        observe: true,
    })
    .await
    .expect("observing");

    // Nothing else: not the files, terminals or worktrees of the computer, not a thread as a
    // client of it, and not answering what a thread asks a person.
    let refusals = [
        peer.send(ListFilesRequest {
            path: None,
            hidden: false,
        })
        .await
        .map(drop),
        peer.send(ListTerminalsRequest {
            directory: studio.dir.path().to_path_buf(),
        })
        .await
        .map(drop),
        peer.send(ListWorktreesRequest {
            repo: studio.dir.path().to_path_buf(),
        })
        .await
        .map(drop),
        peer.send(RenameSessionRequest {
            session_id: theirs.clone(),
            title: "mine".to_owned(),
        })
        .await
        .map(drop),
        peer.send(CreateSessionRequest {
            agent_id: "fake".to_owned(),
            cwd: studio.dir.path().to_path_buf(),
            additional_directories: Vec::new(),
            mode: None,
            policy: None,
            trace: false,
        })
        .await
        .map(drop),
        peer.send(StartTurnRequest {
            session_id: theirs.clone(),
            prompt: vec![ContentBlock::from("hello")],
            key: None,
        })
        .await
        .map(drop),
        peer.send(AnswerPendingRequest {
            session_id: theirs.clone(),
            pending_id: "p1".into(),
            permission: None,
            elicitation: None,
            client_tool: None,
        })
        .await
        .map(drop),
        peer.send(AttachSessionRequest {
            session_id: theirs.clone(),
            after: None,
            agent_id: None,
            cwd: None,
            trace: false,
            observe: false,
        })
        .await
        .map(drop),
        peer.send(RunRequest {
            agent_id: "fake".to_owned(),
            cwd: studio.dir.path().to_path_buf(),
            remote: None,
            session_id: None,
            additional_directories: Vec::new(),
            prompt: vec![ContentBlock::from("hello")],
            policy: PermissionPolicy::ask(),
            attach: true,
            trace: false,
            key: None,
            caller: None,
        })
        .await
        .map(drop),
        peer.send(ListPeersRequest { check: false }).await.map(drop),
    ];
    for refused in refusals {
        let error = refused.expect_err("refused");
        assert!(errors::is(&error, errors::FORBIDDEN), "{error:?}");
    }

    // A device that isn't a Host still may.
    let (b_device_url, b_device_code) = offer(&b_local).await;
    let device_key = DeviceKey::generate();
    let (transport, _) = connect_websocket(&b_device_url)
        .await
        .expect("the WebSocket");
    let (ipad, _) = HostConnection::connect_with(
        transport,
        info("weave-ios"),
        ClientCapabilities::default(),
        Credentials::Pair {
            code: b_device_code,
            name: "iPad".to_owned(),
            key: device_key,
            host: None,
        },
    )
    .await
    .expect("paired");
    ipad.send(ListFilesRequest {
        path: None,
        hidden: false,
    })
    .await
    .expect("a device lists files");
    ipad.shutdown().await;
    peer.shutdown().await;
    drop(b);
}

#[tokio::test]
async fn revoking_a_peer_host_refuses_its_next_connection() {
    let studio = World::new();
    let (b, b_local, url, code) = offering(&studio, "studio").await;
    // Another device stays paired, so B keeps listening once A is revoked.
    let (url_again, ipad_code) = offer(&b_local).await;
    assert_eq!(url_again, url);
    let (transport, _) = connect_websocket(&url).await.expect("the WebSocket");
    let (ipad, _) = HostConnection::connect_with(
        transport,
        info("weave-ios"),
        ClientCapabilities::default(),
        Credentials::Pair {
            code: ipad_code,
            name: "iPad".to_owned(),
            key: DeviceKey::generate(),
            host: None,
        },
    )
    .await
    .expect("paired");
    ipad.shutdown().await;
    let mini = World::new();
    let a = mini.daemon("mini", None);
    let (a_local, mut a_events) = local(&a).await;
    add_peer(&a_local, &url, code, "studio").await;
    let caller = new_session(&a_local, mini.dir.path()).await;
    call(
        &a_local,
        &mut a_events,
        &caller,
        "list_sessions",
        serde_json::json!({"host": "studio"}),
    )
    .await;

    let devices = b_local
        .send(ListDevicesRequest {})
        .await
        .expect("devices/list")
        .devices;
    let mini_on_b = devices
        .iter()
        .find(|device| device.host.is_some())
        .expect("A among B's devices");
    b_local
        .send(RevokeDeviceRequest {
            device_id: mini_on_b.id.clone(),
        })
        .await
        .expect("devices/revoke");
    // B closes A's connection, and refuses the next.
    let deadline = tokio::time::Instant::now() + WAIT;
    while peers(&a_local, false).await[0].status == PeerStatus::Reachable {
        assert!(tokio::time::Instant::now() < deadline, "still connected");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let refused = call_fails(
        &a_local,
        &mut a_events,
        &caller,
        "list_sessions",
        serde_json::json!({"host": "studio"}),
    )
    .await;
    assert!(
        refused.contains("studio can't be reached: it refused this Host"),
        "{refused}"
    );
    let listed = peers(&a_local, true).await;
    assert_eq!(listed[0].status, PeerStatus::Refused);
    let error = listed[0].error.as_deref().unwrap_or_default();
    assert!(error.contains("weave hosts add"), "{error}");
    drop((a, b));
}

/// An HTTP server at a loopback address that answers everything 502, as Tailscale Serve does
/// for a Host that isn't running.
async fn bad_gateway() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a port");
    let address = listener.local_addr().expect("its address");
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buffer = [0u8; 4096];
                let _ = stream.read(&mut buffer).await;
                let _ = stream
                    .write_all(
                        b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await;
            });
        }
    });
    format!("ws://{address}")
}

/// A loopback URL nothing listens at.
async fn nothing_there() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a port");
    let address = listener.local_addr().expect("its address");
    drop(listener);
    format!("ws://{address}")
}

#[tokio::test]
async fn hosts_say_whether_each_peer_can_be_reached_and_why_not() {
    let studio = World::new();
    let (b, b_local, url, code) = offering(&studio, "studio").await;
    let laptop = World::new();
    let (c, _c_local, c_url, _c_code) = offering(&laptop, "laptop").await;
    let mini = World::new();

    // Paired, it's reachable.
    let a = mini.daemon_keeping("mini");
    let (a_local, _) = local(&a).await;
    add_peer(&a_local, &url, code, "studio").await;
    assert_eq!(peers(&a_local, true).await[0].status, PeerStatus::Reachable);
    a_local.shutdown().await;
    a.shutdown().await;

    // A Host that starts again hasn't tried it yet.
    let a = mini.daemon_keeping("mini");
    let (a_local, _) = local(&a).await;
    let listed = peers(&a_local, false).await;
    assert_eq!(listed[0].status, PeerStatus::Unchecked);
    assert_eq!(listed[0].error, None);
    assert_eq!(peers(&a_local, true).await[0].status, PeerStatus::Reachable);
    a_local.shutdown().await;
    a.shutdown().await;

    // Its address answers, but no weave Host does; then nothing answers; then another Host.
    let cases = [
        (bad_gateway().await, PeerStatus::Down, "no weave Host did"),
        (
            nothing_there().await,
            PeerStatus::Unreachable,
            "nothing answered",
        ),
        (c_url, PeerStatus::OtherHost, "another weave Host answers"),
    ];
    for (at, status, why) in cases {
        let mut json = mini.peers_json();
        json["peers"][0]["url"] = serde_json::Value::String(at.clone());
        mini.write_peers_json(&json);
        let a = mini.daemon_keeping("mini");
        let (a_local, mut a_events) = local(&a).await;
        let listed = peers(&a_local, true).await;
        assert_eq!(listed[0].status, status, "{at}: {listed:?}");
        let error = listed[0].error.clone().unwrap_or_default();
        assert!(error.contains(why), "{at}: {error}");

        // An agent's call fails at once, with the same reason.
        let caller = new_session(&a_local, mini.dir.path()).await;
        let refused = call_fails(
            &a_local,
            &mut a_events,
            &caller,
            "list_sessions",
            serde_json::json!({"host": "studio"}),
        )
        .await;
        assert!(
            refused.contains("studio can't be reached") && refused.contains(why),
            "{refused}"
        );
        let hosts = call(
            &a_local,
            &mut a_events,
            &caller,
            "list_hosts",
            serde_json::json!({}),
        )
        .await;
        assert_eq!(
            hosts["peers"][0]["status"],
            serde_json::to_value(status).expect("JSON")
        );
        a_local.shutdown().await;
        a.shutdown().await;
    }
    b_local.shutdown().await;
    drop((b, c));
}

#[tokio::test]
async fn a_start_on_a_peer_that_cannot_be_reached_fails_and_leaves_nothing_to_send() {
    let studio = World::new();
    let (b, b_local, url, code) = offering(&studio, "studio").await;
    let mini = World::new();
    let a = mini.daemon_keeping("mini");
    let (a_local, _) = local(&a).await;
    add_peer(&a_local, &url, code, "studio").await;
    a_local.shutdown().await;
    a.shutdown().await;
    // Nothing answers where B was.
    let mut json = mini.peers_json();
    json["peers"][0]["url"] = serde_json::Value::String(nothing_there().await);
    mini.write_peers_json(&json);

    let a = mini.daemon_keeping("mini");
    let (a_local, mut a_events) = local(&a).await;
    let caller = new_session(&a_local, mini.dir.path()).await;
    let refused = call_fails(
        &a_local,
        &mut a_events,
        &caller,
        "start_session",
        serde_json::json!({
            "host": "studio",
            "agentId": "fake",
            "cwd": "~",
            "prompt": "hello",
        }),
    )
    .await;
    assert!(
        refused.contains("studio can't be reached: nothing answered"),
        "{refused}"
    );
    let refused = call_fails(
        &a_local,
        &mut a_events,
        &caller,
        "prompt_session",
        serde_json::json!({"host": "studio", "sessionId": "s-1", "prompt": "hello"}),
    )
    .await;
    assert!(refused.contains("studio can't be reached"), "{refused}");
    a_local.shutdown().await;
    a.shutdown().await;
    let json = mini.peers_json();
    assert!(json.get("sending").is_none(), "{json:#}");
    assert!(json.get("following").is_none(), "{json:#}");
    b_local.shutdown().await;
    drop(b);
}

#[tokio::test]
async fn a_start_a_peer_never_answered_is_sent_again_under_its_key_and_reported() {
    let studio = World::new();
    let (b, b_local, url, code) = offering(&studio, "studio").await;
    let mini = World::new();
    let a = mini.daemon_keeping("mini");
    let (a_local, mut a_events) = local(&a).await;
    add_peer(&a_local, &url, code, "studio").await;
    let caller = new_session(&a_local, mini.dir.path()).await;
    said(&a_local, &mut a_events, &caller, "hello".to_owned()).await;
    a_local.shutdown().await;
    a.shutdown().await;

    // A recorded a start on B and stopped before B answered, as a Host that crashes does.
    let b_id = b_local.hello().host.id.clone();
    let request = RunRequest {
        agent_id: "fake".to_owned(),
        cwd: studio.dir.path().to_path_buf(),
        remote: None,
        session_id: None,
        additional_directories: Vec::new(),
        prompt: vec![ContentBlock::from("hello from the crash")],
        policy: PermissionPolicy::ask(),
        attach: false,
        trace: false,
        key: Some("k-crash".to_owned()),
        caller: Some(caller.clone()),
    };
    let sending = serde_json::json!([{
        "hostId": b_id,
        "caller": caller,
        "delegated": true,
        "request": {"run": request},
    }]);
    let mut json = mini.peers_json();
    json["sending"] = sending.clone();
    mini.write_peers_json(&json);

    // The next A sends it again; B starts the thread, and A's agent hears of it, then of its
    // turn's end.
    let a = mini.daemon_keeping("mini");
    a.resume_remote().await;
    let (_, text) = heard(&a, &caller, "after all").await;
    assert!(text.contains("studio took the start_session"), "{text}");
    let (origin, text) = heard(&a, &caller, "finished its turn").await;
    assert!(text.contains("You said: hello from the crash"), "{text}");
    let TurnOrigin::Session {
        session_id: delegated,
        ..
    } = origin
    else {
        panic!("a session's report: {origin:?}");
    };
    let got = get(&b_local, &delegated).await;
    assert_eq!(got.session.started_by.as_ref(), Some(&caller));
    a.shutdown().await;
    assert!(mini.peers_json().get("sending").is_none());

    // Sent once more, as when A stopped before it noted the answer, B starts nothing new.
    let mut json = mini.peers_json();
    json["sending"] = sending;
    mini.write_peers_json(&json);
    let a = mini.daemon_keeping("mini");
    a.resume_remote().await;
    let deadline = tokio::time::Instant::now() + WAIT;
    while mini.peers_json().get("sending").is_some() {
        assert!(tokio::time::Instant::now() < deadline, "still sending");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let listed = b_local
        .send(ListSessionsRequest::default())
        .await
        .expect("sessions/list")
        .sessions;
    let started: Vec<_> = listed
        .iter()
        .filter(|listing| listing.started_by.as_ref() == Some(&caller))
        .collect();
    assert_eq!(started.len(), 1, "{listed:#?}");
    assert_eq!(started[0].info.session_id, delegated);
    a.shutdown().await;
    b_local.shutdown().await;
    drop(b);
}

#[tokio::test]
async fn a_hosts_agents_reach_its_peers_and_not_theirs() {
    // A pairs with B, and B with C.
    let laptop = World::new();
    let (c, c_local, c_url, c_code) = offering(&laptop, "laptop").await;
    let c_id = c_local.hello().host.id.clone();
    let studio = World::new();
    let (b, b_local, b_url, b_code) = offering(&studio, "studio").await;
    add_peer(&b_local, &c_url, c_code, "laptop").await;
    let mini = World::new();
    let a = mini.daemon("mini", None);
    let (a_local, mut a_events) = local(&a).await;
    add_peer(&a_local, &b_url, b_code, "studio").await;

    // A's agent can't name C, which only B pairs with.
    let caller = new_session(&a_local, mini.dir.path()).await;
    let refused = call_fails(
        &a_local,
        &mut a_events,
        &caller,
        "list_sessions",
        serde_json::json!({"host": c_id}),
    )
    .await;
    assert!(refused.contains("This Host has no peer Host"), "{refused}");

    // Nor through a thread it starts on B, whose agent reaches none of B's peers.
    call(
        &a_local,
        &mut a_events,
        &caller,
        "start_session",
        serde_json::json!({
            "host": "studio",
            "agentId": "fake",
            "cwd": studio.dir.path(),
            "prompt": r#"tool list_sessions {"host": "laptop"}"#,
        }),
    )
    .await;
    let (_, text) = heard(&a, &caller, "on studio finished its turn").await;
    assert!(
        text.contains("list_sessions failed") && text.contains("one hop"),
        "{text}"
    );

    // Nor through a thread that one starts on B in turn.
    let child = serde_json::json!({
        "agentId": "fake",
        "prompt": r#"tool list_sessions {"host": "laptop"}"#,
    });
    let started = call(
        &a_local,
        &mut a_events,
        &caller,
        "start_session",
        serde_json::json!({
            "host": "studio",
            "agentId": "fake",
            "cwd": studio.dir.path(),
            "prompt": format!("tool start_session {child}"),
        }),
    )
    .await;
    let middle = session_id(&started);
    let (b_observer, _) = local(&b).await;
    let (_, text) = heard(&b, &middle, "finished its turn").await;
    let listed = b_observer
        .send(ListSessionsRequest::default())
        .await
        .expect("sessions/list")
        .sessions;
    let derived = listed
        .iter()
        .find(|listing| listing.started_by.as_ref() == Some(&middle))
        .expect("the thread B's thread started");
    let latest = get(&b_observer, &derived.info.session_id)
        .await
        .latest_turn
        .expect("its turn");
    let message = latest.message.unwrap_or_default();
    assert!(
        message.contains("list_sessions failed") && message.contains("one hop"),
        "{message}; its starter heard {text}"
    );

    // B's own threads reach C.
    let (b_client, mut b_events) = local(&b).await;
    let own = new_session(&b_client, studio.dir.path()).await;
    call(
        &b_client,
        &mut b_events,
        &own,
        "list_sessions",
        serde_json::json!({"host": "laptop"}),
    )
    .await;
    b_local.shutdown().await;
    c_local.shutdown().await;
    drop((a, b, c));
}

#[tokio::test]
async fn a_host_that_restarts_follows_its_turns_on_peers_again() {
    let studio = World::new();
    let (b, b_local, url, code) = offering(&studio, "studio").await;
    let b_id = b_local.hello().host.id.clone();
    let mini = World::new();
    let a = mini.daemon_keeping("mini");
    let (a_local, mut a_events) = local(&a).await;
    add_peer(&a_local, &url, code, "studio").await;
    let caller = new_session(&a_local, mini.dir.path()).await;
    let started = call(
        &a_local,
        &mut a_events,
        &caller,
        "start_session",
        serde_json::json!({
            "host": "studio",
            "agentId": "fake",
            "cwd": studio.dir.path(),
            "prompt": "slow 15",
        }),
    )
    .await;
    let delegated = session_id(&started);

    // A stops while B's turn runs, and another A takes up from A's files.
    a_local.shutdown().await;
    a.shutdown().await;
    let a = mini.daemon_keeping("mini");
    a.resume_remote().await;
    let (origin, _) = heard(&a, &caller, "on studio finished its turn").await;
    assert_eq!(
        origin,
        TurnOrigin::Session {
            session_id: delegated,
            host: Some(b_id),
            host_name: Some("studio".to_owned()),
            report: true,
        }
    );
    b_local.shutdown().await;
    drop((a, b));
}

#[tokio::test]
async fn a_thread_on_a_peer_approves_nothing_its_caller_doesnt() {
    let studio = World::new();
    let (b, b_local, url, code) = offering(&studio, "studio").await;
    let mini = World::new();
    let a = mini.daemon("mini", None);
    let (a_local, mut a_events) = local(&a).await;
    add_peer(&a_local, &url, code, "studio").await;
    let caller = a_local
        .send(CreateSessionRequest {
            agent_id: "fake".to_owned(),
            cwd: mini.dir.path().to_path_buf(),
            additional_directories: Vec::new(),
            mode: None,
            policy: Some(PermissionPolicy {
                approve: vec![ToolKind::Read],
                otherwise: Unapproved::Ask,
            }),
            trace: false,
        })
        .await
        .expect("session/create")
        .session_id;

    // It asks for more than it has; B runs the thread within what it has.
    let started = call(
        &a_local,
        &mut a_events,
        &caller,
        "start_session",
        serde_json::json!({
            "host": "studio",
            "agentId": "fake",
            "cwd": studio.dir.path(),
            "prompt": "hello",
            "approve": ["read", "edit", "execute"],
        }),
    )
    .await;
    let within = PermissionPolicy {
        approve: vec![ToolKind::Read],
        otherwise: Unapproved::Ask,
    };
    assert_eq!(
        serde_json::from_value::<PermissionPolicy>(started["policy"].clone()).expect("a policy"),
        within
    );
    let attached = b_local
        .send(AttachSessionRequest {
            session_id: session_id(&started),
            after: None,
            agent_id: None,
            cwd: None,
            trace: false,
            observe: true,
        })
        .await
        .expect("session/attach");
    assert_eq!(attached.state.policy, within);
    drop((a, b));
}

#[tokio::test]
async fn threads_a_thread_runs_on_peers_count_toward_its_delegation_limit() {
    let studio = World::new();
    let (b, b_local, url, code) = offering(&studio, "studio").await;
    let mini = World::new();
    std::fs::write(
        mini.dir.path().join("config.toml"),
        "[agents.fake]\ncommand = \"fake-agent\"\n\n[delegation]\nrunning = 1\n",
    )
    .expect("config");
    let a = mini.daemon("mini", None);
    let (a_local, mut a_events) = local(&a).await;
    add_peer(&a_local, &url, code, "studio").await;
    let caller = new_session(&a_local, mini.dir.path()).await;
    let slow = serde_json::json!({
        "host": "studio",
        "agentId": "fake",
        "cwd": studio.dir.path(),
        "prompt": "slow 200",
    });
    let first = call(
        &a_local,
        &mut a_events,
        &caller,
        "start_session",
        slow.clone(),
    )
    .await;

    // One runs on B, so neither another there nor one here may start.
    let refused = call_fails(&a_local, &mut a_events, &caller, "start_session", slow).await;
    assert!(refused.contains("[delegation] running"), "{refused}");
    let refused = call_fails(
        &a_local,
        &mut a_events,
        &caller,
        "start_session",
        serde_json::json!({"agentId": "fake", "prompt": "hello"}),
    )
    .await;
    assert!(refused.contains("[delegation] running"), "{refused}");

    // Once it's over, another may.
    call(
        &a_local,
        &mut a_events,
        &caller,
        "cancel_session_turn",
        serde_json::json!({"host": "studio", "sessionId": session_id(&first)}),
    )
    .await;
    heard(&a, &caller, "had its turn cancelled").await;
    call(
        &a_local,
        &mut a_events,
        &caller,
        "start_session",
        serde_json::json!({"agentId": "fake", "prompt": "hello"}),
    )
    .await;
    b_local.shutdown().await;
    drop((a, b));
}

#[tokio::test]
async fn forgetting_a_peer_gives_up_following_its_turns_and_says_so() {
    let studio = World::new();
    let (b, b_local, url, code) = offering(&studio, "studio").await;
    let b_id = b_local.hello().host.id.clone();
    let mini = World::new();
    let a = mini.daemon("mini", None);
    let (a_local, mut a_events) = local(&a).await;
    add_peer(&a_local, &url, code, "studio").await;
    let caller = new_session(&a_local, mini.dir.path()).await;
    call(
        &a_local,
        &mut a_events,
        &caller,
        "start_session",
        serde_json::json!({
            "host": "studio",
            "agentId": "fake",
            "cwd": studio.dir.path(),
            "prompt": "slow 200",
        }),
    )
    .await;
    a_local
        .send(weave_host_protocol::peers::RemovePeerRequest { host_id: b_id })
        .await
        .expect("peers/remove");
    let (_, text) = heard(&a, &caller, "can't follow").await;
    assert!(text.contains("no longer pairs with it"), "{text}");
    assert!(peers(&a_local, false).await.is_empty());
    let refused = call_fails(
        &a_local,
        &mut a_events,
        &caller,
        "list_sessions",
        serde_json::json!({"host": "studio"}),
    )
    .await;
    assert!(refused.contains("isn't paired with any"), "{refused}");
    b_local.shutdown().await;
    drop((a, b));
}

#[tokio::test]
async fn a_turn_a_peer_prompted_into_a_persons_thread_reaches_none_of_its_peers() {
    let laptop = World::new();
    let (c, c_local, c_url, c_code) = offering(&laptop, "laptop").await;
    let studio = World::new();
    let (b, b_local, b_url, b_code) = offering(&studio, "studio").await;
    add_peer(&b_local, &c_url, c_code, "laptop").await;
    let mini = World::new();
    let a = mini.daemon("mini", None);
    let (a_local, mut a_events) = local(&a).await;
    add_peer(&a_local, &b_url, b_code, "studio").await;

    // A thread the person runs on B reaches C itself.
    let (b_client, mut b_events) = local(&b).await;
    let theirs = new_session(&b_client, studio.dir.path()).await;
    call(
        &b_client,
        &mut b_events,
        &theirs,
        "list_sessions",
        serde_json::json!({"host": "laptop"}),
    )
    .await;

    // But not in a turn A's agent prompted.
    let caller = new_session(&a_local, mini.dir.path()).await;
    call(
        &a_local,
        &mut a_events,
        &caller,
        "prompt_session",
        serde_json::json!({
            "host": "studio",
            "sessionId": theirs,
            "prompt": r#"tool list_sessions {"host": "laptop"}"#,
        }),
    )
    .await;
    let (_, text) = heard(&a, &caller, "on studio finished its turn").await;
    assert!(
        text.contains("list_sessions failed") && text.contains("one hop"),
        "{text}"
    );

    // And in the person's next turn it does again.
    call(
        &b_client,
        &mut b_events,
        &theirs,
        "list_sessions",
        serde_json::json!({"host": "laptop"}),
    )
    .await;
    b_local.shutdown().await;
    c_local.shutdown().await;
    drop((a, b, c));
}
