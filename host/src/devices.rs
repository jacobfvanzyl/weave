//! The Host's id and the Dispatcher it joined (`devices.json`, 0600).
//!
//! The Dispatcher the Host joined (ADR 0030) is kept as a service, so the tools it declared and
//! whether it reaches the person's other Hosts (ADR 0029) outlive its connections, and marked
//! joined. It is taken at hello only on the connection the Host opened to it
//! ([`crate::dispatcher`]), proving its key by signing the connection's challenge; the Host keeps
//! no secret for it.
//!
//! The person's devices pair with the Dispatcher and reach the Host through it, and a Host pairs
//! with nothing (WVE-197). Hosts before kept the devices and services that paired with them here,
//! and before ADR 0029 their peer Hosts (ADR 0017). A Host drops them when it loads them, and
//! notes that it served remote clients, so it removes the Tailscale Serve entry it made for them
//! ([`crate::serve_entry`]) and nothing else does.

use std::io::Write as _;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Deserialize;
use serde::Serialize;
use weave_host_protocol::Timestamp;
use weave_host_protocol::devices::DeviceId;
use weave_host_protocol::devices::DeviceInfo;
use weave_host_protocol::devices::Jwk;
use weave_host_protocol::devices::auth_message;
use weave_host_protocol::tools::Tool;
pub(crate) use weave_remote::pairing::random_bytes;
pub(crate) use weave_remote::pairing::random_id;
use weave_remote::pairing::signed;

use crate::journal::now_ms;
use crate::service_tools;
use crate::thread::lock;

pub(crate) struct Devices {
    /// `devices.json`; none for a Host that keeps it in memory only.
    path: Option<PathBuf>,
    state: Mutex<State>,
}

struct State {
    host_id: String,
    /// The Dispatcher the Host joined, if it joined one.
    joined: Option<Stored>,
    /// The Host served remote clients before WVE-197, and may have the Serve entry it made for
    /// them left.
    serve_entry_left: bool,
}

/// `devices.json`.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct File {
    host_id: String,
    /// The Dispatcher the Host joined, and before WVE-197 the devices that paired with it.
    #[serde(default)]
    devices: Vec<Stored>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    serve_entry_left: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    id: DeviceId,
    name: String,
    public_key: Jwk,
    paired_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_seen_at: Option<Timestamp>,
    /// A service: the Dispatcher always, and before WVE-197 a service that paired (ADR 0027).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    service: bool,
    /// The tools it declared, which threads offer (WVE-171).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tools: Vec<Tool>,
    /// It reaches the person's other Hosts, as it declared with its tools (ADR 0029).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    hosts: bool,
    /// The Dispatcher the Host joined (ADR 0030), rather than a device that paired before
    /// WVE-197. Written still, so an older weave reading the file doesn't take it for one.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    joined: bool,
}

impl Stored {
    fn info(&self) -> DeviceInfo {
        DeviceInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            service: self.service,
        }
    }
}

