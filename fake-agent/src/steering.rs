//! The steering extension, as claude-agent-acp and codex-acp define it: the agent advertises
//! `_meta.steering.supported` and takes `_session/steering`, a message for the running turn.
//! The turn answers each steered message before it ends; `slow` stops its chunks to do so.
//! With no turn running, it answers `promptRequired` when asked to (as the weave client
//! always does) and `failed` otherwise, where the adapters would start a turn of their own.

use std::collections::VecDeque;
use std::sync::Mutex;

use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::JsonRpcResponse;
use agent_client_protocol::schema::v1::ContentBlock;
use agent_client_protocol::schema::v1::Meta;
use agent_client_protocol::schema::v1::SessionId;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;

use crate::lock;

/// The `_meta` an `initialize` response advertises steering with.
pub(crate) fn capability() -> Meta {
    let mut meta = Meta::new();
    meta.insert("steering".to_owned(), json!({"supported": true}));
    meta
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "_session/steering", response = SteerResponse)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SteerRequest {
    pub session_id: SessionId,
    pub prompt: Vec<ContentBlock>,
    #[serde(rename = "_meta", default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<Meta>,
}

impl SteerRequest {
    /// Whether the client asked to send the message as a prompt itself when no turn runs.
    pub fn prompt_required(&self) -> bool {
        self.meta
            .as_ref()
            .and_then(|meta| meta.get("steering"))
            .and_then(|steering| steering.get("idleBehavior"))
            .and_then(Value::as_str)
            == Some("promptRequired")
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonRpcResponse)]
pub(crate) struct SteerResponse {
    pub outcome: String,
}

/// A session's running turn, as steering sees it: whether one runs, and the messages steered
/// into it that it hasn't answered yet.
#[derive(Default)]
pub(crate) struct Steering {
    inner: Mutex<Inbox>,
}

#[derive(Default)]
struct Inbox {
    running: bool,
    messages: VecDeque<String>,
}

impl Steering {
    /// A turn starts.
    pub fn start(&self) {
        let mut inbox = lock(&self.inner);
        inbox.running = true;
        inbox.messages.clear();
    }

    /// Steer the running turn with `text`, telling `answer` whether one runs. The answer is
    /// given before the turn can see the message, so it goes out ahead of the turn's reply.
    pub fn offer<R>(&self, text: String, answer: impl FnOnce(bool) -> R) -> R {
        let mut inbox = lock(&self.inner);
        if inbox.running {
            inbox.messages.push_back(text);
        }
        answer(inbox.running)
    }

    /// Whether a steered message waits to be answered.
    pub fn waiting(&self) -> bool {
        !lock(&self.inner).messages.is_empty()
    }

    /// The next steered message to answer, or, with none left, the end of the turn: no
    /// message is accepted after that.
    pub fn next_or_finish(&self) -> Option<String> {
        let mut inbox = lock(&self.inner);
        let next = inbox.messages.pop_front();
        if next.is_none() {
            inbox.running = false;
        }
        next
    }

    /// The turn ended, however it did.
    pub fn stop(&self) {
        let mut inbox = lock(&self.inner);
        inbox.running = false;
        inbox.messages.clear();
    }
}
