//! `agents.lock`, beside the config file: the versions of presets that `weave update` moved
//! past weave's built-in ones. Every agent launch reads it, the Host's included, so a new
//! version applies to the next session without a rebuild. The newer of a preset's built-in
//! and locked version is the one launched, so a weave with bumped presets isn't held back by
//! an old lock; an entry for another package than the preset's is ignored.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;

use anyhow::Context;
use serde::Deserialize;
use serde::Serialize;
use weave_acp_core::Preset;

/// The file's name, in the config file's directory.
pub const FILE: &str = "agents.lock";

const HEADER: &str = "# Written by `weave update`: newer versions of the agents weave launches than its\n\
                      # built-in ones. `weave update --reset` goes back to those.\n\n";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Lock {
    /// By agent id.
    pub agents: BTreeMap<String, Locked>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Locked {
    pub package: String,
    pub version: String,
}

impl Lock {
    /// Where the lock for the config file at `config` is.
    pub fn beside(config: &Path) -> PathBuf {
        config.with_file_name(FILE)
    }

    /// The lock at `path`; none when there's no file.
    pub fn read(path: &Path) -> anyhow::Result<Self> {
        match std::fs::read_to_string(path) {
            Ok(text) => {
                toml::from_str(&text).with_context(|| format!("reading {}", path.display()))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(error).with_context(|| format!("reading {}", path.display())),
        }
    }

    /// Replace the file at `path` whole, or remove it when nothing is locked.
    pub fn write(&self, path: &Path) -> anyhow::Result<()> {
        if self.agents.is_empty() {
            return match std::fs::remove_file(path) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    Err(error).with_context(|| format!("removing {}", path.display()))
                }
                _ => Ok(()),
            };
        }
        let text = format!("{HEADER}{}", toml::to_string(self)?);
        let dir = path.parent().context("the lock's directory")?;
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        let temporary = dir.join(format!(".{FILE}-{}", std::process::id()));
        std::fs::write(&temporary, text)
            .and_then(|()| std::fs::rename(&temporary, path))
            .with_context(|| format!("writing {}", path.display()))
            .inspect_err(|_| {
                let _ = std::fs::remove_file(&temporary);
            })
    }

    /// The version of `preset` to launch: the newer of its built-in one and the locked one.
    pub fn version_of(&self, preset: &Preset) -> String {
        match self.agents.get(preset.id) {
            Some(locked)
                if locked.package == preset.package
                    && compare(&locked.version, preset.version) == Ordering::Greater =>
            {
                locked.version.clone()
            }
            _ => preset.version.to_owned(),
        }
    }

    /// Lock `preset` at `version`.
    pub fn set(&mut self, preset: &Preset, version: &str) {
        self.agents.insert(
            preset.id.to_owned(),
            Locked {
                package: preset.package.to_owned(),
                version: version.to_owned(),
            },
        );
    }
}

/// Compare two versions as `major.minor.patch`, numerically part by part. A pre-release
/// (`1.2.0-beta.1`) comes before its release; parts that aren't numbers compare as text.
pub fn compare(a: &str, b: &str) -> Ordering {
    let split = |version: &str| -> (Vec<String>, Option<String>) {
        let version = version.trim().trim_start_matches('v');
        let (release, pre) = match version.split_once('-') {
            Some((release, pre)) => (release, Some(pre.to_owned())),
            None => (version, None),
        };
        let release = release.split_once('+').map_or(release, |(core, _)| core);
        (release.split('.').map(str::to_owned).collect(), pre)
    };
    let part = |a: &str, b: &str| match (a.parse::<u64>(), b.parse::<u64>()) {
        (Ok(a), Ok(b)) => a.cmp(&b),
        _ => a.cmp(b),
    };
    let ((a_release, a_pre), (b_release, b_pre)) = (split(a), split(b));
    let length = a_release.len().max(b_release.len());
    for index in 0..length {
        let a_part = a_release.get(index).map_or("0", String::as_str);
        let b_part = b_release.get(index).map_or("0", String::as_str);
        match part(a_part, b_part) {
            Ordering::Equal => {}
            other => return other,
        }
    }
    match (a_pre, b_pre) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(a), Some(b)) => a
            .split('.')
            .zip(b.split('.'))
            .map(|(a, b)| part(a, b))
            .find(|ordering| *ordering != Ordering::Equal)
            .unwrap_or_else(|| a.split('.').count().cmp(&b.split('.').count())),
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn claude() -> &'static Preset {
        Preset::find("claude").expect("claude")
    }

    #[test]
    fn versions_compare_by_number_and_pre_releases_come_first() {
        assert_eq!(compare("0.93.0", "0.86.0"), Ordering::Greater);
        assert_eq!(compare("0.100.0", "0.99.9"), Ordering::Greater);
        assert_eq!(compare("2.2.2", "2.2.2"), Ordering::Equal);
        assert_eq!(compare("2.2", "2.2.0"), Ordering::Equal);
        assert_eq!(compare("1.0.0-beta.2", "1.0.0"), Ordering::Less);
        assert_eq!(compare("1.0.0-beta.10", "1.0.0-beta.2"), Ordering::Greater);
        assert_eq!(compare("v1.2.3", "1.2.3+build.5"), Ordering::Equal);
    }

    #[test]
    fn the_newer_of_built_in_and_locked_is_launched() {
        let mut lock = Lock::default();
        assert_eq!(lock.version_of(claude()), claude().version);
        lock.set(claude(), "99.0.0");
        assert_eq!(lock.version_of(claude()), "99.0.0");
        lock.set(claude(), "0.0.1");
        assert_eq!(lock.version_of(claude()), claude().version, "not held back");
        lock.agents.insert(
            "claude".to_owned(),
            Locked {
                package: "@someone/else".to_owned(),
                version: "99.0.0".to_owned(),
            },
        );
        assert_eq!(
            lock.version_of(claude()),
            claude().version,
            "another package"
        );
    }

    #[test]
    fn the_lock_is_written_whole_and_removed_when_empty() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = Lock::beside(&dir.path().join("config.toml"));
        assert_eq!(path, dir.path().join(FILE));
        assert_eq!(Lock::read(&path).expect("none yet"), Lock::default());
        let mut lock = Lock::default();
        lock.set(claude(), "99.0.0");
        lock.write(&path).expect("written");
        let text = std::fs::read_to_string(&path).expect("a file");
        assert!(text.starts_with("# Written by `weave update`"), "{text}");
        assert!(text.contains("[claude]\npackage = \"@agentclientprotocol/claude-agent-acp\"\nversion = \"99.0.0\""), "{text}");
        assert_eq!(Lock::read(&path).expect("read back"), lock);
        Lock::default().write(&path).expect("emptied");
        assert!(!path.exists());
        assert!(Lock::read(&dir.path().join("nested").join(FILE)).is_ok());
    }
}