impl Devices {
    /// What `path` records, or a new id; without a path, in memory only. Devices that paired
    /// with the Host before WVE-197 are dropped, the file noting it served remote clients.
    pub(crate) fn load(path: Option<PathBuf>) -> Self {
        let read = path.as_deref().and_then(|path| match std::fs::read(path) {
            Ok(bytes) => match serde_json::from_slice::<File>(&bytes) {
                Ok(file) => Some(file),
                Err(error) => {
                    tracing::warn!(%error, path = %path.display(), "devices unreadable; starting with none");
                    None
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                tracing::warn!(%error, path = %path.display(), "devices unreadable; starting with none");
                None
            }
        });
        let fresh = read.is_none();
        let file = read.unwrap_or_else(|| File {
            host_id: random_id(16),
            devices: Vec::new(),
            serve_entry_left: false,
        });
        let (joined, paired): (Vec<Stored>, Vec<Stored>) =
            file.devices.into_iter().partition(|stored| stored.joined);
        for device in &paired {
            tracing::info!(device = %device.id, name = %device.name, "forgot a device that paired with this Host: devices pair with the Dispatcher and reach Hosts through it now");
        }
        let devices = Self {
            path,
            state: Mutex::new(State {
                host_id: file.host_id,
                joined: joined.into_iter().next_back(),
                serve_entry_left: file.serve_entry_left || !paired.is_empty(),
            }),
        };
        if fresh || !paired.is_empty() {
            devices.save(&lock(&devices.state));
        }
        devices
    }

    pub(crate) fn host_id(&self) -> String {
        lock(&self.state).host_id.clone()
    }

    /// The Dispatcher the Host joined, `device_id`, when `signature` is its signature of the
    /// connection's challenge `nonce`.
    pub(crate) fn verify(
        &self,
        device_id: &str,
        nonce: &str,
        signature: &str,
    ) -> Option<DeviceInfo> {
        let mut state = lock(&self.state);
        let message = auth_message(&state.host_id, device_id, nonce);
        let stored = state
            .joined
            .as_mut()
            .filter(|stored| stored.id == device_id)?;
        if !signed(&stored.public_key, &message, signature) {
            return None;
        }
        stored.last_seen_at = Some(now_ms());
        let info = stored.info();
        self.save(&state);
        Some(info)
    }

    /// Whether `signature` is the Dispatcher `dispatcher_id`'s, which the Host joined, of
    /// `message`: signed with the key the Host learned when it joined (WVE-195).
    pub(crate) fn joined_signed(
        &self,
        dispatcher_id: &str,
        message: &str,
        signature: &str,
    ) -> bool {
        lock(&self.state)
            .joined
            .as_ref()
            .filter(|stored| stored.id == dispatcher_id)
            .is_some_and(|stored| signed(&stored.public_key, message, signature))
    }

    /// Keep the Dispatcher the Host joined, `id` with `public_key`, as a service, in place of
    /// any it joined before.
    pub(crate) fn join(&self, id: &str, name: &str, public_key: Jwk) {
        let mut state = lock(&self.state);
        state.joined = Some(Stored {
            id: id.to_owned(),
            name: name.to_owned(),
            public_key,
            paired_at: now_ms(),
            last_seen_at: None,
            service: true,
            tools: Vec::new(),
            hosts: false,
            joined: true,
        });
        self.save(&state);
    }

    /// Forget the Dispatcher the Host joined, and the tools it declared.
    pub(crate) fn leave(&self) {
        let mut state = lock(&self.state);
        if state.joined.take().is_some() {
            self.save(&state);
        }
    }

    /// Whether the Host served remote clients before WVE-197 and may have the Serve entry it
    /// made for them left: only then may it touch Tailscale Serve.
    pub(crate) fn serve_entry_left(&self) -> bool {
        lock(&self.state).serve_entry_left
    }

    /// The Serve entry the Host made for remote clients is gone.
    pub(crate) fn serve_entry_removed(&self) {
        let mut state = lock(&self.state);
        if state.serve_entry_left {
            state.serve_entry_left = false;
            self.save(&state);
        }
    }

    /// Replace the tools the service `device_id` serves with `tools`, and say whether it reaches
    /// the person's other Hosts: the names agents see, or why they can't be declared. Only the
    /// Dispatcher the Host joined is a service.
    pub(crate) fn declare_tools(
        &self,
        device_id: &str,
        tools: Vec<Tool>,
        hosts: bool,
    ) -> Result<Vec<String>, String> {
        let mut state = lock(&self.state);
        let Some(stored) = state
            .joined
            .as_mut()
            .filter(|stored| stored.id == device_id && stored.service)
        else {
            return Err("only a service declares tools".to_owned());
        };
        let names = service_tools::named(&service_tools::prefix(&stored.name), &tools)?;
        stored.tools = tools;
        stored.hosts = hosts;
        self.save(&state);
        Ok(names)
    }

    /// Every tool the Dispatcher declared, as threads offer them.
    pub(crate) fn service_tools(&self) -> Vec<service_tools::Offered> {
        let state = lock(&self.state);
        state
            .joined
            .iter()
            .filter(|stored| stored.service)
            .flat_map(|stored| {
                let prefix = service_tools::prefix(&stored.name);
                stored.tools.iter().map(move |tool| service_tools::Offered {
                    tool: Tool {
                        name: format!("{prefix}__{}", tool.name),
                        ..tool.clone()
                    },
                    own: tool.name.clone(),
                    service: stored.id.clone(),
                    service_name: stored.name.clone(),
                })
            })
            .collect()
    }

    /// The service that reaches the person's other Hosts, if the Dispatcher said so: its id and
    /// name.
    pub(crate) fn hosts_service(&self) -> Option<(DeviceId, String)> {
        lock(&self.state)
            .joined
            .as_ref()
            .filter(|stored| stored.service && stored.hosts)
            .map(|stored| (stored.id.clone(), stored.name.clone()))
    }

    /// Write `state`, replacing the file whole.
    fn save(&self, state: &State) {
        let Some(path) = &self.path else {
            return;
        };
        let file = File {
            host_id: state.host_id.clone(),
            devices: state.joined.iter().cloned().collect(),
            serve_entry_left: state.serve_entry_left,
        };
        if let Err(error) = write_private(path, &file) {
            tracing::warn!(%error, path = %path.display(), "writing devices failed");
        }
    }
}

/// Write `value` to `path` as JSON only the Host's user can read, replacing the file whole.
pub(crate) fn write_private(path: &Path, value: &impl Serialize) -> std::io::Result<()> {
    let json = serde_json::to_vec_pretty(value).map_err(std::io::Error::other)?;
    let temporary = path.with_extension("json.tmp");
    let written = (|| {
        let mut out = crate::journal::private_file(&temporary, true)?;
        out.write_all(&json)?;
        out.sync_all()?;
        std::fs::rename(&temporary, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use p256::ecdsa::Signature;
    use p256::ecdsa::SigningKey;
    use p256::ecdsa::signature::Signer as _;
    use pretty_assertions::assert_eq;

    use super::*;

    fn key() -> (SigningKey, Jwk) {
        let signing = SigningKey::from_slice(&random_bytes::<32>()).expect("a scalar");
        let point = signing.verifying_key().to_sec1_point(false);
        let bytes = point.as_bytes();
        let jwk = Jwk {
            kty: "EC".to_owned(),
            crv: "P-256".to_owned(),
            x: URL_SAFE_NO_PAD.encode(&bytes[1..33]),
            y: URL_SAFE_NO_PAD.encode(&bytes[33..65]),
        };
        (signing, jwk)
    }

    fn sign(key: &SigningKey, host_id: &str, device_id: &str, nonce: &str) -> String {
        let signature: Signature = key.sign(auth_message(host_id, device_id, nonce).as_bytes());
        URL_SAFE_NO_PAD.encode(signature.to_der().as_bytes())
    }

    fn read(path: &Path) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(path).expect("devices.json")).expect("JSON")
    }

    #[test]
    fn a_host_in_a_new_directory_served_no_remote_clients() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("devices.json");
        let devices = Devices::load(Some(path.clone()));
        assert!(!devices.serve_entry_left());
        let written = read(&path);
        assert_eq!(written["hostId"], devices.host_id().as_str());
        assert_eq!(written.get("serveEntryLeft"), None);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).expect("file").permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // Joining a Dispatcher is no sign of remote clients either.
        let (_, jwk) = key();
        devices.join("D-1", "Dispatcher on homelab-1", jwk);
        assert!(!Devices::load(Some(path)).serve_entry_left());
    }

