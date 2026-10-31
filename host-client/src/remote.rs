//! A remote client's end: the Host's WebSocket, reached through Tailscale Serve, and the
//! paired device the client proves at hello.
//!
//! A device pairs once with the code `weave pair` shows ([`Credentials::Pair`]), then signs
//! each connection's challenge with its key ([`Credentials::Device`]). Real devices keep that
//! key in the Secure Enclave. A [`DeviceKey`] is one in memory, for tests and the live check,
//! or one in this Mac's Secure Enclave, for a Host proving itself to its peer Hosts.

use std::io;
use std::sync::Arc;
use std::sync::Mutex;

use agent_client_protocol::ConnectTo;
use agent_client_protocol::Lines;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use futures::SinkExt as _;
use futures::StreamExt as _;
use p256::ecdsa::Signature;
use p256::ecdsa::SigningKey;
use p256::ecdsa::signature::Signer as _;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use weave_host_protocol::HostClient;
use weave_host_protocol::devices::DeviceId;
use weave_host_protocol::devices::Jwk;
use weave_host_protocol::websocket::MAX_MESSAGE;
use weave_host_protocol::websocket::SUBPROTOCOL;

/// How a connection authenticates at hello.
#[derive(Clone, Debug)]
pub enum Credentials {
    /// A local client, on the Unix socket or in-process.
    Local,
    /// A paired device. With `host_id`, the client checks the challenge comes from the Host
    /// it paired with before signing it.
    Device {
        device_id: DeviceId,
        key: DeviceKey,
        host_id: Option<String>,
    },
    /// A device pairing with the code `weave pair` showed. A Host pairing as a peer Host gives
    /// its own Host id as `host`.
    Pair {
        code: String,
        name: String,
        key: DeviceKey,
        host: Option<String>,
    },
}

/// A device's P-256 key: in memory, or in this Mac's Secure Enclave.
#[derive(Clone)]
pub struct DeviceKey(Key);

#[derive(Clone)]
enum Key {
    Software(SigningKey),
    #[cfg(target_os = "macos")]
    SecureEnclave(crate::enclave::EnclaveKey),
}

impl std::fmt::Debug for DeviceKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DeviceKey(..)")
    }
}

impl DeviceKey {
    /// A new key from the system's random source.
    pub fn generate() -> Self {
        loop {
            let mut scalar = [0u8; 32];
            // The system's random source failing is no state to go on in.
            #[allow(clippy::expect_used)]
            getrandom::fill(&mut scalar).expect("the system's random source works");
            // Nearly every 32 bytes are a valid scalar.
            if let Ok(key) = SigningKey::from_slice(&scalar) {
                return Self(Key::Software(key));
            }
        }
    }

    /// A new key in this computer's Secure Enclave, whose private key never leaves it. Fails
    /// where there's none: on a Mac without one, and on every other system.
    pub fn in_secure_enclave() -> Result<Self, String> {
        #[cfg(target_os = "macos")]
        return crate::enclave::EnclaveKey::generate().map(|key| Self(Key::SecureEnclave(key)));
        #[cfg(not(target_os = "macos"))]
        Err("this computer has no Secure Enclave".to_owned())
    }

    /// A key saved with [`Self::to_bytes`].
    pub fn from_bytes(bytes: &[u8]) -> Option<Self> {
        SigningKey::from_slice(bytes)
            .ok()
            .map(|key| Self(Key::Software(key)))
    }

    /// A Secure Enclave key saved with [`Self::wrapped`].
    pub fn from_wrapped(wrapped: &[u8]) -> Result<Self, String> {
        #[cfg(target_os = "macos")]
        return crate::enclave::EnclaveKey::from_wrapped(wrapped)
            .map(|key| Self(Key::SecureEnclave(key)));
        #[cfg(not(target_os = "macos"))]
        {
            let _ = wrapped;
            Err("this computer has no Secure Enclave".to_owned())
        }
    }

    /// The private scalar, to save the key: whoever has these bytes is the device. None for a
    /// Secure Enclave key, which saves as [`Self::wrapped`].
    pub fn to_bytes(&self) -> Option<Vec<u8>> {
        match &self.0 {
            Key::Software(key) => Some(key.to_bytes().to_vec()),
            #[cfg(target_os = "macos")]
            Key::SecureEnclave(_) => None,
        }
    }

    /// A Secure Enclave key's wrapped form, to save it: only this computer's Secure Enclave
    /// can use it. None for a key in memory.
    pub fn wrapped(&self) -> Option<Vec<u8>> {
        match &self.0 {
            Key::Software(_) => None,
            #[cfg(target_os = "macos")]
            Key::SecureEnclave(key) => Some(key.wrapped().to_vec()),
        }
    }

    /// The public key, as the Host keeps it.
    pub fn jwk(&self) -> Jwk {
        let jwk = |x: &[u8], y: &[u8]| Jwk {
            kty: "EC".to_owned(),
            crv: "P-256".to_owned(),
            x: URL_SAFE_NO_PAD.encode(x),
            y: URL_SAFE_NO_PAD.encode(y),
        };
        match &self.0 {
            Key::Software(key) => {
                let point = key.verifying_key().to_sec1_point(false);
                let bytes = point.as_bytes();
                jwk(&bytes[1..33], &bytes[33..65])
            }
            #[cfg(target_os = "macos")]
            Key::SecureEnclave(key) => {
                let (x, y) = key.coordinates();
                jwk(x, y)
            }
        }
    }

