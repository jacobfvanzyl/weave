//! A key kept in a file only its user reads: the Secure Enclave's wrapped form of it on a Mac
//! that has one, otherwise the key itself, in unpadded base64url. The Dispatcher proves itself
//! to the Hosts it pairs with with one.

use std::io::Write as _;
use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use serde::Serialize;

use crate::remote::DeviceKey;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum SavedKey {
    SecureEnclave(String),
    Software(String),
}

impl DeviceKey {
    /// The key `path` keeps, or a new one written there: in the Secure Enclave when
    /// `secure_enclave` and this computer has one, otherwise in the file itself.
    pub fn kept(path: &Path, secure_enclave: bool) -> Result<Self, String> {
        if let Some(key) = Self::read(path)? {
            return Ok(key);
        }
        let key = if secure_enclave {
            Self::in_secure_enclave().unwrap_or_else(|why| {
                tracing::info!(%why, "no Secure Enclave for the key; keeping it in a file");
                Self::generate()
            })
        } else {
            Self::generate()
        };
        key.write(path)?;
        Ok(key)
    }

    /// The key `path` keeps, if it keeps one.
    pub fn read(path: &Path) -> Result<Option<Self>, String> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("reading {}: {error}", path.display())),
        };
        let saved: SavedKey = serde_json::from_slice(&bytes)
            .map_err(|error| format!("reading {}: {error}", path.display()))?;
        let decode = |text: &str| {
            URL_SAFE_NO_PAD
                .decode(text)
                .map_err(|error| format!("reading {}: {error}", path.display()))
        };
        let key = match saved {
            SavedKey::SecureEnclave(wrapped) => Self::from_wrapped(&decode(&wrapped)?)
                .map_err(|why| format!("the Secure Enclave key in {}: {why}", path.display()))?,
            SavedKey::Software(scalar) => Self::from_bytes(&decode(&scalar)?)
                .ok_or_else(|| format!("{} holds no P-256 key", path.display()))?,
        };
        Ok(Some(key))
    }

    /// Keep the key in `path`, readable only by its user, replacing the file whole.
    pub fn write(&self, path: &Path) -> Result<(), String> {
        let saved = match (self.wrapped(), self.to_bytes()) {
            (Some(wrapped), _) => SavedKey::SecureEnclave(URL_SAFE_NO_PAD.encode(wrapped)),
            (None, Some(scalar)) => SavedKey::Software(URL_SAFE_NO_PAD.encode(scalar)),
            (None, None) => return Err("the key can't be saved".to_owned()),
        };
        write_private(path, &saved).map_err(|error| format!("writing {}: {error}", path.display()))
    }
}

fn write_private(path: &Path, value: &impl Serialize) -> std::io::Result<()> {
    let json = serde_json::to_vec_pretty(value).map_err(std::io::Error::other)?;
    let temporary = path.with_extension("json.tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let written = (|| {
        let mut out = options.open(&temporary)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            out.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        out.write_all(&json)?;
        out.sync_all()
    })();
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    std::fs::rename(&temporary, path)
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn a_key_is_kept_only_for_its_user_and_comes_back() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("key.json");
        let made = DeviceKey::kept(&path, false).expect("a key");
        let kept = DeviceKey::kept(&path, false).expect("the key again");
        assert_eq!(kept.jwk(), made.jwk());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).expect("file").permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}
