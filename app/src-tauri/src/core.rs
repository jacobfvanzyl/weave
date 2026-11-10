//! What the Mac's app reaches, and how (ADR 0032): this Mac's Host over its Unix socket, as
//! local clients do (ADR 0030), and the Dispatcher this computer is paired with, its API and the
//! connections it carries to every other Host, proved with the computer's key in the Secure
//! Enclave. The core opens each and proves the device itself, then relays the connection to the
//! page ([`crate::relay`]), which speaks the Host protocol and the Dispatcher's API on it. The
//! page never holds the key, nor asks for anything to be signed.
//!
//! The pairing is the one the CLI keeps ([`weave_host_client::paired`]): this computer is one
//! device to the Dispatcher.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::JsonRpcMessage as _;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncBufReadExt as _;
use tokio::io::AsyncWriteExt as _;
use tokio::io::BufReader;
use tokio::net::UnixStream;
use weave_host_client::carry;
use weave_host_client::carry::CarryError;
use weave_host_client::carry::Via;
use weave_host_client::paired;
use weave_host_client::paired::Paired;
use weave_host_protocol::VersionRange;
use weave_host_protocol::dispatcher::CarriedStream;
use weave_host_protocol::dispatcher::DispatcherHello;
use weave_host_protocol::errors;
use weave_host_protocol::hello::Auth;
use weave_host_protocol::hello::ClientCapabilities;
use weave_host_protocol::hello::ClientInfo;
use weave_host_protocol::hello::HelloRequest;
use weave_host_protocol::hello::HelloResponse;

use crate::relay::Pipe;
use crate::relay::Relay;
use crate::relay::Sink;
use crate::terminals::Streams;
use crate::terminals::Target;

/// JSON-RPC's own code for a method the other side doesn't have.
const METHOD_NOT_FOUND: i32 = -32601;

/// How long finding this Mac's Host on its socket may take.
const LOCAL_HELLO: Duration = Duration::from_secs(3);

/// Why a connection couldn't be opened, as the page's `ConnectError` takes it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Failure {
    /// `connection`, `unavailable`, `incompatible`, `refused` or `unpaired`.
    pub kind: &'static str,
    pub message: String,
    /// What a Host the Dispatcher can't reach carried: `hosts/list`'s status and why.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl Failure {
    pub(crate) fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            data: None,
        }
    }

    fn unpaired() -> Self {
        Self::new(
            "unpaired",
            "This Mac isn't paired with a Dispatcher. Pair it here, or run `weave dispatcher \
             connect <its computer>`.",
        )
    }
}

/// Why the Dispatcher didn't take a connection, or didn't carry it, as the page's
/// `dispatcherFailed` says it.
impl From<CarryError> for Failure {
    fn from(error: CarryError) -> Self {
        match error {
            CarryError::Dispatcher { why, .. } => Self::new(
                "connection",
                format!("Couldn't reach the Dispatcher: {why}"),
            ),
            CarryError::Refused(why) => Self::new(
                "unpaired",
                format!("The Dispatcher refused this device ({why}). Pair it again."),
            ),
            CarryError::Unavailable(unavailable) => Self {
                kind: "unavailable",
                message: unavailable.why.clone(),
                data: serde_json::to_value(&unavailable).ok(),
            },
            CarryError::Refusal(error) if errors::is(&error, errors::UNAUTHENTICATED) => Self::new(
                "unpaired",
                format!(
                    "The Dispatcher refused this device ({}). Pair it again.",
                    error.message
                ),
            ),
            CarryError::Refusal(error) if errors::is(&error, errors::INCOMPATIBLE_PROTOCOL) => {
                Self::new(
                    "incompatible",
                    format!(
                        "The Dispatcher and this app share no version of its API ({}). Update \
                         weave there, or this app.",
                        error.message
                    ),
                )
            }
            CarryError::Refusal(error) if errors::is(&error, METHOD_NOT_FOUND) => Self::new(
                "incompatible",
                "The Dispatcher is older than this app; update weave on its computer.",
            ),
            // As for a Host that never joined it, or that it no longer has.
            CarryError::Refusal(error) => Self::new("unavailable", error.message),
            CarryError::Hello(error) => Self::new("refused", error.to_string()),
        }
    }
}

/// This computer's pairing, as the page shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    pub url: String,
    pub dispatcher_id: String,
    pub device_id: String,
    /// What the Dispatcher's computer is called: the one SSH reached, or the URL's host.
    pub name: String,
}

impl From<Paired> for Pairing {
    fn from(paired: Paired) -> Self {
        let name = paired.computer.clone().unwrap_or_else(|| {
            url_host(&paired.url).map_or_else(|| paired.url.clone(), str::to_owned)
        });
        Self {
            url: paired.url,
            dispatcher_id: paired.dispatcher_id,
            device_id: paired.device_id,
            name,
        }
    }
}

/// `wss://homelab.tailnet.ts.net:7342` → `homelab.tailnet.ts.net`.
fn url_host(url: &str) -> Option<&str> {
    let rest = url.split_once("://")?.1;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority
        .rsplit_once(':')
        .map_or(authority, |(host, _)| host);
    (!host.is_empty()).then_some(host)
}

