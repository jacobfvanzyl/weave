//! A fake terminal owner for the Host's tests: terminals in memory, described without `command`
//! or `opened_from`, as an owner that isn't a holder may describe them, unless it's told a
//! command runs in them. What's written to one is its screen.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;

use agent_client_protocol::Error;
use futures::future::BoxFuture;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;
use weave_host::terminals::Incoming;
use weave_host::terminals::Outgoing;
use weave_host::terminals::Owner;
use weave_host::terminals::Start;
use weave_host::terminals::Wire;
use weave_host_protocol::errors;

#[derive(Default)]
pub struct FakeOwner {
    terminals: Arc<Mutex<BTreeMap<String, FakeTerminal>>>,
    /// Its terminals say a command runs in them.
    running: bool,
}

struct FakeTerminal {
    start: Start,
    label: Option<String>,
    screen: String,
    connections: Vec<mpsc::Sender<Incoming>>,
}

impl FakeOwner {
    pub fn running() -> Self {
        Self {
            running: true,
            ..Self::default()
        }
    }
}

fn described(terminal: &FakeTerminal, running: bool) -> Value {
    let mut described = json!({
        "id": terminal.start.id,
        "scope": terminal.start.scope,
        "label": terminal.label,
        "size": {"cols": terminal.start.size.cols, "rows": terminal.start.size.rows},
        "started_at": 1,
    });
    if running {
        described["command"] = json!({"running": true, "command": "npm run dev"});
    }
    described
}

impl Owner for FakeOwner {
    fn find(&self) -> BoxFuture<'_, Vec<String>> {
        let ids = self
            .terminals
            .lock()
            .expect("lock")
            .keys()
            .cloned()
            .collect();
        Box::pin(async move { ids })
    }

    fn start(&self, start: Start) -> BoxFuture<'_, Result<String, Error>> {
        let id = start.id.clone();
        self.terminals.lock().expect("lock").insert(
            id.clone(),
            FakeTerminal {
                label: start.label.clone(),
                start,
                screen: String::new(),
                connections: Vec::new(),
            },
        );
        Box::pin(async move { Ok(id) })
    }

    fn connect<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Wire, Error>> {
        Box::pin(async move {
            let (outgoing, mut requests) = mpsc::channel::<Outgoing>(64);
            let (incoming_tx, incoming) = mpsc::channel(64);
            self.terminals
                .lock()
                .expect("lock")
                .get_mut(id)
                .ok_or_else(|| errors::unknown_terminal(id))?
                .connections
                .push(incoming_tx.clone());
            let terminals = Arc::clone(&self.terminals);
            let running = self.running;
            let id = id.to_owned();
            tokio::spawn(async move {
                while let Some(message) = requests.recv().await {
                    let Outgoing::Request {
                        id: request,
                        method,
                        args,
                    } = message
                    else {
                        continue;
                    };
                    let (result, events) = {
                        let mut terminals = terminals.lock().expect("lock");
                        let Some(terminal) = terminals.get_mut(&id) else {
                            break;
                        };
                        match method.as_str() {
                            "subscribe" | "describe" => (Ok(described(terminal, running)), vec![]),
                            "set_label" => {
                                terminal.label = args["label"].as_str().map(str::to_owned);
                                (Ok(json!({})), vec![("label_changed", json!({}))])
                            }
                            "write" => {
                                terminal
                                    .screen
                                    .push_str(args["text"].as_str().unwrap_or_default());
                                (Ok(json!({})), vec![])
                            }
                            "format" => (Ok(json!({"content": terminal.screen})), vec![]),
                            "attach" => (
                                Ok(json!({"restore": args["restore"], "snapshot_bytes": 4})),
                                vec![("restore", json!({}))],
                            ),
                            "close" => (
                                Ok(json!({})),
                                vec![("child_exited", json!({"exit_code": 129}))],
                            ),
                            other => (Err(format!("no method {other}")), vec![]),
                        }
                    };
                    let _ = incoming_tx
                        .send(Incoming::Answer {
                            id: request,
                            result,
                        })
                        .await;
                    for (kind, payload) in events {
                        if kind == "restore" {
                            let _ = incoming_tx.send(Incoming::Restore(b"fake".to_vec())).await;
                            continue;
                        }
                        let connections = terminals
                            .lock()
                            .expect("lock")
                            .get(&id)
                            .map(|terminal| terminal.connections.clone())
                            .unwrap_or_default();
                        for connection in connections {
                            let _ = connection
                                .send(Incoming::Event {
                                    kind: kind.to_owned(),
                                    payload: payload.clone(),
                                })
                                .await;
                        }
                        if kind == "child_exited" {
                            terminals.lock().expect("lock").remove(&id);
                        }
                    }
                }
            });
            Ok(Wire { outgoing, incoming })
        })
    }
}
