//! Git repositories on the Host's computer and their worktrees (ADR 0019).
//!
//! The Host is git-aware: a session whose directory is in a repository says which one, which
//! worktree and which branch ([`GitLocation`]). Worktrees are the person's, beside sessions
//! rather than parts of them, and a client lists, creates and removes them here: it makes a
//! worktree and then starts a session there with `session/create`, or removes one along with
//! its sessions. New worktrees go where worktrunk puts them by default, beside the repository
//! as `<repo>.<branch>`, so worktrunk in a terminal manages the same ones. The Host never
//! removes a worktree on its own. Paths are absolute on the Host's computer and compared with
//! symlinks resolved.

use std::path::PathBuf;

use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::JsonRpcResponse;
use agent_client_protocol::schema::v1::SessionId;
use serde::Deserialize;
use serde::Serialize;

/// The Host offers the `worktrees/*` methods, in `features`.
pub const FEATURE: &str = "worktrees";

/// Where in a git repository a session's directory is, as the Host last read it: when the
/// session opened, and again after each of its turns.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct GitLocation {
    /// The repository, by its primary worktree.
    pub repo: PathBuf,
    /// The worktree the directory is in: the primary one or another.
    pub worktree: PathBuf,
    /// The branch checked out there; absent when its HEAD is detached.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// The repository's remote as a host and path, such as `github.com/owner/name`, without
    /// credentials or `.git`: `origin`, or else the first. Absent without one, or for a remote
    /// that's a path on this computer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
}

/// `worktrees/list`: a repository's worktrees and the sessions in each.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "worktrees/list", response = ListWorktreesResponse)]
#[serde(rename_all = "camelCase")]
pub struct ListWorktreesRequest {
    /// Any directory in the repository.
    pub repo: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ListWorktreesResponse {
    /// The repository's primary worktree.
    pub repo: PathBuf,
    /// As [`GitLocation::remote`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
    /// The branch new worktrees start from unless asked otherwise: the remote's default
    /// branch, else `main` or `master`. Absent when there's none of those.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_branch: Option<String>,
    /// The primary worktree first, then by path. Worktrees whose directory is gone are left
    /// out.
    pub worktrees: Vec<Worktree>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: PathBuf,
    /// Absent when its HEAD is detached.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// The commit checked out; absent before the first commit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    /// The repository's primary worktree, which can't be removed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub primary: bool,
    /// Staged, unstaged or untracked changes; ignored files don't count.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub changes: bool,
    /// How far its HEAD is from the default branch; absent without one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub divergence: Option<Divergence>,
    /// The branch it tracks, and how far it is from it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream: Option<Upstream>,
    /// The sessions the Host has a record of in it, open or not, most recently active first.
    #[serde(default)]
    pub sessions: Vec<SessionId>,
}

/// Commits one side has that the other doesn't.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Divergence {
    /// Commits it has that the other doesn't.
    pub ahead: u32,
    /// Commits the other has that it doesn't.
    pub behind: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Upstream {
    /// Such as `origin/feature`.
    pub name: String,
    #[serde(flatten)]
    pub divergence: Divergence,
}

/// `worktrees/create`: a new worktree for `branch`, beside the repository as
/// `<repo>.<branch>` with the branch made safe for a path (`feature/auth` becomes
/// `weave.feature-auth`). A branch that doesn't exist is made from `base`. One that exists is
/// checked out, a branch only a remote has included, unless another worktree has it checked
/// out. The client then starts a session there with `session/create`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "worktrees/create", response = CreateWorktreeResponse)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorktreeRequest {
    /// Any directory in the repository.
    pub repo: PathBuf,
    pub branch: String,
    /// What a new branch starts from: a branch, tag or commit. The default branch when absent,
    /// else the primary worktree's HEAD. Refused for a branch that exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct CreateWorktreeResponse {
    /// The new worktree.
    pub path: PathBuf,
    pub branch: String,
    /// The branch was made for it, rather than one that existed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub created_branch: bool,
}

/// `worktrees/remove`: remove a worktree other than the primary one. Refused while a session
/// in it runs a turn or waits on a request (`worktree_busy`), and when it has changes
/// (`uncommitted_changes`) unless `force`. Otherwise the sessions open in it close first. Their
/// journals stay, so they can still be deleted. Its branch is deleted when git counts it merged,
/// and regardless with `deleteBranch`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "worktrees/remove", response = RemoveWorktreeResponse)]
#[serde(rename_all = "camelCase")]
pub struct RemoveWorktreeRequest {
    pub path: PathBuf,
    /// Remove it with its changes, which are lost.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub force: bool,
    /// Delete its branch even when it isn't merged, losing commits only it has.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub delete_branch: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct RemoveWorktreeResponse {
    /// The sessions that were open in it, now closed.
    #[serde(default)]
    pub closed: Vec<SessionId>,
    /// Its branch; absent when its HEAD was detached.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub branch_deleted: bool,
}

/// `worktrees/release`: let a worktree go before something else removes it, as
/// `weave worktrees pre-remove` asks when worktrunk does. Refused, as `worktrees/remove` is,
/// while a session in it runs a turn or waits on a request; otherwise the sessions open in it
/// close.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "worktrees/release", response = ReleaseWorktreeResponse)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseWorktreeRequest {
    pub path: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ReleaseWorktreeResponse {
    /// The sessions that were open in it, now closed.
    #[serde(default)]
    pub closed: Vec<SessionId>,
}
