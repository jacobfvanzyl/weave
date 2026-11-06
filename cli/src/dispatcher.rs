//! Reaching the Dispatcher (ADR 0027, WVE-175), the person's program that keeps triggers and
//! starts their work on their Hosts: over its socket, as the person running it here.
//! `weave dispatcher` manages it ([`crate::commands::dispatcher`]).

use std::time::Duration;
use std::time::Instant;

use anyhow::Context as _;
use anyhow::bail;
use weave_dispatcher::DispatcherPaths;
use weave_dispatcher::client::DispatcherConnection;
use weave_dispatcher::socket;
use weave_host_protocol::hello::ClientInfo;

/// How long to wait for the Dispatcher to answer once started, or to stop.
pub(crate) const STARTUP_WAIT: Duration = Duration::from_secs(10);

/// Where the Dispatcher keeps its state, socket and log.
pub(crate) fn paths() -> anyhow::Result<DispatcherPaths> {
    DispatcherPaths::from_env().context("no home directory for the Dispatcher")
}

/// The Dispatcher running from `paths`, said hello to.
pub(crate) async fn connect(paths: &DispatcherPaths) -> anyhow::Result<DispatcherConnection> {
    let transport = socket::connect(&paths.socket()).await.with_context(|| {
        format!(
            "the Dispatcher isn't running from {}; `weave dispatcher install` runs it as a \
             service, or `weave dispatcher start` here",
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

/// Whether the Dispatcher running from `paths` answers, waiting up to [`STARTUP_WAIT`] for it.
pub(crate) async fn answers(paths: &DispatcherPaths) -> bool {
    let deadline = Instant::now() + STARTUP_WAIT;
    loop {
        if let Ok(dispatcher) = connect(paths).await {
            dispatcher.shutdown().await;
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Wait for the Dispatcher to stop listening.
pub(crate) async fn wait_until_stopped(paths: &DispatcherPaths) -> anyhow::Result<()> {
    let deadline = Instant::now() + STARTUP_WAIT;
    while socket::connect(&paths.socket()).await.is_ok() {
        if Instant::now() >= deadline {
            bail!(
                "the Dispatcher didn't stop within {} seconds; its log is {}",
                STARTUP_WAIT.as_secs(),
                paths.log().display()
            );
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Ok(())
}
