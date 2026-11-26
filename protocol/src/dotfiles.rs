//! The person's dotfiles as a Host receives and places them (ADR 0037, WVE-243).
//!
//! The Dispatcher pulls the configured git repository and syncs its committed tree to every
//! connected Host over three `Peer::Joined`-only requests:
//!
//! 1. [`PlanDotfilesRequest`] (`dotfiles/plan`): the manifest of paths, SHA-256 digests,
//!    executable bits and git symlinks (or `clear: true`). When the Host is already at that
//!    commit, has every blob cached, is in `local` authoring mode, or is `off`, it completes
//!    immediately and returns `report`. Otherwise it returns the SHA-256 digests it needs.
//! 2. [`PutDotfilesBlobsRequest`] (`dotfiles/put`): the missing blobs packed into bounded chunks
//!    ([`MAX_CHUNK_BYTES`]) so even a large cold sync stays well below the WebSocket backlog
//!    limit.
//! 3. [`ApplyDotfilesRequest`] (`dotfiles/apply`): materializes the staged manifest under the
//!    Host's state directory, places file-level symlinks into `$HOME`, unlinks removed paths it
//!    previously owned, prunes unreferenced blobs, and returns [`DotfilesHostReport`].

use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::JsonRpcResponse;
use serde::Deserialize;
use serde::Serialize;

use crate::Empty;

/// The Host takes `dotfiles/plan`, `dotfiles/put` and `dotfiles/apply` from the Dispatcher it
/// joined, in `features`.
pub const FEATURE: &str = "dotfiles";

/// Maximum raw byte size of a single chunk (and target batch payload) sent in `dotfiles/put`,
/// leaving plenty of headroom under the WebSocket's 8 MiB backlog limit.
pub const MAX_CHUNK_BYTES: usize = 512 * 1024;

/// How a Host should handle the Dispatcher's dotfiles.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum DotfilesMode {
    /// Stay in `local` authoring mode if a local git checkout matching the configured remote
    /// exists under `$HOME` (such as `~/.dotfiles`), otherwise sync into `$HOME`.
    #[default]
    Auto,
    /// Always sync managed files into `$HOME` via file-level symlinks.
    Sync,
    /// Authoring Host: never touch `$HOME` symlinks; report the local checkout's status.
    Local,
    /// Do not sync; unlink any symlinks weave previously placed on this Host.
    Off,
}

impl DotfilesMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Sync => "sync",
            Self::Local => "local",
            Self::Off => "off",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "auto" => Some(Self::Auto),
            "sync" => Some(Self::Sync),
            "local" => Some(Self::Local),
            "off" => Some(Self::Off),
            _ => None,
        }
    }
}

/// What mode a Host actually applied on its last sync.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum DotfilesActiveMode {
    Synced,
    Local,
    Off,
}

impl DotfilesActiveMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Synced => "synced",
            Self::Local => "local",
            Self::Off => "off",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "synced" => Some(Self::Synced),
            "local" => Some(Self::Local),
            "off" => Some(Self::Off),
            _ => None,
        }
    }
}

/// One entry in the committed dotfiles tree, relative to `$HOME`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct DotfilesEntry {
    /// Forward-slash relative path under `$HOME` (plain components only).
    pub path: String,
    #[serde(flatten)]
    pub kind: DotfilesEntryKind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DotfilesEntryKind {
    File {
        /// Lowercase hex SHA-256 of the file's raw bytes.
        sha256: String,
        size: u64,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        executable: bool,
    },
    Symlink {
        /// Symlink target recorded in git (`120000` blob).
        target: String,
    },
}

/// A target path in `$HOME` weave skipped rather than clobbering.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct DotfilesConflict {
    pub path: String,
    pub reason: String,
}

/// What a Host did for a dotfiles sync, returned by `dotfiles/apply` (or `dotfiles/plan` when
/// no blob transfer was needed).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct DotfilesHostReport {
    pub mode: DotfilesActiveMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    /// On a `local` Host: path to the local authoring checkout (e.g. `~/.dotfiles`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
    /// On a `local` Host: whether the working tree has uncommitted changes.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub dirty: bool,
    /// On a `local` Host: commits ahead of upstream, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ahead: Option<u32>,
    /// Managed symlinks currently linked in `$HOME`.
    #[serde(default)]
    pub linked: u32,
    /// Previously managed symlinks unlinked during this sync.
    #[serde(default)]
    pub removed: u32,
    /// Unmanaged paths skipped rather than overwritten.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conflicts: Vec<DotfilesConflict>,
}

/// `dotfiles/plan`: begin syncing a dotfiles commit (or clearing managed dotfiles) on a Host.
/// Refused for any client but the Dispatcher the Host joined ([`crate::errors::FORBIDDEN`]).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "dotfiles/plan", response = PlanDotfilesResponse)]
#[serde(rename_all = "camelCase")]
pub struct PlanDotfilesRequest {
    /// Canonical remote identity (e.g. `github.com/owner/repo`) for local checkout detection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
    /// Configured branch name, used for local ahead-count reporting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default)]
    pub mode: DotfilesMode,
    /// Unlink any weave-managed dotfiles and drop the cache (unless the Host stays `local`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub clear: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entries: Vec<DotfilesEntry>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct PlanDotfilesResponse {
    /// Lowercase hex SHA-256 digests the Host does not yet hold in its local blob cache.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missing: Vec<String>,
    /// Present when no transfer was needed and the Host already finished (`local`, `off`, `clear`,
    /// already at `commit`, or all blobs were already cached and applied).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report: Option<DotfilesHostReport>,
}

/// One chunk (or full body, when `offset == 0` and decoded length == `totalSize`) of a blob
/// requested in [`PlanDotfilesResponse::missing`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct DotfilesBlobChunk {
    pub sha256: String,
    pub offset: u64,
    pub total_size: u64,
    /// Standard base64 of this chunk's raw bytes.
    pub data: String,
}

/// `dotfiles/put`: send one or more chunks of missing blobs to the Host's blob cache.
/// Refused for any client but the Dispatcher the Host joined ([`crate::errors::FORBIDDEN`]).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "dotfiles/put", response = Empty)]
pub struct PutDotfilesBlobsRequest {
    pub chunks: Vec<DotfilesBlobChunk>,
}

/// `dotfiles/apply`: apply the plan staged by the preceding `dotfiles/plan` once all missing
/// blobs have been uploaded with `dotfiles/put`. Refused for any client but the Dispatcher the
/// Host joined ([`crate::errors::FORBIDDEN`]).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "dotfiles/apply", response = DotfilesHostReport)]
pub struct ApplyDotfilesRequest {
    pub commit: String,
}
