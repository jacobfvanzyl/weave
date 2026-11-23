//! The person's credentials (ADR 0036, WVE-239): a passphrase set once, values that are read
//! only while unlocked and never answered to a client, a restart that locks, and a database
//! that gives up nothing.

#![allow(clippy::expect_used)]

mod common;

use pretty_assertions::assert_eq;
use weave_dispatcher::Dispatcher;
use weave_host_protocol::dispatcher::CREDENTIALS_FEATURE;
use weave_host_protocol::dispatcher::CredentialKind;
use weave_host_protocol::dispatcher::CredentialsState;
use weave_host_protocol::dispatcher::CredentialsStatusRequest;
use weave_host_protocol::dispatcher::ListCredentialsRequest;
use weave_host_protocol::dispatcher::LockCredentialsRequest;
use weave_host_protocol::dispatcher::RemoveCredentialRequest;
use weave_host_protocol::dispatcher::SetCredentialRequest;
use weave_host_protocol::dispatcher::UnlockCredentialsRequest;
use weave_host_protocol::errors;

use crate::common::ask;
use crate::common::dispatcher_config;
use crate::common::start;

const PASSPHRASE: &str = "correct horse battery staple";
const TOKEN: &str = "ghp_a-token-nobody-should-ever-read-back";
/// Claude Code's sign-in file, as far as the Dispatcher reads it.
const CLAUDE: &str = r#"{"claudeAiOauth":{"accessToken":"claude-access","refreshToken":"claude-renewal","expiresAt":4102444800000}}"#;
/// Codex's, whose access token says no expiry the Dispatcher can read.
const CODEX: &str = r#"{"auth_mode":"chatgpt","tokens":{"id_token":"id","access_token":"codex-access","refresh_token":"codex-renewal","account_id":"account"}}"#;

fn value(dispatcher: &Dispatcher, name: &str) -> Option<(CredentialKind, String)> {
    dispatcher
        .credential_value(name)
        .expect("readable")
        .map(|(kind, value)| (kind, value.to_string()))
}

