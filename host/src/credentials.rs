//! The person's credentials as this Host holds them (ADR 0036, WVE-239): what the Dispatcher it
//! joined gave it with `credentials/sync`, each a copy that can't be renewed.
//!
//! A credential is used one of two ways. One for an agent's environment is added to what the
//! agent's process starts with, which is never written to disk. One that is a file is written
//! under the person's home, readable by them only, where the program it is for reads its own
//! sign-in; a set that leaves it out removes the file.
//!
//! The Host keeps the set so agents start while the Dispatcher is away: sealed in
//! `credentials.sealed`, beside its other records, under a key in `credentials.key` that only
//! the person can read. That keeps a copy of the one file from giving anything up; someone
//! with the whole directory has both, as they have the Host's own key where it is a file.
//! A credential past its `expiresAt` is no longer given out.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

use agent_client_protocol::Error;
use chacha20poly1305::KeyInit as _;
use chacha20poly1305::XChaCha20Poly1305;
use chacha20poly1305::aead::Aead as _;
use weave_host_protocol::Timestamp;
use weave_host_protocol::credentials::CredentialUse;
use weave_host_protocol::credentials::HeldCredential;

use crate::journal::private_file;
use crate::thread::lock;

const KEY_LENGTH: usize = 32;
const NONCE_LENGTH: usize = 24;

/// What the Host holds, and where it keeps it.
pub(crate) struct Credentials {
    /// The directory its two files are in; none keeps the set in memory only.
    dir: Option<PathBuf>,
    /// The home files are written under.
    home: PathBuf,
    held: Mutex<Vec<HeldCredential>>,
}

fn invalid(why: impl Into<String>) -> Error {
    Error::invalid_params().data(why.into())
}

/// Where a file credential goes under `home`: a path of plain names, so nothing leaves it.
fn placed(home: &Path, path: &str) -> Result<PathBuf, Error> {
    let relative = Path::new(path);
    let plain = !path.is_empty()
        && relative
            .components()
            .all(|component| matches!(component, Component::Normal(_)));
    if !plain {
        return Err(invalid(format!(
            "a credential's file is a path under the home directory, and {path} isn't"
        )));
    }
    Ok(home.join(relative))
}

/// Write `contents` to `path`, which only the person can read, replacing the file whole.
fn write_private(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".weave-tmp");
    let temporary = PathBuf::from(temporary);
    let written = (|| {
        let mut out = private_file(&temporary, true)?;
        out.write_all(contents)?;
        out.sync_all()?;
        std::fs::rename(&temporary, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written
}

fn random<const N: usize>() -> std::io::Result<[u8; N]> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|error| std::io::Error::other(error.to_string()))?;
    Ok(bytes)
}

impl Credentials {
    /// What was kept in `dir`, if anything was.
    pub(crate) fn load(dir: Option<PathBuf>, home: PathBuf) -> Self {
        let held = match dir.as_deref().map(read) {
            Some(Ok(held)) => held,
            Some(Err(error)) => {
                tracing::warn!(%error, "the credentials this Host kept couldn't be read; the Dispatcher gives them again");
                Vec::new()
            }
            None => Vec::new(),
        };
        Self {
            dir,
            home,
            held: Mutex::new(held),
        }
    }

