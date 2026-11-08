//! Paired devices: the Host's id, the devices it accepts remote clients from and their public
//! keys (`devices.json`, 0600), the pairing offers `weave pair` makes, and which connections
//! each device has open, so revoking it closes them.
//!
//! The Host keeps no secret for a device: a device proves itself by signing its connection's
//! challenge with a key that never leaves it. Offers live in memory only. A service, such as the
//! Dispatcher, pairs as a device does and is kept as one, with the tools it declared and
//! whether it reaches the person's other Hosts (ADR 0029).
//!
//! The Dispatcher the Host joined (ADR 0030) is kept as a service too, so the tools it declared
//! outlive its connections, but marked joined: it is taken at hello only on the connection the
//! Host opened to it ([`crate::dispatcher`]), it keeps no remote access on, and the person's
//! devices aren't listed with it.
//!
//! Hosts used to pair with each other as peer Hosts (ADR 0017), kept as devices naming their
//! Host id; ADR 0029 retired that, and a Host revokes such a pairing when it loads one.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use serde::Deserialize;
use serde::Serialize;
use weave_host_protocol::HostClient;
use weave_host_protocol::Timestamp;
use weave_host_protocol::devices::Device;
use weave_host_protocol::devices::DeviceId;
use weave_host_protocol::devices::DeviceInfo;
use weave_host_protocol::devices::DevicePairedNotification;
use weave_host_protocol::devices::Jwk;
use weave_host_protocol::devices::NewDevice;
use weave_host_protocol::devices::auth_message;
use weave_host_protocol::tools::Tool;
pub(crate) use weave_remote::pairing::Closer;
use weave_remote::pairing::Connections;
use weave_remote::pairing::Offers;
use weave_remote::pairing::device_id;
pub(crate) use weave_remote::pairing::random_bytes;
pub(crate) use weave_remote::pairing::random_id;
use weave_remote::pairing::signed;
use weave_remote::pairing::verifying_key;

use crate::journal::now_ms;
use crate::service_tools;
use crate::thread::lock;

pub(crate) struct Devices {
    /// `devices.json`; none for a Host whose devices live in memory.
    path: Option<PathBuf>,
    state: Mutex<State>,
}

struct State {
    host_id: String,
    devices: BTreeMap<DeviceId, Stored>,
    /// Each told, when a device takes it, to the connection that asked for it.
    offers: Offers<Option<ConnectionTo<HostClient>>>,
    /// Each device's open connections, by client.
    live: Connections,
}

