//! Following threads from a script (WVE-108): `weave threads follow` observes one, without
//! being one of its clients, and `weave threads watch` prints every thread as it changes.

#![allow(clippy::expect_used)]

mod support;

use std::io::BufRead;
use std::io::BufReader;
use std::process::Child;
use std::process::Output;
use std::process::Stdio;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use std::time::Instant;

use pretty_assertions::assert_eq;
use weave_acp_core::schema::ContentBlock;
use weave_host_protocol::events::SessionEvent;
use weave_host_protocol::events::SessionEventNotification;
use weave_host_protocol::queue::AddQueuedRequest;
use weave_host_protocol::queue::AddQueuedResponse;
use weave_host_protocol::sessions::Activity;
use weave_host_protocol::sessions::CloseSessionRequest;
use weave_host_protocol::sessions::CreateSessionRequest;
use weave_host_protocol::sessions::GetSessionResponse;
use weave_host_protocol::sessions::RunResponse;
use weave_host_protocol::sessions::SessionListing;
use weave_host_protocol::sessions::SessionStatus;
use weave_host_protocol::turns::CancelTurnRequest;
use weave_host_protocol::turns::StartTurnRequest;

use crate::support::TestHost;

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// A headless thread, idle after one turn.
fn idle_thread(host: &TestHost) -> String {
    let output = host.weave(&["run", "--agent", "fake", "--detach", "--json", "hello"]);
    let run: RunResponse = serde_json::from_slice(&output.stdout).expect("session/run's answer");
    let id = run.session_id.to_string();
    wait_until(|| {
        let read = host.weave(&["threads", "read", &id, "--json"]);
        let read: GetSessionResponse = serde_json::from_slice(&read.stdout).expect("sessions/get");
        read.session.activity == Some(Activity::Idle)
            && read.latest_turn.is_some_and(|turn| !turn.running)
    });
    id
}

fn wait_until(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out");
        thread::sleep(Duration::from_millis(50));
    }
}

/// `child`'s stdout, a line at a time, as it comes.
fn lines(child: &mut Child) -> mpsc::Receiver<String> {
    let stdout = child.stdout.take().expect("piped stdout");
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { return };
            if sender.send(line).is_err() {
                return;
            }
        }
    });
    receiver
}

#[test]
fn following_a_prompts_turn_waits_for_it_and_exits_as_it_went() {
    let host = TestHost::start();
    let id = idle_thread(&host);
    for (prompt, status) in [("hello again", 0), ("stop refusal", 6)] {
        let queued = host.weave(&["threads", "prompt", &id, "--json", prompt]);
        let queued: AddQueuedResponse =
            serde_json::from_slice(&queued.stdout).expect("queue/add's answer");
        let after = queued.seq.saturating_sub(1).to_string();
        let followed = host.weave(&[
            "threads",
            "follow",
            &id,
            "--after",
            &after,
            "--until-turn-ends",
            "--json",
        ]);
        assert_eq!(
            followed.status.code(),
            Some(status),
            "{}",
            stderr(&followed)
        );
        let events: Vec<SessionEventNotification> = String::from_utf8_lossy(&followed.stdout)
            .lines()
            .map(|line| serde_json::from_str(line).expect("a session/event"))
            .collect();
        assert_eq!(events.first().map(|event| event.seq), Some(queued.seq));
        assert!(matches!(
            events.first().map(|event| &event.event),
            Some(SessionEvent::TurnStarted { .. })
        ));
        assert!(matches!(
            events.last().map(|event| &event.event),
            Some(SessionEvent::TurnEnded { .. })
        ));
    }
}

