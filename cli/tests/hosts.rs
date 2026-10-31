//! `weave hosts` (WVE-109): pairing the person's Hosts with each other over SSH, both ways
//! unless told otherwise, with a stand-in for `ssh` that runs `weave` against another Host in
//! this process, as `ssh <computer> weave …` would run it there.

#![allow(clippy::expect_used)]

mod support;

use std::path::Path;
use std::path::PathBuf;
use std::process::Output;

use pretty_assertions::assert_eq;
use weave_host_protocol::peers::Peer;

use crate::support::TestHost;

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// An `ssh` that runs its command against the Host named by its destination, as `ssh -o
/// BatchMode=yes <destination> <command>` runs `<command>` there; any other destination can't
/// be reached.
fn fake_ssh(dir: &Path, hosts: &[(&str, &TestHost)]) -> PathBuf {
    let weave = Path::new(env!("CARGO_BIN_EXE_weave"))
        .parent()
        .expect("weave's directory");
    let cases: String = hosts
        .iter()
        .map(|(name, host)| {
            let root = host.dir.path();
            format!(
                "  {name}) export WEAVE_DAEMON_DIR='{}' XDG_CONFIG_HOME='{}' \
                 XDG_STATE_HOME='{}' ;;\n",
                host.paths.dir.display(),
                root.join("config").display(),
                root.join("state").display(),
            )
        })
        .collect();
    let script = format!(
        "#!/bin/sh\n\
         [ \"$1\" = -o ] && [ \"$2\" = BatchMode=yes ] || exit 2\n\
         case \"$3\" in\n{cases}  *) echo \"ssh: Could not resolve hostname $3\" >&2; exit 255 ;;\n\
         esac\n\
         export PATH='{}':\"$PATH\"\n\
         exec sh -c \"$4\"\n",
        weave.display()
    );
    let path = dir.join("ssh");
    std::fs::write(&path, script).expect("the stand-in ssh");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }
    path
}

fn listed(host: &TestHost) -> Vec<Peer> {
    let output = host.weave(&["hosts", "list", "--json", "--no-check"]);
    assert!(output.status.success(), "{}", stderr(&output));
    serde_json::from_slice(&output.stdout).expect("the Hosts as JSON")
}

fn host_id(host: &TestHost) -> String {
    let (connection, _) = host.client();
    let id = connection.hello().host.id.clone();
    host.block_on(connection.shutdown());
    id
}

#[test]
fn adding_a_host_over_ssh_pairs_both_ways() {
    let mini = TestHost::start_peer("mini");
    let studio = TestHost::start_peer("studio");
    let ssh = fake_ssh(mini.dir.path(), &[("studio", &studio)]);

    let output = mini
        .command(&["hosts", "add", "studio"])
        .env("WEAVE_SSH", &ssh)
        .output()
        .expect("weave hosts add");
    assert!(output.status.success(), "{}", stderr(&output));
    let said = stdout(&output);
    assert!(
        said.contains("Paired with studio") && said.contains("studio paired with this Host too"),
        "{said}"
    );

    // Each lists the other, this one by the name SSH reaches it by.
    let here = listed(&mini);
    assert_eq!(here.len(), 1);
    assert_eq!(here[0].name, "studio");
    assert_eq!(here[0].host_id, host_id(&studio));
    let there = listed(&studio);
    assert_eq!(there.len(), 1);
    assert_eq!(there[0].host_id, host_id(&mini));

    // And reaches it.
    let output = mini.weave(&["hosts"]);
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(stdout(&output).contains("studio") && stdout(&output).contains("reachable"));
}

#[test]
fn adding_a_host_one_way_leaves_it_unpaired_with_this_one() {
    let mini = TestHost::start_peer("mini");
    let studio = TestHost::start_peer("studio");
    let ssh = fake_ssh(mini.dir.path(), &[("me@studio", &studio)]);

    let output = mini
        .command(&["hosts", "add", "me@studio", "--one-way", "--json"])
        .env("WEAVE_SSH", &ssh)
        .output()
        .expect("weave hosts add");
    assert!(output.status.success(), "{}", stderr(&output));
    let peer: Peer = serde_json::from_slice(&output.stdout).expect("the Host as JSON");
    assert_eq!(peer.name, "studio");
    assert_eq!(listed(&mini).len(), 1);
    assert!(listed(&studio).is_empty());
}

#[test]
fn a_host_ssh_cannot_reach_is_said_so() {
    let mini = TestHost::start_peer("mini");
    let ssh = fake_ssh(mini.dir.path(), &[]);
    let output = mini
        .command(&["hosts", "add", "nowhere"])
        .env("WEAVE_SSH", &ssh)
        .output()
        .expect("weave hosts add");
    assert!(!output.status.success());
    let said = stderr(&output);
    assert!(
        said.contains("couldn't reach nowhere over SSH") && said.contains("Could not resolve"),
        "{said}"
    );
    assert!(listed(&mini).is_empty());
}

#[test]
fn a_host_is_added_with_the_url_and_code_weave_pair_shows_there() {
    let mini = TestHost::start_peer("mini");
    let studio = TestHost::start_peer("studio");
    let output = studio.weave(&["pair", "--json"]);
    assert!(output.status.success(), "{}", stderr(&output));
    let offered: serde_json::Value = serde_json::from_slice(&output.stdout).expect("JSON");
    let url = offered["url"].as_str().expect("a URL");
    let code = offered["code"].as_str().expect("a code");

    let output = mini.weave(&["hosts", "add", url, code, "--name", "box"]);
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(
        stdout(&output).contains("run `weave hosts add` there"),
        "{}",
        stdout(&output)
    );
    assert_eq!(listed(&mini)[0].name, "box");

    // Forgetting it leaves this Host among the other's devices, as it says.
    let output = mini.weave(&["hosts", "remove", "box"]);
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(stdout(&output).contains("weave devices revoke"));
    assert!(listed(&mini).is_empty());
}
