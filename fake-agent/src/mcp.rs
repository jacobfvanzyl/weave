//! The `tool` script's MCP client: one MCP 2026-07-28 `tools/call` to the MCP server named
//! `weave` the session was given, over ACP (`mcp/message`) when it was declared that way, or
//! as a stdio server otherwise.

use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use agent_client_protocol::Client;
use agent_client_protocol::ConnectionTo;
use agent_client_protocol::schema::v1::McpRequestId;
use agent_client_protocol::schema::v1::McpServer;
use agent_client_protocol::schema::v1::McpServerStdio;
use agent_client_protocol::schema::v1::MessageMcpRequest;
use agent_client_protocol::schema::v1::MessageMcpResponse;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;

/// The server the `tool` script calls.
const SERVER: &str = "weave";
const PROTOCOL_VERSION: &str = "2026-07-28";

static REQUESTS: AtomicU64 = AtomicU64::new(1);

/// A stdio MCP server's output and input, as the agent reads and writes them.
pub type StdioPipes = (
    Box<dyn AsyncRead + Send + Unpin>,
    Box<dyn AsyncWrite + Send + Unpin>,
);

type Start = dyn Fn(McpServerStdio) -> Pin<Box<dyn Future<Output = std::io::Result<StdioPipes>> + Send>>
    + Send
    + Sync;

/// How the agent reaches a stdio MCP server: by starting its command, unless a test says
/// otherwise.
#[derive(Clone)]
pub struct StdioMcp(Arc<Start>);

impl StdioMcp {
    pub fn new(
        start: impl Fn(
            McpServerStdio,
        ) -> Pin<Box<dyn Future<Output = std::io::Result<StdioPipes>> + Send>>
        + Send
        + Sync
        + 'static,
    ) -> Self {
        Self(Arc::new(start))
    }
}

impl Default for StdioMcp {
    fn default() -> Self {
        Self::new(|server| Box::pin(spawn(server)))
    }
}

impl std::fmt::Debug for StdioMcp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("StdioMcp")
    }
}

/// Start a stdio server's command; it ends when its input closes.
async fn spawn(server: McpServerStdio) -> std::io::Result<StdioPipes> {
    let mut child = tokio::process::Command::new(&server.command)
        .args(&server.args)
        .envs(server.env.iter().map(|var| (&var.name, &var.value)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;
    let (Some(input), Some(output)) = (child.stdin.take(), child.stdout.take()) else {
        return Err(std::io::Error::other("the MCP server's stdio wasn't piped"));
    };
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
    Ok((Box::new(output), Box::new(input)))
}

/// Call `tool` with `arguments` on the session's `weave` server. Returns MCP's
/// `CallToolResult`, or why the call itself failed.
pub(crate) async fn call_tool(
    cx: &ConnectionTo<Client>,
    servers: &[McpServer],
    stdio: &StdioMcp,
    tool: &str,
    arguments: Map<String, Value>,
) -> Result<Value, String> {
    let params = json!({
        "name": tool,
        "arguments": arguments,
        "_meta": {
            "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {},
        },
    });
    request(cx, servers, stdio, "tools/call", params).await
}

/// Open the session with the `weave` server as an MCP client before 2026-07-28 would, with
/// `initialize`. Returns what the server answered.
pub(crate) async fn initialize(
    cx: &ConnectionTo<Client>,
    servers: &[McpServer],
    stdio: &StdioMcp,
) -> Result<Value, String> {
    let params = json!({
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "weave-fake-agent", "version": "0"},
    });
    request(cx, servers, stdio, "initialize", params).await
}

/// Send a `tools/call` without arguments to the session's `weave` server over ACP now, and
/// give its answer later; `None` when the server isn't declared over ACP.
pub(crate) fn send_call(
    cx: &ConnectionTo<Client>,
    servers: &[McpServer],
    tool: &str,
) -> Option<impl Future<Output = Result<Value, String>> + Send + use<>> {
    let Some(McpServer::Acp(server)) = servers.iter().find(|server| name(server) == Some(SERVER))
    else {
        return None;
    };
    let id = REQUESTS.fetch_add(1, Ordering::Relaxed);
    let params = json!({
        "name": tool,
        "arguments": {},
        "_meta": {
            "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {},
        },
    });
    let request = MessageMcpRequest::new(
        server.server_id.clone(),
        McpRequestId::new(format!("request-{id}")),
        "tools/call",
    )
    .params(params.as_object().cloned().unwrap_or_default());
    let sent = cx.send_request(request);
    Some(async move {
        match sent.block_task().await {
            Ok(MessageMcpResponse::Result { result, .. }) => Ok(result),
            Ok(MessageMcpResponse::Error { error, .. }) => {
                Err(format!("{} ({})", error.message, error.code))
            }
            Ok(_) => Err("an answer of an unknown kind".to_owned()),
            Err(error) => Err(error.to_string()),
        }
    })
}

/// One MCP request to the session's `weave` server.
async fn request(
    cx: &ConnectionTo<Client>,
    servers: &[McpServer],
    stdio: &StdioMcp,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let server = servers
        .iter()
        .find(|server| name(server) == Some(SERVER))
        .ok_or_else(|| format!("the session has no MCP server named {SERVER}"))?;
    let params = params.as_object().cloned().unwrap_or_default();
    let id = REQUESTS.fetch_add(1, Ordering::Relaxed);
    match server {
        McpServer::Acp(server) => {
            let request = MessageMcpRequest::new(
                server.server_id.clone(),
                McpRequestId::new(format!("request-{id}")),
                method,
            )
            .params(params);
            match cx.send_request(request).block_task().await {
                Ok(MessageMcpResponse::Result { result, .. }) => Ok(result),
                Ok(MessageMcpResponse::Error { error, .. }) => {
                    Err(format!("{} ({})", error.message, error.code))
                }
                Ok(_) => Err("an answer of an unknown kind".to_owned()),
                Err(error) => Err(error.to_string()),
            }
        }
        McpServer::Stdio(server) => {
            let (output, mut input) = (stdio.0)(server.clone())
                .await
                .map_err(|error| format!("starting {}: {error}", server.command.display()))?;
            let request = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
            input
                .write_all(format!("{request}\n").as_bytes())
                .await
                .map_err(|error| error.to_string())?;
            input.flush().await.map_err(|error| error.to_string())?;
            let mut lines = BufReader::new(output).lines();
            while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if message.get("id") != Some(&json!(id)) {
                    continue;
                }
                return match (message.get("result"), message.get("error")) {
                    (Some(result), _) => Ok(result.clone()),
                    (None, Some(error)) => Err(error.to_string()),
                    (None, None) => Err("an answer with neither a result nor an error".to_owned()),
                };
            }
            Err("the MCP server closed without answering".to_owned())
        }
        _ => Err(format!(
            "{SERVER} uses a transport this agent doesn't speak"
        )),
    }
}

fn name(server: &McpServer) -> Option<&str> {
    match server {
        McpServer::Stdio(server) => Some(&server.name),
        McpServer::Http(server) => Some(&server.name),
        McpServer::Sse(server) => Some(&server.name),
        McpServer::Acp(server) => Some(&server.name),
        _ => None,
    }
}

/// A `CallToolResult`'s text blocks, joined.
pub(crate) fn result_text(result: &Value) -> String {
    result
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default()
}