/// This Mac's Host, as its hello says.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalHost {
    pub host_id: String,
}

/// The Dispatcher's API, said hello to, once it's the page's.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDispatcher {
    pub id: u64,
    pub hello: DispatcherHello,
}

/// The core: the connections it relays, and how it reaches what they go to.
pub struct Core {
    relay: Arc<Relay>,
    client: ClientInfo,
    /// This Mac's Host's socket; none where there's no home directory.
    socket: Option<PathBuf>,
    /// The terminals' streams the page opens for itself ([`crate::terminals`]).
    streams: Streams,
}

impl Core {
    pub fn new(client: ClientInfo, socket: Option<PathBuf>) -> Self {
        Self {
            relay: Arc::default(),
            client,
            socket,
            streams: Streams::new(false),
        }
    }

    /// Takes terminals' streams from Vite's pages on this computer too, as under `tauri dev`.
    #[must_use]
    pub fn in_development(mut self, dev: bool) -> Self {
        self.streams = Streams::new(dev);
        self
    }

    pub fn relay(&self) -> &Arc<Relay> {
        &self.relay
    }

    pub fn streams(&self) -> &Streams {
        &self.streams
    }

    pub(crate) fn client(&self) -> &ClientInfo {
        &self.client
    }

    /// This Mac's Host's terminal socket, beside its own (`weave_host::DaemonPaths`).
    pub(crate) fn terminal_socket(&self) -> Option<PathBuf> {
        Some(self.socket.as_ref()?.with_file_name("terminals.sock"))
    }

    /// Where the page opens a WebSocket of its own, soon, for a terminal's stream: this Mac's
    /// Host's, or with `host` the one the Dispatcher carries to that Host. The page says the
    /// stream's `Open` there, with the ticket `terminals/attach` gave it on that Host.
    pub fn offer_terminal_stream(&self, host: Option<&str>) -> Result<String, Failure> {
        self.streams.offer(match host {
            Some(host) => Target::Host(host.to_owned()),
            None => Target::Local,
        })
    }

    /// The Dispatcher this computer is paired with, if it is.
    pub fn pairing(&self) -> Result<Option<Pairing>, Failure> {
        paired::load()
            .map(|paired| paired.map(Pairing::from))
            .map_err(|error| Failure::new("connection", error.to_string()))
    }

    /// Forgets the pairing and its key, for the CLI too: the Dispatcher lists this computer
    /// until it's revoked there.
    pub fn forget(&self) -> Result<(), Failure> {
        paired::forget()
            .map(|_| ())
            .map_err(|error| Failure::new("connection", error.to_string()))
    }

    /// This Mac's Host, if one answers on its socket.
    pub async fn local_host(&self) -> Option<LocalHost> {
        let socket = self.socket.as_ref()?;
        let hello = tokio::time::timeout(LOCAL_HELLO, local_hello(socket, &self.client))
            .await
            .ok()??;
        (!hello.host.id.is_empty()).then_some(LocalHost {
            host_id: hello.host.id,
        })
    }

    /// This Mac's Host's socket, relayed to `sink`: the page says hello there as a local
    /// client.
    pub async fn open_local(&self, sink: Sink) -> Result<u64, Failure> {
        let socket = self.socket.as_ref().ok_or_else(|| {
            Failure::new("connection", "This Mac has no home directory for its Host.")
        })?;
        let stream = UnixStream::connect(socket).await.map_err(|error| {
            Failure::new(
                "connection",
                format!(
                    "Couldn't reach this Mac's Host at {}: {error}",
                    socket.display()
                ),
            )
        })?;
        Ok(self.relay.start(Pipe::Lines(stream), sink))
    }

    /// A connection the Dispatcher carries to `host`, by id or name, relayed to `sink`: the
    /// page says hello there with `dispatcher`.
    pub async fn open_host(&self, host: &str, sink: Sink) -> Result<u64, Failure> {
        let via = self.via()?;
        let (carried, _) = carry::open(&via, &self.client, host, CarriedStream::Host).await?;
        match carried {
            carry::Carried::WebSocket(socket) => {
                Ok(self.relay.start(Pipe::WebSocket(socket), sink))
            }
            // Only a Dispatcher on this computer carries over its socket, and the core goes
            // through the one it's paired with.
            carry::Carried::Socket(..) => Err(Failure::new(
                "connection",
                "The Dispatcher carried the connection over its socket, which the app doesn't use.",
            )),
        }
    }

    /// The Dispatcher's API, said hello to as this computer, relayed to `sink`.
    pub async fn open_dispatcher(&self, sink: Sink) -> Result<OpenedDispatcher, Failure> {
        let Via::Paired {
            url,
            dispatcher_id,
            device_id,
            key,
        } = self.via()?
        else {
            return Err(Failure::unpaired());
        };
        let (socket, hello) =
            carry::api(&url, &self.client, &dispatcher_id, &device_id, &key).await?;
        let id = self.relay.start(Pipe::WebSocket(Box::new(socket)), sink);
        Ok(OpenedDispatcher { id, hello })
    }

