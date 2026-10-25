//! The tools the Host offers a session's agent through the Host MCP server (`weave`), of two
//! kinds:
//!
//! - Client tools, which an attached client runs on its own device (ADR 0009). A call is a
//!   pending request for one client, the one that sent the running turn's latest prompt or
//!   steer; it answers with the tool's result.
//! - Host tools, which the Host answers itself, for the calling session. Each is a Host protocol
//!   method seen from inside the session, answered by the same code (ADR 0020): no tool does
//!   what no client request can. They need no client, so they work in headless sessions. Some
//!   start and follow delegated sessions: sessions of their own that the calling session starts.

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;

/// The [`crate::hello::HelloResponse::features`] entry of a Host that offers client tools.
pub const CLIENT_TOOLS_FEATURE: &str = "clientTools";

/// Put text on the clipboard of the device that sent the turn.
pub const CLIPBOARD_WRITE: &str = "clipboard_write";

/// The Host tool that renames the calling session, as `session/rename` does.
pub const RENAME_SESSION: &str = "rename_session";

/// The Host tool that lists the Host's sessions, as `sessions/list` does.
pub const LIST_SESSIONS: &str = "list_sessions";

/// The Host tool that reads one session and its latest turn, as `sessions/get` does.
pub const READ_SESSION: &str = "read_session";

/// The Host tool that starts a delegated session with a turn, as `session/run` does.
pub const START_SESSION: &str = "start_session";

/// The Host tool that sends a delegated session a prompt, as `queue/add` does.
pub const PROMPT_SESSION: &str = "prompt_session";

/// The Host tool that steers a delegated session's running turn, as `turn/steer` does.
pub const STEER_SESSION: &str = "steer_session";

/// The Host tool that cancels a delegated session's running turn, as `turn/cancel` does.
pub const CANCEL_SESSION_TURN: &str = "cancel_session_turn";

/// The tool kinds a permission policy names, for the tools that take one.
const TOOL_KINDS: [&str; 10] = [
    "read",
    "edit",
    "delete",
    "move",
    "search",
    "execute",
    "think",
    "fetch",
    "switch_mode",
    "other",
];

/// A tool in one of the Host's catalogs, as agents see it in `tools/list`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub name: String,
    pub title: String,
    pub description: String,
    pub input_schema: Value,
}

/// Every client tool the Host defines, in the order agents see them.
pub fn catalog() -> Vec<Tool> {
    vec![Tool {
        name: CLIPBOARD_WRITE.to_owned(),
        title: "Copy to clipboard".to_owned(),
        description: "Put text on the clipboard of the person's device: the device of the \
                      person who sent the current turn. It fails when nobody is connected, as \
                      in a headless run, so don't retry it then."
            .to_owned(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "The text to put on the clipboard."}
            },
            "required": ["text"],
            "additionalProperties": false
        }),
    }]
}

