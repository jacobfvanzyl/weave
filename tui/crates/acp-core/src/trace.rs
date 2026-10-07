//! Protocol traces in the format of the ACP SDK's trace viewer
//! (`agent-client-protocol-trace-viewer trace.jsons`).
//!
//! Each line is one event, `{"type": "request" | "response" | "notification", ...}`, matching
//! `agent_client_protocol_conductor::trace::TraceEvent`. Agent stderr is not protocol traffic;
//! it goes to the log (`agent_stderr` target) instead.

use std::fs::File;
use std::fs::OpenOptions;
use std::io::BufWriter;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

use agent_client_protocol::LineDirection;
use serde_json::Map;
use serde_json::Value;

pub struct ProtocolTrace {
    started: Instant,
    out: Mutex<BufWriter<File>>,
}

impl ProtocolTrace {
    /// Append to `path`, creating it if needed, so reconnects extend one trace.
    pub fn create(path: &Path) -> std::io::Result<Self> {
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        Ok(Self {
            started: Instant::now(),
            out: Mutex::new(BufWriter::new(file)),
        })
    }

    pub(crate) fn record(&self, direction: LineDirection, line: &str) {
        let (from, to) = match direction {
            LineDirection::Stdin => ("client", "agent"),
            LineDirection::Stdout => ("agent", "client"),
            LineDirection::Stderr => return,
        };
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            tracing::warn!(from, "agent wrote a non-JSON line on the protocol stream");
            return;
        };
        let ts = self.started.elapsed().as_secs_f64();
        let Ok(mut out) = self.out.lock() else {
            return;
        };
        // Flush per message so a trace survives the agent or this process crashing.
        let written = trace_events(ts, from, to, &message)
            .into_iter()
            .try_for_each(|event| writeln!(out, "{event}"))
            .and_then(|()| out.flush());
        if let Err(error) = written {
            tracing::warn!(%error, "failed to write protocol trace");
        }
    }
}

/// The trace events for one JSON-RPC message (or each message of a batch).
pub fn trace_events(ts: f64, from: &str, to: &str, message: &Value) -> Vec<Value> {
    if let Value::Array(batch) = message {
        return batch
            .iter()
            .flat_map(|message| trace_events(ts, from, to, message))
            .collect();
    }
    let Some(message) = message.as_object() else {
        return Vec::new();
    };
    let method = message.get("method").and_then(Value::as_str);
    let id = message.get("id").filter(|id| !id.is_null());
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let session = params
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_owned);

    let mut event = Map::new();
    let kind = match (method, id) {
        (Some(method), Some(id)) => {
            event.insert("protocol".into(), "acp".into());
            event.insert("id".into(), id.clone());
            event.insert("method".into(), method.into());
            "request"
        }
        (Some(method), None) => {
            event.insert("protocol".into(), "acp".into());
            event.insert("method".into(), method.into());
            "notification"
        }
        (None, Some(id)) => {
            let error = message.get("error");
            event.insert("id".into(), id.clone());
            event.insert("is_error".into(), error.is_some().into());
            let payload = error
                .or_else(|| message.get("result"))
                .cloned()
                .unwrap_or(Value::Null);
            event.insert("payload".into(), payload);
            "response"
        }
        (None, None) => return Vec::new(),
    };
    event.insert("type".into(), kind.into());
    event.insert("ts".into(), ts.into());
    event.insert("from".into(), from.into());
    event.insert("to".into(), to.into());
    if kind != "response" {
        if let Some(session) = session {
            event.insert("session".into(), session.into());
        }
        event.insert("params".into(), params);
    }
    vec![Value::Object(event)]
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use serde_json::json;

    use super::*;

    #[test]
    fn requests_notifications_and_responses_match_the_viewer_format() {
        let request = json!({"jsonrpc": "2.0", "id": 1, "method": "session/prompt", "params": {"sessionId": "s1", "prompt": []}});
        assert_eq!(
            trace_events(0.5, "client", "agent", &request),
            [json!({
                "type": "request", "ts": 0.5, "protocol": "acp", "from": "client", "to": "agent",
                "id": 1, "method": "session/prompt", "session": "s1",
                "params": {"sessionId": "s1", "prompt": []}
            })]
        );

        let notification =
            json!({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": "s1"}});
        assert_eq!(
            trace_events(1.0, "client", "agent", &notification)[0]["type"],
            "notification"
        );

        let error =
            json!({"jsonrpc": "2.0", "id": 1, "error": {"code": -32800, "message": "cancelled"}});
        assert_eq!(
            trace_events(2.0, "agent", "client", &error),
            [json!({
                "type": "response", "ts": 2.0, "from": "agent", "to": "client", "id": 1,
                "is_error": true, "payload": {"code": -32800, "message": "cancelled"}
            })]
        );
    }

    #[test]
    fn batches_become_one_event_per_message() {
        let batch = json!([
            {"jsonrpc": "2.0", "id": 1, "result": {}},
            {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s1"}}
        ]);
        let events = trace_events(0.0, "agent", "client", &batch);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["type"], "response");
        assert_eq!(events[1]["session"], "s1");
    }
}