    #[test]
    fn devices_that_paired_with_the_host_are_dropped_and_it_notes_it_served_them() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("devices.json");
        let (_, jwk) = key();
        let file = serde_json::json!({
            "hostId": "h-1",
            "devices": [
                {"id": "d-ipad", "name": "iPad", "publicKey": jwk, "pairedAt": 1, "lastSeenAt": 2},
                {"id": "d-peer", "name": "mini", "publicKey": jwk, "pairedAt": 1, "host": "h-2"},
                {"id": "d-bridge", "name": "Bridge", "publicKey": jwk, "pairedAt": 1, "service": true},
                {"id": "D-1", "name": "Dispatcher", "publicKey": jwk, "pairedAt": 1, "service": true,
                 "joined": true, "hosts": true}
            ]
        });
        std::fs::write(&path, file.to_string()).expect("write");

        let devices = Devices::load(Some(path.clone()));
        assert_eq!(devices.host_id(), "h-1");
        assert!(devices.serve_entry_left());
        assert_eq!(
            devices.hosts_service(),
            Some(("D-1".to_owned(), "Dispatcher".to_owned()))
        );
        let written = read(&path);
        let kept: Vec<&str> = written["devices"]
            .as_array()
            .expect("devices")
            .iter()
            .filter_map(|device| device["id"].as_str())
            .collect();
        assert_eq!(kept, vec!["D-1"]);
        assert_eq!(written["devices"][0]["joined"], true);
        assert_eq!(written["serveEntryLeft"], true);