/// `devices.json`.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct File {
    host_id: String,
    #[serde(default)]
    devices: Vec<Stored>,
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
    /// The Host id of a peer Host pairing (ADR 0017), which a Host revokes when it loads one.
    #[serde(default, rename = "host", skip_serializing)]
    peer_host: Option<String>,
    /// A service, such as the Dispatcher (ADR 0027).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    service: bool,
    /// The tools a service declared, which threads offer (WVE-171).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tools: Vec<Tool>,
    /// The service reaches the person's other Hosts, as it declared with its tools (ADR 0029).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    hosts: bool,
    /// The Dispatcher the Host joined (ADR 0030), rather than a device that paired.
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
    /// The devices `path` records, or none yet; without a path, in memory only. A Host
    /// without a record gets an id and writes one.
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
        let mut file = read.unwrap_or_else(|| File {
            host_id: random_id(16),
            devices: Vec::new(),
        });
        // Peer Hosts are retired (ADR 0029): their pairings go.
        let paired = file.devices.len();
        file.devices.retain(|device| {
            let Some(host) = &device.peer_host else {
                return true;
            };
            tracing::info!(device = %device.id, name = %device.name, %host, "revoked a peer Host's pairing: Hosts reach each other through the Dispatcher now");
            false
        });
        let revoked = file.devices.len() < paired;
        let devices = Self {
            path,
            state: Mutex::new(State {
                host_id: file.host_id,
                devices: file
                    .devices
                    .into_iter()
                    .map(|device| (device.id.clone(), device))
                    .collect(),
                offers: Offers::default(),
                live: Connections::default(),
            }),
        };
        if fresh || revoked {
            devices.save(&lock(&devices.state));
        }
        devices
    }

    pub(crate) fn host_id(&self) -> String {
        lock(&self.state).host_id.clone()
    }

    /// A new offer, good for `lifetime_ms` ([`OFFER_LIFETIME_MS`] but in tests). Returns its
    /// code and when it expires.
    pub(crate) fn offer(
        &self,
        name: Option<String>,
        offered_by: Option<ConnectionTo<HostClient>>,
        lifetime_ms: Timestamp,
    ) -> (String, Timestamp) {
        lock(&self.state)
            .offers
            .offer(name, offered_by, lifetime_ms)
    }

    /// Pair `device` with the offer whose code is `code`, which no one can take again.
    /// `None` when there's no such live offer or the key isn't a P-256 point.
    pub(crate) fn pair(&self, code: &str, device: NewDevice) -> Option<DeviceInfo> {
        verifying_key(&device.public_key)?;
        let mut state = lock(&self.state);
        let now = now_ms();
        let offer = state.offers.take(code)?;
        let id = device_id(|id| state.devices.contains_key(id));
        let stored = Stored {
            id: id.clone(),
            name: offer.name.unwrap_or(device.name),
            public_key: device.public_key,
            paired_at: now,
            last_seen_at: Some(now),
            peer_host: None,
            service: device.service,
            tools: Vec::new(),
            hosts: false,
            joined: false,
        };
        state.devices.insert(id, stored.clone());
        self.save(&state);
        drop(state);
        let info = stored.info();
        if let Some(offered_by) = offer.by {
            let device = listing(&stored, 1);
            let _ = offered_by.send_notification(DevicePairedNotification { device });
        }
        if info.service {
            tracing::info!(device = %info.id, name = %info.name, "a service paired");
        } else {
            tracing::info!(device = %info.id, name = %info.name, "a device paired");
        }
        Some(info)
    }

    /// The device `device_id`, when `signature` is its signature of the challenge `nonce`. On
    /// the connection the Host opened to the Dispatcher it joined (`joined`), only that
    /// Dispatcher; on any other, only a device that paired.
    pub(crate) fn verify(
        &self,
        device_id: &str,
        nonce: &str,
        signature: &str,
        joined: bool,
    ) -> Option<DeviceInfo> {
        let mut state = lock(&self.state);
        let host_id = state.host_id.clone();
        let stored = state
            .devices
            .get_mut(device_id)
            .filter(|stored| stored.joined == joined)?;
        let message = auth_message(&host_id, device_id, nonce);
        if !signed(&stored.public_key, &message, signature) {
            return None;
        }
        stored.last_seen_at = Some(now_ms());
        let info = stored.info();
        self.save(&state);
        Some(info)
    }

    /// Note a device's connection, for listing and revoking.
    pub(crate) fn connected(&self, device_id: &str, client: u64, closer: Arc<dyn Closer>) {
        lock(&self.state).live.connected(device_id, client, closer);
    }

    pub(crate) fn disconnected(&self, device_id: &str, client: u64) {
        lock(&self.state).live.disconnected(device_id, client);
    }

    /// Whether any device is paired, which keeps remote access on.
    pub(crate) fn any_paired(&self) -> bool {
        lock(&self.state)
            .devices
            .values()
            .any(|stored| !stored.joined)
    }

    /// Keep the Dispatcher the Host joined, `id` with `public_key`, as a service, in place of
    /// any it joined before. Devices paired with the same key, as the Dispatcher was before
    /// Hosts joined it, are revoked, closing their connections with `code`; their tools pass
    /// to it when it declares its own.
    pub(crate) fn join(&self, id: &str, name: &str, public_key: Jwk, code: u16) {
        let closers: Vec<Arc<dyn Closer>> = {
            let mut state = lock(&self.state);
            let gone: Vec<DeviceId> = state
                .devices
                .values()
                .filter(|stored| stored.joined || stored.public_key == public_key)
                .map(|stored| stored.id.clone())
                .collect();
            let mut closers = Vec::new();
            for device in gone {
                if let Some(stored) = state.devices.remove(&device)
                    && !stored.joined
                {
                    tracing::info!(device = %stored.id, name = %stored.name, "revoked the Dispatcher's pairing from before Hosts joined it");
                    closers.extend(state.live.remove(&device));
                }
            }
            state.devices.insert(
                id.to_owned(),
                Stored {
                    id: id.to_owned(),
                    name: name.to_owned(),
                    public_key,
                    paired_at: now_ms(),
                    last_seen_at: None,
                    peer_host: None,
                    service: true,
                    tools: Vec::new(),
                    hosts: false,
                    joined: true,
                },
            );
            self.save(&state);
            closers
        };
        for closer in closers {
            closer.close(code);
        }
    }

    /// Forget the Dispatcher the Host joined, and the tools it declared.
    pub(crate) fn leave(&self) {
        let mut state = lock(&self.state);
        let before = state.devices.len();
        state.devices.retain(|_, stored| !stored.joined);
        if state.devices.len() != before {
            self.save(&state);
        }
    }

    /// Whether an offer is still good, which keeps remote access on while it is.
    pub(crate) fn offering(&self) -> bool {
        lock(&self.state).offers.any_live()
    }

    pub(crate) fn list(&self) -> Vec<Device> {
        let state = lock(&self.state);
        state
            .devices
            .values()
            .filter(|stored| !stored.joined)
            .map(|stored| listing(stored, state.live.count(&stored.id)))
            .collect()
    }

    /// Replace the tools the service `device_id` serves with `tools`, and say whether it reaches
    /// the person's other Hosts: the names agents see, or why they can't be declared. Another
    /// service paired under the same name, as one paired again without revoking the first is,
    /// gives its tools up to this one, and one that reached the Hosts stops when this one does.
    pub(crate) fn declare_tools(
        &self,
        device_id: &str,
        tools: Vec<Tool>,
        hosts: bool,
    ) -> Result<Vec<String>, String> {
        let mut state = lock(&self.state);
        let prefix = match state.devices.get(device_id) {
            Some(stored) if stored.service => service_tools::prefix(&stored.name),
            _ => return Err("only a service declares tools".to_owned()),
        };
        let names = service_tools::named(&prefix, &tools)?;
        for other in state.devices.values_mut() {
            if other.id != device_id
                && other.service
                && !other.tools.is_empty()
                && service_tools::prefix(&other.name) == prefix
            {
                tracing::info!(service = %other.id, by = %device_id, "a service paired under the same name took its tools over");
                other.tools.clear();
            }
            if hosts && other.id != device_id && other.hosts {
                tracing::info!(service = %other.id, by = %device_id, "another service reaches the person's Hosts now");
                other.hosts = false;
            }
        }
        if let Some(stored) = state.devices.get_mut(device_id) {
            stored.tools = tools;
            stored.hosts = hosts;
        }
        self.save(&state);
        Ok(names)
    }

    /// Every tool services declared, as threads offer them.
    pub(crate) fn service_tools(&self) -> Vec<service_tools::Offered> {
        let state = lock(&self.state);
        state
            .devices
            .values()
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

    /// The service that reaches the person's other Hosts, if one said so: its id and name.
    pub(crate) fn hosts_service(&self) -> Option<(DeviceId, String)> {
        lock(&self.state)
            .devices
            .values()
            .find(|stored| stored.service && stored.hosts)
            .map(|stored| (stored.id.clone(), stored.name.clone()))
    }

    /// Forget a device and close its connections with `code`.
    pub(crate) fn revoke(&self, device_id: &str, code: u16) -> Result<(), Error> {
        let closers: Vec<Arc<dyn Closer>> = {
            let mut state = lock(&self.state);
            if state
                .devices
                .get(device_id)
                .is_none_or(|stored| stored.joined)
            {
                return Err(Error::invalid_params().data(format!("no device {device_id}")));
            }
            state.devices.remove(device_id);
            self.save(&state);
            state.live.remove(device_id)
        };
        for closer in closers {
            closer.close(code);
        }
        tracing::info!(device = %device_id, "a device was revoked");
        Ok(())
    }

    /// Write `state`'s devices, replacing the file whole.
    fn save(&self, state: &State) {
        let Some(path) = &self.path else {
            return;
        };
        let file = File {
            host_id: state.host_id.clone(),
            devices: state.devices.values().cloned().collect(),
        };
        if let Err(error) = write_private(path, &file) {
            tracing::warn!(%error, path = %path.display(), "writing devices failed");
        }
    }
}

