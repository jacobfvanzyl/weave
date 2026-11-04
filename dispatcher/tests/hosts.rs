//! A Host's agents reaching the person's other Hosts through the Dispatcher (ADR 0029,
//! WVE-185): two or three in-process Hosts on loopback WebSockets, each with a home of its own,
//! paired with one Dispatcher, their agents the fake agent calling Host tools with its `tool`
//! script. The specs are the Host protocol's "Other Hosts" and the Dispatcher's "Calls from
//! Hosts' agents" sections.

#![allow(clippy::expect_used)]

mod common;

use std::path::Path;
use std::time::Duration;

use pretty_assertions::assert_eq;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::task::JoinHandle;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::PermissionOptionId;
use weave_acp_core::schema::RequestPermissionOutcome;
use weave_acp_core::schema::RequestPermissionResponse;
use weave_acp_core::schema::SelectedPermissionOutcome;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::SessionUpdate;
use weave_acp_core::schema::StopReason;
use weave_acp_core::schema::ToolKind;
use weave_dispatcher::Dispatcher;
use weave_host_client::HostConnection;
use weave_host_client::HostEvent;
use weave_host_client::HostHandle;
use weave_host_protocol::dispatcher::AddHostRequest;
use weave_host_protocol::errors;
use weave_host_protocol::events::SessionEvent;
use weave_host_protocol::hello::ClientCapabilities;
use weave_host_protocol::pending::AnswerPendingRequest;
use weave_host_protocol::policy::PermissionPolicy;
use weave_host_protocol::policy::Unapproved;
use weave_host_protocol::queue::AddQueuedRequest;
use weave_host_protocol::sessions::AttachSessionRequest;
use weave_host_protocol::sessions::CreateSessionRequest;
use weave_host_protocol::sessions::GetSessionRequest;
use weave_host_protocol::sessions::GetSessionResponse;
use weave_host_protocol::sessions::ListSessionsRequest;
use weave_host_protocol::sessions::SessionListing;
use weave_host_protocol::sessions::TurnOrigin;

use crate::common::ISOLATED_GIT;
use crate::common::WAIT;
use crate::common::World;
use crate::common::host_until;
use crate::common::info;
use crate::common::start;

/// A Dispatcher from a directory of its own, answering on its socket.
struct Running {
    dir: tempfile::TempDir,
    dispatcher: Dispatcher,
    serving: JoinHandle<()>,
}

impl Running {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let (dispatcher, serving) = start(dir.path());
        Self {
            dir,
            dispatcher,
            serving,
        }
    }

    /// Pair with `world`'s Host as `name`, and wait until it's connected there and reaches the
    /// person's Hosts for it: the Host's id.
    async fn pair(&self, world: &World, name: &str) -> String {
        let host = self
            .dispatcher
            .add_host(AddHostRequest {
                url: world.url(),
                code: world.offer().await,
                name: Some(name.to_owned()),
            })
            .await
            .expect("hosts/add");
        host_until(&self.dispatcher, &host.host_id, |host| host.connected).await;
        host.host_id
    }

    async fn stop(self) -> tempfile::TempDir {
        self.dispatcher.stop().await;
        self.serving.abort();
        let _ = self.serving.await;
        self.dir
    }

    /// Stop, and start another Dispatcher from the same directory.
    async fn restart(self) -> Self {
        let dir = self.stop().await;
        let (dispatcher, serving) = start(dir.path());
        Self {
            dir,
            dispatcher,
            serving,
        }
    }
}

async fn local(world: &World) -> (HostConnection, UnboundedReceiver<HostEvent>) {
    HostConnection::connect(
        world.daemon.connect_in_process(),
        info("weave"),
        ClientCapabilities::default(),
    )
    .await
    .expect("a local client")
}

fn host_id(local: &HostConnection) -> String {
    local.hello().host.id.clone()
}

async fn new_session(local: &HostConnection, cwd: &Path) -> SessionId {
    new_session_with(local, cwd, None).await
}

