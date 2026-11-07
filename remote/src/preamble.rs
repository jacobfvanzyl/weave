//! The first messages on a WebSocket before the ACP SDK takes it over: a Host joining the
//! Dispatcher (ADR 0030, WVE-194) asks for the Dispatcher's challenge and proves its key, one
//! request at a time, and only then does the Dispatcher say `host/hello` on the same connection,
//! with the roles the other way round. They are JSON-RPC requests and answers in text frames, as
//! everything after them is, read and written here directly because the SDK owns a connection
//! for good once it has it.

use agent_client_protocol::Error;
use agent_client_protocol::JsonRpcRequest;
use futures::SinkExt as _;
use futures::StreamExt as _;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use weave_host_protocol::errors;

/// A request read off the connection.
#[derive(Debug)]
pub struct Asked {
    pub id: Value,
    pub method: String,
    pub params: Value,
}

impl Asked {
    /// Its params as `T`, or the error that answers it.
    pub fn params<T: DeserializeOwned>(&self) -> Result<T, Error> {
        serde_json::from_value(self.params.clone()).map_err(|error| {
            let mut invalid = Error::invalid_params();
            invalid.message = format!("{}: {error}", self.method);
            invalid
        })
    }
}

/// Send `request` as `id` and wait for its answer. Pings and pongs in between are skipped; a
/// close, or anything that isn't the answer, fails it.
pub async fn ask<S, R>(
    socket: &mut WebSocketStream<S>,
    id: u64,
    request: &R,
) -> Result<R::Response, Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
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
            Some(Ok(Message::Close(frame))) => return Err(closed(frame.as_ref())),
            Some(Ok(_)) => continue,
            Some(Err(error)) => return Err(lost(&error.to_string())),
            None => return Err(closed(None)),
        };
        let answer: Value = serde_json::from_str(&text)
            .map_err(|error| lost(&format!("an answer that isn't JSON: {error}")))?;
        if answer.get("id") != Some(&json!(id)) {
            return Err(lost("an answer to another request"));
        }
        if let Some(error) = answer.get("error") {
            return Err(serde_json::from_value(error.clone())
                .unwrap_or_else(|_| lost("an error that isn't a JSON-RPC error")));
        }
        let result = answer.get("result").cloned().unwrap_or(Value::Null);
        return serde_json::from_value(result).map_err(|error| {
            lost(&format!(
                "an answer to {} that doesn't parse: {error}",
                request.method()
            ))
        });
    }
}

/// The next request on the connection. `None` when it closes first, or sends something else.
pub async fn next_request<S: AsyncRead + AsyncWrite + Unpin>(
    socket: &mut WebSocketStream<S>,
) -> Option<Asked> {
    loop {
        match socket.next().await? {
            Ok(Message::Text(text)) => {
                let mut message: Value = serde_json::from_str(&text).ok()?;
                let id = message.get("id")?.clone();
                let method = message.get("method")?.as_str()?.to_owned();
                let params = message
                    .get_mut("params")
                    .map(Value::take)
                    .unwrap_or_else(|| json!({}));
                return Some(Asked { id, method, params });
            }
            Ok(Message::Close(_)) | Err(_) => return None,
            Ok(_) => {}
        }
    }
}

/// Answer the request `id` with `answer`. Whether it was sent.
pub async fn answer<S, T>(
    socket: &mut WebSocketStream<S>,
    id: Value,
    answer: Result<T, Error>,
) -> bool
where
    S: AsyncRead + AsyncWrite + Unpin,
    T: Serialize,
{
    let message = match answer {
        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
        Err(error) => json!({"jsonrpc": "2.0", "id": id, "error": error}),
    };
    socket
        .send(Message::text(message.to_string()))
        .await
        .is_ok()
}

/// Close the connection with `code`, as after a refusal.
pub async fn close<S: AsyncRead + AsyncWrite + Unpin>(socket: &mut WebSocketStream<S>, code: u16) {
    let frame = CloseFrame {
        code: CloseCode::from(code),
        reason: "".into(),
    };
    let _ = socket.close(Some(frame)).await;
}

/// The connection failed, saying how.
fn lost(how: &str) -> Error {
    Error::new(errors::HOST_UNAVAILABLE, how.to_owned())
}

/// The other end closed the connection, saying why if it did.
fn closed(frame: Option<&CloseFrame>) -> Error {
    let code = frame.map(|frame| u16::from(frame.code));
    let mut error = lost(&match frame {
        Some(frame) if !frame.reason.is_empty() => {
            format!("it closed the connection: {}", frame.reason)
        }
        _ => "it closed the connection".to_owned(),
    });
    error.data = code.map(|code| json!({"closeCode": code}));
    error
}
