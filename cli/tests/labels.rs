//! Labelling threads from a script (WVE-173): `weave run --label` starts a labelled thread,
//! `weave threads label` adds and takes off labels, and `weave threads list --label` finds them.

#![allow(clippy::expect_used)]

mod support;

use pretty_assertions::assert_eq;
use weave_host_protocol::sessions::RunResponse;
use weave_host_protocol::sessions::SessionListing;

use crate::support::TestHost;

fn listed(host: &TestHost, labels: &[&str]) -> Vec<String> {
    let mut args = vec!["threads", "list", "--json"];
    for label in labels {
        args.extend(["--label", label]);
    }
    let output = host.weave(&args);
    assert!(output.status.success(), "{output:?}");
    let sessions: Vec<SessionListing> =
        serde_json::from_slice(&output.stdout).expect("the listings");
    sessions
        .into_iter()
        .map(|session| session.info.session_id.to_string())
        .collect()
}

#[test]
fn threads_are_labelled_and_found_by_their_labels() {
    let host = TestHost::start();
    let output = host.weave(&[
        "run",
        "--agent",
        "fake",
        "--detach",
        "--json",
        "--label",
        "bot:daily",
        "hello",
    ]);
    let run: RunResponse = serde_json::from_slice(&output.stdout).expect("session/run's answer");
    let id = run.session_id.to_string();
    let other = host.weave(&["run", "--agent", "fake", "--detach", "--json", "hello"]);
    assert!(other.status.success(), "{other:?}");
    assert_eq!(listed(&host, &["bot:daily"]), std::slice::from_ref(&id));
    assert_eq!(listed(&host, &[]).len(), 2);

    let labelled = host.weave(&[
        "threads",
        "label",
        &id,
        "--add",
        "keep",
        "--remove",
        "bot:daily",
    ]);
    assert!(labelled.status.success(), "{labelled:?}");
    assert_eq!(String::from_utf8_lossy(&labelled.stdout), "keep\n");
    assert!(listed(&host, &["bot:daily"]).is_empty());
    assert_eq!(listed(&host, &["keep"]), std::slice::from_ref(&id));

    let text = host.weave(&["threads", "list", "--label", "keep"]);
    assert!(
        String::from_utf8_lossy(&text.stdout).contains("labelled keep"),
        "{text:?}"
    );
    let bad = host.weave(&["threads", "label", &id, "--add", "no spaces"]);
    assert!(!bad.status.success());
}
