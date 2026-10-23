//! The Host MCP server, `weave`, which every session's agent gets (ADR 0009). Its tools are
//! client tools, which the client that sent the running turn runs on its device, as a pending
//! request the session owns, and Host tools, which the Host answers itself (`host_tools`). Agents reach the server one of two ways, both MCP 2026-07-28 and
//! both answered by [`Mcp::handle`]:
//!
//! - over ACP itself (`"type": "acp"`), for agents that advertise `mcpCapabilities.acp`: their
//!   `mcp/message` requests come through `weave-acp-core`'s [`McpProvider`];
//! - otherwise as a stdio server, `weave mcp-bridge`, which relays bytes between the agent and
//!   the Host's MCP socket ([`relay`]), after a token that names the declaration.
//!
//! Every session setup declares the server afresh, under a new `serverId` or token: a
//! [`Binding`]. It learns its session's id once the agent has given it, since calls may come
//! before then, and its declaration goes when it's dropped.

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::Weak;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;
use tokio::net::UnixListener;
use tokio::net::UnixStream;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::sync::watch;
use weave_acp_core::mcp::BoxFuture;
use weave_acp_core::mcp::MCP_PROTOCOL_VERSION;
use weave_acp_core::mcp::McpCall;
use weave_acp_core::mcp::McpNotifier;
use weave_acp_core::mcp::McpOutcome;
use weave_acp_core::mcp::McpProvider;
use weave_acp_core::schema::EnvVariable;
use weave_acp_core::schema::McpCapabilities;
use weave_acp_core::schema::McpError;
use weave_acp_core::schema::McpServer;
use weave_acp_core::schema::McpServerAcp;
use weave_acp_core::schema::McpServerStdio;
use weave_acp_core::schema::SessionId;
use weave_host_protocol::tools::ClientToolResult;
use weave_host_protocol::tools::Tool;

use crate::Shared;
use crate::session::ClientToolCall;
use crate::session::Command;
use crate::socket::Peer;

/// The bridge's environment: where the Host's MCP socket is.
pub const SOCKET_VARIABLE: &str = "WEAVE_MCP_SOCKET";
/// The bridge's environment: the token naming the declaration it serves.
pub const TOKEN_VARIABLE: &str = "WEAVE_MCP_TOKEN";
/// The server's name, as agents see it.
pub const SERVER_NAME: &str = "weave";
/// Codex's opt-in, per stdio server, to MCP 2026-07-28. Set for every agent, since the Host
/// doesn't branch on which agent it runs.
const CODEX_VERSION_VARIABLE: &str = "CODEX_MCP_PROTOCOL_VERSION";
/// How long a tool call waits for the agent to name the session it's for.
const BIND_WAIT: Duration = Duration::from_secs(30);
/// How long the bridge has to send its token.
const TOKEN_WAIT: Duration = Duration::from_secs(5);
/// How long agents may keep a list: a session's tools don't change.
const TTL_MS: u64 = 60 * 60 * 1000;
const UNSUPPORTED_PROTOCOL_VERSION: i32 = -32022;
const PARSE_ERROR: i32 = -32700;
const METHOD_NOT_FOUND: i32 = -32601;
const INVALID_PARAMS: i32 = -32602;
const INSTRUCTIONS: &str = "Tools of the weave Host this session runs in. Client tools, such \
                            as clipboard_write, run on the device of the person who sent the \
                            current turn, and fail when nobody is connected, as in a headless \
                            run. Host tools, such as rename_session, act on this session in the \
                            Host and need nobody connected.";

/// What a client is told when its session's agent can't use the server.
pub(crate) const REFUSED: &str = "This agent's MCP client predates MCP 2026-07-28, so it can't \
                                  use weave's tools.";

/// One session setup's declaration of the server.
struct Declared {
    /// What `tools/list` gives: the client tools, then the Host tools.
    tools: Vec<Tool>,
    /// Which of them the Host answers itself.
    host_tools: Vec<String>,
    /// The session's id, once the agent has given it.
    session: watch::Sender<Option<SessionId>>,
    /// The agent spoke an MCP revision before 2026-07-28.
    refused: AtomicBool,
    /// Its session was told so.
    told: AtomicBool,
}

