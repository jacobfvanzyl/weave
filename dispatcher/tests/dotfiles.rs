//! End-to-end dotfiles sync (ADR 0037, WVE-243): Dispatcher bare git mirror, incremental
//! content-addressed transfer across chunks, file-level symlinks, Stow root ignores, seamless
//! local-checkout auto-detection, per-Host mode overrides, automatic polling, locked-credential
//! cached fallback, and clear.

#![allow(clippy::expect_used)]

mod common;

use std::future::Future;
use std::path::Path;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use pretty_assertions::assert_eq;
use tokio::sync::Notify;
use weave_dispatcher::Clock;
use weave_dispatcher::Dispatcher;
use weave_host_protocol::dispatcher::ClearDotfilesRequest;
use weave_host_protocol::dispatcher::CredentialKind;
use weave_host_protocol::dispatcher::DOTFILES_FEATURE;
use weave_host_protocol::dispatcher::DotfilesStatusRequest;
use weave_host_protocol::dispatcher::SetDotfilesHostRequest;
use weave_host_protocol::dispatcher::SetDotfilesRequest;
use weave_host_protocol::dispatcher::SyncDotfilesRequest;
use weave_host_protocol::dotfiles::DotfilesActiveMode;
use weave_host_protocol::dotfiles::DotfilesMode;
use weave_host_protocol::dotfiles::MAX_CHUNK_BYTES;
use weave_host_protocol::dotfiles::PlanDotfilesRequest;
use weave_host_protocol::errors;

use crate::common::ISOLATED_GIT;
use crate::common::WAIT;
use crate::common::World;
use crate::common::ask;
use crate::common::start;
use crate::common::start_with;

struct TestClock {
    now: AtomicU64,
    moved: Notify,
}

impl TestClock {
    fn new(start_ms: u64) -> Self {
        Self {
            now: AtomicU64::new(start_ms),
            moved: Notify::new(),
        }
    }

    fn advance(&self, delta_ms: u64) {
        self.now.fetch_add(delta_ms, Ordering::SeqCst);
        self.moved.notify_waiters();
    }
}

impl Clock for TestClock {
    fn now(&self) -> u64 {
        self.now.load(Ordering::SeqCst)
    }

    fn wait_until(&self, at: u64) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            while self.now() < at {
                self.moved.notified().await;
            }
        })
    }
}

