//! The Dispatcher this computer is paired with (WVE-176), when it runs on another one: the
//! record and key [`weave_host_client::paired`] keeps, which the Mac's app shares (ADR 0032).
//!
//! `weave dispatcher connect` writes them, making a new key for each pairing, `weave dispatcher
//! disconnect` removes them, and
//! [`crate::dispatcher::connect`] uses them when no Dispatcher runs here.

use std::path::PathBuf;

use anyhow::Context as _;
use weave_dispatcher::client::DispatcherConnection;
use weave_host_client::Credentials;
use weave_host_client::paired as kept;
pub(crate) use weave_host_client::paired::Paired;
use weave_host_client::remote::DeviceKey;
use weave_host_client::remote::connect_websocket_as;
use weave_host_protocol::dispatcher::DISPATCHER_SUBPROTOCOL;

use crate::host::client_info;

/// `$XDG_STATE_HOME/weave/client`, by default `~/.local/state/weave/client`: this computer's
/// state as a client of the Dispatcher, its pairing and the Projects it last listed
/// ([`crate::projects`]).
pub(crate) fn dir() -> anyhow::Result<PathBuf> {
    Ok(kept::dir()?)
}

/// The Dispatcher this computer is paired with, if it is.
pub(crate) fn load() -> anyhow::Result<Option<Paired>> {
    Ok(kept::load()?)
}

/// Keep `paired`, made with [`new_key`], replacing any pairing before it and its key.
pub(crate) fn save(paired: &Paired) -> anyhow::Result<()> {
    Ok(kept::save(paired)?)
}

/// Forget the pairing and the device's key, giving the pairing there was.
pub(crate) fn forget() -> anyhow::Result<Option<Paired>> {
    Ok(kept::forget()?)
}

/// A new key for pairing this computer, kept apart from the one it proves itself with now
/// until the pairing is saved: a pairing that fails leaves the one before it working.
pub(crate) fn new_key() -> anyhow::Result<DeviceKey> {
    Ok(kept::new_key()?)
}

/// The key this computer proves itself to the Dispatcher with.
pub(crate) fn key() -> anyhow::Result<DeviceKey> {
    Ok(kept::key()?)
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
