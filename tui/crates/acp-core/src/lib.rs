//! ACP client plumbing for Weave's terminal client, independent of any UI.
//!
//! [`AgentConnection`] launches one agent process, speaks ACP v1 to it, and
//! reports everything the agent sends as an ordered stream of [`AgentEvent`]s.

mod agent;
mod connection;
mod fs;
mod terminals;
mod trace;

pub use agent::AgentSpec;
pub use agent::preset_ids;
pub use connection::AgentConnection;
pub use connection::AgentEvent;
pub use connection::AgentHandle;
pub use connection::ClientOptions;
pub use connection::InitializeError;
pub use connection::PermissionRequest;
pub use connection::SpawnError;
pub use trace::ProtocolTrace;

pub use agent_client_protocol::schema::ProtocolVersion;
/// The ACP v1 schema types this crate speaks, re-exported so callers share one version.
pub use agent_client_protocol::schema::v1 as schema;
