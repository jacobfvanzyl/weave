//! Newer versions of a session's agent (WVE-93): the Host's background lookup when a session
//! opens, `agents/update`, and `session/reopen`. The agent is the `claude` preset, which the
//! launcher runs as the fake agent whatever version it's asked for, noting each; npm is a stub.

#![allow(clippy::expect_used)]

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;

use agent_client_protocol::Channel;
use agent_client_protocol::Error;
use pretty_assertions::assert_eq;
use tokio::sync::Semaphore;
use tokio::sync::mpsc::UnboundedReceiver;
use weave_acp_core::AgentConnection;
use weave_acp_core::ClientOptions;
use weave_acp_core::Preset;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::SessionId;
use weave_agents::environment::Environment;
use weave_agents::lock::Lock;
use weave_agents::registry::Fetched;
use weave_agents::update::BoxFuture;
use weave_agents::update::Upstream;
use weave_fake_agent::FakeAgentConfig;
use weave_host::Daemon;
use weave_host::DaemonConfig;
use weave_host::Launch;
use weave_host::Launcher;
use weave_host::Withheld;
use weave_host_client::HostConnection;
use weave_host_client::HostEvent;
use weave_host_protocol::agents::UPDATES_FEATURE;
use weave_host_protocol::agents::UpdateAgentRequest;
use weave_host_protocol::agents::UpdateAvailableNotification;
use weave_host_protocol::events::SessionEvent;
use weave_host_protocol::hello::ClientCapabilities;
use weave_host_protocol::hello::ClientInfo;
use weave_host_protocol::host::Service;
use weave_host_protocol::sessions::AttachSessionRequest;
use weave_host_protocol::sessions::CreateSessionRequest;
use weave_host_protocol::sessions::ReopenSessionRequest;
use weave_host_protocol::sessions::SessionState;
use weave_host_protocol::turns::StartTurnRequest;

const WAIT: Duration = Duration::from_secs(10);
/// Long enough that something that would have happened, has.
const SETTLE: Duration = Duration::from_millis(300);

fn claude() -> &'static Preset {
    Preset::find("claude").expect("the claude preset")
}

/// npm as a test has it: `latest` for every package, each lookup waiting for a permit when
/// `slow`.
struct Npm {
    latest: Mutex<Result<String, String>>,
    lookups: AtomicUsize,
    slow: Option<Arc<Semaphore>>,
}

impl Upstream for Npm {
    fn latest<'a>(&'a self, _package: &'a str) -> BoxFuture<'a, anyhow::Result<String>> {
        Box::pin(async move {
            self.lookups.fetch_add(1, Ordering::SeqCst);
            if let Some(slow) = &self.slow {
                let _permit = slow.acquire().await;
            }
            self.latest
                .lock()
                .expect("lock")
                .clone()
                .map_err(|why| anyhow::anyhow!(why))
        })
    }

    fn catalog(&self) -> BoxFuture<'_, anyhow::Result<Fetched>> {
        Box::pin(async { anyhow::bail!("no registry here") })
    }
}

/// How the launcher treats versions.
#[derive(Default)]
struct Versions {
    /// Exit before `initialize`.
    broken: Vec<String>,
    /// Start with storage of their own, so they don't know the others' sessions.
    amnesiac: Vec<String>,
    /// Advertise only what every agent must, so no resume or load.
    minimal: bool,
}

struct World {
    dir: tempfile::TempDir,
    npm: Arc<Npm>,
    versions: Arc<Mutex<Versions>>,
    /// The command line of every agent started, in order.
    launched: Arc<Mutex<Vec<String>>>,
}

