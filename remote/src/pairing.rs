//! Pairing and proving a device, as the Dispatcher does it: the one-time codes a device pairs
//! with, good for five minutes; the device's P-256 public key and its signature of a
//! connection's challenge; and each device's open connections, so revoking it closes them. A
//! Host pairs with nothing (WVE-197), and uses only the signature checks and random ids, for the
//! Dispatcher it joined.
//!
//! A program keeps no secret for a device: a device proves itself by signing its connection's
//! challenge with a key that never leaves it. Offers live in memory only.

use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use p256::ecdsa::Signature;
use p256::ecdsa::VerifyingKey;
use p256::ecdsa::signature::Verifier as _;
use weave_host_protocol::Timestamp;
use weave_host_protocol::devices::DeviceId;
use weave_host_protocol::devices::Jwk;

use crate::now_ms;
use crate::websocket::Link;

/// How long an offer stays good.
pub const OFFER_LIFETIME_MS: Timestamp = 5 * 60 * 1000;
/// How many offers can be live at once; a new one replaces the oldest.
const MAX_OFFERS: usize = 3;
/// Crockford's base32, which pairing codes are written in.
const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// The live pairing offers, each with `By`: whoever asked for it, told when a device takes it.
pub struct Offers<By> {
    offers: Vec<Offer<By>>,
}

struct Offer<By> {
    code: String,
    name: Option<String>,
    expires_at: Timestamp,
    by: By,
}

/// An offer a device took: the name it gives the device, if it gave one, and who asked for it.
pub struct Taken<By> {
    pub name: Option<String>,
    pub by: By,
}

impl<By> Default for Offers<By> {
    fn default() -> Self {
        Self { offers: Vec::new() }
    }
}

impl<By> Offers<By> {
    /// A new offer, good for `lifetime_ms`: its code, 128 random bits in Crockford base32, and
    /// when it expires.
    pub fn offer(
        &mut self,
        name: Option<String>,
        by: By,
        lifetime_ms: Timestamp,
    ) -> (String, Timestamp) {
        let code = crockford(&random_bytes::<16>());
        let now = now_ms();
        let expires_at = now + lifetime_ms;
        self.offers.retain(|offer| offer.expires_at > now);
        if self.offers.len() >= MAX_OFFERS {
            self.offers.remove(0);
        }
        self.offers.push(Offer {
            code: code.clone(),
            name,
            expires_at,
            by,
        });
        (code, expires_at)
    }

    /// The live offer whose code is `code`, as typed, which no one can take again.
    pub fn take(&mut self, code: &str) -> Option<Taken<By>> {
        let code = normalize_code(code);
        let now = now_ms();
        self.offers.retain(|offer| offer.expires_at > now);
        let index = self
            .offers
            .iter()
            .position(|offer| constant_time_eq(offer.code.as_bytes(), code.as_bytes()))?;
        let offer = self.offers.remove(index);
        Some(Taken {
            name: offer.name,
            by: offer.by,
        })
    }

    /// Whether an offer is still good, which keeps remote access on while it is.
    pub fn any_live(&self) -> bool {
        let now = now_ms();
        self.offers.iter().any(|offer| offer.expires_at > now)
    }
}

/// Something that can close one live connection of a device.
pub trait Closer: Send + Sync {
    fn close(&self, code: u16);
}

impl Closer for Link {
    fn close(&self, code: u16) {
        Link::close(self, code);
    }
}

/// Each device's open connections, by the program's number for the connection.
#[derive(Default)]
pub struct Connections {
    live: HashMap<DeviceId, HashMap<u64, Arc<dyn Closer>>>,
}

impl Connections {
    pub fn connected(&mut self, device_id: &str, connection: u64, closer: Arc<dyn Closer>) {
        self.live
            .entry(device_id.to_owned())
            .or_default()
            .insert(connection, closer);
    }

