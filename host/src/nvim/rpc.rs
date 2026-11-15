//! A MessagePack-RPC client of one Neovim, on its socket
//! (<https://github.com/msgpack-rpc/msgpack-rpc/blob/master/spec.md>, `:help msgpack-rpc`): a
//! request at a time, each answered or timed out. What Neovim sends meanwhile is passed over:
//! notifications, and its own requests, which are answered with an error.

use std::path::Path;
use std::time::Duration;

use tokio::io::AsyncReadExt as _;
use tokio::io::AsyncWriteExt as _;
use tokio::net::UnixStream;

use super::msgpack;
use super::msgpack::Value;

/// The message types of MessagePack-RPC.
const REQUEST: i64 = 0;
const RESPONSE: i64 = 1;
const NOTIFICATION: i64 = 2;
/// The most a client reads of one answer.
const MAX_MESSAGE: usize = 16 * 1024 * 1024;
/// How much room a read has at least.
const READ_CHUNK: usize = 64 * 1024;

/// Why a call failed.
#[derive(Debug)]
pub(crate) enum RpcError {
    /// Nothing answered at the socket in time, or nothing listens there.
    Connect(std::io::Error),
    /// The call wasn't answered in time.
    TimedOut,
    /// The connection ended, or failed, before the answer.
    Closed(String),
    /// Neovim answered with what isn't MessagePack-RPC.
    Protocol(String),
    /// Neovim answered with an error: its message.
    Remote(String),
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Connect(error) => write!(f, "couldn't connect: {error}"),
            Self::TimedOut => write!(f, "it didn't answer in time"),
            Self::Closed(why) => write!(f, "the connection ended: {why}"),
            Self::Protocol(why) => write!(f, "it answered with what isn't MessagePack-RPC: {why}"),
            Self::Remote(message) => write!(f, "{message}"),
        }
    }
}

/// One connection to a Neovim.
pub(crate) struct Rpc {
    stream: UnixStream,
    /// What was read and not yet taken.
    read: Vec<u8>,
    next: i64,
    timeout: Duration,
}

impl Rpc {
    /// Connects to the socket at `path` within `timeout`, which each call then has too, until
    /// [`Self::set_timeout`] gives another.
    pub(crate) async fn connect(path: &Path, timeout: Duration) -> Result<Self, RpcError> {
        let stream = tokio::time::timeout(timeout, UnixStream::connect(path))
            .await
            .map_err(|_| {
                RpcError::Connect(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "timed out",
                ))
            })?
            .map_err(RpcError::Connect)?;
        Ok(Self {
            stream,
            read: Vec::new(),
            next: 1,
            timeout,
        })
    }

    /// Each call has `timeout` from now on.
    pub(crate) fn set_timeout(&mut self, timeout: Duration) {
        self.timeout = timeout;
    }

    /// Calls `method` with `params`, and gives its result.
    pub(crate) async fn call(
        &mut self,
        method: &str,
        params: Vec<Value>,
    ) -> Result<Value, RpcError> {
        let id = self.next;
        self.next += 1;
        let timeout = self.timeout;
        tokio::time::timeout(timeout, self.exchange(id, method, params))
            .await
            .map_err(|_| RpcError::TimedOut)?
    }

    async fn exchange(
        &mut self,
        id: i64,
        method: &str,
        params: Vec<Value>,
    ) -> Result<Value, RpcError> {
        let request = Value::Array(vec![
            Value::Int(REQUEST),
            Value::Int(id),
            Value::str(method),
            Value::Array(params),
        ]);
        self.send(&request).await?;
        loop {
            let message = self.receive().await?;
            let parts = message
                .as_array()
                .ok_or_else(|| RpcError::Protocol("a message that isn't an array".to_owned()))?;
            match parts.first().and_then(Value::as_i64) {
                Some(RESPONSE) if parts.len() == 4 => {
                    // A late answer to a call that timed out is passed over.
                    if parts[1].as_i64() != Some(id) {
                        continue;
                    }
                    return match &parts[2] {
                        Value::Nil => Ok(parts[3].clone()),
                        error => Err(RpcError::Remote(error_message(error))),
                    };
                }
                Some(NOTIFICATION) if parts.len() == 3 => {}
                Some(REQUEST) if parts.len() == 4 => {
                    let answer = Value::Array(vec![
                        Value::Int(RESPONSE),
                        parts[1].clone(),
                        Value::str("weave's Host answers no requests"),
                        Value::Nil,
                    ]);
                    self.send(&answer).await?;
                }
                _ => {
                    return Err(RpcError::Protocol(format!("{message:?}")));
                }
            }
        }
    }

    async fn send(&mut self, message: &Value) -> Result<(), RpcError> {
        let mut bytes = Vec::new();
        msgpack::encode(message, &mut bytes);
        self.stream
            .write_all(&bytes)
            .await
            .map_err(|error| RpcError::Closed(error.to_string()))
    }

    /// The next whole message.
    async fn receive(&mut self) -> Result<Value, RpcError> {
        loop {
            match msgpack::decode(&self.read) {
                Ok(Some((message, len))) => {
                    self.read.drain(..len);
                    return Ok(message);
                }
                Ok(None) if self.read.len() > MAX_MESSAGE => {
                    return Err(RpcError::Protocol(format!(
                        "a message longer than {MAX_MESSAGE} bytes"
                    )));
                }
                Ok(None) => {}
                Err(malformed) => return Err(RpcError::Protocol(malformed.to_string())),
            }
            self.read.reserve(READ_CHUNK);
            let len = self
                .stream
                .read_buf(&mut self.read)
                .await
                .map_err(|error| RpcError::Closed(error.to_string()))?;
            if len == 0 {
                return Err(RpcError::Closed("Neovim closed it".to_owned()));
            }
        }
    }
}

