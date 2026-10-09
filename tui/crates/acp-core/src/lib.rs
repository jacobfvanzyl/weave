//! ACP client plumbing for Weave's terminal client, independent of any UI.
//!
//! [`AgentConnection`] launches one agent process, speaks ACP v1 to it, and
//! reports everything the agent sends as an ordered stream of [`AgentEvent`]s.

mod agent;
mod connection;
pub mod daemon_protocol;
mod fs;
mod handle;
pub mod policy;
mod requests;
mod subagent_compat;
mod terminal_meta;
mod terminals;
mod trace;

pub use agent::AgentSpec;
pub use agent::preset_ids;
pub use connection::AgentConnection;
pub use connection::AgentEvent;
pub use connection::ClientOptions;
pub use connection::SpawnError;
pub use handle::AgentHandle;
pub use handle::InitializeError;
pub use handle::SessionSetup;
pub use handle::is_auth_required;
pub use requests::ElicitationRequest;
pub use requests::PermissionRequest;
pub use requests::RequestKey;
pub use terminal_meta::extension_terminal_id;
pub use terminal_meta::strip_terminal_events;
pub use trace::ProtocolTrace;
pub use trace::Traces;
pub use trace::trace_events;

pub use agent_client_protocol::schema::MaybeUndefined;
pub use agent_client_protocol::schema::ProtocolVersion;
/// The ACP v1 schema types this crate speaks, re-exported so callers share one version.
pub use agent_client_protocol::schema::v1 as schema;