/// Every Host tool the Host defines, in the order agents see them, after the client tools.
pub fn host_catalog() -> Vec<Tool> {
    let session_id = json!({
        "type": "string",
        "description": "The thread's id, as list_sessions or start_session gave it."
    });
    let key = json!({
        "type": "string",
        "description": "Optional: a name of your choosing, such as a UUID, so that calling again \
                        with the same key after a failure starts nothing twice.",
        "minLength": 1,
        "maxLength": crate::turns::MAX_KEY
    });
    vec![
        rename_session(),
        Tool {
            name: LIST_SESSIONS.to_owned(),
            title: "List threads".to_owned(),
            description: "List the threads of the weave Host this thread runs in, across \
                          agents and directories, most recently active first: each one's id, \
                          agent, directory, title, whether it is open and running, and which \
                          thread started it. Answers with the Host's sessions/list result as \
                          JSON."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "agentId": {"type": "string", "description": "Only this agent's threads, \
                        such as claude or codex, with the agent's own history of the directory."},
                    "cwd": {"type": "string", "description": "Only threads in this absolute \
                        directory."},
                    "repo": {"type": "string", "description": "Only threads in this git \
                        repository's worktrees, given by any directory in it. Not with agentId."}
                },
                "additionalProperties": false
            }),
        },
        Tool {
            name: READ_SESSION.to_owned(),
            title: "Read a thread".to_owned(),
            description: "Read one thread of the weave Host: how it lists, and its latest \
                          turn: the prompt, whether it is still running, how it ended, and the \
                          agent's last message in it. Use it to read a delegated thread's full \
                          answer, or a thread a person started. Answers with the Host's \
                          sessions/get result as JSON."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {"sessionId": session_id},
                "required": ["sessionId"],
                "additionalProperties": false
            }),
        },
        Tool {
            name: START_SESSION.to_owned(),
            title: "Start a thread with another agent".to_owned(),
            description: "Hand work to another agent: start a thread with it in the weave Host \
                          and send it a prompt. It works on its own, in a thread people can \
                          watch and answer from their weave clients. This answers once its turn \
                          has started; when the turn ends, you'll get a message saying how it \
                          ended, with the start of the agent's answer, so don't wait or poll for \
                          it. It can approve only the tool kinds your own thread approves. Give \
                          sessionId to prompt a thread you started before instead of a new one."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "agentId": {"type": "string", "description": "The agent to start, such as \
                        claude or codex; list_sessions shows which agents threads run."},
                    "prompt": {"type": "string", "description": "What to ask of it: everything \
                        it needs to know, since it doesn't see this conversation."},
                    "cwd": {"type": "string", "description": "The absolute directory it works \
                        in; yours when absent."},
                    "sessionId": {"type": "string", "description": "A thread you started \
                        before, to prompt instead of starting one."},
                    "approve": {
                        "type": "array",
                        "items": {"type": "string", "enum": TOOL_KINDS},
                        "description": "Tool kinds it may use without asking anyone; yours when \
                            absent, and never more than yours."
                    },
                    "otherwise": {
                        "type": "string",
                        "enum": ["ask", "reject"],
                        "description": "What happens to tool calls it doesn't approve: ask the \
                            people attached, or reject them. Yours when absent; it rejects if \
                            you do."
                    },
                    "key": key
                },
                "required": ["agentId", "prompt"],
                "additionalProperties": false
            }),
        },
        Tool {
            name: PROMPT_SESSION.to_owned(),
            title: "Prompt a thread you started".to_owned(),
            description: "Send a prompt to a thread you started with start_session: it starts \
                          a turn at once if none runs, or waits in the thread's queue for the \
                          running one to end. When the turn ends, you'll get a message saying \
                          how it ended."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "sessionId": session_id,
                    "prompt": {"type": "string", "description": "What to ask of it."},
                    "key": key
                },
                "required": ["sessionId", "prompt"],
                "additionalProperties": false
            }),
        },
        Tool {
            name: STEER_SESSION.to_owned(),
            title: "Steer a thread you started".to_owned(),
            description: "Send a message into the running turn of a thread you started, to \
                          correct or add to what it's doing, without starting another turn. If \
                          no turn runs, nothing is sent: use prompt_session instead."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "sessionId": session_id,
                    "prompt": {"type": "string", "description": "The message for its turn."}
                },
                "required": ["sessionId", "prompt"],
                "additionalProperties": false
            }),
        },
        Tool {
            name: CANCEL_SESSION_TURN.to_owned(),
            title: "Cancel a thread's turn".to_owned(),
            description: "Stop the running turn of a thread you started. The thread stays, \
                          and can be prompted again."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {"sessionId": session_id},
                "required": ["sessionId"],
                "additionalProperties": false
            }),
        },
    ]
}

fn rename_session() -> Tool {
    Tool {
        name: RENAME_SESSION.to_owned(),
        title: "Rename this thread".to_owned(),
        description: "Give this thread a new title: the name people see for it in their \
                      weave thread lists, on every device. Use it when the person asks for a \
                      name, or when the work has moved on and the title misleads. Keep it \
                      short and specific. It doesn't change the title you keep yourself."
            .to_owned(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "The new title, up to 200 characters.",
                    "minLength": 1,
                    "maxLength": crate::sessions::MAX_TITLE
                }
            },
            "required": ["title"],
            "additionalProperties": false
        }),
    }
}

/// A client's answer to a client tool call: MCP's `CallToolResult`, which the agent gets as it
/// is.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ClientToolResult {
    /// MCP content blocks, such as `{"type": "text", "text": "…"}`.
    #[serde(default)]
    pub content: Vec<Value>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_error: bool,
}

impl ClientToolResult {
    /// A result with one text block.
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            content: vec![json!({"type": "text", "text": text.into()})],
            is_error: false,
        }
    }

    /// A failure, with why.
    pub fn error(why: impl Into<String>) -> Self {
        Self {
            is_error: true,
            ..Self::text(why)
        }
    }
}
