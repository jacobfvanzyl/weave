//! MCP servers this client provides to an agent over ACP itself (`"type": "acp"`), from the
//! draft MCP-over-ACP RFD: the agent sends each MCP request as an `mcp/message` request to the
//! server's `serverId`, and the client answers it. Requests follow MCP 2026-07-28, with no
//! `initialize` handshake and no requests from the server.
//!
//! The connection only carries the messages. What answers them is an [`McpProvider`] its
//! owner installs with [`crate::AgentHandle::provide_mcp`]; without one, every `mcp/message`
//! fails.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use agent_client_protocol::schema::v1::McpError;
use serde_json::Map;
use serde_json::Value;

/// The MCP revision MCP-over-ACP and this crate's servers speak.
pub const MCP_PROTOCOL_VERSION: &str = "2026-07-28";

/// A boxed future, as providers return them.
pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// One MCP request for a provided server.
#[derive(Clone, Debug)]
pub struct McpCall {
    /// The server it's for: the `serverId` the client declared it with.
    pub server: String,
    /// The caller's id for the request, which a subscription's notifications carry.
    pub request: Value,
    pub method: String,
    pub params: Option<Map<String, Value>>,
}

/// How an MCP request ended.
#[derive(Debug)]
pub enum McpOutcome {
    Result(Value),
    Error(McpError),
    /// The caller cancelled it; nothing is answered.
    Cancelled,
}

type Notify = dyn Fn(String, Option<Map<String, Value>>) + Send + Sync;

/// Sends the notifications of one request, such as a subscription's, while it runs.
#[derive(Clone)]
pub struct McpNotifier(Arc<Notify>);

impl McpNotifier {
    pub fn new(send: impl Fn(String, Option<Map<String, Value>>) + Send + Sync + 'static) -> Self {
        Self(Arc::new(send))
    }

    /// One that drops what it's given.
    pub fn none() -> Self {
        Self::new(|_, _| {})
    }

    pub fn notify(&self, method: impl Into<String>, params: Option<Map<String, Value>>) {
        (self.0)(method.into(), params);
    }
}

impl std::fmt::Debug for McpNotifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("McpNotifier")
    }
}

/// What answers the MCP servers a client provides.
pub trait McpProvider: Send + Sync + 'static {
    /// Answer `call`. `cancelled` finishes if the caller cancels it, after which the outcome
    /// should be [`McpOutcome::Cancelled`].
    fn call(
        &self,
        call: McpCall,
        notifier: McpNotifier,
        cancelled: BoxFuture<()>,
    ) -> BoxFuture<McpOutcome>;
}
