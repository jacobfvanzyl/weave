//! Reaching the Dispatcher (ADR 0027, WVE-175), the person's program that keeps triggers and
//! starts their work on their Hosts: over its socket, as the person running it here, or else
//! over its WebSocket as a device paired with it (WVE-176, [`crate::paired`]), as when it runs on
//! the person's homelab. A Dispatcher directory named with `$WEAVE_DISPATCHER_DIR`, as a
//! development one is, is only ever reached here. `weave dispatcher` manages it
//! ([`crate::commands::dispatcher`]).

use std::time::Duration;
use std::time::Instant;

use anyhow::Context as _;
use anyhow::bail;
use weave_dispatcher::DispatcherPaths;
use weave_dispatcher::client::DispatcherConnection;
use weave_dispatcher::paths::DIR_VARIABLE;
use weave_dispatcher::socket;
use weave_host_protocol::dispatcher::DispatcherHello;
use weave_host_protocol::hello::ClientInfo;

use crate::paired;
use crate::paired::Paired;

/// How long to wait for the Dispatcher to answer once started, or to stop.
pub(crate) const STARTUP_WAIT: Duration = Duration::from_secs(10);

/// Where the Dispatcher keeps its state, socket and log.
pub(crate) fn paths() -> anyhow::Result<DispatcherPaths> {
    DispatcherPaths::from_env().context("no home directory for the Dispatcher")
}

/// The Dispatcher a command asks: the one running from `paths` if one does, or else the one
/// this computer is paired with, said hello to.
pub(crate) async fn connect(paths: &DispatcherPaths) -> anyhow::Result<DispatcherConnection> {
    reach(paths).await.map(|reached| reached.connection)
}

/// A Dispatcher a command reached, and the pairing it reached it through when it isn't here.
pub(crate) struct Reached {
    pub(crate) connection: DispatcherConnection,
    pub(crate) paired: Option<Paired>,
}

/// As [`connect`], saying which it reached.
pub(crate) async fn reach(paths: &DispatcherPaths) -> anyhow::Result<Reached> {
    let here = connect_here(paths).await;
    let here_error = match here {
        Ok(connection) => {
            return Ok(Reached {
                connection,
                paired: None,
            });
        }
        Err(error) => error,
    };
    let Some(paired) = remote_pairing()? else {
        return Err(here_error);
    };
    match paired::connect(&paired).await {
        Ok(connection) => Ok(Reached {
            connection,
            paired: Some(paired),
        }),
        Err(error) => bail!(
            "the Dispatcher on {} didn't answer at {}: {error:#}. None runs here either, from {}",
            paired.place(),
            paired.url,
            paths.dir.display()
        ),
    }
}

/// The Dispatcher this computer is paired with, unless `$WEAVE_DISPATCHER_DIR` names a
/// directory here, which keeps a development Dispatcher from ever reaching the person's own.
pub(crate) fn remote_pairing() -> anyhow::Result<Option<Paired>> {
    if std::env::var_os(DIR_VARIABLE).is_some_and(|dir| !dir.is_empty()) {
        return Ok(None);
    }
    paired::load()
}

/// The Dispatcher running from `paths`, said hello to.
pub(crate) async fn connect_here(paths: &DispatcherPaths) -> anyhow::Result<DispatcherConnection> {
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

/// Fail unless `dispatcher` answers the optional part of its API `feature` names, saying that
/// it's older than `what`, as a Dispatcher from before them is, and needs updating.
pub(crate) fn require(
    dispatcher: &DispatcherConnection,
    feature: &str,
    what: &str,
) -> anyhow::Result<()> {
    match older(dispatcher.hello(), feature, what) {
        Some(said) => bail!("{said}"),
        None => Ok(()),
    }
}

/// What to say of a Dispatcher whose hello doesn't offer `feature`: that it's older than `what`.
fn older(hello: &DispatcherHello, feature: &str, what: &str) -> Option<String> {
    (!hello.offers(feature)).then(|| {
        format!(
            "the Dispatcher runs weave {}, which is older than {what}: update weave where it runs",
            hello.version
        )
    })
}

/// Whether the Dispatcher running from `paths` answers, waiting up to [`STARTUP_WAIT`] for it.
pub(crate) async fn answers(paths: &DispatcherPaths) -> bool {
    let deadline = Instant::now() + STARTUP_WAIT;
    loop {
        if let Ok(dispatcher) = connect_here(paths).await {
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

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use weave_host_protocol::dispatcher::BOTS_FEATURE;
    use weave_host_protocol::dispatcher::PROJECTS_FEATURE;

    use super::*;

    #[test]
    fn a_dispatcher_from_before_a_feature_is_said_to_be_older() {
        let hello = DispatcherHello {
            protocol: 2,
            version: "0.1.0".to_owned(),
            id: String::new(),
            device: None,
            features: vec![PROJECTS_FEATURE.to_owned()],
        };
        assert_eq!(older(&hello, PROJECTS_FEATURE, "Projects"), None);
        assert_eq!(
            older(&hello, BOTS_FEATURE, "Bots").as_deref(),
            Some(
                "the Dispatcher runs weave 0.1.0, which is older than Bots: update weave where it \
                 runs"
            )
        );
    }
}