fn listing(stored: &Stored, connections: u32) -> Device {
    Device {
        id: stored.id.clone(),
        name: stored.name.clone(),
        paired_at: stored.paired_at,
        last_seen_at: stored.last_seen_at,
        connections,
        service: stored.service,
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
    use weave_remote::pairing::OFFER_LIFETIME_MS;

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

    fn new_device(jwk: Jwk) -> NewDevice {
        NewDevice {
            name: "iPad".to_owned(),
            public_key: jwk,
            service: false,
        }
    }

    #[test]
    fn a_service_is_recorded_as_one_and_one_at_a_time_reaches_the_hosts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("devices.json");
        let devices = Devices::load(Some(path.clone()));
        let mut paired = Vec::new();
        for name in ["Dispatcher", "Dispatcher on mini"] {
            let (code, _) = devices.offer(Some(name.to_owned()), None, OFFER_LIFETIME_MS);
            let (_, jwk) = key();
            let service = NewDevice {
                service: true,
                ..new_device(jwk)
            };
            let info = devices.pair(&code, service).expect("a good offer");
            assert!(info.service);
            paired.push(info.id);
        }
        assert_eq!(devices.hosts_service(), None);
        devices
            .declare_tools(&paired[0], Vec::new(), true)
            .expect("declared");
        assert_eq!(
            devices.hosts_service(),
            Some((paired[0].clone(), "Dispatcher".to_owned()))
        );
        devices
            .declare_tools(&paired[1], Vec::new(), true)
            .expect("declared");
        let reloaded = Devices::load(Some(path));
        assert!(reloaded.list().iter().all(|device| device.service));
        assert_eq!(
            reloaded.hosts_service().map(|(id, _)| id),
            Some(paired[1].clone())
        );
    }

    #[test]
    fn a_peer_hosts_pairing_is_revoked_when_the_host_loads_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("devices.json");
        let (_, jwk) = key();
        let file = serde_json::json!({
            "hostId": "h-1",
            "devices": [
                {"id": "d-peer", "name": "mini", "publicKey": jwk, "pairedAt": 1, "host": "h-2"},
                {"id": "d-ipad", "name": "iPad", "publicKey": jwk, "pairedAt": 1}
            ]
        });
        std::fs::write(&path, file.to_string()).expect("write");
        let devices = Devices::load(Some(path.clone()));
        let ids = |devices: &Devices| -> Vec<String> {
            devices.list().into_iter().map(|device| device.id).collect()
        };
        assert_eq!(ids(&devices), vec!["d-ipad".to_owned()]);
        let written = std::fs::read_to_string(&path).expect("read");
        assert!(!written.contains("d-peer"), "{written}");
        assert_eq!(ids(&Devices::load(Some(path))), vec!["d-ipad".to_owned()]);
    }

    #[test]
    fn the_dispatcher_it_joined_is_kept_apart_from_the_devices_that_paired() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("devices.json");
        let devices = Devices::load(Some(path.clone()));
        let (signing, jwk) = key();
        // The Dispatcher paired as a service before Hosts joined it, with the key it keeps.
        let (code, _) = devices.offer(None, None, OFFER_LIFETIME_MS);
        let old = devices
            .pair(
                &code,
                NewDevice {
                    service: true,
                    ..new_device(jwk.clone())
                },
            )
            .expect("pairs");
        let (code, _) = devices.offer(None, None, OFFER_LIFETIME_MS);
        let (_, ipad) = key();
        devices
            .pair(&code, new_device(ipad))
            .expect("an iPad pairs");

        devices.join("D-1", "Dispatcher on homelab-1", jwk, 4001);
        let listed: Vec<String> = devices
            .list()
            .into_iter()
            .map(|device| device.name)
            .collect();
        assert_eq!(
            listed,
            vec!["iPad".to_owned()],
            "its old pairing is revoked"
        );
        assert!(devices.verify(&old.id, "n", "", false).is_none());

        // Only on the connection the Host opened to it, and as a service.
        let host_id = devices.host_id();
        let signature = sign(&signing, &host_id, "D-1", "n1");
        assert_eq!(devices.verify("D-1", "n1", &signature, false), None);
        let joined = devices
            .verify("D-1", "n1", &signature, true)
            .expect("the Dispatcher");
        assert!(joined.service);
        assert!(
            devices.revoke("D-1", 4001).is_err(),
            "it isn't revoked as a device"
        );

        // It keeps no remote access on, and leaving forgets it, across a restart too.
        devices
            .revoke(&devices.list()[0].id, 4001)
            .expect("the iPad revoked");
        assert!(!devices.any_paired());
        let reloaded = Devices::load(Some(path.clone()));
        assert!(reloaded.verify("D-1", "n1", &signature, true).is_some());
        reloaded.leave();
        assert!(
            Devices::load(Some(path))
                .verify("D-1", "n1", &signature, true)
                .is_none()
        );
    }

    #[test]
    fn a_device_pairs_once_and_proves_itself_with_its_key() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("devices.json");
        let devices = Devices::load(Some(path.clone()));
        let (code, _) = devices.offer(None, None, OFFER_LIFETIME_MS);
        let (signing, jwk) = key();
        let paired = devices.pair(&code, new_device(jwk.clone())).expect("pairs");
        assert_eq!(paired.name, "iPad");
        assert!(
            devices.pair(&code, new_device(jwk)).is_none(),
            "an offer pairs once"
        );

        let host_id = devices.host_id();
        let signature = sign(&signing, &host_id, &paired.id, "n1");
        assert_eq!(
            devices.verify(&paired.id, "n1", &signature, false),
            Some(paired.clone())
        );
        assert!(
            devices
                .verify(&paired.id, "n2", &signature, false)
                .is_none(),
            "another nonce"
        );
        let (other, _) = key();
        let forged = sign(&other, &host_id, &paired.id, "n1");
        assert!(
            devices.verify(&paired.id, "n1", &forged, false).is_none(),
            "another key"
        );

        // The record outlives the Host, and holds no secret.
        let reloaded = Devices::load(Some(path.clone()));
        assert_eq!(reloaded.host_id(), host_id);
        assert_eq!(
            reloaded.verify(&paired.id, "n1", &signature, false),
            Some(paired)
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).expect("file").permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn an_offer_names_the_device_and_codes_are_read_forgivingly() {
        let devices = Devices::load(None);
        let (code, _) = devices.offer(Some("Jaco's iPad".to_owned()), None, OFFER_LIFETIME_MS);
        assert_eq!(code.len(), 26);
        let typed = format!("{}-{}", &code[..13], &code[13..]).to_lowercase();
        let (_, jwk) = key();
        let paired = devices.pair(&typed, new_device(jwk)).expect("pairs");
        assert_eq!(paired.name, "Jaco's iPad");
    }

    #[test]
    fn only_the_newest_offers_are_live() {
        let devices = Devices::load(None);
        let codes: Vec<String> = (0..4)
            .map(|_| devices.offer(None, None, OFFER_LIFETIME_MS).0)
            .collect();
        let (_, jwk) = key();
        assert!(devices.pair(&codes[0], new_device(jwk.clone())).is_none());
        assert!(devices.pair(&codes[3], new_device(jwk)).is_some());
    }

    #[test]
    fn a_key_off_the_curve_is_refused() {
        let devices = Devices::load(None);
        let (code, _) = devices.offer(None, None, OFFER_LIFETIME_MS);
        let (_, mut jwk) = key();
        jwk.y = URL_SAFE_NO_PAD.encode([7u8; 32]);
        assert!(devices.pair(&code, new_device(jwk)).is_none());
    }

    struct Recorded(Mutex<Vec<u16>>);

    impl Closer for Recorded {
        fn close(&self, code: u16) {
            lock(&self.0).push(code);
        }
    }

    #[test]
    fn revoking_closes_a_devices_connections_and_forgets_it() {
        let devices = Devices::load(None);
        let (code, _) = devices.offer(None, None, OFFER_LIFETIME_MS);
        let (signing, jwk) = key();
        let paired = devices.pair(&code, new_device(jwk)).expect("pairs");
        let closer = Arc::new(Recorded(Mutex::new(Vec::new())));
        devices.connected(&paired.id, 7, closer.clone());
        assert_eq!(devices.list()[0].connections, 1);
        devices.revoke(&paired.id, 4000).expect("revoked");
        assert_eq!(*lock(&closer.0), vec![4000]);
        let signature = sign(&signing, &devices.host_id(), &paired.id, "n");
        assert!(devices.verify(&paired.id, "n", &signature, false).is_none());
        assert!(devices.list().is_empty());
        assert!(devices.revoke(&paired.id, 4000).is_err());
    }
}