/// The message in an RPC error: Neovim's are `[type, message]`.
fn error_message(error: &Value) -> String {
    match error {
        Value::Str(message) => message.clone(),
        Value::Array(parts) => match parts.get(1).and_then(Value::as_str) {
            Some(message) => message.to_owned(),
            None => format!("{error:?}"),
        },
        other => format!("{other:?}"),
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use tokio::net::UnixListener;

    use super::*;

    /// A server on a socket in `dir` that answers each request with what `answer` gives for its
    /// method, by writing the bytes it returns; requests and their ids go to `seen`.
    fn serve(
        dir: &Path,
        answer: impl Fn(i64, &str) -> Vec<Value> + Send + 'static,
    ) -> (
        std::path::PathBuf,
        tokio::sync::mpsc::UnboundedReceiver<(String, Vec<Value>)>,
    ) {
        let path = dir.join("n.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let (seen_tx, seen) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut read = Vec::new();
            loop {
                let request = loop {
                    if let Some((value, len)) = msgpack::decode(&read).unwrap() {
                        read.drain(..len);
                        break value;
                    }
                    let mut chunk = [0; 1024];
                    let len = stream.read(&mut chunk).await.unwrap();
                    if len == 0 {
                        return;
                    }
                    read.extend_from_slice(&chunk[..len]);
                };
                let parts = request.as_array().unwrap().to_vec();
                // The client's answer to a request of the server's.
                if parts[0] == Value::Int(RESPONSE) {
                    let _ = seen_tx.send(("response".to_owned(), parts));
                    continue;
                }
                let method = parts[2].as_str().unwrap_or_default().to_owned();
                let id = parts[1].as_i64().unwrap();
                let _ = seen_tx.send((method.clone(), parts[3].as_array().unwrap().to_vec()));
                for message in answer(id, &method) {
                    let mut bytes = Vec::new();
                    msgpack::encode(&message, &mut bytes);
                    // A byte at a time, so answers arrive in pieces.
                    for byte in bytes {
                        stream.write_all(&[byte]).await.unwrap();
                    }
                }
            }
        });
        (path, seen)
    }

    fn response(id: i64, error: Value, result: Value) -> Value {
        Value::Array(vec![Value::Int(RESPONSE), Value::Int(id), error, result])
    }

    #[tokio::test]
    async fn a_request_gets_its_response() {
        let dir = tempfile::tempdir().unwrap();
        let (path, mut seen) = serve(dir.path(), |id, method| {
            vec![response(
                id,
                Value::Nil,
                Value::str(format!("{method} done")),
            )]
        });
        let mut rpc = Rpc::connect(&path, Duration::from_secs(5)).await.unwrap();
        let answer = rpc
            .call("nvim_eval", vec![Value::str("1 + 1"), Value::Int(-3)])
            .await
            .unwrap();
        assert_eq!(answer, Value::str("nvim_eval done"));
        assert_eq!(
            seen.recv().await.unwrap(),
            (
                "nvim_eval".to_owned(),
                vec![Value::str("1 + 1"), Value::Int(-3)]
            )
        );
        // A second call on the same connection.
        let answer = rpc.call("nvim_get_mode", vec![]).await.unwrap();
        assert_eq!(answer, Value::str("nvim_get_mode done"));
    }

    #[tokio::test]
    async fn an_error_response_is_its_message() {
        let dir = tempfile::tempdir().unwrap();
        let (path, _seen) = serve(dir.path(), |id, _| {
            vec![response(
                id,
                Value::Array(vec![
                    Value::Int(0),
                    Value::str("Vim:E37: No write since last change"),
                ]),
                Value::Nil,
            )]
        });
        let mut rpc = Rpc::connect(&path, Duration::from_secs(5)).await.unwrap();
        match rpc.call("nvim_exec_lua", vec![]).await {
            Err(RpcError::Remote(message)) => {
                assert_eq!(message, "Vim:E37: No write since last change");
            }
            other => panic!("an error response, not {other:?}"),
        }
    }

    #[tokio::test]
    async fn notifications_requests_and_stale_answers_in_between_are_passed_over() {
        let dir = tempfile::tempdir().unwrap();
        let (path, mut seen) = serve(dir.path(), |id, method| {
            if method != "nvim_get_mode" {
                return vec![];
            }
            vec![
                Value::Array(vec![
                    Value::Int(NOTIFICATION),
                    Value::str("redraw"),
                    Value::Array(vec![]),
                ]),
                // A request of Neovim's own, which the client answers with an error.
                Value::Array(vec![
                    Value::Int(REQUEST),
                    Value::Int(77),
                    Value::str("ask"),
                    Value::Array(vec![]),
                ]),
                response(id - 1, Value::Nil, Value::str("stale")),
                response(id, Value::Nil, Value::map([("mode", Value::str("n"))])),
            ]
        });
        let mut rpc = Rpc::connect(&path, Duration::from_secs(5)).await.unwrap();
        let answer = rpc.call("nvim_get_mode", vec![]).await.unwrap();
        assert_eq!(answer.get("mode"), Some(&Value::str("n")));
        assert_eq!(seen.recv().await.unwrap().0, "nvim_get_mode");
        assert_eq!(
            seen.recv().await.unwrap(),
            (
                "response".to_owned(),
                vec![
                    Value::Int(RESPONSE),
                    Value::Int(77),
                    Value::str("weave's Host answers no requests"),
                    Value::Nil,
                ]
            )
        );
    }

    #[tokio::test]
    async fn a_call_nobody_answers_times_out() {
        let dir = tempfile::tempdir().unwrap();
        let (path, _seen) = serve(dir.path(), |_, _| vec![]);
        let mut rpc = Rpc::connect(&path, Duration::from_millis(200))
            .await
            .unwrap();
        let started = std::time::Instant::now();
        assert!(matches!(
            rpc.call("nvim_exec_lua", vec![]).await,
            Err(RpcError::TimedOut)
        ));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    /// A socket file whose listener has closed, as a Neovim that's gone leaves one. Another
    /// test's child can hold the listener between its fork and exec, so this waits until
    /// nothing does.
    pub(crate) async fn stale_socket(path: &Path) {
        drop(std::os::unix::net::UnixListener::bind(path).unwrap());
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::os::unix::net::UnixStream::connect(path).is_ok() {
            assert!(
                std::time::Instant::now() < deadline,
                "the socket still answers"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn nothing_listening_fails_to_connect() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("left.sock");
        stale_socket(&path).await;
        assert!(matches!(
            Rpc::connect(&path, Duration::from_secs(1)).await,
            Err(RpcError::Connect(_))
        ));
        assert!(matches!(
            Rpc::connect(&dir.path().join("none.sock"), Duration::from_secs(1)).await,
            Err(RpcError::Connect(_))
        ));
    }

    #[tokio::test]
    async fn a_connection_that_ends_fails_the_call() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("n.sock");
        let listener = UnixListener::bind(&path).unwrap();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            drop(stream);
        });
        let mut rpc = Rpc::connect(&path, Duration::from_secs(5)).await.unwrap();
        assert!(matches!(
            rpc.call("nvim_get_mode", vec![]).await,
            Err(RpcError::Closed(_))
        ));
    }
}