impl World {
    fn new(latest: Result<&str, &str>, slow: Option<Arc<Semaphore>>) -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("config.toml"),
            "[agents.fake]\ncommand = \"fake-agent\"\n",
        )
        .expect("config");
        Self {
            dir,
            npm: Arc::new(Npm {
                latest: Mutex::new(latest.map(str::to_owned).map_err(str::to_owned)),
                lookups: AtomicUsize::new(0),
                slow,
            }),
            versions: Arc::new(Mutex::new(Versions::default())),
            launched: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn daemon(&self) -> Daemon {
        let state: PathBuf = self.dir.path().join("agent-state.json");
        let elsewhere: PathBuf = self.dir.path().join("other-state.json");
        let versions = Arc::clone(&self.versions);
        let launched = Arc::clone(&self.launched);
        let launcher: Launcher = Arc::new(move |launch: &Launch, options: ClientOptions, _| {
            let command = launch.spec.display_command();
            launched.lock().expect("lock").push(command.clone());
            let versions = versions.lock().expect("lock");
            let has = |list: &[String]| list.iter().any(|version| command.ends_with(version));
            let broken = has(&versions.broken);
            let config = FakeAgentConfig {
                state_path: Some(if has(&versions.amnesiac) {
                    elsewhere.clone()
                } else {
                    state.clone()
                }),
                minimal: versions.minimal,
                ..FakeAgentConfig::default()
            };
            Box::pin(async move {
                if broken {
                    return Err(Error::internal_error().data("it exited"));
                }
                let (client, agent) = Channel::duplex();
                tokio::spawn(weave_fake_agent::serve_with(agent, config));
                AgentConnection::connect(client, options)
                    .await
                    .map_err(|error| Error::internal_error().data(error.to_string()))
            })
        });
        Daemon::new(DaemonConfig {
            journals: Some(self.dir.path().join("sessions")),
            idle_grace: Duration::from_secs(60),
            drain_timeout: weave_host::DEFAULT_DRAIN_TIMEOUT,
            blank_grace: Duration::from_secs(60),
            launcher,
            config_file: Some(self.dir.path().join("config.toml")),
            registry_cache: Some(self.dir.path().join("cache")),
            agents: Default::default(),
            withheld: Withheld::default(),
            environment: Environment::default(),
            service: Service::InProcess,
            traces: self.dir.path().join("traces"),
            devices: None,
            upstream: Arc::clone(&self.npm) as Arc<dyn Upstream>,
            mcp_socket: None,
            mcp_bridge: vec!["weave-mcp-bridge".to_owned()],
            remote: None,
            terminals: None,
        })
    }

    fn set_latest(&self, latest: &str) {
        *self.npm.latest.lock().expect("lock") = Ok(latest.to_owned());
    }

    fn lookups(&self) -> usize {
        self.npm.lookups.load(Ordering::SeqCst)
    }

    fn launched(&self) -> Vec<String> {
        self.launched.lock().expect("lock").clone()
    }

    fn lock(&self) -> Lock {
        Lock::read(&self.dir.path().join("agents.lock")).expect("a readable lock")
    }
}

fn spec_at(version: &str) -> String {
    claude().spec_at(version).display_command()
}

struct Client {
    connection: HostConnection,
    events: UnboundedReceiver<HostEvent>,
}

impl Client {
    async fn new(daemon: &Daemon) -> Self {
        let (connection, events) = HostConnection::connect(
            daemon.connect_in_process(),
            ClientInfo {
                name: "test".to_owned(),
                version: "0".to_owned(),
            },
            ClientCapabilities::default(),
        )
        .await
        .expect("connect");
        Self { connection, events }
    }

    async fn create(&self, world: &World, agent: &str) -> SessionState {
        self.connection
            .send(CreateSessionRequest {
                agent_id: agent.to_owned(),
                cwd: world.dir.path().to_path_buf(),
                additional_directories: Vec::new(),
                mode: None,
                policy: None,
                trace: false,
            })
            .await
            .expect("session/create")
    }

    async fn prompt(&self, session_id: &SessionId, text: &str) {
        self.connection
            .send(StartTurnRequest {
                session_id: session_id.clone(),
                prompt: vec![ContentBlock::from(text.to_owned())],
                key: None,
            })
            .await
            .expect("turn/start");
    }

    async fn next(&mut self) -> HostEvent {
        tokio::time::timeout(WAIT, self.events.recv())
            .await
            .expect("an event in time")
            .expect("connected")
    }

    /// The next update notice, passing over other events.
    async fn update_available(&mut self) -> UpdateAvailableNotification {
        loop {
            if let HostEvent::UpdateAvailable(notification) = self.next().await {
                return notification;
            }
        }
    }

