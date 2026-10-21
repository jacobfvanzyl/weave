//! Paired devices: the Host's id, the devices it accepts remote clients from and their public
//! keys (`devices.json`, 0600), the pairing offers `weave pair` makes, and which connections
//! each device has open, so revoking it closes them.
//!
//! The Host keeps no secret for a device: a device proves itself by signing its connection's
//! challenge with a key that never leaves it. Offers live in memory only.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::io::Write as _;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use p256::ecdsa::Signature;
use p256::ecdsa::VerifyingKey;
use p256::ecdsa::signature::Verifier as _;
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

use crate::journal::now_ms;
use crate::session::lock;

/// How long an offer stays good.
pub(crate) const OFFER_LIFETIME_MS: Timestamp = 5 * 60 * 1000;
/// How many offers can be live at once; a new one replaces the oldest.
const MAX_OFFERS: usize = 3;
/// Crockford's base32, which pairing codes are written in.
const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Something that can close one live connection of a device.
pub(crate) trait Closer: Send + Sync {
    fn close(&self, code: u16);
}

pub(crate) struct Devices {
    /// `devices.json`; none for a Host whose devices live in memory.
    path: Option<PathBuf>,
    state: Mutex<State>,
}

struct State {
    host_id: String,
    devices: BTreeMap<DeviceId, Stored>,
    offers: Vec<Offer>,
    /// Each device's open connections, by client.
    live: HashMap<DeviceId, HashMap<u64, Arc<dyn Closer>>>,
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
}

struct Offer {
    code: String,
    name: Option<String>,
    expires_at: Timestamp,
    /// The connection that asked for it, told when a device takes it.
    offered_by: Option<ConnectionTo<HostClient>>,
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
        let file = read.unwrap_or_else(|| File {
            host_id: random_id(16),
            devices: Vec::new(),
        });
        let devices = Self {
            path,
            state: Mutex::new(State {
                host_id: file.host_id,
                devices: file
                    .devices
                    .into_iter()
                    .map(|device| (device.id.clone(), device))
                    .collect(),
                offers: Vec::new(),
                live: HashMap::new(),
            }),
        };
        if fresh {
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
        let code = crockford(&random_bytes::<16>());
        let expires_at = now_ms() + lifetime_ms;
        let mut state = lock(&self.state);
        let now = now_ms();
        state.offers.retain(|offer| offer.expires_at > now);
        if state.offers.len() >= MAX_OFFERS {
            state.offers.remove(0);
        }
        state.offers.push(Offer {
            code: code.clone(),
            name,
            expires_at,
            offered_by,
        });
        (code, expires_at)
    }

    /// Pair `device` with the offer whose code is `code`, which no one can take again.
    /// `None` when there's no such live offer or the key isn't a P-256 point.
    pub(crate) fn pair(&self, code: &str, device: NewDevice) -> Option<DeviceInfo> {
        verifying_key(&device.public_key)?;
        let code = normalize_code(code);
        let mut state = lock(&self.state);
        let now = now_ms();
        state.offers.retain(|offer| offer.expires_at > now);
        let index = state
            .offers
            .iter()
            .position(|offer| constant_time_eq(offer.code.as_bytes(), code.as_bytes()))?;
        let offer = state.offers.remove(index);
        let mut id = format!("d-{}", random_id(9));
        while state.devices.contains_key(&id) {
            id = format!("d-{}", random_id(9));
        }
        let stored = Stored {
            id: id.clone(),
            name: offer.name.unwrap_or(device.name),
            public_key: device.public_key,
            paired_at: now,
            last_seen_at: Some(now),
        };
        state.devices.insert(id.clone(), stored.clone());
        self.save(&state);
        drop(state);
        let info = DeviceInfo {
            id,
            name: stored.name.clone(),
        };
        if let Some(offered_by) = offer.offered_by {
            let device = listing(&stored, 1);
            let _ = offered_by.send_notification(DevicePairedNotification { device });
        }
        tracing::info!(device = %info.id, name = %info.name, "a device paired");
        Some(info)
    }

    /// The device `device_id`, when `signature` is its signature of the challenge `nonce`.
    pub(crate) fn verify(
        &self,
        device_id: &str,
        nonce: &str,
        signature: &str,
    ) -> Option<DeviceInfo> {
        let mut state = lock(&self.state);
        let host_id = state.host_id.clone();
        let stored = state.devices.get_mut(device_id)?;
        let key = verifying_key(&stored.public_key)?;
        let der = URL_SAFE_NO_PAD.decode(signature).ok()?;
        let signature = Signature::from_der(&der).ok()?;
        key.verify(
            auth_message(&host_id, device_id, nonce).as_bytes(),
            &signature,
        )
        .ok()?;
        stored.last_seen_at = Some(now_ms());
        let info = DeviceInfo {
            id: stored.id.clone(),
            name: stored.name.clone(),
        };
        self.save(&state);
        Some(info)
    }

