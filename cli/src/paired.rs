//! The Dispatcher this computer is paired with (WVE-176), when it runs on another one, as the
//! person's runs on their homelab: its URL and id, and this computer's device id there, in
//! `$XDG_STATE_HOME/weave/client/dispatcher.json` (by default under `~/.local/state`), and the
//! device's key beside it in `key.json`, in the Secure Enclave on a Mac that has one, otherwise
//! in the file itself. Both are 0600 and hold no secret of the Dispatcher's.
//!
//! `weave dispatcher connect` writes them, making a new key for each pairing, `weave dispatcher
//! disconnect` removes them, and
//! [`crate::dispatcher::connect`] uses them when no Dispatcher runs here.

use std::io::Write as _;
use std::path::PathBuf;

use anyhow::Context as _;
use serde::Deserialize;
use serde::Serialize;
use weave_dispatcher::client::DispatcherConnection;
use weave_host_client::Credentials;
use weave_host_client::remote::DeviceKey;
use weave_host_client::remote::connect_websocket_as;
use weave_host_protocol::dispatcher::DISPATCHER_SUBPROTOCOL;

use crate::host::client_info;

/// This computer's pairing with a Dispatcher on another one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Paired {
    /// What this computer connects to: the Dispatcher's Tailscale Serve URL.
    pub(crate) url: String,
    /// The Dispatcher's id, which it checks is the one answering at `url`.
    pub(crate) dispatcher_id: String,
    /// The device the Dispatcher knows this computer as, which `weave devices revoke` takes
    /// there.
    pub(crate) device_id: String,
    /// The computer SSH reached it on when pairing, if it did: what messages call it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) computer: Option<String>,
    pub(crate) paired_at: u64,
}

impl Paired {
    /// Where it runs, in messages: the computer SSH reached, or the URL.
    pub(crate) fn place(&self) -> &str {
        self.computer.as_deref().unwrap_or(&self.url)
    }
}

/// `$XDG_STATE_HOME/weave/client`, by default `~/.local/state/weave/client`.
fn dir() -> anyhow::Result<PathBuf> {
    let state = std::env::var_os("XDG_STATE_HOME")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .filter(|home| !home.is_empty())
                .map(|home| PathBuf::from(home).join(".local/state"))
        })
        .context("no home directory for this computer's pairing with the Dispatcher")?;
    Ok(state.join("weave/client"))
}

fn record() -> anyhow::Result<PathBuf> {
    Ok(dir()?.join("dispatcher.json"))
}

fn key_path() -> anyhow::Result<PathBuf> {
    Ok(dir()?.join("key.json"))
}

/// A new pairing's key, until it pairs and [`save`] puts it in place.
fn new_key_path() -> anyhow::Result<PathBuf> {
    Ok(dir()?.join("key.new.json"))
}

/// The Dispatcher this computer is paired with, if it is.
pub(crate) fn load() -> anyhow::Result<Option<Paired>> {
    let path = record()?;
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("reading {}", path.display())),
    };
    let paired =
        serde_json::from_slice(&bytes).with_context(|| format!("reading {}", path.display()))?;
    Ok(Some(paired))
}

/// Keep `paired`, made with [`new_key`], replacing any pairing before it and its key.
pub(crate) fn save(paired: &Paired) -> anyhow::Result<()> {
    let (new_key, key) = (new_key_path()?, key_path()?);
    std::fs::rename(&new_key, &key)
        .with_context(|| format!("moving {} to {}", new_key.display(), key.display()))?;
    let path = record()?;
    let json = serde_json::to_vec_pretty(paired)?;
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
    written.with_context(|| format!("writing {}", path.display()))
}

/// Forget the pairing and the device's key, giving the pairing there was.
pub(crate) fn forget() -> anyhow::Result<Option<Paired>> {
    let paired = load()?;
    for path in [record()?, key_path()?, new_key_path()?] {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| format!("removing {}", path.display()));
            }
        }
    }
    Ok(paired)
}

/// A new key for pairing this computer, kept apart from the one it proves itself with now
/// until the pairing is saved: a pairing that fails leaves the one before it working.
pub(crate) fn new_key() -> anyhow::Result<DeviceKey> {
    let path = new_key_path()?;
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).with_context(|| format!("removing {}", path.display())),
    }
    let dir = dir()?;
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .with_context(|| format!("securing {}", dir.display()))?;
    }
    DeviceKey::kept(&path, true).map_err(anyhow::Error::msg)
}

/// The key this computer proves itself to the Dispatcher with.
pub(crate) fn key() -> anyhow::Result<DeviceKey> {
    let path = key_path()?;
    DeviceKey::read(&path)
        .map_err(anyhow::Error::msg)?
        .with_context(|| {
            format!(
                "{} is gone; pair again with `weave dispatcher connect`",
                path.display()
            )
        })
}

/// Connect to the Dispatcher at `url` and say hello with `credentials`.
pub(crate) async fn connect_with(
    url: &str,
    credentials: Credentials,
) -> anyhow::Result<DispatcherConnection> {
    let (transport, closed) = connect_websocket_as(url, DISPATCHER_SUBPROTOCOL)
        .await
        .with_context(|| format!("connecting to {url}"))?;
    DispatcherConnection::connect_with(transport, client_info("weave-cli"), credentials)
        .await
        .map_err(|error| match closed.get() {
            Some((_, reason)) if !reason.is_empty() => {
                anyhow::anyhow!("{}: {reason}", error.message)
            }
            _ => anyhow::anyhow!("{}", error.message),
        })
}

/// Connect to the Dispatcher this computer is paired with, as its device.
pub(crate) async fn connect(paired: &Paired) -> anyhow::Result<DispatcherConnection> {
    let credentials = Credentials::Device {
        device_id: paired.device_id.clone(),
        key: key()?,
        host_id: Some(paired.dispatcher_id.clone()),
    };
    connect_with(&paired.url, credentials).await
}