#[test]
fn a_follower_isnt_one_of_the_threads_clients() {
    let host = TestHost::start();
    let id = idle_thread(&host);
    let queued = host.weave(&["threads", "prompt", &id, "--json", "slow 400"]);
    let queued: AddQueuedResponse =
        serde_json::from_slice(&queued.stdout).expect("queue/add's answer");
    let after = queued.seq.saturating_sub(1).to_string();
    let mut follower = host
        .command(&["threads", "follow", &id, "--after", &after, "--json"])
        .stdout(Stdio::piped())
        .spawn()
        .expect("follow");
    let lines = lines(&mut follower);
    let first: SessionEventNotification =
        serde_json::from_str(&lines.recv_timeout(Duration::from_secs(10)).expect("a line"))
            .expect("a session/event");
    assert_eq!(first.seq, queued.seq);
    assert!(
        matches!(first.event, SessionEvent::TurnStarted { .. }),
        "{first:?}"
    );

    // Following, it isn't counted, and closing the thread ends it.
    let listed = host.weave(&["threads", "list", "--json"]);
    let listed: Vec<SessionListing> = serde_json::from_slice(&listed.stdout).expect("threads");
    let thread = listed
        .iter()
        .find(|thread| thread.info.session_id.to_string() == id)
        .expect("listed");
    assert_eq!(thread.clients, 0);
    host.weave(&["threads", "close", &id]);
    let output = follower.wait_with_output().expect("wait");
    assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
}

#[test]
fn following_a_thread_that_isnt_open_fails() {
    let host = TestHost::start();
    let id = idle_thread(&host);
    host.weave(&["threads", "close", &id]);
    let output = host.weave(&["threads", "follow", &id]);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        stderr(&output).contains("isn't open"),
        "{}",
        stderr(&output)
    );
}

#[test]
fn watching_prints_a_thread_as_it_starts_runs_waits_and_ends() {
    let host = TestHost::start();
    // Watching starts with the threads there are: this one says it has started.
    let earlier = idle_thread(&host);
    let mut watcher = host
        .command(&["threads", "watch"])
        .stdout(Stdio::piped())
        .spawn()
        .expect("watch");
    let lines = lines(&mut watcher);
    let first = lines
        .recv_timeout(Duration::from_secs(10))
        .expect("the threads there are");
    assert!(first.contains(&earlier), "{first}");

    // A thread whose policy asks the person: it runs a while, and then `write` waits on them
    // until it's cancelled.
    let (client, _events) = host.client();
    let session_id = host.block_on(async {
        let state = client
            .send(CreateSessionRequest {
                agent_id: "fake".to_owned(),
                cwd: host.work(),
                additional_directories: Vec::new(),
                mode: None,
                policy: None,
                trace: false,
            })
            .await
            .expect("session/create");
        client
            .send(StartTurnRequest {
                session_id: state.session_id.clone(),
                prompt: vec![ContentBlock::from("slow 3".to_owned())],
                key: None,
            })
            .await
            .expect("turn/start");
        client
            .send(AddQueuedRequest {
                session_id: state.session_id.clone(),
                prompt: vec![ContentBlock::from("write notes.txt hi".to_owned())],
                key: None,
                caller: None,
            })
            .await
            .expect("queue/add");
        state.session_id
    });

    let mut seen = Vec::new();
    let next = |seen: &mut Vec<(String, Option<Activity>, SessionStatus)>| {
        let line = lines
            .recv_timeout(Duration::from_secs(10))
            .unwrap_or_else(|_| panic!("no line after {seen:?}"));
        let value: serde_json::Value = serde_json::from_str(&line).expect("JSON");
        let method = value["method"].as_str().expect("a method").to_owned();
        assert_eq!(method, "sessions/updated", "{line}");
        let listing: SessionListing =
            serde_json::from_value(value["params"]["session"].clone()).expect("a listing");
        if listing.info.session_id == session_id {
            seen.push((method, listing.activity, listing.state));
        }
    };
    let saw = |seen: &[(String, Option<Activity>, SessionStatus)], activity| {
        seen.iter().any(|(_, seen, _)| *seen == Some(activity))
    };
    while !saw(&seen, Activity::Waiting) {
        next(&mut seen);
    }
    assert!(saw(&seen, Activity::Running), "{seen:?}");

    host.block_on(async {
        client
            .send(CancelTurnRequest {
                session_id: session_id.clone(),
            })
            .await
            .expect("turn/cancel");
    });
    while !saw(&seen, Activity::Idle) {
        next(&mut seen);
    }
    host.block_on(async {
        client
            .send(CloseSessionRequest {
                session_id: session_id.clone(),
            })
            .await
            .expect("session/close");
    });
    while !seen
        .iter()
        .any(|(_, _, state)| *state == SessionStatus::Closed)
    {
        next(&mut seen);
    }
    watcher.kill().expect("kill");
    watcher.wait().expect("wait");
}
