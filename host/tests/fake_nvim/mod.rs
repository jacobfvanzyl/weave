//! A fake Neovim for the Host's tests: a MessagePack-RPC server on a socket that says it's
//! Neovim 0.12 in Normal mode, answers `nvim_exec_lua` as the Neovim tools' scripts would, and
//! keeps every request it's sent.

#![allow(dead_code)]

use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

use tokio::io::AsyncReadExt as _;
use tokio::io::AsyncWriteExt as _;
use tokio::net::UnixListener;
use tokio::net::UnixStream;
use weave_host::nvim::msgpack;
use weave_host::nvim::msgpack::Value;

/// A request: its method and its parameters.
pub type Request = (String, Vec<Value>);

pub struct FakeNvim {
    requests: Arc<Mutex<Vec<Request>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for FakeNvim {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl FakeNvim {
    /// One listening on `socket`.
    pub fn listen(socket: &Path) -> Self {
        let listener = UnixListener::bind(socket).expect("the fake Neovim's socket");
        let requests: Arc<Mutex<Vec<Request>>> = Arc::default();
        let kept = Arc::clone(&requests);
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(serve(stream, Arc::clone(&kept)));
            }
        });
        Self { requests, task }
    }

    /// The `nvim_exec_lua` requests it was sent: each one's script and arguments.
    pub fn scripts(&self) -> Vec<(String, Vec<Value>)> {
        self.requests
            .lock()
            .expect("lock")
            .iter()
            .filter(|(method, _)| method == "nvim_exec_lua")
            .map(|(_, params)| {
                (
                    params[0].as_str().unwrap_or_default().to_owned(),
                    params[1].as_array().unwrap_or_default().to_vec(),
                )
            })
            .collect()
    }
}

async fn serve(mut stream: UnixStream, requests: Arc<Mutex<Vec<Request>>>) {
    let mut read = Vec::new();
    loop {
        let mut chunk = [0; 4096];
        let Ok(len) = stream.read(&mut chunk).await else {
            return;
        };
        if len == 0 {
            return;
        }
        read.extend_from_slice(&chunk[..len]);
        while let Ok(Some((request, len))) = msgpack::decode(&read) {
            read.drain(..len);
            let Some(parts) = request.as_array() else {
                return;
            };
            let method = parts[2].as_str().unwrap_or_default().to_owned();
            let params = parts[3].as_array().unwrap_or_default().to_vec();
            requests
                .lock()
                .expect("lock")
                .push((method.clone(), params.clone()));
            let (error, result) = answer(&method, &params);
            let response = Value::Array(vec![Value::Int(1), parts[1].clone(), error, result]);
            let mut bytes = Vec::new();
            msgpack::encode(&response, &mut bytes);
            if stream.write_all(&bytes).await.is_err() {
                return;
            }
        }
    }
}

fn position(line: i64, column: i64) -> Value {
    Value::map([("line", Value::Int(line)), ("column", Value::Int(column))])
}

fn answer(method: &str, params: &[Value]) -> (Value, Value) {
    match method {
        "nvim_get_api_info" => (
            Value::Nil,
            Value::Array(vec![
                Value::Int(1),
                Value::map([(
                    "version",
                    Value::map([
                        ("major", Value::Int(0)),
                        ("minor", Value::Int(12)),
                        ("patch", Value::Int(0)),
                    ]),
                )]),
            ]),
        ),
        "nvim_get_mode" => (
            Value::Nil,
            Value::map([("mode", Value::str("n")), ("blocking", Value::Bool(false))]),
        ),
        // open.lua is given the path, line and column; state.lua nothing.
        "nvim_exec_lua" => {
            let arguments = params.get(1).and_then(Value::as_array).unwrap_or_default();
            if let Some(path) = arguments.first() {
                let number = |at: usize| arguments.get(at).and_then(Value::as_i64).unwrap_or(1);
                (
                    Value::Nil,
                    Value::map([
                        ("path", path.clone()),
                        ("line", Value::Int(number(1))),
                        ("column", Value::Int(number(2))),
                        ("split", Value::Bool(false)),
                    ]),
                )
            } else {
                (
                    Value::Nil,
                    Value::map([
                        ("path", Value::str("/src/app/main.rs")),
                        ("buftype", Value::str("")),
                        ("filetype", Value::str("rust")),
                        ("modified", Value::Bool(true)),
                        ("mode", Value::str("v")),
                        ("cursor", position(3, 5)),
                        (
                            "selection",
                            Value::map([
                                ("kind", Value::str("char")),
                                ("start", position(2, 1)),
                                ("end", position(3, 5)),
                                (
                                    "text",
                                    Value::Array(vec![
                                        Value::str("fn main() {"),
                                        Value::str("    x"),
                                    ]),
                                ),
                            ]),
                        ),
                    ]),
                )
            }
        }
        other => (
            Value::Array(vec![
                Value::Int(0),
                Value::str(format!("no method {other}")),
            ]),
            Value::Nil,
        ),
    }
}
