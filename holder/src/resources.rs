//! Ghostty's resources, its terminfo and shell integration, which `build.rs` embeds in the holder
//! and the holder writes out once per Ghostty commit, where its shells can find them.

use std::fs;
use std::io;
use std::path::Path;
use std::path::PathBuf;

use crate::vt::GHOSTTY_COMMIT;

mod embedded {
    include!(concat!(env!("OUT_DIR"), "/resources.rs"));
}

/// Where Ghostty's resources are for a holder's shells.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resources {
    root: PathBuf,
}

impl Resources {
    /// `share/terminfo`, for `TERMINFO`.
    pub fn terminfo(&self) -> PathBuf {
        self.root.join("share/terminfo")
    }

    /// `share/ghostty`, for `GHOSTTY_RESOURCES_DIR`, which holds `shell-integration/`.
    pub fn ghostty(&self) -> PathBuf {
        self.root.join("share/ghostty")
    }
}

/// The resources in `dir/resources/<commit>`, written there first unless an earlier holder did.
/// None when this build embeds none (`$GHOSTTY_VT_PREFIX` named a build without them).
pub fn materialize(dir: &Path) -> io::Result<Option<Resources>> {
    if embedded::FILES.is_empty() {
        return Ok(None);
    }
    let parent = dir.join("resources");
    let root = parent.join(GHOSTTY_COMMIT);
    let complete = root.join(".complete");
    if !complete.exists() {
        let staging = parent.join(format!("{GHOSTTY_COMMIT}.{}.partial", std::process::id()));
        let _ = fs::remove_dir_all(&staging);
        for (path, bytes) in embedded::FILES {
            let file = staging.join(path);
            if let Some(parent) = file.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&file, bytes)?;
        }
        fs::write(staging.join(".complete"), "")?;
        // A holder that starts at the same time may have written them first.
        if let Err(error) = fs::rename(&staging, &root) {
            let _ = fs::remove_dir_all(&staging);
            if !complete.exists() {
                return Err(error);
            }
        }
    }
    Ok(Some(Resources { root }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_the_terminfo_and_shell_integration_once() {
        let dir = tempfile::tempdir().unwrap();
        let resources = materialize(dir.path()).unwrap().unwrap();
        assert!(
            resources
                .ghostty()
                .join("shell-integration/zsh/.zshenv")
                .is_file()
        );
        assert!(
            resources
                .ghostty()
                .join("shell-integration/bash/ghostty.bash")
                .is_file()
        );
        assert!(resources.terminfo().join("ghostty.terminfo").is_file());
        let compiled = std::process::Command::new("infocmp")
            .arg("xterm-ghostty")
            .env("TERMINFO", resources.terminfo())
            .output()
            .unwrap();
        assert!(compiled.status.success(), "{compiled:?}");

        // A second holder finds them in place.
        assert_eq!(materialize(dir.path()).unwrap(), Some(resources));
    }
}
