//! Where the daemon keeps its socket, lock, log and session journals.

use std::path::PathBuf;

/// The daemon's directory, `$WEAVE_DAEMON_DIR` to run one beside another.
const DIR_VARIABLE: &str = "WEAVE_DAEMON_DIR";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaemonPaths {
    /// Holds the lock, the log and the journals, and the socket unless it's in
    /// `$XDG_RUNTIME_DIR`.
    pub dir: PathBuf,
    pub socket: PathBuf,
}

impl DaemonPaths {
    /// `$WEAVE_DAEMON_DIR`, or else `$XDG_STATE_HOME/weave/daemon` (by default
    /// `~/.local/state/weave/daemon`) with the socket in `$XDG_RUNTIME_DIR/weave` when that's
    /// set.
    pub fn from_env() -> Option<Self> {
        if let Some(dir) = std::env::var_os(DIR_VARIABLE).filter(|dir| !dir.is_empty()) {
            return Some(Self::in_dir(PathBuf::from(dir)));
        }
        let state = std::env::var_os("XDG_STATE_HOME")
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from)
            .or_else(|| home().map(|home| home.join(".local/state")))?;
        let dir = state.join("weave/daemon");
        let socket = std::env::var_os("XDG_RUNTIME_DIR")
            .filter(|dir| !dir.is_empty())
            .map_or_else(
                || dir.join("daemon.sock"),
                |runtime| PathBuf::from(runtime).join("weave/daemon.sock"),
            );
        Some(Self { dir, socket })
    }

    /// Everything, socket included, in `dir`.
    pub fn in_dir(dir: PathBuf) -> Self {
        Self {
            socket: dir.join("daemon.sock"),
            dir,
        }
    }

    /// Create the directory, and the socket's, readable only by the user.
    pub fn prepare(&self) -> std::io::Result<()> {
        crate::journal::create_private_dir(&self.dir)?;
        match self.socket.parent() {
            Some(parent) => crate::journal::create_private_dir(parent),
            None => Ok(()),
        }
    }

    /// Held for as long as a daemon serves this directory.
    pub fn lock(&self) -> PathBuf {
        self.dir.join("daemon.lock")
    }

    /// Where a daemon started in the background writes its diagnostics.
    pub fn log(&self) -> PathBuf {
        self.dir.join("daemon.log")
    }

    /// One JSONL journal per session.
    pub fn journals(&self) -> PathBuf {
        self.dir.join("sessions")
    }
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn a_directory_holds_everything() {
        let paths = DaemonPaths::in_dir("/tmp/weave-dev".into());
        assert_eq!(paths.socket, PathBuf::from("/tmp/weave-dev/daemon.sock"));
        assert_eq!(paths.lock(), PathBuf::from("/tmp/weave-dev/daemon.lock"));
        assert_eq!(paths.journals(), PathBuf::from("/tmp/weave-dev/sessions"));
    }
}
