//! The person's credentials as a Host holds them (ADR 0036, WVE-239). The Dispatcher keeps the
//! credentials and gives each Host that joined it the ones its agents need, as copies that
//! can't be renewed: a Host is told the whole set at once ([`SyncCredentialsRequest`]), keeps
//! it, and drops whatever a later set leaves out. Only the Dispatcher a Host joined may send
//! one, and nothing answers a value back.

use agent_client_protocol::JsonRpcRequest;
use serde::Deserialize;
use serde::Serialize;

use crate::Empty;
use crate::Timestamp;

/// The Host takes [`SyncCredentialsRequest`] from the Dispatcher it joined, in `features`.
pub const FEATURE: &str = "credentials";

/// How a Host gives a credential to what uses it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CredentialUse {
    /// In the environment of `agent`'s process, as `variable`, when the Host starts it. Never
    /// written anywhere but the Host's own keeping of it.
    Environment { agent: String, variable: String },
    /// As the file at `path` under the home of the Host's user, which only they can read: for
    /// a program that reads its sign-in from a file of its own.
    File { path: String },
    /// For git HTTPS access to `remote` (normalized as `host/owner/repo`), served to agents'
    /// git through the Host's credential helper and never written to git config or an agent's
    /// environment.
    Git { remote: String, username: String },
}

/// A credential for a Host to hold.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct HeldCredential {
    /// What the Dispatcher calls it.
    pub name: String,
    #[serde(rename = "use")]
    pub used: CredentialUse,
    pub value: String,
    /// When the Host stops giving it out, if the Dispatcher hasn't sent it again by then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<Timestamp>,
}

impl std::fmt::Debug for HeldCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HeldCredential")
            .field("name", &self.name)
            .field("used", &self.used)
            .field("value", &"…")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

/// `credentials/sync`: every credential the Host is to hold, in place of those it held. One
/// left out is dropped, and a file it was kept in removed. Refused for any client but the
/// Dispatcher the Host joined ([`crate::errors::FORBIDDEN`]).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "credentials/sync", response = Empty)]
pub struct SyncCredentialsRequest {
    pub credentials: Vec<HeldCredential>,
}