pub(crate) struct Mcp {
    shared: Weak<Shared>,
    /// Declarations, by `serverId` or bridge token.
    declared: Mutex<HashMap<String, Arc<Declared>>>,
    /// Where the bridge connects, once the Host listens there.
    socket: OnceLock<Result<PathBuf, String>>,
    /// A directory made for the socket, removed with the Host.
    made: Mutex<Option<PathBuf>>,
    next_call: AtomicU64,
}

/// A session setup's declaration of the server, removed when dropped.
pub(crate) struct Binding {
    key: String,
    declared: Arc<Declared>,
    mcp: Weak<Mcp>,
}

impl Binding {
    /// The agent named the session this declaration serves.
    pub(crate) fn bind(&self, session_id: &SessionId) {
        self.declared.session.send_replace(Some(session_id.clone()));
        if let Some(mcp) = self.mcp.upgrade() {
            mcp.tell_if_refused(&self.declared);
        }
    }
}

impl Drop for Binding {
    fn drop(&mut self) {
        if let Some(mcp) = self.mcp.upgrade() {
            crate::session::lock(&mcp.declared).remove(&self.key);
        }
    }
}

impl Drop for Mcp {
    fn drop(&mut self) {
        if let Some(dir) = crate::session::lock(&self.made).take() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

impl Mcp {
    pub(crate) fn new(shared: Weak<Shared>) -> Self {
        Self {
            shared,
            declared: Mutex::new(HashMap::new()),
            socket: OnceLock::new(),
            made: Mutex::new(None),
            next_call: AtomicU64::new(1),
        }
    }

    /// What answers `mcp/message` for the agents this Host starts.
    pub(crate) fn provider(self: &Arc<Self>) -> Arc<dyn McpProvider> {
        Arc::new(Provider(Arc::downgrade(self)))
    }

    /// Declare the server for one session setup, with `client_tools` and `host_tools`: over ACP
    /// when the agent takes that, otherwise as the stdio bridge. `Err` says why it can't be
    /// declared.
    pub(crate) fn declare(
        self: &Arc<Self>,
        client_tools: Vec<Tool>,
        host_tools: Vec<Tool>,
        capabilities: &McpCapabilities,
        bridge: &[String],
    ) -> Result<(McpServer, Binding), String> {
        let key = crate::devices::random_id(32);
        let server = if capabilities.acp {
            McpServer::Acp(McpServerAcp::new(SERVER_NAME, key.clone()))
        } else {
            let (command, args) = bridge
                .split_first()
                .ok_or_else(|| "there's no command to run weave's MCP bridge".to_owned())?;
            let socket = self.socket()?;
            McpServer::Stdio(
                McpServerStdio::new(SERVER_NAME, command)
                    .args(args.to_vec())
                    .env(vec![
                        EnvVariable::new(SOCKET_VARIABLE, socket.display().to_string()),
                        EnvVariable::new(TOKEN_VARIABLE, key.clone()),
                        EnvVariable::new(CODEX_VERSION_VARIABLE, MCP_PROTOCOL_VERSION),
                    ]),
            )
        };
        let declared = Arc::new(Declared {
            host_tools: host_tools.iter().map(|tool| tool.name.clone()).collect(),
            tools: client_tools.into_iter().chain(host_tools).collect(),
            session: watch::Sender::new(None),
            refused: AtomicBool::new(false),
            told: AtomicBool::new(false),
        });
        crate::session::lock(&self.declared).insert(key.clone(), Arc::clone(&declared));
        Ok((
            server,
            Binding {
                key,
                declared,
                mcp: Arc::downgrade(self),
            },
        ))
    }

    fn declared(&self, key: &str) -> Option<Arc<Declared>> {
        crate::session::lock(&self.declared).get(key).cloned()
    }

    /// The socket the bridge connects to, listened on from the first time it's needed.
    fn socket(self: &Arc<Self>) -> Result<PathBuf, String> {
        self.socket.get_or_init(|| self.listen()).clone()
    }

    fn listen(self: &Arc<Self>) -> Result<PathBuf, String> {
        let shared = self
            .shared
            .upgrade()
            .ok_or_else(|| "the Host is stopping".to_owned())?;
        let path = match &shared.config.mcp_socket {
            Some(path) => path.clone(),
            None => {
                let dir = std::env::temp_dir().join(format!(
                    "weave-mcp-{}-{}",
                    std::process::id(),
                    crate::devices::random_id(6)
                ));
                crate::journal::create_private_dir(&dir)
                    .map_err(|error| format!("creating {}: {error}", dir.display()))?;
                *crate::session::lock(&self.made) = Some(dir.clone());
                dir.join("mcp.sock")
            }
        };
        let listener = bind(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        tokio::spawn(accept(
            Arc::downgrade(self),
            listener,
            shared.stop.subscribe(),
        ));
        Ok(path)
    }

    /// The agent behind `declared` can't speak 2026-07-28: tell its session, once.
    fn refused(&self, declared: &Declared) {
        declared.refused.store(true, Ordering::Relaxed);
        self.tell_if_refused(declared);
    }

    fn tell_if_refused(&self, declared: &Declared) {
        if !declared.refused.load(Ordering::Relaxed) {
            return;
        }
        let Some(session_id) = declared.session.borrow().clone() else {
            return;
        };
        if declared.told.swap(true, Ordering::Relaxed) {
            return;
        }
        let session = self
            .shared
            .upgrade()
            .and_then(|shared| shared.registry().live(&session_id));
        if let Some(session) = session {
            let _ = session.send(Command::Notice {
                text: REFUSED.to_owned(),
            });
        }
    }

    /// Answer one MCP request for `declared`'s server.
    async fn handle(
        self: Arc<Self>,
        declared: Arc<Declared>,
        call: McpCall,
        notifier: McpNotifier,
        cancelled: BoxFuture<()>,
    ) -> McpOutcome {
        let McpCall {
            request,
            method,
            params,
            ..
        } = call;
        if method == "initialize" {
            self.refused(&declared);
            let requested = params
                .as_ref()
                .and_then(|params| params.get("protocolVersion"))
                .cloned();
            return McpOutcome::Error(unsupported(requested));
        }
        let requested = params
            .as_ref()
            .and_then(|params| params.get("_meta"))
            .and_then(|meta| meta.get("io.modelcontextprotocol/protocolVersion"))
            .cloned();
        if requested.as_ref().and_then(Value::as_str) != Some(MCP_PROTOCOL_VERSION) {
            return McpOutcome::Error(unsupported(requested));
        }
        match method.as_str() {
            "server/discover" => McpOutcome::Result(complete(json!({
                "supportedVersions": [MCP_PROTOCOL_VERSION],
                "capabilities": {"tools": {"listChanged": false}},
                "instructions": INSTRUCTIONS,
                "ttlMs": TTL_MS,
                "cacheScope": "private",
            }))),
            "tools/list" => McpOutcome::Result(complete(json!({
                "tools": declared.tools,
                "ttlMs": TTL_MS,
                "cacheScope": "private",
            }))),
            "resources/list" => McpOutcome::Result(complete(json!({
                "resources": [],
                "ttlMs": TTL_MS,
                "cacheScope": "private",
            }))),
            "tools/call" => self.call_tool(&declared, params, cancelled).await,
            // Agents open one whatever the server says; it honors nothing, and stays open
            // until it's cancelled.
            "subscriptions/listen" => {
                let mut acknowledged = Map::new();
                acknowledged.insert(
                    "_meta".to_owned(),
                    json!({"io.modelcontextprotocol/subscriptionId": request}),
                );
                acknowledged.insert("notifications".to_owned(), json!({}));
                notifier.notify(
                    "notifications/subscriptions/acknowledged",
                    Some(acknowledged),
                );
                cancelled.await;
                McpOutcome::Cancelled
            }
            _ => McpOutcome::Error(McpError::new(
                METHOD_NOT_FOUND,
                format!("method not found: {method}"),
            )),
        }
    }

    /// `tools/call`: a Host tool the Host answers, or a client tool, which is a pending request
    /// for the client that sent the running turn.
    async fn call_tool(
        &self,
        declared: &Declared,
        params: Option<Map<String, Value>>,
        mut cancelled: BoxFuture<()>,
    ) -> McpOutcome {
        let params = params.unwrap_or_default();
        let Some(tool) = params.get("name").and_then(Value::as_str) else {
            return McpOutcome::Error(McpError::new(INVALID_PARAMS, "a tool call needs a name"));
        };
        if !declared.tools.iter().any(|known| known.name == tool) {
            return McpOutcome::Error(McpError::new(
                INVALID_PARAMS,
                format!("unknown tool: {tool}"),
            ));
        }
        let arguments = params
            .get("arguments")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let mut named = declared.session.subscribe();
        let session_id = tokio::select! {
            named = tokio::time::timeout(BIND_WAIT, named.wait_for(Option::is_some)) => {
                named.ok().and_then(|named| named.ok().and_then(|id| id.clone()))
            }
            () = &mut cancelled => return McpOutcome::Cancelled,
        };
        let session = session_id.and_then(|session_id| {
            self.shared
                .upgrade()
                .and_then(|shared| shared.registry().live(&session_id))
        });
        let Some(session) = session else {
            return tool_result(ClientToolResult::error("The session isn't open."));
        };
        if declared.host_tools.iter().any(|known| known == tool) {
            let Some(shared) = self.shared.upgrade() else {
                return tool_result(ClientToolResult::error("The Host is stopping."));
            };
            return tool_result(crate::host_tools::call(&shared, &session, tool, &arguments).await);
        }
        let call = self.next_call.fetch_add(1, Ordering::Relaxed);
        let (reply, answered) = oneshot::channel();
        let sent = session.send(Command::ClientTool(ClientToolCall {
            call,
            tool: tool.to_owned(),
            arguments,
            reply,
        }));
        if sent.is_err() {
            return tool_result(ClientToolResult::error("The session has ended."));
        }
        tokio::select! {
            answer = answered => tool_result(answer.unwrap_or_else(|_| {
                ClientToolResult::error("The session ended before the tool ran.")
            })),
            () = cancelled => {
                let _ = session.send(Command::WithdrawClientTool { call });
                McpOutcome::Cancelled
            }
        }
    }
}

/// Answers `mcp/message` for the agents the Host starts.
struct Provider(Weak<Mcp>);

impl McpProvider for Provider {
    fn call(
        &self,
        call: McpCall,
        notifier: McpNotifier,
        cancelled: BoxFuture<()>,
    ) -> BoxFuture<McpOutcome> {
        let mcp = self.0.upgrade();
        Box::pin(async move {
            let Some(mcp) = mcp else {
                return McpOutcome::Error(McpError::new(METHOD_NOT_FOUND, "the Host is stopping"));
            };
            let Some(declared) = mcp.declared(&call.server) else {
                return McpOutcome::Error(McpError::new(
                    INVALID_PARAMS,
                    format!("no MCP server {}", call.server),
                ));
            };
            mcp.handle(declared, call, notifier, cancelled).await
        })
    }
}

fn unsupported(requested: Option<Value>) -> McpError {
    McpError::new(UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version").data(json!({
        "supported": [MCP_PROTOCOL_VERSION],
        "requested": requested.unwrap_or(Value::Null),
    }))
}

/// A complete result, saying which server it's from.
fn complete(mut result: Value) -> Value {
    if let Some(object) = result.as_object_mut() {
        object.insert("resultType".to_owned(), json!("complete"));
        object.insert(
            "_meta".to_owned(),
            json!({"io.modelcontextprotocol/serverInfo": {
                "name": SERVER_NAME,
                "version": env!("CARGO_PKG_VERSION"),
            }}),
        );
    }
    result
}

fn tool_result(result: ClientToolResult) -> McpOutcome {
    McpOutcome::Result(complete(serde_json::to_value(result).unwrap_or_default()))
}

fn bind(path: &Path) -> std::io::Result<UnixListener> {
    // A socket left by a Host that died; this one holds the lock.
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let listener = UnixListener::bind(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(listener)
}

/// Accept bridges until the Host stops. Only the Host's own user may connect.
async fn accept(mcp: Weak<Mcp>, listener: UnixListener, mut stop: watch::Receiver<bool>) {
    let owner = crate::socket::owner(&listener);
    loop {
        let stream = tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => stream,
                Err(error) => {
                    tracing::warn!(%error, "the MCP socket stopped accepting");
                    return;
                }
            },
            _ = stop.changed() => return,
        };
        match crate::socket::peer(&stream, owner) {
            Peer::Owner => {}
            Peer::Other(uid) => {
                tracing::warn!(uid, "refused an MCP bridge of another user");
                continue;
            }
            Peer::Unknown => continue,
        }
        tokio::spawn(serve_bridge(mcp.clone(), stream));
    }
}

