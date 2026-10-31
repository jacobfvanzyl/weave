//! Where the daemon keeps its socket, lock, log and session journals.

use std::path::PathBuf;

/// The daemon's directory, `$WEAVE_DAEMON_DIR` to run one beside another.
const DIR_VARIABLE: &str = "WEAVE_DAEMON_DIR";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaemonPaths {
    /// Holds the lock, the log and the journals, and the socket unless it's in the user's
    /// runtime directory.
    pub dir: PathBuf,
    pub socket: PathBuf,
}

impl DaemonPaths {
    /// `$WEAVE_DAEMON_DIR`, or else `$XDG_STATE_HOME/weave/daemon` (by default
    /// `~/.local/state/weave/daemon`) with the socket in the user's runtime directory, under
    /// `weave/`, when they have one.
    pub fn from_env() -> Option<Self> {
        if let Some(dir) = std::env::var_os(DIR_VARIABLE).filter(|dir| !dir.is_empty()) {
            return Some(Self::in_dir(PathBuf::from(dir)));
        }
        let dir = Self::default_dir()?;
        let socket = runtime_dir().map_or_else(
            || dir.join("daemon.sock"),
            |runtime| runtime.join("weave/daemon.sock"),
        );
        Some(Self { dir, socket })
    }

    /// The per-user Host's directory when `$WEAVE_DAEMON_DIR` doesn't name another:
    /// `$XDG_STATE_HOME/weave/daemon`, by default `~/.local/state/weave/daemon`.
    pub fn default_dir() -> Option<PathBuf> {
        let state = std::env::var_os("XDG_STATE_HOME")
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from)
            .or_else(|| home().map(|home| home.join(".local/state")))?;
        Some(state.join("weave/daemon"))
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

    /// The Host's id and the devices it accepts remote clients from.
    pub fn devices(&self) -> PathBuf {
        self.dir.join("devices.json")
    }

    /// The person's other Hosts this one pairs with as peers, and the turns it follows there.
    pub fn peers(&self) -> PathBuf {
        self.dir.join("peers.json")
    }

    /// The key the Host proves itself to its peers with: its wrapped Secure Enclave key, or
    /// the key itself where there's no Secure Enclave.
    pub fn host_key(&self) -> PathBuf {
        self.dir.join("host-key.json")
    }

    /// The Host MCP server's socket, which `weave mcp-bridge` connects to: beside the Host's.
    pub fn mcp_socket(&self) -> PathBuf {
        self.socket.with_file_name("mcp.sock")
    }

    /// The holders of the Host's terminals: their records, sockets and Ghostty's resources.
    pub fn terminals(&self) -> PathBuf {
        self.dir.join("terminals")
    }
}

/// `$XDG_RUNTIME_DIR`, or on Linux the directory systemd keeps for the user, which a login
/// would have set it to: a session that sets nothing, as over Tailscale SSH or `su`, finds
/// the socket of a Host systemd started all the same.
fn runtime_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR").filter(|dir| !dir.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    #[cfg(target_os = "linux")]
    {
        // SAFETY: getuid has no preconditions and can't fail.
        let uid = unsafe { libc::getuid() };
        owned_dir(PathBuf::from(format!("/run/user/{uid}")), uid)
    }
    #[cfg(not(target_os = "linux"))]
    None
}

/// `dir`, if it's a directory `uid` owns.
#[cfg(any(target_os = "linux", all(unix, test)))]
fn owned_dir(dir: PathBuf, uid: u32) -> Option<PathBuf> {
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::metadata(&dir).ok()?;
    (metadata.is_dir() && metadata.uid() == uid).then_some(dir)
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

    #[cfg(unix)]
    #[test]
    fn a_runtime_directory_counts_only_when_its_the_users() {
        use std::os::unix::fs::MetadataExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let uid = std::fs::metadata(dir.path()).expect("metadata").uid();
        let path = dir.path().to_path_buf();
        assert_eq!(owned_dir(path.clone(), uid), Some(path.clone()));
        assert_eq!(owned_dir(path.clone(), uid + 1), None);
        assert_eq!(owned_dir(path.join("missing"), uid), None);
    }

    #[test]
    fn a_directory_holds_everything() {
        let paths = DaemonPaths::in_dir("/tmp/weave-dev".into());
        assert_eq!(paths.socket, PathBuf::from("/tmp/weave-dev/daemon.sock"));
        assert_eq!(paths.lock(), PathBuf::from("/tmp/weave-dev/daemon.lock"));
        assert_eq!(paths.journals(), PathBuf::from("/tmp/weave-dev/sessions"));
    }
}