        // It stays noted until the entry is gone, across restarts.
        let reloaded = Devices::load(Some(path.clone()));
        assert!(reloaded.serve_entry_left());
        reloaded.serve_entry_removed();
        assert_eq!(read(&path).get("serveEntryLeft"), None);
        assert!(!Devices::load(Some(path)).serve_entry_left());
    }

    #[test]
    fn the_dispatcher_it_joined_proves_its_key_and_leaving_forgets_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("devices.json");
        let devices = Devices::load(Some(path.clone()));
        let host_id = devices.host_id();
        let (signing, jwk) = key();
        devices.join("D-1", "Dispatcher on homelab-1", jwk);

        let signature = sign(&signing, &host_id, "D-1", "n1");
        let joined = devices
            .verify("D-1", "n1", &signature)
            .expect("the Dispatcher");
        assert!(joined.service);
        assert_eq!(joined.name, "Dispatcher on homelab-1");
        assert!(
            devices.verify("D-1", "n2", &signature).is_none(),
            "another nonce"
        );
        assert!(
            devices.verify("D-2", "n1", &signature).is_none(),
            "another id"
        );
        let (other, _) = key();
        let forged = sign(&other, &host_id, "D-1", "n1");
        assert!(
            devices.verify("D-1", "n1", &forged).is_none(),
            "another key"
        );

        // Joining another Dispatcher replaces it.
        let (second, jwk) = key();
        devices.join("D-2", "Dispatcher on studio", jwk);
        assert!(devices.verify("D-1", "n1", &signature).is_none());
        let signature = sign(&second, &host_id, "D-2", "n3");
        assert!(devices.verify("D-2", "n3", &signature).is_some());

        // It outlives the Host, and leaving forgets it.
        let reloaded = Devices::load(Some(path.clone()));
        assert_eq!(reloaded.host_id(), host_id);
        assert!(reloaded.verify("D-2", "n3", &signature).is_some());
        reloaded.leave();
        assert!(
            Devices::load(Some(path))
                .verify("D-2", "n3", &signature)
                .is_none()
        );
    }

    #[test]
    fn the_dispatcher_declares_tools_and_says_it_reaches_the_hosts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("devices.json");
        let devices = Devices::load(Some(path.clone()));
        let tool = Tool {
            name: "add_schedule".to_owned(),
            title: "Add a schedule".to_owned(),
            description: "Add a schedule to the Dispatcher".to_owned(),
            input_schema: serde_json::json!({"type": "object"}),
        };
        assert!(
            devices
                .declare_tools("D-1", vec![tool.clone()], true)
                .is_err(),
            "only the Dispatcher it joined declares tools"
        );
        let (_, jwk) = key();
        devices.join("D-1", "Dispatcher", jwk);
        assert_eq!(devices.hosts_service(), None);
        let names = devices
            .declare_tools("D-1", vec![tool], true)
            .expect("declared");
        assert_eq!(names, vec!["dispatcher__add_schedule".to_owned()]);
        let reloaded = Devices::load(Some(path));
        assert_eq!(
            reloaded.hosts_service(),
            Some(("D-1".to_owned(), "Dispatcher".to_owned()))
        );
        assert_eq!(
            reloaded
                .service_tools()
                .into_iter()
                .map(|offered| offered.tool.name)
                .collect::<Vec<_>>(),
            vec!["dispatcher__add_schedule".to_owned()]
        );
    }
}
