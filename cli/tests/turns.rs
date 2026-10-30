//! Waiting for a turn from a script, with what WVE-108 borrowed from A2A: a turn goes by its
//! prompt's id, `threads prompt --wait` waits for it, waiting stops when it waits on a person
//! (7) or at `--timeout` (8) with the turn going on, and `--key` makes a retry safe.

#![allow(clippy::expect_used)]

mod support;

use std::process::Output;

use pretty_assertions::assert_eq;
use tokio::sync::mpsc::UnboundedReceiver;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::SessionId;
use weave_host_client::HostConnection;
use weave_host_client::HostEvent;
use weave_host_protocol::events::SessionEvent;
use weave_host_protocol::events::SessionEventNotification;
use weave_host_protocol::queue::AddQueuedResponse;
use weave_host_protocol::sessions::CreateSessionRequest;
use weave_host_protocol::sessions::GetSessionResponse;
use weave_host_protocol::sessions::RunResponse;
use weave_host_protocol::sessions::SessionListing;
use weave_host_protocol::sessions::TurnState;
use weave_host_protocol::turns::CancelTurnRequest;
use weave_host_protocol::turns::StartTurnRequest;

use crate::support::TestHost;

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn status(output: &Output) -> Option<i32> {
    output.status.code()
}

/// `output`'s JSON lines, as journal events.
fn events(output: &Output) -> Vec<SessionEventNotification> {
    stdout(output)
        .lines()
        .map(|line| serde_json::from_str(line).expect("a session/event"))
        .collect()
}

/// The id of the turn whose start `events` begin with.
fn started_turn(events: &[SessionEventNotification]) -> Option<String> {
    match events.first().map(|event| &event.event) {
        Some(SessionEvent::TurnStarted { turn_id, .. }) => turn_id.clone(),
        _ => None,
    }
}

/// A headless thread, open and idle after one turn.
fn idle_thread(host: &TestHost) -> String {
    let output = host.weave(&["run", "--agent", "fake", "--detach", "--json", "hello"]);
    let run: RunResponse = serde_json::from_slice(&output.stdout).expect("session/run's answer");
    let id = run.session_id.to_string();
    let turn = run.turn_id.expect("the turn's id");
    let waited = host.weave(&["threads", "follow", &id, "--turn", &turn]);
    assert_eq!(status(&waited), Some(0), "{}", stderr(&waited));
    id
}

/// A thread whose policy asks the person, held open by a client that never answers, and idle
/// after a first turn.
fn asking_thread(host: &TestHost) -> (HostConnection, UnboundedReceiver<HostEvent>, SessionId) {
    let (client, mut events) = host.client();
    let session_id = host.block_on(async {
        let session_id = client
            .send(CreateSessionRequest {
                agent_id: "fake".to_owned(),
                cwd: host.work(),
                additional_directories: Vec::new(),
                mode: None,
                policy: None,
                trace: false,
            })
            .await
            .expect("session/create")
            .session_id;
        client
            .send(StartTurnRequest {
                session_id: session_id.clone(),
                prompt: vec![ContentBlock::from("hello".to_owned())],
                key: None,
            })
            .await
            .expect("turn/start");
        loop {
            match events.recv().await.expect("an event") {
                HostEvent::Event(event)
                    if matches!(event.event, SessionEvent::TurnEnded { .. }) =>
                {
                    break;
                }
                _ => {}
            }
        }
        session_id
    });
    (client, events, session_id)
}

fn read(host: &TestHost, id: &str, turn: &str) -> GetSessionResponse {
    let output = host.weave(&["threads", "read", id, "--turn", turn, "--json"]);
    assert_eq!(status(&output), Some(0), "{}", stderr(&output));
    serde_json::from_slice(&output.stdout).expect("sessions/get")
}

#[test]
fn a_prompts_id_is_its_turns_which_follow_waits_for_or_prints_once_ended() {
    let host = TestHost::start();
    let id = idle_thread(&host);
    let queued = host.weave(&["threads", "prompt", &id, "--json", "hello again"]);
    let queued: AddQueuedResponse =
        serde_json::from_slice(&queued.stdout).expect("queue/add's answer");
    let turn = queued.queued_id;
    for _ in 0..2 {
        let followed = host.weave(&["threads", "follow", &id, "--turn", &turn, "--json"]);
        assert_eq!(status(&followed), Some(0), "{}", stderr(&followed));
        let events = events(&followed);
        assert_eq!(started_turn(&events).as_ref(), Some(&turn));
        assert!(matches!(
            events.last().map(|event| &event.event),
            Some(SessionEvent::TurnEnded { .. })
        ));
    }
    let got = read(&host, &id, &turn);
    let latest = got.latest_turn.expect("the turn");
    assert_eq!(latest.state, TurnState::Ended);
    assert_eq!(latest.message.as_deref(), Some("You said: hello again"));

    let unknown = host.weave(&["threads", "read", &id, "--turn", "q-none"]);
    assert_eq!(status(&unknown), Some(1));
    assert!(
        stderr(&unknown).contains("has no turn q-none"),
        "{}",
        stderr(&unknown)
    );
}

