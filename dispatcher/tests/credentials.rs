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
        .set_credential("git", CredentialKind::Token, TOKEN)
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
        .set_credential("git", CredentialKind::Token, TOKEN)
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
        .set_credential("git", CredentialKind::SignIn, "{\"a\":1}")
        .expect("replaced");
    assert_eq!(replaced.created_at, kept.created_at);
    assert_eq!(
        value(&dispatcher, "git"),
        Some((CredentialKind::SignIn, "{\"a\":1}".to_owned()))
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
        .set_credential("other", CredentialKind::Token, TOKEN)
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
        Some((CredentialKind::SignIn, "{\"a\":1}".to_owned()))
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
        .set_credential("git", CredentialKind::Token, TOKEN)
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
        .set_credential("work", CredentialKind::Token, "the work token")
        .expect("kept");
    dispatcher
        .set_credential("personal", CredentialKind::Token, "the personal token")
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
        }
    );
    assert!(!unlock.contains(PASSPHRASE), "{unlock}");
    assert!(!set.contains(TOKEN), "{set}");
    assert!(set.contains("git"), "{set}");
}