    /// Hold `credentials` in place of what was held: write the files among them, remove the
    /// files of those left out, and keep the set. All of them are checked before any is taken.
    pub(crate) fn sync(&self, credentials: Vec<HeldCredential>) -> Result<(), Error> {
        let mut files = BTreeMap::new();
        for credential in &credentials {
            match &credential.used {
                CredentialUse::File { path } => {
                    files.insert(placed(&self.home, path)?, credential.value.as_bytes());
                }
                CredentialUse::Environment { agent, variable } => {
                    let named = !agent.is_empty()
                        && !variable.is_empty()
                        && variable
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '_');
                    if !named {
                        return Err(invalid(format!(
                            "credential {} names no agent or no variable an environment takes",
                            credential.name
                        )));
                    }
                }
            }
        }
        let mut held = lock(&self.held);
        for (path, contents) in &files {
            write_private(path, contents).map_err(|error| {
                Error::internal_error().data(format!("writing {}: {error}", path.display()))
            })?;
        }
        // A file the Host wrote for a credential it no longer holds goes with it.
        for credential in held.iter() {
            if let CredentialUse::File { path } = &credential.used
                && let Ok(path) = placed(&self.home, path)
                && !files.contains_key(&path)
                && let Err(error) = std::fs::remove_file(&path)
                && error.kind() != std::io::ErrorKind::NotFound
            {
                tracing::warn!(%error, path = %path.display(), "couldn't remove a dropped credential's file");
            }
        }
        *held = credentials;
        if let Some(dir) = &self.dir
            && let Err(error) = write(dir, &held)
        {
            tracing::warn!(%error, "keeping this Host's credentials failed; it has them until it stops");
        }
        Ok(())
    }

    /// What `agent`'s process starts with, of the credentials still good at `now`.
    pub(crate) fn environment(&self, agent: &str, now: Timestamp) -> BTreeMap<String, String> {
        lock(&self.held)
            .iter()
            .filter(|credential| credential.expires_at.is_none_or(|expires| expires > now))
            .filter_map(|credential| match &credential.used {
                CredentialUse::Environment {
                    agent: for_agent,
                    variable,
                } if for_agent == agent => Some((variable.clone(), credential.value.clone())),
                _ => None,
            })
            .collect()
    }

    /// The names of the credentials it holds, in the order given.
    pub(crate) fn names(&self) -> Vec<String> {
        lock(&self.held)
            .iter()
            .map(|credential| credential.name.clone())
            .collect()
    }
}

fn sealed_path(dir: &Path) -> PathBuf {
    dir.join("credentials.sealed")
}

fn key_path(dir: &Path) -> PathBuf {
    dir.join("credentials.key")
}