    /// Pairs this computer with the Dispatcher at `url`, its WebSocket, with the code `weave
    /// pair` showed, as a device called `name`, in place of any pairing before; then relays its
    /// API, said hello to as the new device, to `sink`. A pairing that fails leaves the one
    /// before it as it was.
    pub async fn pair(
        &self,
        url: &str,
        code: &str,
        name: &str,
        sink: Sink,
    ) -> Result<OpenedDispatcher, Failure> {
        let key =
            paired::new_key().map_err(|error| Failure::new("connection", error.to_string()))?;
        let (socket, hello) = carry::pair(url, &self.client, code, name, &key).await?;
        let Some(device) = hello.device.clone() else {
            return Err(Failure::new(
                "refused",
                "The Dispatcher paired no device. Is it a weave Dispatcher?",
            ));
        };
        paired::save(&Paired {
            url: url.to_owned(),
            dispatcher_id: hello.id.clone(),
            device_id: device.id,
            computer: None,
            paired_at: paired::now_ms(),
        })
        .map_err(|error| Failure::new("connection", error.to_string()))?;
        let id = self.relay.start(Pipe::WebSocket(Box::new(socket)), sink);
        Ok(OpenedDispatcher { id, hello })
    }

    pub(crate) fn via(&self) -> Result<Via, Failure> {
        let paired = paired::load()
            .map_err(|error| Failure::new("connection", error.to_string()))?
            .ok_or_else(Failure::unpaired)?;
        let key = paired::key().map_err(|error| Failure::new("unpaired", error.to_string()))?;
        Ok(Via::Paired {
            url: paired.url,
            dispatcher_id: paired.dispatcher_id,
            device_id: paired.device_id,
            key,
        })
    }
}

/// Says hello on this Mac's Host's socket as a local client, and gives its answer.
async fn local_hello(socket: &PathBuf, client: &ClientInfo) -> Option<HelloResponse> {
    let stream = UnixStream::connect(socket).await.ok()?;
    let (reader, mut writer) = stream.into_split();
    let request = HelloRequest {
        protocol: VersionRange::supported(),
        client: client.clone(),
        auth: Auth::Local,
        capabilities: ClientCapabilities::default(),
    };
    let message = json!({"jsonrpc": "2.0", "id": 1, "method": request.method(), "params": request});
    writer
        .write_all(format!("{message}\n").as_bytes())
        .await
        .ok()?;
    let mut reader = BufReader::new(reader);
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).await.ok()? == 0 {
            return None;
        }
        let answer: Value = serde_json::from_str(&line).ok()?;
        if answer.get("id") != Some(&json!(1)) {
            continue;
        }
        return serde_json::from_value(answer.get("result")?.clone()).ok();
    }
}

/// This Mac's Host's socket, as `weave daemon` places it (`weave_host::DaemonPaths::from_env`):
/// in `$WEAVE_DAEMON_DIR`, else in `$XDG_RUNTIME_DIR/weave` when that's set, else in the Host's
/// directory, `$XDG_STATE_HOME/weave/daemon` (by default `~/.local/state/weave/daemon`). An app
/// started from the Finder has none of those set, and finds the launchd service's Host there.
pub fn local_socket() -> Option<PathBuf> {
    let var = |name: &str| std::env::var_os(name).filter(|value| !value.is_empty());
    if let Some(dir) = var("WEAVE_DAEMON_DIR") {
        return Some(PathBuf::from(dir).join("daemon.sock"));
    }
    if let Some(runtime) = var("XDG_RUNTIME_DIR") {
        return Some(PathBuf::from(runtime).join("weave/daemon.sock"));
    }
    let state = var("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| var("HOME").map(|home| PathBuf::from(home).join(".local/state")))?;
    Some(state.join("weave/daemon/daemon.sock"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn a_pairing_is_named_after_its_computer_or_its_urls_host() {
        let paired = |computer: Option<&str>| Paired {
            url: "wss://homelab.tail.ts.net:7342".to_owned(),
            dispatcher_id: "d-1".to_owned(),
            device_id: "dev-1".to_owned(),
            computer: computer.map(str::to_owned),
            paired_at: 0,
        };
        assert_eq!(Pairing::from(paired(Some("homelab"))).name, "homelab");
        assert_eq!(Pairing::from(paired(None)).name, "homelab.tail.ts.net");
        assert_eq!(url_host("ws://127.0.0.1:9000/x"), Some("127.0.0.1"));
        assert_eq!(url_host("nonsense"), None);
    }

    #[test]
    fn a_host_the_dispatcher_cant_reach_says_why_with_its_status() {
        let failure = Failure::from(CarryError::Unavailable(
            serde_json::from_value(json!({"status": "unreachable", "why": "homelab is asleep"}))
                .expect("a HostUnavailable"),
        ));
        assert_eq!(failure.kind, "unavailable");
        assert_eq!(failure.message, "homelab is asleep");
        assert_eq!(
            failure.data,
            Some(json!({"status": "unreachable", "why": "homelab is asleep"}))
        );
        let refused = Failure::from(CarryError::Refused("revoked".to_owned()));
        assert_eq!(refused.kind, "unpaired");
    }
}