    /// Note a device's connection, for listing and revoking.
    pub(crate) fn connected(&self, device_id: &str, client: u64, closer: Arc<dyn Closer>) {
        lock(&self.state)
            .live
            .entry(device_id.to_owned())
            .or_default()
            .insert(client, closer);
    }

    pub(crate) fn disconnected(&self, device_id: &str, client: u64) {
        let mut state = lock(&self.state);
        if let Some(clients) = state.live.get_mut(device_id) {
            clients.remove(&client);
            if clients.is_empty() {
                state.live.remove(device_id);
            }
        }
    }

    /// Whether any device is paired, which keeps remote access on.
    pub(crate) fn any_paired(&self) -> bool {
        !lock(&self.state).devices.is_empty()
    }

    /// Whether an offer is still good, which keeps remote access on while it is.
    pub(crate) fn offering(&self) -> bool {
        let now = now_ms();
        lock(&self.state)
            .offers
            .iter()
            .any(|offer| offer.expires_at > now)
    }

    pub(crate) fn list(&self) -> Vec<Device> {
        let state = lock(&self.state);
        state
            .devices
            .values()
            .map(|stored| {
                let connections = state.live.get(&stored.id).map_or(0, |clients| {
                    u32::try_from(clients.len()).unwrap_or(u32::MAX)
                });
                listing(stored, connections)
            })
            .collect()
    }

    /// Forget a device and close its connections with `code`.
    pub(crate) fn revoke(&self, device_id: &str, code: u16) -> Result<(), Error> {
        let closers: Vec<Arc<dyn Closer>> = {
            let mut state = lock(&self.state);
            if state.devices.remove(device_id).is_none() {
                return Err(Error::invalid_params().data(format!("no device {device_id}")));
            }
            self.save(&state);
            state
                .live
                .remove(device_id)
                .map(|clients| clients.into_values().collect())
                .unwrap_or_default()
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
    }
}

fn write_private(path: &Path, file: &File) -> std::io::Result<()> {
    let json = serde_json::to_vec_pretty(file).map_err(std::io::Error::other)?;
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

/// A P-256 public key from its JWK.
fn verifying_key(jwk: &Jwk) -> Option<VerifyingKey> {
    if jwk.kty != "EC" || jwk.crv != "P-256" {
        return None;
    }
    let x = URL_SAFE_NO_PAD.decode(&jwk.x).ok()?;
    let y = URL_SAFE_NO_PAD.decode(&jwk.y).ok()?;
    if x.len() != 32 || y.len() != 32 {
        return None;
    }
    let mut point = Vec::with_capacity(65);
    point.push(0x04);
    point.extend_from_slice(&x);
    point.extend_from_slice(&y);
    VerifyingKey::from_sec1_bytes(&point).ok()
}

/// `N` bytes from the system's random source.
pub(crate) fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    // The system's random source failing is no state to go on in.
    #[allow(clippy::expect_used)]
    getrandom::fill(&mut bytes).expect("the system's random source works");
    bytes
}

/// `bytes` random bytes in unpadded base64url.
pub(crate) fn random_id(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    #[allow(clippy::expect_used)]
    getrandom::fill(&mut buffer).expect("the system's random source works");
    URL_SAFE_NO_PAD.encode(buffer)
}

fn crockford(bytes: &[u8]) -> String {
    let mut out = String::new();
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for byte in bytes {
        buffer = (buffer << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(char::from(CROCKFORD[((buffer >> bits) & 31) as usize]));
        }
    }
    if bits > 0 {
        out.push(char::from(
            CROCKFORD[((buffer << (5 - bits)) & 31) as usize],
        ));
    }
    out
}

/// A typed code as Crockford base32 reads it: case and dashes don't matter, and O, I and L
/// are the digits they look like.
fn normalize_code(code: &str) -> String {
    code.chars()
        .filter(|c| !matches!(c, '-' | ' '))
        .map(|c| match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            other => other,
        })
        .collect()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
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

    fn new_device(jwk: Jwk) -> NewDevice {
        NewDevice {
            name: "iPad".to_owned(),
            public_key: jwk,
        }
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
            devices.verify(&paired.id, "n1", &signature),
            Some(paired.clone())
        );
        assert!(
            devices.verify(&paired.id, "n2", &signature).is_none(),
            "another nonce"
        );
        let (other, _) = key();
        let forged = sign(&other, &host_id, &paired.id, "n1");
        assert!(
            devices.verify(&paired.id, "n1", &forged).is_none(),
            "another key"
        );

        // The record outlives the Host, and holds no secret.
        let reloaded = Devices::load(Some(path.clone()));
        assert_eq!(reloaded.host_id(), host_id);
        assert_eq!(reloaded.verify(&paired.id, "n1", &signature), Some(paired));
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
        assert!(devices.verify(&paired.id, "n", &signature).is_none());
        assert!(devices.list().is_empty());
        assert!(devices.revoke(&paired.id, 4000).is_err());
    }
}