/// The key the set is sealed under, made the first time it's needed.
fn key(dir: &Path, make: bool) -> std::io::Result<Option<[u8; KEY_LENGTH]>> {
    let path = key_path(dir);
    match std::fs::read(&path) {
        Ok(bytes) => <[u8; KEY_LENGTH]>::try_from(bytes.as_slice())
            .map(Some)
            .map_err(|_| std::io::Error::other("credentials.key is the wrong size")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && make => {
            let key = random::<KEY_LENGTH>()?;
            write_private(&path, &key)?;
            Ok(Some(key))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn write(dir: &Path, held: &[HeldCredential]) -> std::io::Result<()> {
    let Some(key) = key(dir, true)? else {
        return Err(std::io::Error::other("no key to seal them under"));
    };
    let nonce = random::<NONCE_LENGTH>()?;
    let plain = serde_json::to_vec(held).map_err(std::io::Error::other)?;
    let sealed = XChaCha20Poly1305::new((&key).into())
        .encrypt((&nonce).into(), plain.as_slice())
        .map_err(|_| std::io::Error::other("sealing failed"))?;
    let mut file = nonce.to_vec();
    file.extend(sealed);
    write_private(&sealed_path(dir), &file)
}

fn read(dir: &Path) -> std::io::Result<Vec<HeldCredential>> {
    let file = match std::fs::read(sealed_path(dir)) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let Some(key) = key(dir, false)? else {
        return Err(std::io::Error::other("credentials.key is gone"));
    };
    let Some((nonce, sealed)) = file.split_at_checked(NONCE_LENGTH) else {
        return Err(std::io::Error::other("credentials.sealed is cut short"));
    };
    let nonce: &[u8; NONCE_LENGTH] = nonce
        .try_into()
        .map_err(|_| std::io::Error::other("credentials.sealed is cut short"))?;
    let plain = XChaCha20Poly1305::new((&key).into())
        .decrypt(nonce.into(), sealed)
        .map_err(|_| std::io::Error::other("credentials.sealed doesn't open with this key"))?;
    serde_json::from_slice(&plain).map_err(std::io::Error::other)
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn environment(
        name: &str,
        agent: &str,
        value: &str,
        expires_at: Option<u64>,
    ) -> HeldCredential {
        HeldCredential {
            name: name.to_owned(),
            used: CredentialUse::Environment {
                agent: agent.to_owned(),
                variable: "AGENT_TOKEN".to_owned(),
            },
            value: value.to_owned(),
            expires_at,
        }
    }

    fn file(name: &str, path: &str, value: &str) -> HeldCredential {
        HeldCredential {
            name: name.to_owned(),
            used: CredentialUse::File {
                path: path.to_owned(),
            },
            value: value.to_owned(),
            expires_at: None,
        }
    }

    #[test]
    fn an_agent_starts_with_its_own_credentials_until_they_expire() {
        let home = tempfile::tempdir().expect("tempdir");
        let credentials = Credentials::load(None, home.path().to_path_buf());
        credentials
            .sync(vec![
                environment("claude", "claude", "token-a", Some(2_000)),
                environment("other", "codex", "token-b", None),
            ])
            .expect("held");
        assert_eq!(
            credentials.environment("claude", 1_000),
            BTreeMap::from([("AGENT_TOKEN".to_owned(), "token-a".to_owned())])
        );
        assert_eq!(credentials.environment("claude", 2_000), BTreeMap::new());
        assert_eq!(credentials.environment("gemini", 1_000), BTreeMap::new());
        assert_eq!(credentials.names(), vec!["claude", "other"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_file_credential_is_written_privately_and_removed_when_dropped() {
        use std::os::unix::fs::PermissionsExt as _;

        let home = tempfile::tempdir().expect("tempdir");
        let credentials = Credentials::load(None, home.path().to_path_buf());
        credentials
            .sync(vec![file("codex", ".codex/auth.json", "{\"a\":1}")])
            .expect("held");
        let path = home.path().join(".codex/auth.json");
        assert_eq!(
            std::fs::read_to_string(&path).expect("written"),
            "{\"a\":1}"
        );
        let mode = std::fs::metadata(&path).expect("file").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);

        credentials
            .sync(vec![file("codex", ".codex/auth.json", "{\"a\":2}")])
            .expect("replaced");
        assert_eq!(
            std::fs::read_to_string(&path).expect("written"),
            "{\"a\":2}"
        );

        credentials.sync(Vec::new()).expect("dropped");
        assert!(!path.exists());
    }

    #[test]
    fn a_file_outside_the_home_is_refused_and_nothing_is_taken() {
        let home = tempfile::tempdir().expect("tempdir");
        let credentials = Credentials::load(None, home.path().to_path_buf());
        for path in ["../elsewhere", "/etc/passwd", "", "a/../../b"] {
            let refused = credentials
                .sync(vec![
                    environment("claude", "claude", "token", None),
                    file("bad", path, "x"),
                ])
                .expect_err("outside the home");
            assert!(
                format!("{refused:?}").contains("under the home"),
                "{refused:?}"
            );
        }
        assert_eq!(credentials.names(), Vec::<String>::new());
    }

    #[test]
    fn what_it_holds_is_kept_sealed_and_read_again() {
        let home = tempfile::tempdir().expect("tempdir");
        let dir = tempfile::tempdir().expect("tempdir");
        let credentials =
            Credentials::load(Some(dir.path().to_path_buf()), home.path().to_path_buf());
        credentials
            .sync(vec![environment(
                "claude",
                "claude",
                "a-token-nobody-reads-from-the-file",
                None,
            )])
            .expect("held");
        let sealed = std::fs::read(sealed_path(dir.path())).expect("kept");
        let secret = b"a-token-nobody-reads-from-the-file";
        assert!(!sealed.windows(secret.len()).any(|window| window == secret));

        let again = Credentials::load(Some(dir.path().to_path_buf()), home.path().to_path_buf());
        assert_eq!(
            again.environment("claude", 0),
            BTreeMap::from([(
                "AGENT_TOKEN".to_owned(),
                "a-token-nobody-reads-from-the-file".to_owned()
            )])
        );

        // Without its key the kept set is nothing, and the Host starts with none.
        std::fs::remove_file(key_path(dir.path())).expect("its key");
        let lost = Credentials::load(Some(dir.path().to_path_buf()), home.path().to_path_buf());
        assert_eq!(lost.names(), Vec::<String>::new());
    }
}
