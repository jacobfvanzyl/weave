//! Files on the Host's computer, for clients that aren't on it.
//!
//! [`ListFilesRequest`] lists a directory, so a client can pick where a session runs. Later
//! methods join the family under the same rules: `files/search` for `@` mentions, over a
//! session directory's files as the TUI's picker matches them, and `files/read` for
//! attachments, a file as the content block the TUI's `@` mentions attach. Paths are absolute
//! on the Host's computer; each method is a `features` entry of its own; nothing writes; and a
//! listing gives names and kinds, never sizes, times or contents.

use std::path::PathBuf;

use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::JsonRpcResponse;
use serde::Deserialize;
use serde::Serialize;

/// The Host offers [`ListFilesRequest`], in `features`.
pub const LIST_FEATURE: &str = "files/list";

/// The most entries [`ListFilesRequest`] gives; past it, the answer is `truncated`.
pub const MAX_ENTRIES: usize = 2_000;

/// `files/list`: what a directory on the Host's computer holds, by name and kind.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "files/list", response = ListFilesResponse)]
#[serde(rename_all = "camelCase")]
pub struct ListFilesRequest {
    /// An absolute path; the home directory of the Host's user when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<PathBuf>,
    /// Entries whose names start with a dot too.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ListFilesResponse {
    /// The directory listed, without `.` or `..`. Symlinks stay as named, so a session's
    /// directory reads as the person chose it.
    pub path: PathBuf,
    /// Its parent; none at the root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<PathBuf>,
    /// The home directory of the Host's user, so clients can show paths under it as `~`.
    pub home: PathBuf,
    /// Directories first, then by name. Names that aren't UTF-8 are left out.
    pub entries: Vec<FileEntry>,
    /// The directory holds more than [`MAX_ENTRIES`] entries the request asked for.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub kind: FileKind,
}

/// What an entry is, following symlinks.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum FileKind {
    Directory,
    File,
    /// Anything else: a socket, a device, or a symlink that leads nowhere.
    #[serde(other)]
    Other,
}
