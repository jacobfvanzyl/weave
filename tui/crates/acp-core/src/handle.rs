//! Requests the client sends, each checked against what the agent advertised.
//!
//! The protocol forbids calling methods an agent did not advertise, so every gated method
//! fails locally, before anything is sent, when its capability is missing.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;

use agent_client_protocol::Agent;
use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::AgentCapabilities;
use agent_client_protocol::schema::v1::AuthMethod;
use agent_client_protocol::schema::v1::AuthMethodId;
use agent_client_protocol::schema::v1::AuthenticateRequest;
use agent_client_protocol::schema::v1::CancelNotification;
use agent_client_protocol::schema::v1::CloseSessionRequest;
use agent_client_protocol::schema::v1::ContentBlock;
use agent_client_protocol::schema::v1::DeleteSessionRequest;
use agent_client_protocol::schema::v1::Implementation;
use agent_client_protocol::schema::v1::InitializeRequest;
use agent_client_protocol::schema::v1::InitializeResponse;
use agent_client_protocol::schema::v1::ListSessionsRequest;
use agent_client_protocol::schema::v1::ListSessionsResponse;
use agent_client_protocol::schema::v1::LoadSessionRequest;
use agent_client_protocol::schema::v1::LoadSessionResponse;
use agent_client_protocol::schema::v1::LogoutRequest;
use agent_client_protocol::schema::v1::McpServer;
use agent_client_protocol::schema::v1::NewSessionRequest;
use agent_client_protocol::schema::v1::NewSessionResponse;
use agent_client_protocol::schema::v1::PromptRequest;
use agent_client_protocol::schema::v1::ResumeSessionRequest;
use agent_client_protocol::schema::v1::ResumeSessionResponse;
use agent_client_protocol::schema::v1::SessionConfigId;
use agent_client_protocol::schema::v1::SessionConfigOption;
use agent_client_protocol::schema::v1::SessionConfigOptionValue;
use agent_client_protocol::schema::v1::SessionId;
use agent_client_protocol::schema::v1::SessionModeId;
use agent_client_protocol::schema::v1::SetSessionConfigOptionRequest;
use agent_client_protocol::schema::v1::SetSessionModeRequest;
use tokio::sync::mpsc;

use crate::AgentEvent;
use crate::ClientOptions;

#[derive(Debug, thiserror::Error)]
pub enum InitializeError {
    #[error(transparent)]
    Protocol(#[from] Error),
    #[error("agent requires ACP protocol version {0:?}, but this client supports only v1")]
    UnsupportedVersion(ProtocolVersion),
}

/// Where a session works and what it connects to, sent with `session/new`, `session/load`
/// and `session/resume`.
#[derive(Clone, Debug, Default)]
pub struct SessionSetup {
    pub cwd: PathBuf,
    /// Extra workspace roots; sent only to agents advertising `additionalDirectories`.
    pub additional_directories: Vec<PathBuf>,
    pub mcp_servers: Vec<McpServer>,
}

pub(crate) struct Shared {
    pub(crate) cx: ConnectionTo<Agent>,
    pub(crate) options: ClientOptions,
    pub(crate) events: mpsc::UnboundedSender<AgentEvent>,
    pub(crate) session_dirs: Arc<Mutex<HashMap<SessionId, PathBuf>>>,
    agent: OnceLock<InitializeResponse>,
}

/// A cloneable handle for everything the client asks of the agent.
#[derive(Clone)]
pub struct AgentHandle {
    shared: Arc<Shared>,
}

impl AgentHandle {
    pub(crate) fn new(
        cx: ConnectionTo<Agent>,
        options: ClientOptions,
        events: mpsc::UnboundedSender<AgentEvent>,
        session_dirs: Arc<Mutex<HashMap<SessionId, PathBuf>>>,
    ) -> Self {
        Self {
            shared: Arc::new(Shared {
                cx,
                options,
                events,
                session_dirs,
                agent: OnceLock::new(),
            }),
        }
    }

    fn cx(&self) -> &ConnectionTo<Agent> {
        &self.shared.cx
    }

    /// The agent's `initialize` response, once initialized.
    pub fn agent(&self) -> Option<&InitializeResponse> {
        self.shared.agent.get()
    }

