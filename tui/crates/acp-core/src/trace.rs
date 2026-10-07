use std::fs::File;
use std::fs::OpenOptions;
use std::io::BufWriter;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

use agent_client_protocol::LineDirection;
use serde_json::Value;
use serde_json::json;

/// Appends every line exchanged with an agent process to a JSONL file.
///
/// Each record is `{"ts": <seconds since start>, "stream": <stream>, "message": <line>}`,
/// where `stream` is `client_to_agent`, `agent_to_client` or `agent_stderr`. Protocol
/// lines are stored as parsed JSON; anything unparseable is stored as a string.
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
        let stream = match direction {
            LineDirection::Stdin => "client_to_agent",
            LineDirection::Stdout => "agent_to_client",
            LineDirection::Stderr => "agent_stderr",
        };
        let message = serde_json::from_str::<Value>(line).unwrap_or_else(|_| line.into());
        let record = json!({
            "ts": self.started.elapsed().as_secs_f64(),
            "stream": stream,
            "message": message,
        });
        let Ok(mut out) = self.out.lock() else {
            return;
        };
        // Flush per record so a trace survives the agent or this process crashing.
        if let Err(error) = writeln!(out, "{record}").and_then(|()| out.flush()) {
            tracing::warn!(%error, "failed to write protocol trace");
        }
    }
}
