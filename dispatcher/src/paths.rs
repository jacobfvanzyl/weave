//! Where the Dispatcher keeps its state: `$WEAVE_DISPATCHER_DIR`, or else
//! `$XDG_STATE_HOME/weave/dispatcher`, by default `~/.local/state/weave/dispatcher`.

use std::path::PathBuf;

/// Names another directory for the Dispatcher's state, as for a development Dispatcher.
pub const DIR_VARIABLE: &str = "WEAVE_DISPATCHER_DIR";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DispatcherPaths {
    pub dir: PathBuf,
}

impl DispatcherPaths {
    pub fn from_env() -> Option<Self> {
        if let Some(dir) = std::env::var_os(DIR_VARIABLE).filter(|dir| !dir.is_empty()) {
            return Some(Self::in_dir(PathBuf::from(dir)));
        }
        Self::default_dir().map(Self::in_dir)
    }

    /// The Dispatcher's directory when `$WEAVE_DISPATCHER_DIR` doesn't name another.
    pub fn default_dir() -> Option<PathBuf> {
        let state = std::env::var_os("XDG_STATE_HOME")
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .filter(|home| !home.is_empty())
                    .map(|home| PathBuf::from(home).join(".local/state"))
            })?;
        Some(state.join("weave/dispatcher"))
    }

    pub fn in_dir(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// Create the directory, readable only by the user, which keeps the database's own files
    /// from others too.
    pub fn prepare(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&self.dir, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }

    /// The socket the `weave dispatcher` CLI asks it over.
    pub fn socket(&self) -> PathBuf {
        self.dir.join("dispatcher.sock")
    }

    /// Held for as long as a Dispatcher runs from this directory.
    pub fn lock(&self) -> PathBuf {
        self.dir.join("dispatcher.lock")
    }

    pub fn database(&self) -> PathBuf {
        self.dir.join("dispatcher.db")
    }

    /// The key it proves itself to Hosts with, kept as a Host keeps its own.
    pub fn key(&self) -> PathBuf {
        self.dir.join("key.json")
    }

    /// Where its service writes its diagnostics.
    pub fn log(&self) -> PathBuf {
        self.dir.join("dispatcher.log")
    }
}