    fn capabilities(&self) -> Result<&AgentCapabilities, Error> {
        self.agent()
            .map(|agent| &agent.agent_capabilities)
            .ok_or_else(|| Error::internal_error().data("the connection is not initialized"))
    }

    /// Negotiate ACP v1 and advertise this connection's client services.
    pub async fn initialize(&self) -> Result<InitializeResponse, InitializeError> {
        let request = InitializeRequest::new(ProtocolVersion::V1)
            .client_capabilities(self.shared.options.capabilities())
            .client_info(Implementation::new("weave", env!("CARGO_PKG_VERSION")));
        let response = self.cx().send_request(request).block_task().await?;
        // The agent answers with the version it will speak; the client must not
        // continue with one it does not support.
        if response.protocol_version != ProtocolVersion::V1 {
            return Err(InitializeError::UnsupportedVersion(
                response.protocol_version,
            ));
        }
        let _ = self.shared.agent.set(response.clone());
        Ok(response)
    }

    /// Run a protocol-driven (`agent` type) authentication method.
    pub async fn authenticate(&self, method_id: AuthMethodId) -> Result<(), Error> {
        let agent = self
            .agent()
            .ok_or_else(|| Error::internal_error().data("not initialized"))?;
        match agent
            .auth_methods
            .iter()
            .find(|method| *method.id() == method_id)
        {
            Some(AuthMethod::Agent(_)) => {}
            Some(_) => {
                return Err(Error::invalid_params().data(
                    "terminal sign-in runs the agent interactively, not through authenticate",
                ));
            }
            None => {
                return Err(
                    Error::invalid_params().data(format!("unknown sign-in method {method_id}"))
                );
            }
        }
        self.cx()
            .send_request(AuthenticateRequest::new(method_id))
            .block_task()
            .await
            .map(drop)
    }

    pub async fn logout(&self) -> Result<(), Error> {
        let supported = self.capabilities()?.auth.logout.is_some();
        require(supported, "auth.logout")?;
        self.cx()
            .send_request(LogoutRequest::new())
            .block_task()
            .await
            .map(drop)
    }

    pub async fn new_session(&self, setup: &SessionSetup) -> Result<NewSessionResponse, Error> {
        self.check_setup(setup)?;
        let request = NewSessionRequest::new(setup.cwd.clone())
            .additional_directories(setup.additional_directories.clone())
            .mcp_servers(setup.mcp_servers.clone());
        let response = self.cx().send_request(request).block_task().await?;
        self.remember_cwd(&response.session_id, setup);
        Ok(response)
    }

    /// `session/load`. The agent replays the conversation as `session/update` events, all of
    /// which are queued before this returns.
    pub async fn load_session(
        &self,
        session_id: SessionId,
        setup: &SessionSetup,
    ) -> Result<LoadSessionResponse, Error> {
        require(self.capabilities()?.load_session, "loadSession")?;
        self.check_setup(setup)?;
        let request = LoadSessionRequest::new(session_id.clone(), setup.cwd.clone())
            .additional_directories(setup.additional_directories.clone())
            .mcp_servers(setup.mcp_servers.clone());
        let response = self.cx().send_request(request).block_task().await?;
        self.remember_cwd(&session_id, setup);
        Ok(response)
    }

    /// `session/resume`: reconnect without replaying history.
    pub async fn resume_session(
        &self,
        session_id: SessionId,
        setup: &SessionSetup,
    ) -> Result<ResumeSessionResponse, Error> {
        let supported = self.capabilities()?.session_capabilities.resume.is_some();
        require(supported, "sessionCapabilities.resume")?;
        self.check_setup(setup)?;
        let request = ResumeSessionRequest::new(session_id.clone(), setup.cwd.clone())
            .additional_directories(setup.additional_directories.clone())
            .mcp_servers(setup.mcp_servers.clone());
        let response = self.cx().send_request(request).block_task().await?;
        self.remember_cwd(&session_id, setup);
        Ok(response)
    }

    pub async fn list_sessions(
        &self,
        cwd: Option<PathBuf>,
        cursor: Option<String>,
    ) -> Result<ListSessionsResponse, Error> {
        let supported = self.capabilities()?.session_capabilities.list.is_some();
        require(supported, "sessionCapabilities.list")?;
        let request = ListSessionsRequest::new().cwd(cwd).cursor(cursor);
        self.cx().send_request(request).block_task().await
    }

