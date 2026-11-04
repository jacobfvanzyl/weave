//! Following a turn into its successor (WVE-168): `weave run` and `weave threads follow --turn`
//! wait through a Host that stops under the turn, and end as the thread's continuation of it
//! ends; `weave threads follow` moves on to the thread a thread continues in.

#![allow(clippy::expect_used)]

mod support;

use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::process::Child;
use std::process::Stdio;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use std::time::Instant;

use weave_host_protocol::events::SessionEvent;
use weave_host_protocol::events::SessionEventNotification;
use weave_host_protocol::sessions::Activity;
use weave_host_protocol::sessions::GetSessionResponse;
use weave_host_protocol::sessions::RunResponse;

use crate::support::TestHost;

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

/// Lines from `lines` until one has `text`, and that one.
fn until(lines: &mpsc::Receiver<String>, text: &str) -> Vec<String> {
    let mut seen = Vec::new();
    loop {
        let line = lines
            .recv_timeout(Duration::from_secs(20))
            .unwrap_or_else(|_| panic!("no line with {text:?} in {seen:?}"));
        let found = line.contains(text);
        seen.push(line);
        if found {
            return seen;
        }
    }
}

/// `child`'s exit code and stderr, once it exits, within a while.
fn exited(mut child: Child) -> (Option<i32>, String) {
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(status) = child.try_wait().expect("wait") {
            break status;
        }
        assert!(Instant::now() < deadline, "it didn't exit");
        thread::sleep(Duration::from_millis(50));
    };
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stderr.take() {
        pipe.read_to_string(&mut stderr).expect("stderr");
    }
    (status.code(), stderr)
}

fn wait_until(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out");
        thread::sleep(Duration::from_millis(50));
    }
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

#[test]
fn a_run_the_host_stops_under_ends_as_its_continuation_does() {
    let mut host = TestHost::start();
    let mut run = host
        .command(&["run", "--agent", "fake", "slow 20"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("weave run");
    let lines = lines(&mut run);
    until(&lines, "Chunk 2 of 20.");

    host.restart();
    // The thread continues the turn, and the run prints the continuation's reply.
    until(&lines, "You said: [weave] The weave Host stopped");
    let (code, stderr) = exited(run);
    assert_eq!(code, Some(0), "{stderr}");
    assert!(stderr.contains("lost the weave Host"), "{stderr}");
    assert!(
        stderr.contains("the thread continued it in turn"),
        "{stderr}"
    );
}

#[test]
fn following_a_turn_the_host_stops_under_ends_as_its_continuation_does() {
    let mut host = TestHost::start();
    let output = host.weave(&["run", "--agent", "fake", "--detach", "--json", "slow 20"]);
    let run: RunResponse = serde_json::from_slice(&output.stdout).expect("session/run's answer");
    let id = run.session_id.to_string();
    let turn = run.turn_id.expect("the run's turn");
    let mut follower = host
        .command(&["threads", "follow", &id, "--turn", &turn])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("follow");
    let lines = lines(&mut follower);
    until(&lines, "Chunk 2 of 20.");

    host.restart();
    until(&lines, "You said: [weave] The weave Host stopped");
    let (code, stderr) = exited(follower);
    assert_eq!(code, Some(0), "{stderr}");
    assert!(
        stderr.contains(&format!("turn {turn} ran; the thread continued it")),
        "{stderr}"
    );
}

#[test]
fn following_a_thread_moves_on_to_its_successor() {
    let host = TestHost::start();
    let old = idle_thread(&host);
    let new = idle_thread(&host);
    let mut follower = host
        .command(&["threads", "follow", &old, "--json"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("follow");
    let lines = lines(&mut follower);
    // Following has begun once the thread's events reach it.
    let named = host.weave(&["threads", "set-successor", &old, &new]);
    assert!(named.status.success(), "{named:?}");
    let mut seen = Vec::new();
    let event = loop {
        let line = lines
            .recv_timeout(Duration::from_secs(20))
            .unwrap_or_else(|_| panic!("nothing of the successor in {seen:?}"));
        let event: SessionEventNotification = serde_json::from_str(&line).expect("a session/event");
        if event.session_id.to_string() == new {
            break event;
        }
        seen.push(line);
    };
    // From its start: its first turn's.
    assert!(
        matches!(event.event, SessionEvent::TurnStarted { .. }),
        "{event:?}"
    );
    let _ = follower.kill();
}