fn run_git(dir: &Path, args: &[&str]) -> String {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    for (k, v) in ISOLATED_GIT {
        cmd.env(k, v);
    }
    let out = cmd.output().expect("git");
    assert!(
        out.status.success(),
        "git {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

/// Create a bare remote repo and a working checkout pushed to `main`, returning `(bare, work)`.
fn make_dotfiles_repos(root: &Path) -> (PathBuf, PathBuf) {
    let bare = root.join("remote.git");
    let work = root.join("work");
    std::fs::create_dir_all(&bare).expect("bare");
    std::fs::create_dir_all(&work).expect("work");
    run_git(&bare, &["init", "--bare", "--initial-branch=main"]);
    run_git(&work, &["init", "--initial-branch=main"]);
    run_git(
        &work,
        &["remote", "add", "origin", bare.to_str().expect("utf8")],
    );
    (bare, work)
}

fn commit_and_push(work: &Path, message: &str) -> String {
    run_git(work, &["add", "-A"]);
    run_git(work, &["commit", "-m", message]);
    run_git(work, &["push", "-u", "origin", "main"]);
    run_git(work, &["rev-parse", "HEAD"])
}

async fn wait_for_host_dotfiles(
    dispatcher: &Dispatcher,
    host_name: &str,
    predicate: impl Fn(&weave_host_protocol::dispatcher::DotfilesHostStatus) -> bool,
) -> weave_host_protocol::dispatcher::DotfilesHostStatus {
    tokio::time::timeout(WAIT, async {
        loop {
            if let Ok(status) = dispatcher.dotfiles_status()
                && let Some(host) = status.hosts.into_iter().find(|h| h.host_name == host_name)
                && predicate(&host)
            {
                return host;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("dotfiles host status in time")
}

#[tokio::test(flavor = "multi_thread")]
async fn syncs_git_dotfiles_incrementally_detects_local_authoring_and_clears() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let dispatcher_dir = tmp.path();
    let (bare, work) = make_dotfiles_repos(tmp.path());

    // Initial commit: shell config, nested config, ssh config, executable script, symlink, large
    // (> 512 KiB) file forcing multi-chunk upload, and Stow-ignored root metadata.
    std::fs::write(work.join(".zshrc"), b"export EDITOR=nvim\n").expect("zshrc");
    std::fs::create_dir_all(work.join(".config/nvim")).expect("nvim dir");
    std::fs::write(work.join(".config/nvim/init.lua"), b"vim.g.leader = ' '\n").expect("init.lua");
    std::fs::create_dir_all(work.join(".ssh")).expect("ssh dir");
    std::fs::write(work.join(".ssh/config"), b"Host demo\n  User jaco\n").expect("ssh cfg");
    std::fs::create_dir_all(work.join("bin")).expect("bin dir");
    let script = work.join("bin/hello");
    std::fs::write(&script, b"#!/bin/sh\necho hello\n").expect("script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }
    std::fs::create_dir_all(work.join(".config/kanata")).expect("kanata dir");
    #[cfg(unix)]
    std::os::unix::fs::symlink("../../kanata.kbd", work.join(".config/kanata/kanata.kbd"))
        .expect("symlink");
    // > MAX_CHUNK_BYTES file to exercise multi-chunk put + SHA-256 verification.
    let big_bytes = vec![b'A'; MAX_CHUNK_BYTES + 4096];
    std::fs::write(work.join(".config/big.dat"), &big_bytes).expect("big");
    // Root metadata files Stow skips by default.
    std::fs::write(work.join("README.md"), b"# My dotfiles\n").expect("readme");
    std::fs::write(work.join(".gitignore"), b"*.log\n").expect("gitignore");
    std::fs::write(work.join(".DS_Store"), b"junk").expect("ds_store");
    let commit1 = commit_and_push(&work, "initial dotfiles");

    let (dispatcher, serving) = start(dispatcher_dir);

    // Host 1 ("cloud"): empty home -> should auto-sync all 6 non-ignored entries.
    let cloud = World::new().await;
    // Pre-existing local file inside `.config/zsh/local.zsh` must remain untouched.
    std::fs::create_dir_all(cloud.home().join(".config/zsh")).expect("local zsh dir");
    std::fs::write(
        cloud.home().join(".config/zsh/local.zsh"),
        b"export LOCAL=1\n",
    )
    .expect("local.zsh");
    cloud.join(&dispatcher, dispatcher_dir, "cloud").await;
    cloud
        .dispatcher_until(|d| d.is_some_and(|d| d.connected))
        .await;

    // Host 2 ("mac"): already has `~/.dotfiles` cloned from the same bare repo -> auto-detects as
    // `local` authoring Host!
    let mac = World::new().await;
    let mac_dotfiles = mac.home().join(".dotfiles");
    run_git(
        &mac.home(),
        &[
            "clone",
            bare.to_str().expect("utf8"),
            mac_dotfiles.to_str().expect("utf8"),
        ],
    );
    // Make an uncommitted change and 1 local commit ahead on Mac to verify status reporting.
    std::fs::write(mac_dotfiles.join(".zshrc"), b"export EDITOR=vim\n").expect("mac edit");
    run_git(&mac_dotfiles, &["add", ".zshrc"]);
    run_git(&mac_dotfiles, &["commit", "-m", "local mac commit"]);
    let mac_head = run_git(&mac_dotfiles, &["rev-parse", "HEAD"]);
    std::fs::write(mac_dotfiles.join("untracked-local.txt"), b"wip").expect("dirty");
    mac.join(&dispatcher, dispatcher_dir, "mac").await;
    mac.dispatcher_until(|d| d.is_some_and(|d| d.connected))
        .await;

    // Non-Dispatcher client calling `dotfiles/plan` directly on a Host is forbidden.
    let local_client = cloud.local().await;
    let err = local_client
        .send(PlanDotfilesRequest::default())
        .await
        .expect_err("non-dispatcher refused");
    assert!(errors::is(&err, errors::FORBIDDEN), "{err}");
    local_client.shutdown().await;

    // Configure via Dispatcher API (`dotfiles/set`) and check `DOTFILES_FEATURE` on hello.
    let client = ask(dispatcher_dir).await;
    assert!(client.hello().offers(DOTFILES_FEATURE));
    let status = client
        .send(SetDotfilesRequest {
            repo: bare.display().to_string(),
            branch: Some("main".into()),
            git_credential: None,
            poll_interval_secs: Some(0),
        })
        .await
        .expect("dotfiles/set");
    assert_eq!(status.settings.commit.as_deref(), Some(commit1.as_str()));
    assert_eq!(status.settings.fetch_error, None);

    let cloud_status = status
        .hosts
        .iter()
        .find(|h| h.host_name == "cloud")
        .expect("cloud host");
    assert_eq!(cloud_status.active_mode, Some(DotfilesActiveMode::Synced));
    assert_eq!(cloud_status.commit.as_deref(), Some(commit1.as_str()));
    assert_eq!(cloud_status.linked, 6);
    assert!(cloud_status.conflicts.is_empty());

    // Verify cloud `$HOME` files & permissions.
    assert_eq!(
        std::fs::read(cloud.home().join(".zshrc")).expect("zshrc"),
        b"export EDITOR=nvim\n"
    );
    assert_eq!(
        std::fs::read(cloud.home().join(".config/big.dat")).expect("big"),
        big_bytes
    );
    assert_eq!(
        std::fs::read(cloud.home().join(".config/zsh/local.zsh")).expect("local.zsh"),
        b"export LOCAL=1\n"
    );
    assert!(!cloud.home().join("README.md").exists());
    assert!(!cloud.home().join(".gitignore").exists());
    assert!(!cloud.home().join(".DS_Store").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(
            std::fs::metadata(cloud.home().join(".ssh"))
                .expect("ssh dir")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(cloud.home().join(".ssh/config"))
                .expect("ssh cfg")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(cloud.home().join("bin/hello"))
                .expect("bin")
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
    }

    // Verify mac auto-detected as `local`, untouched, reporting commit + ahead + dirty!
    let mac_status = status
        .hosts
        .iter()
        .find(|h| h.host_name == "mac")
        .expect("mac host");
    assert_eq!(mac_status.active_mode, Some(DotfilesActiveMode::Local));
    assert_eq!(mac_status.local_path.as_deref(), Some("~/.dotfiles"));
    assert_eq!(mac_status.commit.as_deref(), Some(mac_head.as_str()));
    assert_eq!(mac_status.ahead, Some(1));
    assert!(mac_status.dirty);
    assert!(!mac.home().join(".zshrc").exists());

    // Push commit 2: modify `.zshrc`, remove `.config/big.dat`, add `.tmux.conf`.
    std::fs::write(work.join(".zshrc"), b"export EDITOR=hx\n").expect("edit zshrc");
    std::fs::remove_file(work.join(".config/big.dat")).expect("rm big");
    std::fs::write(work.join(".tmux.conf"), b"set -g mouse on\n").expect("tmux");
    let commit2 = commit_and_push(&work, "update zshrc and tmux");

    let status2 = client
        .send(SyncDotfilesRequest {})
        .await
        .expect("dotfiles/sync");
    assert_eq!(status2.settings.commit.as_deref(), Some(commit2.as_str()));
    let cloud_status2 = status2
        .hosts
        .iter()
        .find(|h| h.host_name == "cloud")
        .expect("cloud");
    assert_eq!(cloud_status2.commit.as_deref(), Some(commit2.as_str()));
    assert_eq!(cloud_status2.linked, 6);
    assert_eq!(cloud_status2.removed, 1);
    assert_eq!(
        std::fs::read(cloud.home().join(".zshrc")).expect("updated zshrc"),
        b"export EDITOR=hx\n"
    );
    assert!(!cloud.home().join(".config/big.dat").exists());
    assert_eq!(
        std::fs::read(cloud.home().join(".tmux.conf")).expect("tmux"),
        b"set -g mouse on\n"
    );

    // Override `cloud` to `off` -> unlinks all 6 managed symlinks, keeps local.zsh.
    let off = client
        .send(SetDotfilesHostRequest {
            host: "cloud".into(),
            mode: DotfilesMode::Off,
        })
        .await
        .expect("setHost off");
    let cloud_off = off
        .hosts
        .iter()
        .find(|h| h.host_name == "cloud")
        .expect("cloud off");
    assert_eq!(cloud_off.configured_mode, DotfilesMode::Off);
    assert_eq!(cloud_off.active_mode, Some(DotfilesActiveMode::Off));
    assert_eq!(cloud_off.removed, 6);
    assert!(!cloud.home().join(".zshrc").exists());
    assert!(cloud.home().join(".config/zsh/local.zsh").exists());

    // Switch `cloud` back to `auto` -> re-links all 6.
    let back = client
        .send(SetDotfilesHostRequest {
            host: "cloud".into(),
            mode: DotfilesMode::Auto,
        })
        .await
        .expect("setHost auto");
    let cloud_back = back
        .hosts
        .iter()
        .find(|h| h.host_name == "cloud")
        .expect("cloud back");
    assert_eq!(cloud_back.active_mode, Some(DotfilesActiveMode::Synced));
    assert_eq!(cloud_back.linked, 6);
    assert!(cloud.home().join(".zshrc").exists());

    // Clear dotfiles config -> unlinks `cloud`, leaves `mac` `~/.dotfiles` untouched.
    let cleared = client
        .send(ClearDotfilesRequest {})
        .await
        .expect("dotfiles/clear");
    assert_eq!(cleared.settings.repo, None);
    assert!(!cloud.home().join(".zshrc").exists());
    assert!(mac_dotfiles.join(".zshrc").exists());
    let _ = client.send(DotfilesStatusRequest {}).await.expect("status");

    client.shutdown().await;
    dispatcher.stop().await;
    serving.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn polls_automatically_on_clock_and_serves_cached_snapshot_while_locked() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let dispatcher_dir = tmp.path();
    let (bare, work) = make_dotfiles_repos(tmp.path());

    std::fs::write(work.join(".zshrc"), b"v1\n").expect("v1");
    let commit1 = commit_and_push(&work, "v1");

    let clock = Arc::new(TestClock::new(1_000_000));
    let (dispatcher, serving) = start_with(dispatcher_dir, Arc::clone(&clock) as Arc<dyn Clock>);

    // Unlock credentials and store a dummy token credential attached to dotfiles.
    dispatcher
        .unlock_credentials("correct horse battery staple".into(), true)
        .await
        .expect("unlock");
    dispatcher
        .set_credential("git-personal", CredentialKind::Token, None, "dummy-token")
        .expect("cred");

    let host1 = World::new().await;
    host1.join(&dispatcher, dispatcher_dir, "host1").await;
    host1
        .dispatcher_until(|d| d.is_some_and(|d| d.connected))
        .await;

    dispatcher
        .set_dotfiles(SetDotfilesRequest {
            repo: bare.display().to_string(),
            branch: Some("main".into()),
            git_credential: Some(Some("git-personal".into())),
            poll_interval_secs: Some(60),
        })
        .await
        .expect("set_dotfiles");
    assert_eq!(
        std::fs::read(host1.home().join(".zshrc")).expect("v1"),
        b"v1\n"
    );

    // Lock credentials: a newly joining Host still receives the cached v1 snapshot!
    dispatcher.lock_credentials().expect("lock");
    let host2 = World::new().await;
    host2.join(&dispatcher, dispatcher_dir, "host2").await;
    host2
        .dispatcher_until(|d| d.is_some_and(|d| d.connected))
        .await;
    let host2_status = wait_for_host_dotfiles(&dispatcher, "host2", |h| {
        h.commit.as_deref() == Some(commit1.as_str())
    })
    .await;
    assert_eq!(host2_status.active_mode, Some(DotfilesActiveMode::Synced));
    assert_eq!(
        std::fs::read(host2.home().join(".zshrc")).expect("v1"),
        b"v1\n"
    );

    // Push commit 2 and advance the clock while locked -> fetch records locked error, hosts keep v1.
    std::fs::write(work.join(".zshrc"), b"v2\n").expect("v2");
    let commit2 = commit_and_push(&work, "v2");
    clock.advance(61_000);
    tokio::time::timeout(WAIT, async {
        loop {
            if dispatcher
                .dotfiles_status()
                .ok()
                .and_then(|s| s.settings.fetch_error)
                .is_some()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("locked fetch error recorded");

    // Unlock credentials -> poller wakes immediately, fetches commit 2, and syncs both Hosts!
    dispatcher
        .unlock_credentials("correct horse battery staple".into(), false)
        .await
        .expect("re-unlock");
    let _ = wait_for_host_dotfiles(&dispatcher, "host1", |h| {
        h.commit.as_deref() == Some(commit2.as_str())
    })
    .await;
    let _ = wait_for_host_dotfiles(&dispatcher, "host2", |h| {
        h.commit.as_deref() == Some(commit2.as_str())
    })
    .await;
    assert_eq!(
        std::fs::read(host1.home().join(".zshrc")).expect("v2"),
        b"v2\n"
    );
    assert_eq!(
        std::fs::read(host2.home().join(".zshrc")).expect("v2"),
        b"v2\n"
    );

    // Push commit 3 and advance the clock while unlocked -> automatic poll picks it up!
    std::fs::write(work.join(".zshrc"), b"v3\n").expect("v3");
    let commit3 = commit_and_push(&work, "v3");
    clock.advance(61_000);
    let _ = wait_for_host_dotfiles(&dispatcher, "host1", |h| {
        h.commit.as_deref() == Some(commit3.as_str())
    })
    .await;
    assert_eq!(
        std::fs::read(host1.home().join(".zshrc")).expect("v3"),
        b"v3\n"
    );

    dispatcher.stop().await;
    serving.abort();
}