    pub async fn close_session(&self, session_id: SessionId) -> Result<(), Error> {
        let supported = self.capabilities()?.session_capabilities.close.is_some();
        require(supported, "sessionCapabilities.close")?;
        self.cx()
            .send_request(CloseSessionRequest::new(session_id))
            .block_task()
            .await
            .map(drop)
    }

    pub async fn delete_session(&self, session_id: SessionId) -> Result<(), Error> {
        let supported = self.capabilities()?.session_capabilities.delete.is_some();
        require(supported, "sessionCapabilities.delete")?;
        self.cx()
            .send_request(DeleteSessionRequest::new(session_id))
            .block_task()
            .await
            .map(drop)
    }

    /// Start a prompt turn. Its updates and final [`AgentEvent::TurnEnded`] arrive as events.
    pub fn prompt(&self, session_id: SessionId, prompt: Vec<ContentBlock>) -> Result<(), Error> {
        let events = self.shared.events.clone();
        self.cx()
            .send_request(PromptRequest::new(session_id.clone(), prompt))
            // Delivered under the dispatch loop's ordering barrier, so every update
            // received before the response is already queued ahead of it.
            .on_receiving_result(async move |result| {
                let _ = events.send(AgentEvent::TurnEnded { session_id, result });
                Ok(())
            })
    }

    /// Ask the agent to stop the current turn. The turn still ends with
    /// [`AgentEvent::TurnEnded`], normally with the `cancelled` stop reason.
    pub fn cancel(&self, session_id: SessionId) -> Result<(), Error> {
        self.cx()
            .send_notification(CancelNotification::new(session_id))
    }

    /// `session/set_mode`. Superseded by config options when the agent offers them.
    pub async fn set_mode(
        &self,
        session_id: SessionId,
        mode_id: SessionModeId,
    ) -> Result<(), Error> {
        self.cx()
            .send_request(SetSessionModeRequest::new(session_id, mode_id))
            .block_task()
            .await
            .map(drop)
    }

    /// `session/set_config_option`. Returns every option's new state.
    pub async fn set_config_option(
        &self,
        session_id: SessionId,
        config_id: SessionConfigId,
        value: SessionConfigOptionValue,
    ) -> Result<Vec<SessionConfigOption>, Error> {
        self.cx()
            .send_request(SetSessionConfigOptionRequest::new(
                session_id, config_id, value,
            ))
            .block_task()
            .await
            .map(|response| response.config_options)
    }

    /// Reject setup the agent cannot accept: extra roots or MCP transports it did not advertise.
    fn check_setup(&self, setup: &SessionSetup) -> Result<(), Error> {
        let capabilities = self.capabilities()?;
        if !setup.additional_directories.is_empty() {
            let supported = capabilities
                .session_capabilities
                .additional_directories
                .is_some();
            require(supported, "sessionCapabilities.additionalDirectories")?;
        }
        for server in &setup.mcp_servers {
            match server {
                McpServer::Http(server) if !capabilities.mcp_capabilities.http => {
                    return Err(unsupported(&format!(
                        "mcpCapabilities.http (MCP server {})",
                        server.name
                    )));
                }
                McpServer::Sse(server) if !capabilities.mcp_capabilities.sse => {
                    return Err(unsupported(&format!(
                        "mcpCapabilities.sse (MCP server {})",
                        server.name
                    )));
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn remember_cwd(&self, session_id: &SessionId, setup: &SessionSetup) {
        // Commands the agent starts without a directory run in the session's.
        self.shared
            .session_dirs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(session_id.clone(), setup.cwd.clone());
    }
}

fn require(supported: bool, capability: &str) -> Result<(), Error> {
    if supported {
        Ok(())
    } else {
        Err(unsupported(capability))
    }
}

fn unsupported(capability: &str) -> Error {
    Error::method_not_found().data(format!("the agent does not advertise {capability}"))
}

/// Whether an error is the protocol's "authentication required".
pub fn is_auth_required(error: &Error) -> bool {
    error.code == agent_client_protocol::schema::v1::ErrorCode::AuthRequired
}