    pub fn disconnected(&mut self, device_id: &str, connection: u64) {
        if let Some(connections) = self.live.get_mut(device_id) {
            connections.remove(&connection);
            if connections.is_empty() {
                self.live.remove(device_id);
            }
        }
    }

    /// How many connections `device_id` has open.
    pub fn count(&self, device_id: &str) -> u32 {
        self.live.get(device_id).map_or(0, |connections| {
            u32::try_from(connections.len()).unwrap_or(u32::MAX)
        })
    }

    /// Forget `device_id`'s connections, giving what closes them.
    pub fn remove(&mut self, device_id: &str) -> Vec<Arc<dyn Closer>> {
        self.live
            .remove(device_id)
            .map(|connections| connections.into_values().collect())
            .unwrap_or_default()
    }
}

/// A P-256 public key from its JWK; `None` unless it's a point on the curve.
pub fn verifying_key(jwk: &Jwk) -> Option<VerifyingKey> {
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

/// Whether `signature`, DER in unpadded base64url, is `key`'s signature of `message`.
pub fn signed(key: &Jwk, message: &str, signature: &str) -> bool {
    let Some(key) = verifying_key(key) else {
        return false;
    };
    let Ok(der) = URL_SAFE_NO_PAD.decode(signature) else {
        return false;
    };
    let Ok(signature) = Signature::from_der(&der) else {
        return false;
    };
    key.verify(message.as_bytes(), &signature).is_ok()
}

/// `N` bytes from the system's random source.
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    // The system's random source failing is no state to go on in.
    #[allow(clippy::expect_used)]
    getrandom::fill(&mut bytes).expect("the system's random source works");
    bytes
}

/// `bytes` random bytes in unpadded base64url.
pub fn random_id(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    #[allow(clippy::expect_used)]
    getrandom::fill(&mut buffer).expect("the system's random source works");
    URL_SAFE_NO_PAD.encode(buffer)
}

/// A new device's id, `d-` and 72 random bits, that `taken` doesn't already have.
pub fn device_id(taken: impl Fn(&str) -> bool) -> DeviceId {
    loop {
        let id = format!("d-{}", random_id(9));
        if !taken(&id) {
            return id;
        }
    }
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
        #[allow(clippy::expect_used)]
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

    #[test]
    fn an_offer_is_taken_once_and_its_code_is_read_forgivingly() {
        let mut offers = Offers::default();
        let (code, _) = offers.offer(Some("iPad".to_owned()), 7, OFFER_LIFETIME_MS);
        assert_eq!(code.len(), 26);
        assert!(offers.any_live());
        let typed = format!("{}-{}", &code[..13], &code[13..]).to_lowercase();
        let taken = offers.take(&typed).map(|taken| (taken.name, taken.by));
        assert_eq!(taken, Some((Some("iPad".to_owned()), 7)));
        assert!(offers.take(&code).is_none());
        assert!(!offers.any_live());
    }

    #[test]
    fn only_the_newest_offers_are_live_and_none_past_its_time() {
        let mut offers = Offers::default();
        let codes: Vec<String> = (0..4)
            .map(|_| offers.offer(None, (), OFFER_LIFETIME_MS).0)
            .collect();
        assert!(offers.take(&codes[0]).is_none());
        assert!(offers.take(&codes[3]).is_some());
        let (expired, _) = offers.offer(None, (), 0);
        assert!(offers.take(&expired).is_none());
    }

    #[test]
    fn a_signature_is_checked_against_its_key_and_message() {
        let (signing, jwk) = key();
        let signature: Signature = signing.sign(b"a message");
        let signature = URL_SAFE_NO_PAD.encode(signature.to_der().as_bytes());
        assert!(signed(&jwk, "a message", &signature));
        assert!(!signed(&jwk, "another", &signature));
        let (_, other) = key();
        assert!(!signed(&other, "a message", &signature));
        let mut off_curve = jwk;
        off_curve.y = URL_SAFE_NO_PAD.encode([7u8; 32]);
        assert!(verifying_key(&off_curve).is_none());
    }
}