async fn new_session_with(
    local: &HostConnection,
    cwd: &Path,
    policy: Option<PermissionPolicy>,
) -> SessionId {
    local
        .send(CreateSessionRequest {
            agent_id: "fake".to_owned(),
            cwd: cwd.to_path_buf(),
            additional_directories: Vec::new(),
            mode: None,
            policy,
            trace: false,
            labels: Vec::new(),
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
/// what its agent said in it. Reports start turns of their own, before or after it.
async fn said(
    local: &HostHandle,
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
            origin: None,
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
    let said = said(
        &local.handle(),
        events,
        caller,
        format!("tool {tool} {arguments}"),
    )
    .await;
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
    let said = said(
        &local.handle(),
        events,
        caller,
        format!("tool {tool} {arguments}"),
    )
    .await;
    failure(&said, tool)
}

fn failure(said: &str, tool: &str) -> String {
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

/// The first report to `session_id` on `world`'s Host whose text has `needle`: its origin and
/// text. Reads the session's journal from its start, as an observer, so a report that came
/// while the test looked elsewhere, steered into a running turn or queued, counts.
async fn heard(world: &World, session_id: &SessionId, needle: &str) -> (TurnOrigin, String) {
    let reports = reports(world, session_id, Some(needle)).await;
    reports
        .into_iter()
        .find(|(_, text)| text.contains(needle))
        .expect("the report")
}

/// The reports to `session_id` so far, or until one has `until`.
async fn reports(
    world: &World,
    session_id: &SessionId,
    until: Option<&str>,
) -> Vec<(TurnOrigin, String)> {
    let (observer, mut events) = local(world).await;
    // A session that isn't open, as after a restart, is until a report takes it up.
    let deadline = tokio::time::Instant::now() + WAIT;
    let attached = loop {
        match observer
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
            Ok(attached) => break attached,
            Err(error) => {
                assert!(
                    errors::is(&error, errors::SESSION_NOT_OPEN)
                        && tokio::time::Instant::now() < deadline,
                    "session/attach: {error:?}"
                );
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    };
    let head = attached.state.journal.head;
    let mut reports = Vec::new();
    let found = tokio::time::timeout(WAIT, async {
        loop {
            let Some(HostEvent::Event(notification)) = events.recv().await else {
                continue;
            };
            let seq = notification.seq;
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
                let done = until.is_some_and(|needle| text.contains(needle));
                reports.push((origin, text));
                if done {
                    return;
                }
            }
            if until.is_none() && seq >= head {
                return;
            }
        }
    })
    .await;
    observer.shutdown().await;
    if found.is_err() && until.is_some() {
        panic!("no report with {until:?} in time; heard {reports:#?}");
    }
    reports
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

async fn listed(local: &HostConnection) -> Vec<SessionListing> {
    local
        .send(ListSessionsRequest::default())
        .await
        .expect("sessions/list")
        .sessions
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

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_starts_a_thread_on_another_host_and_hears_how_its_turn_ended() {
    let mini = World::new().await;
    let studio = World::new().await;
    let running = Running::new();
    let a_id = running.pair(&mini, "mini").await;
    let b_id = running.pair(&studio, "studio").await;
    let (a_local, mut a_events) = local(&mini).await;
    let (b_local, _b_events) = local(&studio).await;
    assert_eq!(host_id(&a_local), a_id);

    // A's agent sees B among the person's Hosts, and what agents B runs.
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
    assert_eq!(hosts["hosts"][0]["name"], "studio");
    assert_eq!(hosts["hosts"][0]["hostId"], b_id);
    assert_eq!(hosts["hosts"][0]["connected"], true);
    assert_eq!(hosts["hosts"].as_array().map(Vec::len), Some(1));
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

    // B runs it: its turn's origin names A's thread and A.
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
    let (origin, text) = heard(&mini, &caller, "waiting on a person").await;
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

    // Its turn ends on B, and A's agent hears how, once.
    let (_, text) = heard(&mini, &caller, "finished its turn").await;
    assert!(text.contains("on studio finished its turn"), "{text}");
    assert_eq!(
        std::fs::read_to_string(&target)
            .expect("written")
            .trim_end(),
        "hello"
    );
    let waited = reports(&mini, &caller, None)
        .await
        .into_iter()
        .filter(|(_, text)| text.contains("waiting on a person"))
        .count();
    assert_eq!(waited, 1);

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

    // Naming its own Host, by id, acts here; by name, says to leave it out.
    let here = call(
        &a_local,
        &mut a_events,
        &caller,
        "list_sessions",
        serde_json::json!({"host": a_id}),
    )
    .await;
    assert!(here.to_string().contains(&caller.to_string()), "{here}");
    let refused = call_fails(
        &a_local,
        &mut a_events,
        &caller,
        "list_sessions",
        serde_json::json!({"host": "mini"}),
    )
    .await;
    assert!(refused.contains("this thread's own Host"), "{refused}");
    let refused = call_fails(
        &a_local,
        &mut a_events,
        &caller,
        "list_sessions",
        serde_json::json!({"host": "laptop"}),
    )
    .await;
    assert!(
        refused.contains("reaches no Host laptop") && refused.contains("studio"),
        "{refused}"
    );
    a_local.shutdown().await;
    b_local.shutdown().await;
    running.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_prompts_steers_and_cancels_threads_on_another_host() {
    let mini = World::new().await;
    let studio = World::new().await;
    let running = Running::new();
    running.pair(&mini, "mini").await;
    running.pair(&studio, "studio").await;
    let (a_local, mut a_events) = local(&mini).await;
    let caller = new_session(&a_local, mini.dir.path()).await;

    // A thread the person runs on B, which A's agent finds and prompts.
    let (b_local, mut b_events) = local(&studio).await;
    let theirs = new_session(&b_local, studio.dir.path()).await;
    said(
        &b_local.handle(),
        &mut b_events,
        &theirs,
        "hello".to_owned(),
    )
    .await;
    let found = call(
        &a_local,
        &mut a_events,
        &caller,
        "list_sessions",
        serde_json::json!({"host": "studio"}),
    )
    .await;
    assert!(found.to_string().contains(&theirs.to_string()), "{found}");
    let queued = call(
        &a_local,
        &mut a_events,
        &caller,
        "prompt_session",
        serde_json::json!({"host": "studio", "sessionId": theirs, "prompt": "from mini"}),
    )
    .await;
    assert!(queued["queuedId"].is_string(), "{queued}");
    let (_, text) = heard(&mini, &caller, "You said: from mini").await;
    assert!(text.contains("on studio finished its turn"), "{text}");
    assert_eq!(get(&b_local, &theirs).await.session.started_by, None);

    // One it starts there runs long; it steers it, then cancels the turn.
    let started = call(
        &a_local,
        &mut a_events,
        &caller,
        "start_session",
        serde_json::json!({
            "host": "studio",
            "agentId": "fake",
            "cwd": studio.dir.path(),
            "prompt": "slow 400",
        }),
    )
    .await;
    let long = session_id(&started);
    let steered = call(
        &a_local,
        &mut a_events,
        &caller,
        "steer_session",
        serde_json::json!({"host": "studio", "sessionId": long, "prompt": "faster"}),
    )
    .await;
    assert_eq!(steered["outcome"], "steered", "{steered}");
    let (_, text) = heard(&mini, &caller, "You steered: faster").await;
    assert!(text.contains("on studio finished its turn"), "{text}");
    call(
        &a_local,
        &mut a_events,
        &caller,
        "prompt_session",
        serde_json::json!({"host": "studio", "sessionId": long, "prompt": "slow 400"}),
    )
    .await;
    call(
        &a_local,
        &mut a_events,
        &caller,
        "cancel_session_turn",
        serde_json::json!({"host": "studio", "sessionId": long}),
    )
    .await;
    let (_, text) = heard(&mini, &caller, "had its turn cancelled").await;
    assert!(text.contains("on studio had its turn cancelled"), "{text}");
    let latest = get(&b_local, &long).await.latest_turn.expect("a turn");
    assert_eq!(
        latest.response.map(|response| response.stop_reason),
        Some(StopReason::Cancelled)
    );
    a_local.shutdown().await;
    b_local.shutdown().await;
    running.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_thread_started_on_another_host_without_a_directory_works_in_the_same_checkout_there() {
    let mini = World::new().await;
    let studio = World::new().await;
    let running = Running::new();
    running.pair(&mini, "mini").await;
    running.pair(&studio, "studio").await;
    let (a_local, mut a_events) = local(&mini).await;
    let (b_local, _b_events) = local(&studio).await;

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
    a_local.shutdown().await;
    b_local.shutdown().await;
    running.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_call_to_another_host_fails_at_once_when_nothing_reaches_it() {
    let mini = World::new().await;
    let studio = World::new().await;
    let (a_local, mut a_events) = local(&mini).await;
    let caller = new_session(&a_local, mini.dir.path()).await;
    let start = serde_json::json!({
        "host": "studio",
        "agentId": "fake",
        "cwd": "~",
        "prompt": "hello",
    });

    // No Dispatcher reaches the person's Hosts from A.
    let refused = call_fails(
        &a_local,
        &mut a_events,
        &caller,
        "start_session",
        start.clone(),
    )
    .await;
    assert!(refused.contains("No Dispatcher reaches"), "{refused}");
    let refused = call_fails(
        &a_local,
        &mut a_events,
        &caller,
        "list_hosts",
        serde_json::json!({}),
    )
    .await;
    assert!(
        refused.contains("No Dispatcher reaches") && refused.contains(&host_id(&a_local)),
        "{refused}"
    );

    // One that can't reach B fails the call, leaving nothing to send it.
    let running = Running::new();
    running.pair(&mini, "mini").await;
    let b_id = running.pair(&studio, "studio").await;
    studio.relay.cut();
    host_until(&running.dispatcher, &b_id, |host| !host.connected).await;
    let refused = call_fails(
        &a_local,
        &mut a_events,
        &caller,
        "start_session",
        start.clone(),
    )
    .await;
    assert!(refused.contains("studio can't be reached now"), "{refused}");
    let refused = call_fails(
        &a_local,
        &mut a_events,
        &caller,
        "prompt_session",
        serde_json::json!({"host": "studio", "sessionId": "s-1", "prompt": "hello"}),
    )
    .await;
    assert!(refused.contains("studio can't be reached now"), "{refused}");
    let b = host_until(&running.dispatcher, &b_id, |_| true).await;
    assert_eq!(b.pending, 0);
    let hosts = call(
        &a_local,
        &mut a_events,
        &caller,
        "list_hosts",
        serde_json::json!({}),
    )
    .await;
    assert_eq!(hosts["hosts"][0]["connected"], false, "{hosts}");

    // Nor does one that is away.
    running.stop().await;
    let refused = call_fails(&a_local, &mut a_events, &caller, "start_session", start).await;
    assert!(
        refused.contains("Dispatcher isn't connected to this Host"),
        "{refused}"
    );
    studio.relay.resume();
    a_local.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_start_whose_answer_was_lost_lands_once_and_its_caller_is_told() {
    let mini = World::new().await;
    let studio = World::new().await;
    let running = Running::new();
    running.pair(&mini, "mini").await;
    let b_id = running.pair(&studio, "studio").await;
    let (a_local, mut a_events) = local(&mini).await;
    let (b_local, _b_events) = local(&studio).await;
    let caller = new_session(&a_local, mini.dir.path()).await;
    said(
        &a_local.handle(),
        &mut a_events,
        &caller,
        "hello".to_owned(),
    )
    .await;

    // B starts the thread, but its answer never comes back before the connection goes.
    studio.relay.deafen();
    let start = format!(
        "tool start_session {}",
        serde_json::json!({
            "host": "studio",
            "agentId": "fake",
            "cwd": studio.dir.path(),
            "prompt": "hello from the gap",
            "key": "k-gap",
        })
    );
    let asking = {
        let a_local = a_local.handle();
        let caller = caller.clone();
        tokio::spawn(async move { said(&a_local, &mut a_events, &caller, start).await })
    };
    let deadline = tokio::time::Instant::now() + WAIT;
    while !listed(&b_local)
        .await
        .iter()
        .any(|listing| listing.started_by.as_ref() == Some(&caller))
    {
        assert!(tokio::time::Instant::now() < deadline, "B never started it");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    studio.relay.cut();
    let said = asking.await.expect("the agent's turn");
    let failed = failure(&said, "start_session");
    assert!(
        failed.contains("studio stopped answering") && failed.contains("keeps asking"),
        "{failed}"
    );

    // Once the Dispatcher reaches B again it sends it again, under the same key: B starts
    // nothing new, and A's agent hears that it started, then how its turn ended.
    studio.relay.resume();
    host_until(&running.dispatcher, &b_id, |host| {
        host.connected && host.pending == 0
    })
    .await;
    let (_, text) = heard(&mini, &caller, "after all").await;
    assert!(text.contains("studio took the thread"), "{text}");
    let (origin, text) = heard(&mini, &caller, "finished its turn").await;
    assert!(text.contains("You said: hello from the gap"), "{text}");
    let TurnOrigin::Session {
        session_id: delegated,
        ..
    } = origin
    else {
        panic!("a thread's report: {origin:?}");
    };
    let started: Vec<SessionListing> = listed(&b_local)
        .await
        .into_iter()
        .filter(|listing| listing.started_by.as_ref() == Some(&caller))
        .collect();
    assert_eq!(started.len(), 1, "{started:#?}");
    assert_eq!(started[0].info.session_id, delegated);
    a_local.shutdown().await;
    b_local.shutdown().await;
    running.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hosts_agents_reach_other_hosts_one_hop_away() {
    let mini = World::new().await;
    let studio = World::new().await;
    let laptop = World::new().await;
    let running = Running::new();
    running.pair(&mini, "mini").await;
    running.pair(&studio, "studio").await;
    running.pair(&laptop, "laptop").await;
    let (a_local, mut a_events) = local(&mini).await;
    let caller = new_session(&a_local, mini.dir.path()).await;

    // A thread A's agent starts on B reaches no third Host.
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
    let (_, text) = heard(&mini, &caller, "on studio finished its turn").await;
    assert!(
        text.contains("list_sessions failed") && text.contains("one hop"),
        "{text}"
    );

    // Nor does a thread that one starts on B in turn.
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
    heard(&studio, &middle, "finished its turn").await;
    let (b_local, mut b_events) = local(&studio).await;
    let derived = listed(&b_local)
        .await
        .into_iter()
        .find(|listing| listing.started_by.as_ref() == Some(&middle))
        .expect("the thread B's thread started");
    let latest = get(&b_local, &derived.info.session_id)
        .await
        .latest_turn
        .expect("its turn");
    let message = latest.message.unwrap_or_default();
    assert!(
        message.contains("list_sessions failed") && message.contains("one hop"),
        "{message}"
    );

    // B's own threads reach the laptop.
    let own = new_session(&b_local, studio.dir.path()).await;
    call(
        &b_local,
        &mut b_events,
        &own,
        "list_sessions",
        serde_json::json!({"host": "laptop"}),
    )
    .await;
    a_local.shutdown().await;
    b_local.shutdown().await;
    running.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_thread_on_another_host_approves_nothing_its_caller_doesnt() {
    let mini = World::new().await;
    let studio = World::new().await;
    let running = Running::new();
    running.pair(&mini, "mini").await;
    running.pair(&studio, "studio").await;
    let (a_local, mut a_events) = local(&mini).await;
    let (b_local, _b_events) = local(&studio).await;
    let within = PermissionPolicy {
        approve: vec![ToolKind::Read],
        otherwise: Unapproved::Ask,
    };
    let caller = new_session_with(&a_local, mini.dir.path(), Some(within.clone())).await;

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
    a_local.shutdown().await;
    b_local.shutdown().await;
    running.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn threads_on_other_hosts_count_toward_the_delegation_limit() {
    let mini = World::new().await;
    mini.configure("running = 1\n");
    let studio = World::new().await;
    let running = Running::new();
    running.pair(&mini, "mini").await;
    running.pair(&studio, "studio").await;
    let (a_local, mut a_events) = local(&mini).await;
    let caller = new_session(&a_local, mini.dir.path()).await;
    let slow = serde_json::json!({
        "host": "studio",
        "agentId": "fake",
        "cwd": studio.dir.path(),
        "prompt": "slow 400",
    });
    let first = call(
        &a_local,
        &mut a_events,
        &caller,
        "start_session",
        slow.clone(),
    )
    .await;

    // One runs on B, so another there may not start.
    let refused = call_fails(
        &a_local,
        &mut a_events,
        &caller,
        "start_session",
        slow.clone(),
    )
    .await;
    assert!(refused.contains("[delegation] running"), "{refused}");

    // Once it's over, another may; and one running here keeps one from starting there.
    call(
        &a_local,
        &mut a_events,
        &caller,
        "cancel_session_turn",
        serde_json::json!({"host": "studio", "sessionId": session_id(&first)}),
    )
    .await;
    heard(&mini, &caller, "had its turn cancelled").await;
    call(
        &a_local,
        &mut a_events,
        &caller,
        "start_session",
        serde_json::json!({"agentId": "fake", "prompt": "slow 400"}),
    )
    .await;
    let refused = call_fails(&a_local, &mut a_events, &caller, "start_session", slow).await;
    assert!(refused.contains("[delegation] running"), "{refused}");
    a_local.shutdown().await;
    running.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_dispatcher_follows_turns_again_after_it_restarts() {
    let mini = World::new().await;
    let studio = World::new().await;
    let running = Running::new();
    running.pair(&mini, "mini").await;
    let b_id = running.pair(&studio, "studio").await;
    let (a_local, mut a_events) = local(&mini).await;
    let (b_local, _b_events) = local(&studio).await;
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
            "prompt": "slow 20",
        }),
    )
    .await;
    let delegated = session_id(&started);

    // The Dispatcher stops while B's turn runs, and it ends while nothing follows it.
    let dir = running.stop().await;
    let deadline = tokio::time::Instant::now() + WAIT;
    while !get(&b_local, &delegated)
        .await
        .latest_turn
        .is_some_and(|turn| turn.state.is_over())
    {
        assert!(
            tokio::time::Instant::now() < deadline,
            "B's turn never ended"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // Another Dispatcher from its directory follows it again, and A's agent hears how it went.
    let (dispatcher, serving) = start(dir.path());
    let running = Running {
        dir,
        dispatcher,
        serving,
    };
    let (origin, _) = heard(&mini, &caller, "on studio finished its turn").await;
    assert_eq!(
        origin,
        TurnOrigin::Session {
            session_id: delegated,
            host: Some(b_id),
            host_name: Some("studio".to_owned()),
            report: true,
        }
    );
    let running = running.restart().await;
    let told = reports(&mini, &caller, None)
        .await
        .into_iter()
        .filter(|(_, text)| text.contains("finished its turn"))
        .count();
    assert_eq!(told, 1);
    a_local.shutdown().await;
    b_local.shutdown().await;
    running.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_turn_its_host_stops_under_is_followed_into_its_continuation() {
    let mini = World::new().await;
    let mut studio = World::with_journals().await;
    let running = Running::new();
    running.pair(&mini, "mini").await;
    let b_id = running.pair(&studio, "studio").await;
    let (a_local, mut a_events) = local(&mini).await;
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
            "prompt": "slow 400",
            "otherwise": "reject",
        }),
    )
    .await;
    let delegated = session_id(&started);
    let asking = call(
        &a_local,
        &mut a_events,
        &caller,
        "start_session",
        serde_json::json!({
            "host": "studio",
            "agentId": "fake",
            "cwd": studio.dir.path(),
            "prompt": "slow 400",
        }),
    )
    .await;

    // B stops under both turns; the headless thread continues its own when B starts again,
    // and the one that asks a person isn't taken up, so its turn won't go on.
    studio.restart().await;
    host_until(&running.dispatcher, &b_id, |host| host.connected).await;
    let (_, text) = heard(&mini, &caller, "stopped with its Host").await;
    assert!(
        text.contains(&session_id(&asking).to_string()) && text.contains("won't go on"),
        "{text}"
    );
    let (origin, text) = heard(&mini, &caller, "on studio finished its turn").await;
    assert!(text.contains("The weave Host stopped"), "{text}");
    assert_eq!(
        origin,
        TurnOrigin::Session {
            session_id: delegated,
            host: Some(b_id),
            host_name: Some("studio".to_owned()),
            report: true,
        }
    );
    a_local.shutdown().await;
    running.stop().await;
}
