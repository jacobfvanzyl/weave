//! Reaching one of the person's Hosts through the Dispatcher (ADR 0030, WVE-195), which passes
//! the Host protocol through unchanged. A paired device opens the Dispatcher's WebSocket with
//! the carry subprotocol, proves its key there as it does at `dispatcher/hello`, and names the
//! Host in `hosts/open`; on the Dispatcher's own computer a client asks on its socket instead,
//! after a hello there. Once the Dispatcher answers, the connection is the Host's: the client
//! says `host/hello` with [`Credentials::Dispatcher`], or, for a terminal's stream, opens it
//! with a ticket `terminals/attach` gave on a carried connection of its own.
//!
//! The CLI uses this, and the Mac's app will (ADR 0032).

use std::path::PathBuf;
use std::time::Duration;

use agent_client_protocol::ByteStreams;
use agent_client_protocol::DynConnectTo;
use agent_client_protocol::Error;
use agent_client_protocol::JsonRpcRequest;
use futures::SinkExt as _;
use futures::StreamExt as _;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncBufReadExt as _;
use tokio::io::AsyncWriteExt as _;
use tokio::io::BufReader;
use tokio::net::TcpStream;
use tokio::net::UnixStream;
use tokio::net::unix::OwnedReadHalf;
use tokio::net::unix::OwnedWriteHalf;
use tokio::sync::mpsc;
use tokio_tungstenite::MaybeTlsStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::compat::TokioAsyncReadCompatExt as _;
use tokio_util::compat::TokioAsyncWriteCompatExt as _;
use weave_host_protocol::HostClient;
use weave_host_protocol::devices::DeviceId;
use weave_host_protocol::devices::NewDevice;
use weave_host_protocol::dispatcher::CarriedStream;
use weave_host_protocol::dispatcher::DISPATCHER_CARRY_SUBPROTOCOL;
use weave_host_protocol::dispatcher::DISPATCHER_PROTOCOL;
use weave_host_protocol::dispatcher::DISPATCHER_SUBPROTOCOL;
use weave_host_protocol::dispatcher::DispatcherChallengeRequest;
use weave_host_protocol::dispatcher::DispatcherHello;
use weave_host_protocol::dispatcher::DispatcherHelloRequest;
use weave_host_protocol::dispatcher::HostUnavailable;
use weave_host_protocol::dispatcher::OpenHostRequest;
use weave_host_protocol::dispatcher::OpenedHost;
use weave_host_protocol::dispatcher::dispatcher_auth_message;
use weave_host_protocol::errors;
use weave_host_protocol::hello::Auth;
use weave_host_protocol::hello::ClientCapabilities;
use weave_host_protocol::hello::ClientInfo;

use crate::ConnectError;
use crate::Credentials;
use crate::HostConnection;
use crate::HostEvent;
use crate::remote::CloseReason;
use crate::remote::DeviceKey;
use crate::remote::messages;
use crate::remote::open_websocket;

/// The Dispatcher a connection goes through, and who this client is to it.
#[derive(Clone, Debug)]
pub enum Via {
    /// Its WebSocket, as a device paired with it.
    Paired {
        url: String,
        /// The Dispatcher's id, which it checks is the one answering.
        dispatcher_id: String,
        device_id: DeviceId,
        key: DeviceKey,
    },
    /// Its socket, on its own computer, as the person running it there.
    Socket(PathBuf),
}

impl Via {
    /// Where it is, in messages.
    pub fn place(&self) -> String {
        match self {
            Self::Paired { url, .. } => url.clone(),
            Self::Socket(path) => path.display().to_string(),
        }
    }
}