#[tokio::test(flavor = "multi_thread")]
async fn credentials_are_read_only_while_unlocked() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (dispatcher, serving) = start(dir.path());

    // Nothing is kept before a passphrase is set.
    let status = dispatcher.credentials_status().expect("status");
    assert_eq!((status.state, status.count), (CredentialsState::Unset, 0));
    let refused = dispatcher
        .set_credential("git", CredentialKind::Token, None, TOKEN)
        .expect_err("locked");
    assert!(
        errors::is(&refused, errors::CREDENTIALS_LOCKED),
        "{refused}"
    );
    let refused = dispatcher
        .unlock_credentials(PASSPHRASE.to_owned(), false)
        .await
        .expect_err("no passphrase yet");
    assert!(
        errors::is(&refused, errors::CREDENTIALS_LOCKED),
        "{refused}"
    );
    let refused = dispatcher
        .unlock_credentials("too short".to_owned(), true)
        .await
        .expect_err("a short passphrase");
    assert!(refused.message.contains("at least 12"), "{refused}");

    let status = dispatcher
        .unlock_credentials(PASSPHRASE.to_owned(), true)
        .await
        .expect("set");
    assert_eq!(status.state, CredentialsState::Unlocked);
    let refused = dispatcher
        .unlock_credentials("another passphrase entirely".to_owned(), true)
        .await
        .expect_err("it has one");
    assert!(refused.message.contains("already"), "{refused}");

    let kept = dispatcher
        .set_credential("git", CredentialKind::Token, None, TOKEN)
        .expect("kept");
    assert_eq!(
        (kept.name.as_str(), kept.kind),
        ("git", CredentialKind::Token)
    );
    assert_eq!(
        value(&dispatcher, "git"),
        Some((CredentialKind::Token, TOKEN.to_owned()))
    );
    assert_eq!(value(&dispatcher, "none"), None);

    // Replacing keeps when it was first kept.
    let replaced = dispatcher
        .set_credential("git", CredentialKind::SignIn, Some("claude"), CLAUDE)
        .expect("replaced");
    assert_eq!(replaced.created_at, kept.created_at);
    assert_eq!(
        value(&dispatcher, "git"),
        Some((CredentialKind::SignIn, CLAUDE.to_owned()))
    );

    // Locked: named and removable, not readable or settable.
    let status = dispatcher.lock_credentials().expect("locked");
    assert_eq!((status.state, status.count), (CredentialsState::Locked, 1));
    let refused = dispatcher.credential_value("git").expect_err("locked");
    assert!(
        errors::is(&refused, errors::CREDENTIALS_LOCKED),
        "{refused}"
    );
    let refused = dispatcher
        .set_credential("other", CredentialKind::Token, None, TOKEN)
        .expect_err("locked");
    assert!(
        errors::is(&refused, errors::CREDENTIALS_LOCKED),
        "{refused}"
    );
    assert_eq!(
        dispatcher
            .credentials()
            .expect("listed")
            .into_iter()
            .map(|credential| credential.name)
            .collect::<Vec<_>>(),
        vec!["git"]
    );

    let refused = dispatcher
        .unlock_credentials("not the passphrase at all".to_owned(), false)
        .await
        .expect_err("a wrong passphrase");
    assert!(errors::is(&refused, errors::UNAUTHENTICATED), "{refused}");
    assert_eq!(
        dispatcher.credentials_status().expect("status").state,
        CredentialsState::Locked
    );
    dispatcher
        .unlock_credentials(PASSPHRASE.to_owned(), false)
        .await
        .expect("unlocked");
    assert_eq!(
        value(&dispatcher, "git"),
        Some((CredentialKind::SignIn, CLAUDE.to_owned()))
    );

    dispatcher.remove_credential("git").expect("removed");
    let refused = dispatcher.remove_credential("git").expect_err("gone");
    assert!(refused.message.contains("no credential"), "{refused}");
    dispatcher.stop().await;
    serving.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restart_locks_and_the_database_gives_up_nothing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (dispatcher, serving) = start(dir.path());
    dispatcher
        .unlock_credentials(PASSPHRASE.to_owned(), true)
        .await
        .expect("set");
    dispatcher
        .set_credential("git", CredentialKind::Token, None, TOKEN)
        .expect("kept");
    dispatcher.stop().await;
    serving.abort();
    let _ = serving.await;

    // Neither the value nor the passphrase is anywhere the Dispatcher wrote.
    let kept = dispatcher_config(dir.path()).paths.dir;
    for entry in std::fs::read_dir(&kept).expect("its directory") {
        let path = entry.expect("an entry").path();
        if !path.is_file() {
            continue;
        }
        let bytes = std::fs::read(&path).expect("read");
        for secret in [TOKEN, PASSPHRASE] {
            assert!(
                !bytes
                    .windows(secret.len())
                    .any(|window| window == secret.as_bytes()),
                "{} holds a secret in the clear",
                path.display()
            );
        }
    }

    let (dispatcher, serving) = start(dir.path());
    let status = dispatcher.credentials_status().expect("status");
    assert_eq!((status.state, status.count), (CredentialsState::Locked, 1));
    dispatcher
        .unlock_credentials(PASSPHRASE.to_owned(), false)
        .await
        .expect("unlocked");
    assert_eq!(
        value(&dispatcher, "git"),
        Some((CredentialKind::Token, TOKEN.to_owned()))
    );
    dispatcher.stop().await;
    serving.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_value_moved_to_another_name_does_not_open() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (dispatcher, serving) = start(dir.path());
    dispatcher
        .unlock_credentials(PASSPHRASE.to_owned(), true)
        .await
        .expect("set");
    dispatcher
        .set_credential("work", CredentialKind::Token, None, "the work token")
        .expect("kept");
    dispatcher
        .set_credential(
            "personal",
            CredentialKind::Token,
            None,
            "the personal token",
        )
        .expect("kept");

    // Someone with the database swaps one credential's sealed value for another's.
    let database = rusqlite::Connection::open(dispatcher_config(dir.path()).paths.database())
        .expect("the database");
    database
        .execute(
            "UPDATE credentials SET (nonce, sealed) =
                 (SELECT nonce, sealed FROM credentials WHERE name = 'work')
             WHERE name = 'personal'",
            [],
        )
        .expect("swapped");

    let refused = dispatcher.credential_value("personal").expect_err("moved");
    assert!(refused.message.contains("doesn't open"), "{refused}");
    assert_eq!(
        value(&dispatcher, "work"),
        Some((CredentialKind::Token, "the work token".to_owned()))
    );
    dispatcher.stop().await;
    serving.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_api_manages_credentials_and_never_answers_a_value() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (dispatcher, serving) = start(dir.path());
    let client = ask(dir.path()).await;
    assert!(client.hello().offers(CREDENTIALS_FEATURE));

    let status = client
        .send(CredentialsStatusRequest {})
        .await
        .expect("status");
    assert_eq!(status.state, CredentialsState::Unset);
    let status = client
        .send(UnlockCredentialsRequest {
            passphrase: PASSPHRASE.to_owned(),
            create: true,
        })
        .await
        .expect("set");
    assert_eq!(status.state, CredentialsState::Unlocked);

    let kept = client
        .send(SetCredentialRequest {
            name: "git".to_owned(),
            kind: CredentialKind::Token,
            value: TOKEN.to_owned(),
            agent: None,
        })
        .await
        .expect("kept");
    let listed = client
        .send(ListCredentialsRequest {})
        .await
        .expect("listed");
    assert_eq!(listed.credentials, vec![kept.credential.clone()]);
    for answer in [
        serde_json::to_string(&kept).expect("json"),
        serde_json::to_string(&listed).expect("json"),
    ] {
        assert!(!answer.contains(TOKEN), "{answer}");
    }
    // The Dispatcher itself reads what the client set.
    assert_eq!(
        value(&dispatcher, "git"),
        Some((CredentialKind::Token, TOKEN.to_owned()))
    );

    let status = client
        .send(LockCredentialsRequest {})
        .await
        .expect("locked");
    assert_eq!((status.state, status.count), (CredentialsState::Locked, 1));
    let refused = client
        .send(UnlockCredentialsRequest {
            passphrase: "not the passphrase at all".to_owned(),
            create: false,
        })
        .await
        .expect_err("a wrong passphrase");
    assert!(errors::is(&refused, errors::UNAUTHENTICATED), "{refused}");
    client
        .send(RemoveCredentialRequest {
            name: "git".to_owned(),
        })
        .await
        .expect("removed while locked");
    assert_eq!(dispatcher.credentials().expect("listed"), Vec::new());

    client.shutdown().await;
    dispatcher.stop().await;
    serving.abort();
}

