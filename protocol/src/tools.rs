//! The tools the Host offers a session's agent through the Host MCP server (`weave`), of two
//! kinds:
//!
//! - Client tools, which an attached client runs on its own device (ADR 0009). A call is a
//!   pending request for one client, the one that sent the running turn's latest prompt or
//!   steer; it answers with the tool's result.
//! - Host tools, which the Host answers itself, for the calling session. Each is a Host protocol
//!   method seen from inside the session, answered by the same code (WVE-106's model): no tool
//!   does what no client request can. They need no client, so they work in headless sessions.

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
    vec![Tool {
        name: RENAME_SESSION.to_owned(),
        title: "Rename this session".to_owned(),
        description: "Give this session a new title: the name people see for it in their \
                      weave session lists, on every device. Use it when the person asks for a \
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
    }]
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