/// Why a connection couldn't be carried to a Host.
#[derive(Debug, thiserror::Error)]
pub enum CarryError {
    /// Nothing answered where the Dispatcher is, or the connection broke: trying again later
    /// may work.
    #[error("the Dispatcher didn't answer at {at}: {why}")]
    Dispatcher { at: String, why: String },
    /// The Dispatcher refused this device, as after revoking it, or another one answers there:
    /// pairing again is the way back.
    #[error("the Dispatcher refused this device: {0}")]
    Refused(String),
    /// The Dispatcher can't reach the Host now, as `hosts/list` would say.
    #[error("{}", .0.why)]
    Unavailable(HostUnavailable),
    /// It answered `hosts/open` otherwise, as for a Host that never joined it.
    #[error("{}", .0.message)]
    Refusal(Error),
    /// The Host refused the device's hello, or speaks another version.
    #[error(transparent)]
    Hello(#[from] ConnectError),
}

impl CarryError {
    /// Whether waiting may help: the Dispatcher or the Host may come back.
    pub fn may_pass(&self) -> bool {
        matches!(self, Self::Dispatcher { .. } | Self::Unavailable(_))
    }
}

/// A connection the Dispatcher carries to a Host, once it has answered `hosts/open`.
pub enum Carried {
    /// On its WebSocket: the Host protocol in text frames, or a terminal's stream.
    WebSocket(Box<WebSocketStream<MaybeTlsStream<TcpStream>>>),
    /// On its socket: the Host protocol, one message per line.
    Socket(BufReader<OwnedReadHalf>, OwnedWriteHalf),
}

impl Carried {
    /// The Host protocol over it, for [`HostConnection::connect_with`] with
    /// [`Credentials::Dispatcher`], and how the Dispatcher closed it once it has.
    pub fn transport(self) -> (DynConnectTo<HostClient>, CloseReason) {
        match self {
            Self::WebSocket(socket) => {
                let (transport, closed) = messages::<HostClient, _>(*socket);
                (DynConnectTo::new(transport), closed)
            }
            Self::Socket(reader, writer) => (
                DynConnectTo::new(ByteStreams::new(writer.compat_write(), reader.compat())),
                CloseReason::default(),
            ),
        }
    }
}

/// Have the Dispatcher at `via` carry a connection of `stream`'s kind to `host`, by id or name,
/// saying hello to it as `client`.
pub async fn open(
    via: &Via,
    client: &ClientInfo,
    host: &str,
    stream: CarriedStream,
) -> Result<(Carried, OpenedHost), CarryError> {
    let request = OpenHostRequest {
        host: host.to_owned(),
        stream,
    };
    match via {
        Via::Paired {
            url,
            dispatcher_id,
            device_id,
            key,
        } => {
            let lost = |why: String| CarryError::Dispatcher {
                at: url.clone(),
                why,
            };
            let mut socket = open_websocket(url, DISPATCHER_CARRY_SUBPROTOCOL)
                .await
                .map_err(|error| lost(error.to_string()))?;
            prove(&mut socket, client, dispatcher_id, device_id, key, &lost).await?;
            let opened = ask(&mut socket, 3, &request)
                .await
                .map_err(|error| opening_error(error, &lost))?;
            Ok((Carried::WebSocket(Box::new(socket)), opened))
        }
        Via::Socket(path) => {
            let lost = |why: String| CarryError::Dispatcher {
                at: path.display().to_string(),
                why,
            };
            let stream = UnixStream::connect(path)
                .await
                .map_err(|error| lost(error.to_string()))?;
            let (reader, mut writer) = stream.into_split();
            let mut reader = BufReader::new(reader);
            let hello = DispatcherHelloRequest {
                protocol: DISPATCHER_PROTOCOL,
                client: client.clone(),
                auth: None,
            };
            ask_line(&mut reader, &mut writer, 1, &hello)
                .await
                .map_err(|error| dispatcher_error(error, &lost))?;
            let opened = ask_line(&mut reader, &mut writer, 2, &request)
                .await
                .map_err(|error| opening_error(error, &lost))?;
            Ok((Carried::Socket(reader, writer), opened))
        }
    }
}

/// The Dispatcher's WebSocket, in text frames.
pub type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// The Dispatcher's challenge, signed, and `dispatcher/hello` as the paired device, on a
/// WebSocket just opened to it: ids 1 and 2.
async fn prove(
    socket: &mut Socket,
    client: &ClientInfo,
    dispatcher_id: &str,
    device_id: &DeviceId,
    key: &DeviceKey,
    lost: &impl Fn(String) -> CarryError,
) -> Result<DispatcherHello, CarryError> {
    let challenge = ask(socket, 1, &DispatcherChallengeRequest {})
        .await
        .map_err(|error| dispatcher_error(error, lost))?;
    if challenge.dispatcher_id != dispatcher_id {
        return Err(CarryError::Refused(
            "another Dispatcher answers there now; pair with it again".to_owned(),
        ));
    }
    let message = dispatcher_auth_message(&challenge.dispatcher_id, device_id, &challenge.nonce);
    let signature = key.sign(&message).map_err(CarryError::Refused)?;
    let hello = DispatcherHelloRequest {
        protocol: DISPATCHER_PROTOCOL,
        client: client.clone(),
        auth: Some(Auth::Device {
            device_id: device_id.clone(),
            signature,
        }),
    };
    ask(socket, 2, &hello)
        .await
        .map_err(|error| dispatcher_error(error, lost))
}

/// The Dispatcher's API at `url`, said hello to as the paired device, for a client that passes
/// it through rather than speaking it itself: the Mac's app relays it to its page, which never
/// holds the device's key (ADR 0032). What follows on the socket is the page's, its own ids
/// from 1.
pub async fn api(
    url: &str,
    client: &ClientInfo,
    dispatcher_id: &str,
    device_id: &DeviceId,
    key: &DeviceKey,
) -> Result<(Socket, DispatcherHello), CarryError> {
    let lost = |why: String| CarryError::Dispatcher {
        at: url.to_owned(),
        why,
    };
    let mut socket = open_websocket(url, DISPATCHER_SUBPROTOCOL)
        .await
        .map_err(|error| lost(error.to_string()))?;
    let hello = prove(&mut socket, client, dispatcher_id, device_id, key, &lost).await?;
    Ok((socket, hello))
}

/// Pairs with the Dispatcher at `url` with the code `weave pair` showed, as a device called
/// `name` with `key`, and gives its API, said hello to as that device, as [`api`] does.
pub async fn pair(
    url: &str,
    client: &ClientInfo,
    code: &str,
    name: &str,
    key: &DeviceKey,
) -> Result<(Socket, DispatcherHello), CarryError> {
    let lost = |why: String| CarryError::Dispatcher {
        at: url.to_owned(),
        why,
    };
    let mut socket = open_websocket(url, DISPATCHER_SUBPROTOCOL)
        .await
        .map_err(|error| lost(error.to_string()))?;
    let hello = DispatcherHelloRequest {
        protocol: DISPATCHER_PROTOCOL,
        client: client.clone(),
        auth: Some(Auth::Pair {
            code: code.to_owned(),
            device: NewDevice {
                name: name.to_owned(),
                public_key: key.jwk(),
                service: false,
            },
        }),
    };
    let hello = ask(&mut socket, 1, &hello)
        .await
        .map_err(|error| dispatcher_error(error, &lost))?;
    Ok((socket, hello))
}

/// A connection to `host` through the Dispatcher at `via`, said hello to as `client` with the
/// device the Dispatcher names, within `timeout`: the connection, its messages, how it closed
/// once it has, and the Host.
pub async fn reach(
    via: &Via,
    client: ClientInfo,
    capabilities: ClientCapabilities,
    host: &str,
    timeout: Duration,
) -> Result<Reached, CarryError> {
    let attempt = async {
        let (carried, opened) = open(via, &client, host, CarriedStream::Host).await?;
        let (transport, closed) = carried.transport();
        let (connection, events) =
            HostConnection::connect_with(transport, client, capabilities, Credentials::Dispatcher)
                .await?;
        Ok(Reached {
            connection,
            events,
            closed,
            host: opened,
        })
    };
    tokio::time::timeout(timeout, attempt)
        .await
        .unwrap_or_else(|_| {
            Err(CarryError::Dispatcher {
                at: via.place(),
                why: format!(
                    "it didn't carry the connection to {host} within {} seconds",
                    timeout.as_secs_f32()
                ),
            })
        })
}

/// A connection the Dispatcher carries to a Host, said hello to.
pub struct Reached {
    pub connection: HostConnection,
    pub events: mpsc::UnboundedReceiver<HostEvent>,
    pub closed: CloseReason,
    pub host: OpenedHost,
}

/// Why the Dispatcher's challenge or hello failed.
fn dispatcher_error(error: Error, lost: &impl Fn(String) -> CarryError) -> CarryError {
    if errors::is(&error, errors::UNAUTHENTICATED) {
        CarryError::Refused(error.message)
    } else if errors::is(&error, errors::HOST_UNAVAILABLE) {
        lost(error.message)
    } else {
        CarryError::Refusal(error)
    }
}

/// Why `hosts/open` failed: the Host the Dispatcher can't reach says why.
fn opening_error(error: Error, lost: &impl Fn(String) -> CarryError) -> CarryError {
    if errors::is(&error, errors::HOST_UNAVAILABLE)
        && let Some(unavailable) = error
            .data
            .clone()
            .and_then(|data| serde_json::from_value::<HostUnavailable>(data).ok())
    {
        return CarryError::Unavailable(unavailable);
    }
    dispatcher_error(error, lost)
}

/// Send `request` as `id` on the WebSocket and wait for its answer. A connection that fails or
/// closes first fails it with [`errors::HOST_UNAVAILABLE`].
async fn ask<R>(socket: &mut Socket, id: u64, request: &R) -> Result<R::Response, Error>
where
    R: JsonRpcRequest + Serialize,
    R::Response: DeserializeOwned,
{
    let message =
        json!({"jsonrpc": "2.0", "id": id, "method": request.method(), "params": request});
    socket
        .send(Message::text(message.to_string()))
        .await
        .map_err(|error| lost(&format!("sending {}: {error}", request.method())))?;
    loop {
        let text = match socket.next().await {
            Some(Ok(Message::Text(text))) => text,
            Some(Ok(Message::Close(frame))) => {
                let why = frame
                    .map(|frame| frame.reason.to_string())
                    .filter(|reason| !reason.is_empty())
                    .unwrap_or_else(|| "it closed the connection".to_owned());
                return Err(lost(&why));
            }
            Some(Ok(_)) => continue,
            Some(Err(error)) => return Err(lost(&error.to_string())),
            None => return Err(lost("it closed the connection")),
        };
        return answer(&text, id, request.method());
    }
}

/// Send `request` as `id` on the Dispatcher's socket and read its answer, a line each.
async fn ask_line<R>(
    reader: &mut BufReader<OwnedReadHalf>,
    writer: &mut OwnedWriteHalf,
    id: u64,
    request: &R,
) -> Result<R::Response, Error>
where
    R: JsonRpcRequest + Serialize,
    R::Response: DeserializeOwned,
{
    let message =
        json!({"jsonrpc": "2.0", "id": id, "method": request.method(), "params": request});
    writer
        .write_all(format!("{message}\n").as_bytes())
        .await
        .map_err(|error| lost(&format!("sending {}: {error}", request.method())))?;
    let mut line = String::new();
    match reader.read_line(&mut line).await {
        Ok(0) => Err(lost("it closed the connection")),
        Ok(_) => answer(&line, id, request.method()),
        Err(error) => Err(lost(&error.to_string())),
    }
}

/// The answer to request `id` in `text`.
fn answer<T: DeserializeOwned>(text: &str, id: u64, method: &str) -> Result<T, Error> {
    let answer: Value = serde_json::from_str(text)
        .map_err(|error| lost(&format!("an answer that isn't JSON: {error}")))?;
    if answer.get("id") != Some(&json!(id)) {
        return Err(lost("an answer to another request"));
    }
    if let Some(error) = answer.get("error") {
        return Err(serde_json::from_value(error.clone())
            .unwrap_or_else(|_| lost("an error that isn't a JSON-RPC error")));
    }
    let result = answer.get("result").cloned().unwrap_or(Value::Null);
    serde_json::from_value(result).map_err(|error| {
        lost(&format!(
            "an answer to {method} that doesn't parse: {error}"
        ))
    })
}

fn lost(how: &str) -> Error {
    Error::new(errors::HOST_UNAVAILABLE, how.to_owned())
}
