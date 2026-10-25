//! The weave Host as a service of this computer's service manager: a launchd user agent on
//! macOS, a systemd user service on Linux. The manager starts it and starts it again if it
//! exits, with no idle exit. `weave daemon install` writes it, and while it's installed
//! `start`, `stop` and `restart` go through the manager, and clients never start a Host of
//! their own.
//!
//! A Host directory of its own (`WEAVE_DAEMON_DIR`) gets a service of its own, named after it.

mod launchd;
mod systemd;

use std::path::PathBuf;

use anyhow::Context;
use anyhow::bail;
use weave_host::DaemonPaths;

use crate::daemon;

/// Environment the service passes on, as it was when installed, so it uses the same places.
const PASSED_ON: [&str; 5] = [
    "WEAVE_DAEMON_DIR",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "XDG_CACHE_HOME",
];

/// The service managers the Host can be installed with.
#[derive(Clone, Copy)]
enum Manager {
    Launchd,
    Systemd,
}

impl Manager {
    /// This computer's, if weave knows it.
    fn here() -> Option<Self> {
        if cfg!(target_os = "macos") {
            Some(Self::Launchd)
        } else if cfg!(target_os = "linux") {
            Some(Self::Systemd)
        } else {
            None
        }
    }
}

fn manager() -> anyhow::Result<Manager> {
    Manager::here().context(
        "running the weave Host as a service needs launchd, on macOS, or systemd, on Linux",
    )
}

/// The name of this computer's service manager.
pub fn manager_name() -> &'static str {
    match Manager::here() {
        Some(Manager::Launchd) => "launchd",
        Some(Manager::Systemd) | None => "systemd",
    }
}

/// Whether the service manager runs the Host for `paths`.
pub fn installed(paths: &DaemonPaths) -> bool {
    match Manager::here() {
        Some(Manager::Launchd) => launchd::installed(paths),
        Some(Manager::Systemd) => systemd::installed(paths),
        None => false,
    }
}

pub async fn install(paths: &DaemonPaths) -> anyhow::Result<()> {
    match manager()? {
        Manager::Launchd => launchd::install(paths).await,
        Manager::Systemd => systemd::install(paths).await,
    }
}

pub async fn uninstall(paths: &DaemonPaths) -> anyhow::Result<()> {
    if !installed(paths) {
        bail!("the weave Host isn't installed as a service");
    }
    match manager()? {
        Manager::Launchd => launchd::uninstall(paths).await,
        Manager::Systemd => systemd::uninstall(paths).await,
    }
}

/// Start the installed service.
pub fn start(paths: &DaemonPaths) -> anyhow::Result<()> {
    match manager()? {
        Manager::Launchd => launchd::start(paths),
        Manager::Systemd => systemd::start(paths),
    }
}

/// Stop the installed service until it's started again.
pub fn stop(paths: &DaemonPaths) -> anyhow::Result<()> {
    match manager()? {
        Manager::Launchd => launchd::stop(paths),
        Manager::Systemd => systemd::stop(paths),
    }
}

/// Stop the installed service if it's running, and start it again.
pub async fn restart(paths: &DaemonPaths) -> anyhow::Result<()> {
    match manager()? {
        Manager::Launchd => {
            launchd::stop(paths)?;
            daemon::wait_until_stopped(paths).await?;
            launchd::start(paths)
        }
        // One job of systemd's, which finishes even when the restart was asked for from
        // inside the service, where stopping it ends the asker too.
        Manager::Systemd => systemd::restart(paths),
    }
}

/// What may keep the installed service from running when the person expects it to: each a
/// paragraph that says how to change it.
pub fn notes(paths: &DaemonPaths) -> Vec<String> {
    match Manager::here() {
        Some(Manager::Systemd) => systemd::notes(paths),
        Some(Manager::Launchd) | None => Vec::new(),
    }
}

/// Whether the installed service keeps running after the person logs out and after this
/// computer restarts, and if not, how to have it.
pub fn lingering_note(paths: &DaemonPaths) -> Option<String> {
    match Manager::here() {
        Some(Manager::Systemd) => systemd::lingering_note(paths),
        Some(Manager::Launchd) | None => None,
    }
}

/// The name a Host directory of its own gives its service; none for the default Host's.
fn instance(paths: &DaemonPaths) -> Option<String> {
    let default = DaemonPaths::default_dir();
    if default.as_deref() == Some(paths.dir.as_path()) {
        return None;
    }
    let name: String = paths
        .dir
        .display()
        .to_string()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect();
    Some(name.trim_matches('-').to_owned())
}

/// The weave binary the service runs: this one.
fn executable() -> anyhow::Result<PathBuf> {
    std::env::current_exe()
        .and_then(std::fs::canonicalize)
        .context("finding the weave executable")
}

/// The variables of [`PASSED_ON`] this process has.
fn passed_on() -> Vec<(String, String)> {
    PASSED_ON
        .iter()
        .filter_map(|name| Some(((*name).to_owned(), std::env::var(name).ok()?)))
        .filter(|(_, value)| !value.is_empty())
        .collect()
}

/// This user's id: the owner of the Host's directory, which this user created.
fn user_id(paths: &DaemonPaths) -> anyhow::Result<u32> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        paths
            .prepare()
            .with_context(|| format!("creating {}", paths.dir.display()))?;
        Ok(std::fs::metadata(&paths.dir)
            .with_context(|| format!("reading {}", paths.dir.display()))?
            .uid())
    }
    #[cfg(not(unix))]
    {
        let _ = paths;
        bail!("no user id on this platform")
    }
}
