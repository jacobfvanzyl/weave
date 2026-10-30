//! `weave`'s exit statuses (`cli/src/exit.rs`): with no Host running, in a Host directory of
//! its own that nothing listens in, and for how a turn `weave run` waits on goes.

#![allow(clippy::expect_used)]

mod support;

use std::thread;
use std::time::Duration;
use std::time::Instant;

use pretty_assertions::assert_eq;
use weave_host_protocol::sessions::Activity;
use weave_host_protocol::sessions::SessionListing;

use crate::support::TestHost;
use crate::support::weave_command;

fn without_host(args: &[&str]) -> std::process::Output {
    let dir = tempfile::tempdir().expect("tempdir");
    weave_command(dir.path(), &dir.path().join("host"), dir.path(), args)
        .output()
        .expect("run weave")
}

#[test]
fn status_exits_3_when_the_host_isnt_running() {
    let output = without_host(&["daemon", "status"]);
    assert_eq!(output.status.code(), Some(3));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("isn't running"), "{stdout}");
}

#[test]
fn acting_on_a_thread_exits_3_when_the_host_isnt_running() {
    for args in [
        &["threads", "read", "s1"][..],
        &["threads", "prompt", "s1", "go"],
        &["threads", "steer", "s1", "go"],
        &["threads", "cancel", "s1"],
        &["threads", "close", "s1"],
    ] {
        let output = without_host(args);
        assert_eq!(output.status.code(), Some(3), "{args:?}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("isn't running"), "{args:?}: {stderr}");
    }
}

#[test]
fn listing_threads_with_no_host_finds_none_and_succeeds() {
    let output = without_host(&["threads", "list", "--json"]);
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "[]");
}

#[test]
fn arguments_clap_refuses_exit_2() {
    let output = without_host(&["threads", "--no-such-flag"]);
    assert_eq!(output.status.code(), Some(2));
}

#[test]
fn a_run_exits_with_how_its_turn_went() {
    let host = TestHost::start();
    for (prompt, status) in [
        ("hello", 0),
        ("fail", 4),
        ("stop refusal", 6),
        ("stop max-tokens", 6),
    ] {
        let output = host.weave(&["run", "--agent", "fake", prompt]);
        assert_eq!(
            output.status.code(),
            Some(status),
            "{prompt}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn a_run_whose_turn_is_cancelled_exits_5() {
    let host = TestHost::start();
    let running = host.command(&["run", "--agent", "fake", "slow 400"]);
    let running = thread::spawn(move || running_output(running));
    let session = wait_for_running(&host);
    let cancelled = host.weave(&["threads", "cancel", &session]);
    assert_eq!(cancelled.status.code(), Some(0));
    let output = running.join().expect("join");
    assert_eq!(
        output.status.code(),
        Some(5),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn a_run_that_loses_the_host_exits_3() {
    let mut host = TestHost::start();
    let running = host.command(&["run", "--agent", "fake", "slow 400"]);
    let running = thread::spawn(move || running_output(running));
    wait_for_running(&host);
    host.lose();
    let output = running.join().expect("join");
    assert_eq!(
        output.status.code(),
        Some(3),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn running_output(mut command: std::process::Command) -> std::process::Output {
    command.output().expect("run weave")
}

/// The id of the thread running a turn, once one is.
fn wait_for_running(host: &TestHost) -> String {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let listed = host.weave(&["threads", "list", "--json"]);
        let threads: Vec<SessionListing> =
            serde_json::from_slice(&listed.stdout).expect("threads as JSON");
        if let Some(thread) = threads
            .iter()
            .find(|thread| thread.activity == Some(Activity::Running))
        {
            return thread.info.session_id.to_string();
        }
        assert!(Instant::now() < deadline, "no turn started: {threads:?}");
        thread::sleep(Duration::from_millis(50));
    }
}