    /// `message`'s DER signature in unpadded base64url, as `host/hello` carries it. Only a
    /// Secure Enclave key can fail to sign.
    pub fn sign(&self, message: &str) -> Result<String, String> {
        let der = match &self.0 {
            Key::Software(key) => {
                let signature: Signature = key.sign(message.as_bytes());
                signature.to_der().as_bytes().to_vec()
            }
            #[cfg(target_os = "macos")]
            Key::SecureEnclave(key) => key.sign(message.as_bytes())?,
        };
        Ok(URL_SAFE_NO_PAD.encode(der))
    }
}

/// Why the Host closed a WebSocket, once it has.
#[derive(Clone, Debug, Default)]
pub struct CloseReason(Arc<Mutex<Option<(u16, String)>>>);

impl CloseReason {
    /// The close code and reason the Host sent, if it has closed the connection.
    pub fn get(&self) -> Option<(u16, String)> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

/// Open the Host's WebSocket at `url` (`wss://` through Tailscale Serve, or `ws://` on
/// loopback), for [`crate::HostConnection::connect_with`].
pub async fn connect_websocket(
    url: &str,
) -> io::Result<(impl ConnectTo<HostClient> + 'static, CloseReason)> {
    let mut request = url.into_client_request().map_err(io::Error::other)?;
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_static(SUBPROTOCOL),
    );
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE))
        .max_frame_size(Some(MAX_MESSAGE));
    let (socket, _) = tokio_tungstenite::connect_async_with_config(request, Some(config), false)
        .await
        .map_err(io::Error::other)?;
    let (sink, stream) = socket.split();
    let outgoing = sink
        .sink_map_err(io::Error::other)
        .with(|line: String| std::future::ready(Ok::<_, io::Error>(Message::text(line))));
    let reason = CloseReason::default();
    let closed = reason.clone();
    let incoming = stream.filter_map(move |message| {
        std::future::ready(match message {
            Ok(Message::Text(text)) => Some(Ok(text.to_string())),
            Ok(Message::Close(Some(frame))) => {
                *closed
                    .0
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) =
                    Some((u16::from(frame.code), frame.reason.to_string()));
                None
            }
            Ok(_) => None,
            Err(error) => Some(Err(io::Error::other(error))),
        })
    });
    Ok((Lines::new(Box::pin(outgoing), incoming), reason))
}

/// The HTTP status a server answered [`connect_websocket`] with instead of taking the
/// WebSocket: something answered at the URL, but no weave Host did, as when Tailscale Serve
/// answers for a Host that isn't running.
pub fn answered_without_host(error: &io::Error) -> Option<u16> {
    match error
        .get_ref()?
        .downcast_ref::<tokio_tungstenite::tungstenite::Error>()?
    {
        tokio_tungstenite::tungstenite::Error::Http(response) => Some(response.status().as_u16()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use p256::ecdsa::VerifyingKey;
    use p256::ecdsa::signature::Verifier as _;

    use super::*;

    /// Whether `signature` is `key`'s of `message`, checked against its public key alone.
    fn verifies(key: &DeviceKey, message: &str, signature: &str) -> bool {
        let jwk = key.jwk();
        let mut point = vec![4];
        point.extend(URL_SAFE_NO_PAD.decode(jwk.x).expect("x"));
        point.extend(URL_SAFE_NO_PAD.decode(jwk.y).expect("y"));
        let public = VerifyingKey::from_sec1_bytes(&point).expect("a P-256 point");
        let der = URL_SAFE_NO_PAD.decode(signature).expect("base64url");
        let signature = Signature::from_der(&der).expect("DER");
        public.verify(message.as_bytes(), &signature).is_ok()
    }

    #[test]
    fn a_key_in_memory_saves_as_its_scalar_and_signs() {
        let key = DeviceKey::generate();
        assert!(key.wrapped().is_none());
        let saved = DeviceKey::from_bytes(&key.to_bytes().expect("a scalar")).expect("restored");
        assert_eq!(saved.jwk(), key.jwk());
        let signature = saved.sign("weave-host-auth/1 h d n").expect("signed");
        assert!(verifies(&key, "weave-host-auth/1 h d n", &signature));
        assert!(!verifies(&key, "weave-host-auth/1 h d m", &signature));
    }

    /// The Secure Enclave of the Mac the tests run on, where there's one: a key made there
    /// saves as its wrapped form, comes back from it, and signs as `host/hello` checks.
    #[test]
    fn a_secure_enclave_key_saves_wrapped_and_signs() {
        let key = match DeviceKey::in_secure_enclave() {
            Ok(key) => key,
            Err(why) => {
                eprintln!("no Secure Enclave here, so not checked: {why}");
                return;
            }
        };
        assert!(key.to_bytes().is_none(), "its private key never leaves it");
        let wrapped = key.wrapped().expect("a wrapped key");
        let restored = DeviceKey::from_wrapped(&wrapped).expect("restored");
        assert_eq!(restored.jwk(), key.jwk());
        let signature = restored.sign("weave-host-auth/1 h d n").expect("signed");
        assert!(verifies(&key, "weave-host-auth/1 h d n", &signature));
        assert!(DeviceKey::from_wrapped(b"not a key").is_err());
    }
}