#[test]
fn a_request_with_a_secret_prints_without_it() {
    let unlock = format!(
        "{:?}",
        UnlockCredentialsRequest {
            passphrase: PASSPHRASE.to_owned(),
            create: false,
        }
    );
    let set = format!(
        "{:?}",
        SetCredentialRequest {
            name: "git".to_owned(),
            kind: CredentialKind::Token,
            value: TOKEN.to_owned(),
            agent: None,
        }
    );
    assert!(!unlock.contains(PASSPHRASE), "{unlock}");
    assert!(!set.contains(TOKEN), "{set}");
    assert!(set.contains("git"), "{set}");
}

/// Wait until `seen` holds, as a Host takes what the Dispatcher sends it a moment later.
async fn until(what: &str, seen: impl Fn() -> bool) {
    tokio::time::timeout(crate::common::WAIT, async {
        while !seen() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{what} in time"));
}

#[tokio::test(flavor = "multi_thread")]
async fn hosts_hold_copies_of_sign_ins_that_cannot_renew() {
    use std::collections::BTreeMap;

    use crate::common::World;
    use crate::common::host_until;

    let studio = World::new().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let (dispatcher, serving) = start(dir.path());
    studio.join(&dispatcher, dir.path(), "studio").await;
    host_until(&dispatcher, &studio.host_id().await, |host| host.connected).await;
    assert_eq!(studio.daemon.credential_names(), Vec::<String>::new());

    dispatcher
        .unlock_credentials(PASSPHRASE.to_owned(), true)
        .await
        .expect("set");
    let refused = dispatcher
        .set_credential("claude", CredentialKind::SignIn, None, CLAUDE)
        .expect_err("no agent");
    assert!(refused.message.contains("names the agent"), "{refused}");
    let refused = dispatcher
        .set_credential("claude", CredentialKind::SignIn, Some("claude"), CODEX)
        .expect_err("another agent's file");
    assert!(refused.message.contains(".credentials.json"), "{refused}");
    let refused = dispatcher
        .set_credential("git", CredentialKind::Token, Some("claude"), TOKEN)
        .expect_err("a token for an agent");
    assert!(refused.message.contains("only a sign-in"), "{refused}");

    // Claude's goes to the agent's environment, as its access token alone.
    dispatcher
        .set_credential("claude", CredentialKind::SignIn, Some("claude"), CLAUDE)
        .expect("kept");
    until("the Host holds Claude's", || {
        studio.daemon.credential_names() == ["claude"]
    })
    .await;
    assert_eq!(
        studio.daemon.credential_environment("claude"),
        BTreeMap::from([(
            "CLAUDE_CODE_OAUTH_TOKEN".to_owned(),
            "claude-access".to_owned()
        )])
    );
    assert_eq!(
        studio.daemon.credential_environment("codex"),
        BTreeMap::new()
    );

    // Codex's is its own file, with nothing to renew with; a token isn't given yet.
    dispatcher
        .set_credential("codex", CredentialKind::SignIn, Some("codex"), CODEX)
        .expect("kept");
    dispatcher
        .set_credential("git", CredentialKind::Token, None, TOKEN)
        .expect("kept");
    until("the Host holds both", || {
        studio.daemon.credential_names() == ["claude", "codex"]
    })
    .await;
    let file = studio.home().join(".codex/auth.json");
    let written = std::fs::read_to_string(&file).expect("Codex's file");
    assert!(written.contains("codex-access"), "{written}");
    assert!(!written.contains("codex-renewal"), "{written}");

    // A Host that joins later is given them as it connects.
    let mini = World::new().await;
    mini.join(&dispatcher, dir.path(), "mini").await;
    until("the new Host holds both", || {
        mini.daemon.credential_names() == ["claude", "codex"]
    })
    .await;

    // Locked, the Dispatcher sends nothing and the Hosts keep what they hold.
    dispatcher.lock_credentials().expect("locked");
    dispatcher.remove_credential("git").expect("removed");
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert_eq!(studio.daemon.credential_names(), ["claude", "codex"]);

    // Removing one has every Host drop it, and its file with it.
    dispatcher
        .unlock_credentials(PASSPHRASE.to_owned(), false)
        .await
        .expect("unlocked");
    dispatcher.remove_credential("codex").expect("removed");
    until("both Hosts dropped Codex's", || {
        studio.daemon.credential_names() == ["claude"]
            && mini.daemon.credential_names() == ["claude"]
    })
    .await;
    assert!(!file.exists());

    dispatcher.stop().await;
    serving.abort();
}

mod renewal {
    use std::collections::BTreeMap;
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use pretty_assertions::assert_eq;
    use serde_json::json;
    use tokio::sync::Notify;
    use tokio::sync::watch;
    use weave_dispatcher::Clock;
    use weave_dispatcher::Dispatcher;
    use weave_dispatcher::signins::Renewer;
    use weave_dispatcher::socket;
    use weave_host_protocol::dispatcher::CredentialKind;
    use weave_host_protocol::dispatcher::RenewCredentialRequest;
    use weave_host_protocol::errors;
    use zeroize::Zeroizing;

    use super::PASSPHRASE;
    use super::TOKEN;
    use super::until;
    use super::value;
    use crate::common::World;
    use crate::common::ask;
    use crate::common::dispatcher_config_with;
    use crate::common::host_until;

    struct TestClock {
        time: watch::Sender<u64>,
    }

    impl TestClock {
        fn new(now: u64) -> Arc<Self> {
            Arc::new(Self {
                time: watch::Sender::new(now),
            })
        }

        fn advance(&self, delta_ms: u64) {
            let next = *self.time.borrow() + delta_ms;
            self.time.send_replace(next);
        }
    }

    impl Clock for TestClock {
        fn now(&self) -> u64 {
            *self.time.borrow()
        }

        fn wait_until(&self, at: u64) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
            let mut time = self.time.subscribe();
            Box::pin(async move {
                let _ = time.wait_for(|now| *now >= at).await;
            })
        }
    }

    fn claude_signin(access: &str, refresh: &str, expires_at: u64) -> String {
        json!({"claudeAiOauth": {
            "accessToken": access,
            "refreshToken": refresh,
            "expiresAt": expires_at,
        }})
        .to_string()
    }

    struct ScriptedRenewer {
        calls: AtomicUsize,
        next: Mutex<Vec<Result<String, String>>>,
    }

    impl ScriptedRenewer {
        fn new(answers: Vec<Result<String, String>>) -> Arc<Self> {
            Arc::new(Self {
                calls: AtomicUsize::new(0),
                next: Mutex::new(answers),
            })
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }

        fn push(&self, answer: Result<String, String>) {
            self.next.lock().expect("lock").push(answer);
        }
    }

    impl Renewer for ScriptedRenewer {
        fn renew<'a>(
            &'a self,
            _agent: &'a str,
            _current: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<Zeroizing<String>, String>> + Send + 'a>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let answer = {
                let mut queue = self.next.lock().expect("lock");
                if queue.is_empty() {
                    Err("no scripted renewal answer".to_owned())
                } else {
                    queue.remove(0)
                }
            };
            Box::pin(async move { answer.map(Zeroizing::new) })
        }
    }

    fn start_with_renewer(
        dir: &std::path::Path,
        clock: Arc<dyn Clock>,
        renewer: Arc<dyn Renewer>,
    ) -> (Dispatcher, tokio::task::JoinHandle<()>) {
        let mut config = dispatcher_config_with(dir, clock);
        config.renewer = renewer;
        let listening = socket::listen(&config.paths).expect("socket");
        let dispatcher = Dispatcher::open(config).expect("opened");
        let serving = dispatcher.clone();
        let task = tokio::spawn(async move { serving.serve(listening.listener).await });
        (dispatcher, task)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn sign_ins_renew_before_expiry_and_sync_hosts() {
        const HOUR: u64 = 60 * 60 * 1000;
        let t0 = 2_000_000_000_000u64;
        let clock = TestClock::new(t0);
        let renewer = ScriptedRenewer::new(vec![Ok(claude_signin(
            "claude-v2",
            "refresh-v2",
            t0 + 15 * HOUR,
        ))]);

        let studio = World::new().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let (dispatcher, serving) = start_with_renewer(
            dir.path(),
            Arc::clone(&clock) as Arc<dyn Clock>,
            Arc::clone(&renewer) as Arc<dyn Renewer>,
        );
        studio.join(&dispatcher, dir.path(), "studio").await;
        host_until(&dispatcher, &studio.host_id().await, |host| host.connected).await;

        dispatcher
            .unlock_credentials(PASSPHRASE.to_owned(), true)
            .await
            .expect("unlocked");
        let kept = dispatcher
            .set_credential(
                "claude",
                CredentialKind::SignIn,
                Some("claude"),
                &claude_signin("claude-v1", "refresh-v1", t0 + 8 * HOUR),
            )
            .expect("kept");
        assert_eq!(kept.expires_at, Some(t0 + 8 * HOUR));
        assert_eq!(kept.renewal_error, None);

        until("Host holds v1", || {
            studio.daemon.credential_environment("claude")
                == BTreeMap::from([("CLAUDE_CODE_OAUTH_TOKEN".to_owned(), "claude-v1".to_owned())])
        })
        .await;

        // 2 hours left: still outside the 1-hour renewal window.
        clock.advance(6 * HOUR);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(renewer.calls(), 0);

        // 1 hour left: due now; renews automatically and pushes v2 to the Host.
        clock.advance(HOUR);
        until("Host receives renewed v2", || {
            studio.daemon.credential_environment("claude")
                == BTreeMap::from([("CLAUDE_CODE_OAUTH_TOKEN".to_owned(), "claude-v2".to_owned())])
        })
        .await;
        assert_eq!(renewer.calls(), 1);
        let listed = dispatcher.credentials().expect("listed");
        assert_eq!(listed[0].expires_at, Some(t0 + 15 * HOUR));
        assert_eq!(listed[0].renewal_error, None);

        dispatcher.stop().await;
        serving.abort();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn failed_renewal_records_error_backs_off_and_recovers_plus_manual_renew() {
        const MINUTE: u64 = 60 * 1000;
        const HOUR: u64 = 60 * MINUTE;
        let t0 = 2_000_000_000_000u64;
        let clock = TestClock::new(t0);
        let renewer = ScriptedRenewer::new(vec![
            Err("temporary vendor outage".to_owned()),
            Ok(claude_signin("claude-v2", "refresh-v2", t0 + 10 * HOUR)),
            Ok(claude_signin("claude-v3", "refresh-v3", t0 + 18 * HOUR)),
        ]);

        let dir = tempfile::tempdir().expect("tempdir");
        let (dispatcher, serving) = start_with_renewer(
            dir.path(),
            Arc::clone(&clock) as Arc<dyn Clock>,
            Arc::clone(&renewer) as Arc<dyn Renewer>,
        );
        let client = ask(dir.path()).await;

        dispatcher
            .unlock_credentials(PASSPHRASE.to_owned(), true)
            .await
            .expect("unlocked");
        dispatcher
            .set_credential("git", CredentialKind::Token, None, TOKEN)
            .expect("token");
        // Already inside the 1-hour renewal window (30m left).
        dispatcher
            .set_credential(
                "claude",
                CredentialKind::SignIn,
                Some("claude"),
                &claude_signin("claude-v1", "refresh-v1", t0 + 30 * MINUTE),
            )
            .expect("kept");

        until("first renewal error recorded", || {
            dispatcher
                .credentials()
                .expect("listed")
                .into_iter()
                .find(|c| c.name == "claude")
                .and_then(|c| c.renewal_error)
                .as_deref()
                == Some("temporary vendor outage")
        })
        .await;
        assert_eq!(renewer.calls(), 1);

        // 30s later: still in the 1-minute backoff, so no retry yet.
        clock.advance(30 * 1000);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(renewer.calls(), 1);

        // Past the 1-minute backoff: retries, succeeds, clears renewal_error.
        clock.advance(31 * 1000);
        until("recovered to v2", || {
            dispatcher
                .credentials()
                .expect("listed")
                .into_iter()
                .find(|c| c.name == "claude")
                .is_some_and(|c| c.expires_at == Some(t0 + 10 * HOUR) && c.renewal_error.is_none())
        })
        .await;
        assert_eq!(renewer.calls(), 2);

        // Manual `credentials/renew` over the API works even far from expiry, and refuses tokens.
        let refused = client
            .send(RenewCredentialRequest {
                name: "git".to_owned(),
            })
            .await
            .expect_err("tokens aren't renewed");
        assert!(refused.message.contains("isn't a sign-in"), "{refused}");

        let renewed = client
            .send(RenewCredentialRequest {
                name: "claude".to_owned(),
            })
            .await
            .expect("manual renew")
            .credential;
        assert_eq!(renewed.expires_at, Some(t0 + 18 * HOUR));
        assert_eq!(renewed.renewal_error, None);
        assert_eq!(renewer.calls(), 3);

        // Locked: manual renew is refused with credentialsLocked.
        dispatcher.lock_credentials().expect("locked");
        let refused = client
            .send(RenewCredentialRequest {
                name: "claude".to_owned(),
            })
            .await
            .expect_err("locked");
        assert!(
            errors::is(&refused, errors::CREDENTIALS_LOCKED),
            "{refused}"
        );

        // Adding another scripted answer shouldn't run while locked even past expiry.
        renewer.push(Ok(claude_signin("claude-v4", "refresh-v4", t0 + 26 * HOUR)));
        clock.advance(20 * HOUR);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(renewer.calls(), 3);

        // Unlocking wakes the renewer immediately for the now-due sign-in.
        dispatcher
            .unlock_credentials(PASSPHRASE.to_owned(), false)
            .await
            .expect("unlocked");
        until("renewed on unlock", || {
            dispatcher
                .credentials()
                .expect("listed")
                .into_iter()
                .find(|c| c.name == "claude")
                .is_some_and(|c| c.expires_at == Some(t0 + 26 * HOUR))
        })
        .await;

        client.shutdown().await;
        dispatcher.stop().await;
        serving.abort();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_replacement_during_renewal_is_not_overwritten() {
        struct GatedRenewer {
            entered: Notify,
            release: Notify,
            answer: String,
        }

        impl Renewer for GatedRenewer {
            fn renew<'a>(
                &'a self,
                _agent: &'a str,
                _current: &'a str,
            ) -> Pin<Box<dyn Future<Output = Result<Zeroizing<String>, String>> + Send + 'a>>
            {
                Box::pin(async move {
                    self.entered.notify_one();
                    self.release.notified().await;
                    Ok(Zeroizing::new(self.answer.clone()))
                })
            }
        }

        let t0 = 2_000_000_000_000u64;
        let clock = TestClock::new(t0);
        let renewer = Arc::new(GatedRenewer {
            entered: Notify::new(),
            release: Notify::new(),
            answer: claude_signin("stale-renewal", "r-stale", t0 + 10_000_000),
        });

        let dir = tempfile::tempdir().expect("tempdir");
        let (dispatcher, serving) = start_with_renewer(
            dir.path(),
            Arc::clone(&clock) as Arc<dyn Clock>,
            Arc::clone(&renewer) as Arc<dyn Renewer>,
        );
        dispatcher
            .unlock_credentials(PASSPHRASE.to_owned(), true)
            .await
            .expect("unlocked");
        dispatcher
            .set_credential(
                "claude",
                CredentialKind::SignIn,
                Some("claude"),
                &claude_signin("v1", "r1", t0 + 99_000_000_000),
            )
            .expect("v1");

        let renewing_dispatcher = dispatcher.clone();
        let task =
            tokio::spawn(async move { renewing_dispatcher.renew_credential("claude").await });
        renewer.entered.notified().await;

        // While the vendor command is in flight, the person replaces the sign-in.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let brand_new = claude_signin("brand-new", "r-new", t0 + 99_999_000_000);
        dispatcher
            .set_credential("claude", CredentialKind::SignIn, Some("claude"), &brand_new)
            .expect("replaced");

        renewer.release.notify_one();
        let returned = task.await.expect("join").expect("result");
        assert_eq!(returned.expires_at, Some(t0 + 99_999_000_000));
        assert_eq!(
            value(&dispatcher, "claude"),
            Some((CredentialKind::SignIn, brand_new))
        );

        dispatcher.stop().await;
        serving.abort();
    }
}
