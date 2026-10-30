//! What `weave` prints with `--json` is the Host protocol's own types, so scripts read it as
//! the protocol defines it (WVE-108): each command's output parses as the type it claims.

#![allow(clippy::expect_used)]

mod support;

use std::process::Output;
use std::thread;
use std::time::Duration;
use std::time::Instant;

use pretty_assertions::assert_eq;
use serde::de::DeserializeOwned;
use weave_host_protocol::devices::Device;
use weave_host_protocol::events::SessionEvent;
use weave_host_protocol::events::SessionEventNotification;
use weave_host_protocol::host::HostStatus;
use weave_host_protocol::host::Service;
use weave_host_protocol::queue::AddQueuedResponse;
use weave_host_protocol::sessions::Activity;
use weave_host_protocol::sessions::GetSessionResponse;
use weave_host_protocol::sessions::RunResponse;
use weave_host_protocol::sessions::SessionListing;
use weave_host_protocol::turns::SteerOutcome;
use weave_host_protocol::turns::SteerTurnResponse;

use crate::support::TestHost;
use crate::support::weave_command;

/// `output`'s stdout as `T`, once it exited with `status`.
fn parsed<T: DeserializeOwned>(output: &Output, status: i32) -> T {
    assert_eq!(
        output.status.code(),
        Some(status),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|error| panic!("{error}: {}", String::from_utf8_lossy(&output.stdout)))
}

#[test]
fn daemon_status_is_the_hosts_status() {
    let host = TestHost::start();
    let status: HostStatus = parsed(&host.weave(&["daemon", "status", "--json"]), 0);
    assert_eq!(status.service, Service::InProcess);
    assert_eq!(status.pid, std::process::id());
}

#[test]
fn daemon_status_prints_nothing_when_the_host_isnt_running() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = weave_command(
        dir.path(),
        &dir.path().join("host"),
        dir.path(),
        &["daemon", "status", "--json"],
    )
    .output()
    .expect("run weave");
    assert_eq!(output.status.code(), Some(3));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("isn't running"));
}

#[test]
fn a_run_prints_its_threads_journal_events() {
    let host = TestHost::start();
    let output = host.weave(&["run", "--agent", "fake", "--json", "hello"]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let events: Vec<SessionEventNotification> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| serde_json::from_str(line).expect("a session/event"))
        .collect();
    assert!(
        events
            .iter()
            .any(|event| matches!(event.event, SessionEvent::TurnStarted { .. }))
    );
    assert!(matches!(
        events.last().map(|event| &event.event),
        Some(SessionEvent::TurnEnded { .. })
    ));
    let seqs: Vec<u64> = events.iter().map(|event| event.seq).collect();
    assert!(seqs.windows(2).all(|pair| pair[0] < pair[1]), "{seqs:?}");
}

#[test]
fn threads_and_their_turns_are_the_hosts_answers() {
    let host = TestHost::start();
    let run: RunResponse = parsed(
        &host.weave(&["run", "--agent", "fake", "--detach", "--json", "slow 400"]),
        0,
    );
    let id = run.session_id.to_string();

    let listed: Vec<SessionListing> = parsed(&host.weave(&["threads", "list", "--json"]), 0);
    assert!(
        listed
            .iter()
            .any(|thread| thread.info.session_id == run.session_id)
    );
    let read: GetSessionResponse = parsed(&host.weave(&["threads", "read", &id, "--json"]), 0);
    assert_eq!(read.session.info.session_id, run.session_id);

    // The detached turn still runs, so a prompt waits for it and a steer joins it.
    let queued: AddQueuedResponse = parsed(
        &host.weave(&["threads", "prompt", &id, "--json", "next"]),
        0,
    );
    assert!(!queued.started);
    let steered: SteerTurnResponse = parsed(
        &host.weave(&["threads", "steer", &id, "--json", "and this"]),
        0,
    );
    assert_eq!(steered.outcome, SteerOutcome::Steered);

    // Cancelled, its queue pauses with `next` in it, and there's nothing to steer.
    host.weave(&["threads", "cancel", &id]);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let read: GetSessionResponse = parsed(&host.weave(&["threads", "read", &id, "--json"]), 0);
        let ended = read.latest_turn.as_ref().is_some_and(|turn| !turn.running);
        if read.session.activity == Some(Activity::Idle) && ended {
            break;
        }
        assert!(Instant::now() < deadline, "still busy: {read:?}");
        thread::sleep(Duration::from_millis(50));
    }
    let steered: SteerTurnResponse =
        parsed(&host.weave(&["threads", "steer", &id, "--json", "late"]), 1);
    assert_eq!(steered.outcome, SteerOutcome::NotRunning);
}

#[test]
fn devices_are_the_hosts_listing() {
    let host = TestHost::start();
    let devices: Vec<Device> = parsed(&host.weave(&["devices", "list", "--json"]), 0);
    assert!(devices.is_empty());
}
