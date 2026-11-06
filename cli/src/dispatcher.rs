//! Reaching the Dispatcher (ADR 0027, WVE-175), the person's program that keeps triggers and
//! starts their work on their Hosts: over its socket, as the person running it here.
//! `weave dispatcher` manages it ([`crate::commands::dispatcher`]).

use anyhow::Context as _;
use weave_dispatcher::DispatcherPaths;
use weave_dispatcher::client::DispatcherConnection;
use weave_dispatcher::socket;
use weave_host_protocol::hello::ClientInfo;

/// Where the Dispatcher keeps its state, socket and log.
pub(crate) fn paths() -> anyhow::Result<DispatcherPaths> {
    DispatcherPaths::from_env().context("no home directory for the Dispatcher")
}

/// The Dispatcher running from `paths`, said hello to.
pub(crate) async fn connect(paths: &DispatcherPaths) -> anyhow::Result<DispatcherConnection> {
    let transport = socket::connect(&paths.socket()).await.with_context(|| {
        format!(
            "the Dispatcher isn't running from {}; `weave dispatcher install` runs it as a \
             service, or `weave dispatcher run` here",
            paths.dir.display()
        )
    })?;
    let client = ClientInfo {
        name: "weave-cli".to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
    };
    DispatcherConnection::connect(transport, client)
        .await
        .map_err(|error| anyhow::anyhow!("{}", error.message))
}