#[test]
fn prompting_and_waiting_prints_the_reply_and_exits_as_the_turn_went() {
    let host = TestHost::start();
    let id = idle_thread(&host);
    let answered = host.weave(&["threads", "prompt", &id, "--wait", "hello again"]);
    assert_eq!(status(&answered), Some(0), "{}", stderr(&answered));
    assert_eq!(stdout(&answered).trim(), "You said: hello again");
    let refused = host.weave(&["threads", "prompt", &id, "--wait", "stop refusal"]);
    assert_eq!(status(&refused), Some(6), "{}", stderr(&refused));
}

#[test]
fn a_turn_waiting_on_a_person_stops_the_wait_with_7_and_goes_on() {
    let host = TestHost::start();
    let (client, _events, session_id) = asking_thread(&host);
    let id = session_id.to_string();
    let waited = host.weave(&[
        "threads",
        "prompt",
        &id,
        "--wait",
        "--json",
        "write notes.txt hi",
    ]);
    assert_eq!(status(&waited), Some(7), "{}", stderr(&waited));
    assert!(
        stderr(&waited).contains("waiting on a person"),
        "{}",
        stderr(&waited)
    );
    let turn = started_turn(&events(&waited)).expect("the turn's id");
    assert_eq!(
        read(&host, &id, &turn)
            .latest_turn
            .map(|latest| latest.state),
        Some(TurnState::Waiting)
    );

    // Following it again stops at once, unless asked to wait on.
    let followed = host.weave(&["threads", "follow", &id, "--turn", &turn]);
    assert_eq!(status(&followed), Some(7), "{}", stderr(&followed));
    let waited_on = host.weave(&[
        "threads",
        "follow",
        &id,
        "--turn",
        &turn,
        "--keep-waiting",
        "--timeout",
        "300ms",
    ]);
    assert_eq!(status(&waited_on), Some(8), "{}", stderr(&waited_on));

    host.block_on(async {
        client
            .send(CancelTurnRequest {
                session_id: session_id.clone(),
            })
            .await
            .expect("turn/cancel");
    });
    let cancelled = host.weave(&["threads", "follow", &id, "--turn", &turn]);
    assert_eq!(status(&cancelled), Some(5), "{}", stderr(&cancelled));
}

#[test]
fn a_timeout_stops_waiting_with_8_and_the_turn_goes_on() {
    let host = TestHost::start();
    let id = idle_thread(&host);
    let waited = host.weave(&[
        "threads",
        "prompt",
        &id,
        "--wait",
        "--json",
        "--timeout",
        "200ms",
        "slow 5",
    ]);
    assert_eq!(status(&waited), Some(8), "{}", stderr(&waited));
    let turn = started_turn(&events(&waited)).expect("the turn's id");
    assert!(
        stderr(&waited).contains(&format!("--turn {turn}")),
        "{}",
        stderr(&waited)
    );
    let followed = host.weave(&["threads", "follow", &id, "--turn", &turn]);
    assert_eq!(status(&followed), Some(0), "{}", stderr(&followed));
    assert!(
        stdout(&followed).contains("Chunk 5 of 5."),
        "{}",
        stdout(&followed)
    );

    // A run that stops waiting leaves its thread open, its turn running.
    let ran = host.weave(&["run", "--agent", "fake", "--timeout", "200ms", "slow 5"]);
    assert_eq!(status(&ran), Some(8), "{}", stderr(&ran));
    let listed = host.weave(&["threads", "list", "--activity", "running", "--json"]);
    let listed: Vec<SessionListing> = serde_json::from_slice(&listed.stdout).expect("threads");
    assert_eq!(listed.len(), 1, "{listed:?}");
}

#[test]
fn a_key_makes_prompting_or_running_again_safe() {
    let host = TestHost::start();
    let id = idle_thread(&host);
    let prompt = |extra: &[&str]| {
        let mut args = vec!["threads", "prompt", &id, "--key", "k-1"];
        args.extend_from_slice(extra);
        args.push("hello again");
        host.weave(&args)
    };
    let first: AddQueuedResponse =
        serde_json::from_slice(&prompt(&["--json"]).stdout).expect("queue/add's answer");
    let again: AddQueuedResponse =
        serde_json::from_slice(&prompt(&["--json"]).stdout).expect("queue/add's answer");
    assert_eq!(again, first);
    // Waiting for it with the same key follows the turn the first prompt started.
    let waited = prompt(&["--wait", "--json"]);
    assert_eq!(status(&waited), Some(0), "{}", stderr(&waited));
    assert_eq!(started_turn(&events(&waited)), Some(first.queued_id));

    // Run again with its key once its thread has closed, it says how the turn went.
    let run = |prompt: &str| host.weave(&["run", "--agent", "fake", "--key", "r-1", prompt]);
    let ran = run("hello");
    assert_eq!(status(&ran), Some(0), "{}", stderr(&ran));
    let rerun = run("hello");
    assert_eq!(status(&rerun), Some(0), "{}", stderr(&rerun));
    assert_eq!(stdout(&rerun).trim(), stdout(&ran).trim());
    let refused = run("stop refusal");
    assert_eq!(status(&refused), Some(1), "another prompt under the key");

    let detached = host.weave(&["run", "--agent", "fake", "--detach", "--json", "hello"]);
    let detached: RunResponse = serde_json::from_slice(&detached.stdout).expect("session/run");
    assert!(detached.turn_id.is_some());
}