/// One bridge: its token, then newline-delimited MCP from the agent, answered in any order.
async fn serve_bridge(mcp: Weak<Mcp>, stream: UnixStream) {
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    let token = match tokio::time::timeout(TOKEN_WAIT, lines.next_line()).await {
        Ok(Ok(Some(token))) => token,
        _ => return,
    };
    let Some(declared) = mcp.upgrade().and_then(|mcp| mcp.declared(token.trim())) else {
        tracing::debug!("refused an MCP bridge with an unknown token");
        return;
    };
    let (out, mut outgoing) = mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        while let Some(message) = outgoing.recv().await {
            let mut line = message.to_string();
            line.push('\n');
            if write.write_all(line.as_bytes()).await.is_err() {
                break;
            }
        }
    });
    // Requests running, by id, with what cancels them.
    let mut running: HashMap<String, oneshot::Sender<()>> = HashMap::new();
    let (finished, mut done) = mpsc::unbounded_channel::<String>();
    loop {
        tokio::select! {
            line = lines.next_line() => {
                let Ok(Some(line)) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    let _ = out.send(json!({
                        "jsonrpc": "2.0",
                        "id": null,
                        "error": {"code": PARSE_ERROR, "message": "Parse error"},
                    }));
                    continue;
                };
                let method = message.get("method").and_then(Value::as_str).map(str::to_owned);
                let params = message.get("params").and_then(Value::as_object).cloned();
                match (method, message.get("id").cloned()) {
                    (Some(method), Some(id)) => {
                        let Some(mcp) = mcp.upgrade() else { break };
                        let key = id.to_string();
                        let (cancel, cancelled) = oneshot::channel::<()>();
                        running.insert(key.clone(), cancel);
                        let notifications = out.clone();
                        let notifier = McpNotifier::new(move |method, params| {
                            let mut notification = json!({"jsonrpc": "2.0", "method": method});
                            if let Some(params) = params {
                                notification["params"] = Value::Object(params);
                            }
                            let _ = notifications.send(notification);
                        });
                        let call = McpCall {
                            server: SERVER_NAME.to_owned(),
                            request: id.clone(),
                            method,
                            params,
                        };
                        let declared = Arc::clone(&declared);
                        let responses = out.clone();
                        let finished = finished.clone();
                        tokio::spawn(async move {
                            let cancelled = Box::pin(async move {
                                let _ = cancelled.await;
                            });
                            let outcome = mcp.handle(declared, call, notifier, cancelled).await;
                            let response = match outcome {
                                McpOutcome::Result(result) => {
                                    Some(json!({"jsonrpc": "2.0", "id": id, "result": result}))
                                }
                                McpOutcome::Error(error) => {
                                    Some(json!({"jsonrpc": "2.0", "id": id, "error": error}))
                                }
                                McpOutcome::Cancelled => None,
                            };
                            if let Some(response) = response {
                                let _ = responses.send(response);
                            }
                            let _ = finished.send(key);
                        });
                    }
                    (Some(method), None) if method == "notifications/cancelled" => {
                        let request = params
                            .as_ref()
                            .and_then(|params| params.get("requestId"))
                            .map(Value::to_string);
                        if let Some(cancel) = request.and_then(|request| running.remove(&request)) {
                            let _ = cancel.send(());
                        }
                    }
                    // Other notifications, and responses: the Host asks the agent nothing.
                    _ => {}
                }
            }
            Some(key) = done.recv() => {
                running.remove(&key);
            }
        }
    }
    // The agent or its bridge went away: what it was waiting for is withdrawn.
    for (_, cancel) in running.drain() {
        let _ = cancel.send(());
    }
    drop(out);
    let _ = writer.await;
}

/// `weave mcp-bridge`: relay an agent's MCP messages between its stdio (`input`, `output`)
/// and the Host's MCP socket, after the token that names the server's declaration. Returns
/// when either side closes.
pub async fn relay(
    socket: &Path,
    token: &str,
    mut input: impl AsyncRead + Unpin,
    mut output: impl AsyncWrite + Unpin,
) -> std::io::Result<()> {
    let stream = UnixStream::connect(socket).await?;
    let (mut from_host, mut to_host) = stream.into_split();
    to_host.write_all(token.as_bytes()).await?;
    to_host.write_all(b"\n").await?;
    tokio::select! {
        sent = tokio::io::copy(&mut input, &mut to_host) => sent.map(drop),
        received = tokio::io::copy(&mut from_host, &mut output) => {
            output.flush().await?;
            received.map(drop)
        }
    }
}
