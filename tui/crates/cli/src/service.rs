//! The weave Host as a launchd user agent. Until `weave daemon install` exists, it never is.

use anyhow::bail;
use weave_daemon::DaemonPaths;

/// Whether launchd runs the Host for `paths`.
pub fn installed(_paths: &DaemonPaths) -> bool {
    false
}

pub async fn install(_paths: &DaemonPaths) -> anyhow::Result<()> {
    bail!("installing the weave Host as a service isn't available yet")
}

pub async fn uninstall(_paths: &DaemonPaths) -> anyhow::Result<()> {
    bail!("the weave Host isn't installed as a service")
}

pub fn start(_paths: &DaemonPaths) -> anyhow::Result<()> {
    bail!("the weave Host isn't installed as a service")
}

pub fn stop(_paths: &DaemonPaths) -> anyhow::Result<()> {
    bail!("the weave Host isn't installed as a service")
}
