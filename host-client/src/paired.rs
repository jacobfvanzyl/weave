//! The Dispatcher this computer is paired with (WVE-176), when it runs on another one, as the
//! person's runs on their homelab: its URL and id, and this computer's device id there, in
//! `$XDG_STATE_HOME/weave/client/dispatcher.json` (by default under `~/.local/state`), and the
//! device's key beside it in `key.json`, in the Secure Enclave on a Mac that has one, otherwise
//! in the file itself. Both are 0600 and hold no secret of the Dispatcher's.
//!
//! The computer is one device to the Dispatcher: the CLI (`weave dispatcher connect` and
//! `disconnect`) and the Mac's app (ADR 0032) share this pairing and its key.

use std::io;
use std::io::Write as _;
use std::path::PathBuf;

use serde::Deserialize;
use serde::Serialize;

use crate::remote::DeviceKey;

/// This computer's pairing with a Dispatcher on another one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Paired {
    /// What this computer connects to: the Dispatcher's Tailscale Serve URL.
    pub url: String,
    /// The Dispatcher's id, which it checks is the one answering at `url`.
    pub dispatcher_id: String,
    /// The device the Dispatcher knows this computer as, which `weave devices revoke` takes
    /// there.
    pub device_id: String,
    /// The computer SSH reached it on when pairing, if it did: what messages call it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub computer: Option<String>,
    pub paired_at: u64,
}

impl Paired {
    /// Where it runs, in messages: the computer SSH reached, or the URL.
    pub fn place(&self) -> &str {
        self.computer.as_deref().unwrap_or(&self.url)
    }
}

fn context(error: io::Error, doing: impl std::fmt::Display) -> io::Error {
    io::Error::new(error.kind(), format!("{doing}: {error}"))
}

/// `$XDG_STATE_HOME/weave/client`, by default `~/.local/state/weave/client`: this computer's
/// state as a client of the Dispatcher, its pairing and what the CLI last listed there.
pub fn dir() -> io::Result<PathBuf> {
    let state = std::env::var_os("XDG_STATE_HOME")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .filter(|home| !home.is_empty())
                .map(|home| PathBuf::from(home).join(".local/state"))
        })
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "no home directory for this computer's pairing with the Dispatcher",
            )
        })?;
    Ok(state.join("weave/client"))
}

fn record() -> io::Result<PathBuf> {
    Ok(dir()?.join("dispatcher.json"))
}

fn key_path() -> io::Result<PathBuf> {
    Ok(dir()?.join("key.json"))
}

/// A new pairing's key, until it pairs and [`save`] puts it in place.
fn new_key_path() -> io::Result<PathBuf> {
    Ok(dir()?.join("key.new.json"))
}

/// The Dispatcher this computer is paired with, if it is.
pub fn load() -> io::Result<Option<Paired>> {
    let path = record()?;
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(context(error, format!("reading {}", path.display()))),
    };
    let paired = serde_json::from_slice(&bytes).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("reading {}: {error}", path.display()),
        )
    })?;
    Ok(Some(paired))
}

/// Keep `paired`, made with [`new_key`], replacing any pairing before it and its key.
pub fn save(paired: &Paired) -> io::Result<()> {
    let (new_key, key) = (new_key_path()?, key_path()?);
    std::fs::rename(&new_key, &key).map_err(|error| {
        context(
            error,
            format!("moving {} to {}", new_key.display(), key.display()),
        )
    })?;
    let path = record()?;
    let json = serde_json::to_vec_pretty(paired).map_err(io::Error::other)?;
    let temporary = path.with_extension("json.tmp");
    let written = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut out = options.open(&temporary)?;
        out.write_all(&json)?;
        out.sync_all()?;
        std::fs::rename(&temporary, &path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written.map_err(|error| context(error, format!("writing {}", path.display())))
}

/// Forget the pairing and the device's key, giving the pairing there was.
pub fn forget() -> io::Result<Option<Paired>> {
    let paired = load()?;
    for path in [record()?, key_path()?, new_key_path()?] {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(context(error, format!("removing {}", path.display()))),
        }
    }
    Ok(paired)
}

/// A new key for pairing this computer, kept apart from the one it proves itself with now
/// until the pairing is saved: a pairing that fails leaves the one before it working.
pub fn new_key() -> io::Result<DeviceKey> {
    let path = new_key_path()?;
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(context(error, format!("removing {}", path.display()))),
    }
    let dir = dir()?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| context(error, format!("creating {}", dir.display())))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| context(error, format!("securing {}", dir.display())))?;
    }
    DeviceKey::kept(&path, true).map_err(io::Error::other)
}

/// The key this computer proves itself to the Dispatcher with.
pub fn key() -> io::Result<DeviceKey> {
    let path = key_path()?;
    DeviceKey::read(&path).map_err(io::Error::other)?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "{} is gone; pair again with `weave dispatcher connect`",
                path.display()
            ),
        )
    })
}

/// The time now, in milliseconds since the Unix epoch, for [`Paired::paired_at`].
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}
