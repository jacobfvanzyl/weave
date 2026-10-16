//! A remote client's end: the Host's WebSocket, reached through Tailscale Serve, and the
//! paired device the client proves at hello.
//!
//! A device pairs once with the code `weave pair` shows ([`Credentials::Pair`]), then signs
//! each connection's challenge with its key ([`Credentials::Device`]). Real devices keep that
//! key in the Secure Enclave; [`DeviceKey`] keeps it in memory, for tests and the live check.

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
    /// A device pairing with the code `weave pair` showed.
    Pair {
        code: String,
        name: String,
        key: DeviceKey,
    },
}

/// A device's P-256 key, in memory.
#[derive(Clone)]
pub struct DeviceKey(SigningKey);

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
                return Self(key);
            }
        }
    }

    /// A key saved with [`Self::to_bytes`].
    pub fn from_bytes(bytes: &[u8]) -> Option<Self> {
        SigningKey::from_slice(bytes).ok().map(Self)
    }

    /// The private scalar, to save the key: whoever has these bytes is the device.
    pub fn to_bytes(&self) -> Vec<u8> {
        self.0.to_bytes().to_vec()
    }

    /// The public key, as the Host keeps it.
    pub fn jwk(&self) -> Jwk {
        let point = self.0.verifying_key().to_sec1_point(false);
        let bytes = point.as_bytes();
        Jwk {
            kty: "EC".to_owned(),
            crv: "P-256".to_owned(),
            x: URL_SAFE_NO_PAD.encode(&bytes[1..33]),
            y: URL_SAFE_NO_PAD.encode(&bytes[33..65]),
        }
    }

    /// `message`'s DER signature in unpadded base64url, as `host/hello` carries it.
    pub fn sign(&self, message: &str) -> String {
        let signature: Signature = self.0.sign(message.as_bytes());
        URL_SAFE_NO_PAD.encode(signature.to_der().as_bytes())
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
