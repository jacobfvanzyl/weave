//! The weave Host as a service of this computer's service manager: a launchd user agent on
//! macOS, a systemd user service on Linux. The manager starts it and starts it again if it
//! exits, with no idle exit. `weave daemon install` writes it, and while it's installed
//! `start`, `stop` and `restart` go through the manager, and clients never start a Host of
//! their own.
//!
//! A Host directory of its own (`WEAVE_DAEMON_DIR`) gets a service of its own, named after it.

mod launchd;
mod systemd;

use std::path::Path;
use std::path::PathBuf;
use std::process::Stdio;

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
        Manager::Launchd => launchd::install(paths).await?,
        Manager::Systemd => systemd::install(paths).await?,
    }
    if let Some(note) = ssh_note() {
        eprintln!("\n{note}");
    }
    Ok(())
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

/// What may keep the installed service from running, or from being managed over SSH, when the
/// person expects it to: each a paragraph that says how to change it.
pub fn notes(paths: &DaemonPaths) -> Vec<String> {
    let mut notes = match Manager::here() {
        Some(Manager::Systemd) => systemd::notes(paths),
        Some(Manager::Launchd) | None => Vec::new(),
    };
    notes.extend(ssh_note());
    notes
}

/// The `PATH` sshd gives a command before the user's shell adds to it.
const SSH_PATH: &str = if cfg!(target_os = "macos") {
    "/usr/bin:/bin:/usr/sbin:/sbin"
} else {
    "/usr/local/bin:/usr/bin:/bin"
};

/// Whether `ssh <this computer> weave …` finds weave, as ADR 0017's management over SSH needs,
/// and if not, how to have it. The login shell runs as sshd runs a command: without a login or
/// a terminal, from sshd's `PATH`, so it reads `~/.zshenv` but not `~/.zprofile` or
/// `~/.zshrc`, and bash on Debian or Ubuntu stops early in `~/.bashrc`. None when it finds
/// weave, or the shell can't be run to tell.
pub fn ssh_note() -> Option<String> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|shell| !shell.is_empty())?;
    let mut command = std::process::Command::new(&shell);
    command
        .args(["-c", "command -v weave"])
        .env_clear()
        .env("PATH", SSH_PATH)
        .env("SSH_CLIENT", "127.0.0.1 22 22")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for name in ["HOME", "USER", "LOGNAME", "SHELL"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    if command.status().ok()?.success() {
        return None;
    }
    let weave = std::env::current_exe().ok()?;
    Some(ssh_advice(&shell, &weave))
}

/// How to have a command over SSH find `weave`, for a login `shell`.
fn ssh_advice(shell: &str, weave: &Path) -> String {
    let name = Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(shell);
    let fix = match (name, weave.parent()) {
        ("zsh", Some(dir)) => format!(
            "add `export PATH=\"{}:$PATH\"` to ~/.zshenv, which zsh reads for a command over SSH",
            dir.display()
        ),
        _ => "link it into /usr/local/bin".to_owned(),
    };
    format!(
        "A command over SSH (`ssh <this computer> weave …`) doesn't find weave: {name} runs it \
         without a login, on sshd's PATH. To have it, {fix}; or name it by path, {}.",
        weave.display()
    )
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_over_ssh_is_told_where_weave_is_for_its_shell() {
        let weave = Path::new("/Users/me/.local/bin/weave");
        let zsh = ssh_advice("/bin/zsh", weave);
        assert!(
            zsh.contains("add `export PATH=\"/Users/me/.local/bin:$PATH\"` to ~/.zshenv"),
            "{zsh}"
        );
        assert!(
            zsh.ends_with("by path, /Users/me/.local/bin/weave."),
            "{zsh}"
        );
        let bash = ssh_advice("/usr/bin/bash", weave);
        assert!(bash.contains("link it into /usr/local/bin"), "{bash}");
        assert!(bash.contains("bash runs it without a login"), "{bash}");
    }
}