    /// Journaled events until `until` says to stop, with their positions.
    async fn events_until(
        &mut self,
        mut until: impl FnMut(&SessionEvent) -> bool,
    ) -> Vec<(u64, SessionEvent)> {
        let mut seen = Vec::new();
        loop {
            if let HostEvent::Event(notification) = self.next().await {
                let done = until(&notification.event);
                seen.push((notification.seq, notification.event));
                if done {
                    return seen;
                }
            }
        }
    }

    async fn turn(&mut self, session_id: &SessionId, text: &str) -> Vec<(u64, SessionEvent)> {
        self.prompt(session_id, text).await;
        self.events_until(|event| matches!(event, SessionEvent::TurnEnded { .. }))
            .await
    }

    /// Nothing but what `ignore` lets pass arrives for a while.
    async fn quiet(&mut self, ignore: impl Fn(&HostEvent) -> bool) {
        let deadline = tokio::time::Instant::now() + SETTLE;
        while let Ok(Some(event)) = tokio::time::timeout_at(deadline, self.events.recv()).await {
            assert!(ignore(&event), "unexpected {event:?}");
        }
    }
}

fn is_reopened(event: &SessionEvent) -> bool {
    matches!(event, SessionEvent::AgentReopened { .. })
}

#[tokio::test]
async fn a_session_start_looks_once_an_hour_in_the_background_and_tells_every_client() {
    let slow = Arc::new(Semaphore::new(0));
    let world = World::new(Ok("99.0.0"), Some(Arc::clone(&slow)));
    let daemon = world.daemon();
    let mut first = Client::new(&daemon).await;
    assert!(
        first
            .connection
            .hello()
            .features
            .iter()
            .any(|feature| feature == UPDATES_FEATURE)
    );
    // npm hasn't answered, and the sessions open anyway.
    let one = first.create(&world, "claude").await;
    let mut second = Client::new(&daemon).await;
    let two = second.create(&world, "claude").await;
    assert_eq!(one.update, None);
    let release = one.agent.release.clone().expect("a preset's release");
    assert_eq!(
        (release.name.as_str(), release.version.as_str()),
        (claude().package, claude().version)
    );
    // Two sessions opened together share one lookup.
    tokio::time::timeout(WAIT, async {
        while world.lookups() == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("a lookup");
    slow.add_permits(10);
    for (client, session) in [(&mut first, &one), (&mut second, &two)] {
        let notice = client.update_available().await;
        assert_eq!(notice.session_id, session.session_id);
        assert_eq!(notice.update.agent_id, "claude");
        assert_eq!(notice.update.name, claude().package);
        assert_eq!(notice.update.running, claude().version);
        assert_eq!(notice.update.latest, "99.0.0");
    }
    assert_eq!(world.lookups(), 1);

    // A client attaching later finds it in the session's state, and the hour's lookup
    // serves another session start.
    let late = Client::new(&daemon).await;
    let attached = late
        .connection
        .send(AttachSessionRequest {
            session_id: one.session_id.clone(),
            after: None,
            agent_id: None,
            cwd: None,
            trace: false,
            observe: false,
        })
        .await
        .expect("session/attach");
    assert_eq!(
        attached.state.update.map(|update| update.latest).as_deref(),
        Some("99.0.0")
    );
    late.create(&world, "claude").await;
    tokio::time::sleep(SETTLE).await;
    assert_eq!(world.lookups(), 1);

    // Configured agents are the user's to update, and aren't looked up.
    let mut fake = Client::new(&daemon).await;
    let configured = fake.create(&world, "fake").await;
    assert_eq!(configured.agent.release, None);
    fake.quiet(|event| !matches!(event, HostEvent::UpdateAvailable(_)))
        .await;
    assert_eq!(world.lookups(), 1);
}

#[tokio::test]
async fn a_failed_lookup_or_no_newer_version_shows_nothing() {
    let world = World::new(Err("npm is down"), None);
    let daemon = world.daemon();
    let mut client = Client::new(&daemon).await;
    let state = client.create(&world, "claude").await;
    client
        .quiet(|event| !matches!(event, HostEvent::UpdateAvailable(_)))
        .await;
    assert_eq!(world.lookups(), 1);
    // The failure serves the hour too.
    client.create(&world, "claude").await;
    client
        .quiet(|event| !matches!(event, HostEvent::UpdateAvailable(_)))
        .await;
    assert_eq!(world.lookups(), 1);
    assert_eq!(state.update, None);

    // npm naming the version running is no update either.
    let current = World::new(Ok(claude().version), None);
    let daemon = current.daemon();
    let mut client = Client::new(&daemon).await;
    client.create(&current, "claude").await;
    client
        .quiet(|event| !matches!(event, HostEvent::UpdateAvailable(_)))
        .await;
    assert_eq!(current.lookups(), 1);
}

#[tokio::test]
async fn agents_update_locks_a_version_that_starts_and_nothing_else() {
    let world = World::new(Ok("99.0.0"), None);
    world.versions.lock().expect("lock").broken = vec!["@99.0.0".to_owned()];
    let daemon = world.daemon();
    let client = Client::new(&daemon).await;
    let update = |agent_id: &str| {
        client.connection.send(UpdateAgentRequest {
            agent_id: agent_id.to_owned(),
        })
    };

    let error = update("claude").await.expect_err("99.0.0 doesn't start");
    assert!(error.to_string().contains("doesn't start"), "{error}");
    assert_eq!(world.lock(), Lock::default(), "nothing changed");

    world.set_latest("98.0.0");
    let updated = update("claude").await.expect("agents/update");
    assert_eq!(updated.version, "98.0.0");
    assert_eq!(world.lock().version_of(claude()), "98.0.0");
    assert_eq!(
        world.launched(),
        [spec_at("99.0.0"), spec_at("98.0.0")],
        "each checked as it would run"
    );
    // New sessions start it.
    let state = client.create(&world, "claude").await;
    assert_eq!(
        state
            .agent
            .release
            .map(|release| release.version)
            .as_deref(),
        Some("98.0.0")
    );
    assert_eq!(world.launched().last(), Some(&spec_at("98.0.0")));
    // Already the newest: nothing to do, and it says so.
    let again = update("claude").await.expect("agents/update");
    assert_eq!(again.version, "98.0.0");

    let configured = update("fake").await.expect_err("a configured agent");
    assert!(
        configured.to_string().contains("yours to do"),
        "{configured}"
    );
}

#[tokio::test]
async fn an_idle_session_moves_to_the_new_version_keeping_its_id_and_journal() {
    let world = World::new(Ok("98.0.0"), None);
    let daemon = world.daemon();
    let mut client = Client::new(&daemon).await;
    let state = client.create(&world, "claude").await;
    let session_id = state.session_id.clone();
    client.turn(&session_id, "hello").await;
    client
        .connection
        .send(UpdateAgentRequest {
            agent_id: "claude".to_owned(),
        })
        .await
        .expect("agents/update");
    let reopened = client
        .connection
        .send(ReopenSessionRequest {
            session_id: session_id.clone(),
        })
        .await
        .expect("session/reopen");
    assert_eq!(reopened.version.as_deref(), Some("98.0.0"));
    let events = client.events_until(is_reopened).await;
    let Some((
        seq,
        SessionEvent::AgentReopened {
            agent,
            previous,
            failed,
            ..
        },
    )) = events.last().cloned()
    else {
        panic!("agentReopened");
    };
    assert_eq!(
        agent.release.map(|release| release.version).as_deref(),
        Some("98.0.0")
    );
    assert_eq!(
        previous.map(|release| release.version).as_deref(),
        Some(claude().version)
    );
    assert_eq!(failed, None);
    assert_eq!(world.launched().last(), Some(&spec_at("98.0.0")));

    // The same session and journal carry on, in the new process.
    client.turn(&session_id, "again").await;
    let later = Client::new(&daemon).await;
    let attached = later
        .connection
        .send(AttachSessionRequest {
            session_id: session_id.clone(),
            after: None,
            agent_id: None,
            cwd: None,
            trace: false,
            observe: false,
        })
        .await
        .expect("session/attach");
    assert_eq!(attached.state.journal.id, state.journal.id);
    assert!(attached.state.journal.head > seq);
    assert_eq!(
        attached
            .state
            .agent
            .release
            .map(|release| release.version)
            .as_deref(),
        Some("98.0.0")
    );
    assert_eq!(attached.state.update, None, "it runs the newest");
}

#[tokio::test]
async fn a_running_turn_holds_the_reopen_until_it_ends() {
    let world = World::new(Ok("98.0.0"), None);
    let daemon = world.daemon();
    let mut client = Client::new(&daemon).await;
    let session_id = client.create(&world, "claude").await.session_id;
    client
        .connection
        .send(UpdateAgentRequest {
            agent_id: "claude".to_owned(),
        })
        .await
        .expect("agents/update");
    client.prompt(&session_id, "/slow 5").await;
    let handle = client.connection.handle();
    let reopen = tokio::spawn({
        let session_id = session_id.clone();
        async move { handle.send(ReopenSessionRequest { session_id }).await }
    });
    tokio::time::sleep(SETTLE).await;
    assert!(!reopen.is_finished(), "it waits for the turn");
    let events = client.events_until(is_reopened).await;
    let ended = events
        .iter()
        .position(|(_, event)| matches!(event, SessionEvent::TurnEnded { .. }))
        .expect("the turn ended first");
    assert_eq!(ended, events.len() - 2, "then it moved");
    let reopened = tokio::time::timeout(WAIT, reopen)
        .await
        .expect("answered")
        .expect("joined")
        .expect("session/reopen");
    assert_eq!(reopened.version.as_deref(), Some("98.0.0"));
}

#[tokio::test]
async fn a_version_that_cant_take_the_session_up_gives_way_to_the_old_one() {
    let world = World::new(Ok("98.0.0"), None);
    world.versions.lock().expect("lock").amnesiac = vec!["@98.0.0".to_owned()];
    let daemon = world.daemon();
    let mut client = Client::new(&daemon).await;
    let session_id = client.create(&world, "claude").await.session_id;
    client.turn(&session_id, "hello").await;
    client
        .connection
        .send(UpdateAgentRequest {
            agent_id: "claude".to_owned(),
        })
        .await
        .expect("agents/update");
    let reopened = client
        .connection
        .send(ReopenSessionRequest {
            session_id: session_id.clone(),
        })
        .await
        .expect("session/reopen");
    assert_eq!(reopened.version.as_deref(), Some(claude().version));
    let events = client.events_until(is_reopened).await;
    let Some((_, SessionEvent::AgentReopened { agent, failed, .. })) = events.last().cloned()
    else {
        panic!("agentReopened");
    };
    assert_eq!(
        agent.release.map(|release| release.version).as_deref(),
        Some(claude().version)
    );
    assert!(
        failed
            .as_deref()
            .is_some_and(|failed| failed.starts_with("98.0.0 couldn't resume the thread")),
        "{failed:?}"
    );
    let launched = world.launched();
    assert_eq!(
        launched[launched.len() - 2..],
        [spec_at("98.0.0"), spec_at(claude().version)],
        "the new one, then the old one again"
    );
    // It carries on, on the old version.
    client.turn(&session_id, "still here").await;
}

#[tokio::test]
async fn a_blank_session_stays_as_it_was_with_nothing_to_move() {
    let world = World::new(Ok("98.0.0"), None);
    let daemon = world.daemon();
    let mut client = Client::new(&daemon).await;
    let session_id = client.create(&world, "claude").await.session_id;
    client
        .connection
        .send(UpdateAgentRequest {
            agent_id: "claude".to_owned(),
        })
        .await
        .expect("agents/update");
    let started = world.launched().len();
    let error = client
        .connection
        .send(ReopenSessionRequest {
            session_id: session_id.clone(),
        })
        .await
        .expect_err("nothing to move");
    assert!(error.to_string().contains("nothing to move"), "{error}");
    assert_eq!(world.launched().len(), started, "nothing started");
    // It carries on in the process it had.
    client.turn(&session_id, "hello").await;
    assert_eq!(world.launched().len(), started);
}

#[tokio::test]
async fn an_agent_that_cant_resume_or_load_keeps_its_process() {
    let world = World::new(Ok("98.0.0"), None);
    world.versions.lock().expect("lock").minimal = true;
    let daemon = world.daemon();
    let mut client = Client::new(&daemon).await;
    let session_id = client.create(&world, "claude").await.session_id;
    let started = world.launched().len();
    let error = client
        .connection
        .send(ReopenSessionRequest {
            session_id: session_id.clone(),
        })
        .await
        .expect_err("it can't move");
    assert!(error.to_string().contains("new threads"), "{error}");
    assert_eq!(world.launched().len(), started, "nothing started");
    client.turn(&session_id, "hello").await;
}
