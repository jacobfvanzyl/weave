//! Sessions: one directory on the Host's computer, the threads and terminals a client put in it,
//! and the layout clients show them in (ADR 0031, WVE-202, WVE-203).
//!
//! A Session is known by its directory, which is its scope as terminals have one: the deepest
//! worktree a directory is in, or the directory itself outside a repository, with symlinks
//! resolved. So every worktree of a repository is a Session of its own, and there is one
//! Session per directory. A client makes one, by setting a layout for a directory that has none
//! or by adding to one (`sessions/add`): the Host makes none on its own, so a directory where
//! threads only ran from a terminal or a schedule has none. A Session ends with its worktree
//! (`worktrees/remove`, `worktrees/release`), when its directory is gone, or when a client ends
//! it (`sessions/end`).
//!
//! What's in a Session is what a client added to it, and what a thread in it started: a thread
//! or terminal elsewhere in its directory isn't its, until a client adds it. A thread that
//! closes stays its; one that's deleted, and a terminal that ends, leave it.
//!
//! A Session's layout is a document the Host stores and versions but never reads: tabs, each a
//! tree of `row` and `column` nodes with Blocks at the leaves, and Blocks floating over them,
//! some of them minimized ([`layout`]). Each write gives it a new revision, the newest write wins, and every client
//! watching the Session is sent the new revision. Focus, zoom, the tab in front and scroll
//! positions stay on each device, and are never written to it.

use std::path::PathBuf;

use agent_client_protocol::JsonRpcNotification;
use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::JsonRpcResponse;
use serde::Deserialize;
use serde::Serialize;

use crate::Timestamp;
use crate::threads::ThreadId;
use crate::worktrees::GitLocation;

/// The Host offers the `sessions/*` methods, in `features`.
pub const FEATURE: &str = "sessions";

/// The Host's `sessions/end` closes what's in the Session, in `features`: a Host from before it
/// only forgot the Session's layout, leaving its threads and terminals without one.
pub const END_FEATURE: &str = "sessions_end";

/// A Session holds what clients add to it (`sessions/add`), and the Host makes none on its own,
/// in `features`: a Host from before it made one for any directory a thread was prompted or a
/// terminal started in, and counted everything in the directory as the Session's.
pub const ADD_FEATURE: &str = "sessions_add";

/// The largest layout document the Host keeps, serialized: far more than any layout needs.
pub const MAX_LAYOUT: usize = 1024 * 1024;

/// A Session as clients see it. `HostSession` in the schema, apart from ACP's sessions.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "schema", schemars(rename = "HostSession"))]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// What it's known by: a worktree, or a directory outside a repository; symlinks resolved.
    pub directory: PathBuf,
    /// Its layout's revision: 0 before any client set one, then one more with every write.
    pub revision: u64,
    /// Its layout, as the last client to set it wrote it; absent before any did, and in
    /// `sessions/list`. The Host never reads it: [`layout::Layout`] is the shape clients agree
    /// on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "schema", schemars(with = "Option<layout::Layout>"))]
    pub layout: Option<serde_json::Value>,
    /// Where in a git repository it is; absent outside one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<GitLocation>,
    pub created_at: Timestamp,
    /// When its layout was last set; absent before any client set one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<Timestamp>,
    /// Its threads that the Host has a record of, open or not, most recently active first, so a
    /// client can place one no Block shows: those clients added to it and those its threads
    /// started, not every thread in its directory. One a client added before prompting it is
    /// here too, though no listing has it yet. `threads/watch` follows them.
    #[serde(default)]
    pub threads: Vec<ThreadId>,
    /// Its terminals' ids, oldest first: those clients added to it and those opened from its
    /// threads. `terminals/watch` follows them.
    #[serde(default)]
    pub terminals: Vec<String>,
}

/// `sessions/list`: the Host's Sessions, by directory, without their layouts.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "sessions/list", response = ListSessionsResponse)]
#[serde(rename_all = "camelCase")]
pub struct ListSessionsRequest {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ListSessionsResponse {
    pub sessions: Vec<Session>,
}

/// `sessions/get`: the Session `directory` is in, with its layout. `no_session` when it has
/// none.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "sessions/get", response = SessionResponse)]
#[serde(rename_all = "camelCase")]
pub struct GetSessionRequest {
    /// Any directory: its Session is that of the deepest worktree it's in, or of the directory
    /// itself outside a repository.
    pub directory: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct SessionResponse {
    pub session: Session,
}

/// `sessions/set`: a new layout for the Session `directory` is in, made first if it has none.
/// The newest write wins: the layout replaces whatever was there, under the next revision, and
/// every client watching the Session is sent it. With `ifRevision`, only when that is still
/// the Session's revision, else `revision_conflict` with the current one, so a client can merge
/// rather than overwrite. Refused, as invalid params, over [`MAX_LAYOUT`] bytes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "sessions/set", response = SessionResponse)]
#[serde(rename_all = "camelCase")]
pub struct SetSessionRequest {
    pub directory: PathBuf,
    #[cfg_attr(feature = "schema", schemars(with = "layout::Layout"))]
    pub layout: serde_json::Value,
    /// The revision the client's layout was made from: 0 for a Session without one yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub if_revision: Option<u64>,
}

/// `sessions/add`: `threads` and `terminals` are the Session's that `directory` is in from now
/// on, which is made first if the directory has none, without a layout. A client asks it as it
/// starts a thread or terminal in a Session, and to bring in one started elsewhere. Each must be
/// in the Session's directory, else invalid params; one that's already its changes nothing.
/// Every client watching the Session is sent it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "sessions/add", response = SessionResponse)]
#[serde(rename_all = "camelCase")]
pub struct AddToSessionRequest {
    pub directory: PathBuf,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub threads: Vec<ThreadId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub terminals: Vec<String>,
}

/// `sessions/watch`: the Session `directory` is in, or with no `directory` every Session, as
/// `sessions/get` gives them; then a [`SessionUpdatedNotification`] when one is made, its
/// layout is set or something joins it, and a [`SessionEndedNotification`] when one ends, until the connection ends
/// or the client sends `sessions/unwatch`. A directory with no Session yet may be watched, and
/// answers no Session.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "sessions/watch", response = WatchSessionsResponse)]
#[serde(rename_all = "camelCase")]
pub struct WatchSessionsRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct WatchSessionsResponse {
    /// The directory watched, as the Host resolved it; absent when watching every Session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory: Option<PathBuf>,
    /// With their layouts.
    pub sessions: Vec<Session>,
}

/// `sessions/unwatch`: stop what `sessions/watch` sends for `directory`, as its answer gave it,
/// or for every Session without one.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "sessions/unwatch", response = crate::Empty)]
#[serde(rename_all = "camelCase")]
pub struct UnwatchSessionsRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory: Option<PathBuf>,
}

/// `sessions/end`: end the Session `directory` is in, for good. Its open threads close, as
/// `thread/close` closes them, its terminals end, and its layout is forgotten: nothing brings it
/// back. What else is in its directory, which was never the Session's, is left as it is. Its
/// directory stays, a worktree too. Refused, with nothing closed, while a thread in it runs a
/// turn or waits on a request, or a terminal in it runs a command (`session_busy`); `no_session`
/// when it has none.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "sessions/end", response = crate::Empty)]
#[serde(rename_all = "camelCase")]
pub struct EndSessionRequest {
    pub directory: PathBuf,
}

/// `sessions/updated`, to clients watching it: a Session was made, its layout set, or a thread or
/// terminal joined it, which leaves its revision as it was. It carries the layout.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcNotification)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[notification(method = "sessions/updated")]
#[serde(rename_all = "camelCase")]
pub struct SessionUpdatedNotification {
    pub session: Session,
}

/// `sessions/ended`, to clients watching it: a Session ended, with its worktree, its directory
/// or by `sessions/end`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcNotification)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[notification(method = "sessions/ended")]
#[serde(rename_all = "camelCase")]
pub struct SessionEndedNotification {
    pub directory: PathBuf,
}

/// The layout document clients write to a Session and read back. The Host keeps it as JSON it
/// doesn't read, so these types are the clients' agreement, not the Host's: a client checks
/// [`Layout::version`] before it trusts the rest, and new Block types change nothing here.
pub mod layout {
    use serde::Deserialize;
    use serde::Serialize;

    /// This shape's version, which [`Layout::version`] carries. Version 1 (WVE-202) also had
    /// `stack` nodes, Blocks one behind another in one place of the tree; since version 2
    /// (WVE-203) a Block in a tab is docked in its tree, alone in its place, or floats over it.
    pub const VERSION: u32 = 2;

    /// A Session's tabs.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    #[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
    #[cfg_attr(feature = "schema", schemars(rename = "SessionLayout"))]
    #[serde(rename_all = "camelCase")]
    pub struct Layout {
        /// The shape it was written in: [`VERSION`].
        pub version: u32,
        /// In order. Which is in front is each device's own.
        pub tabs: Vec<Tab>,
    }

    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    #[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
    #[cfg_attr(feature = "schema", schemars(rename = "SessionTab"))]
    #[serde(rename_all = "camelCase")]
    pub struct Tab {
        /// Permanent and opaque, unique in the layout.
        pub id: String,
        /// The person's name for it; clients name an untitled tab from what it shows.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub title: Option<String>,
        /// Its tree of docked Blocks; absent for a tab with none.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub root: Option<Node>,
        /// Blocks over the tree, last on top.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        pub floating: Vec<Floating>,
    }

    /// A docked Block, or several side by side or one above another.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    #[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
    #[cfg_attr(feature = "schema", schemars(rename = "SessionNode"))]
    #[serde(tag = "kind", rename_all = "camelCase")]
    pub enum Node {
        /// Side by side, left to right.
        Row(Split),
        /// One above another, top to bottom.
        Column(Split),
        Block(Block),
    }

    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    #[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
    #[cfg_attr(feature = "schema", schemars(rename = "SessionSplit"))]
    #[serde(rename_all = "camelCase")]
    pub struct Split {
        pub children: Vec<Node>,
        /// Each child's share of the space, in the children's order, relative to the others';
        /// equal shares when absent.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub sizes: Option<Vec<f64>>,
    }

    /// What one place in a tab shows. It points at something on the Session's Host, such as a thread or a
    /// terminal, which the Host doesn't read. A client that closes one closes what it shows: a
    /// thread, which can be shown again, or a terminal, which ends with its Block (ADR 0031).
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    #[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
    #[cfg_attr(feature = "schema", schemars(rename = "SessionBlock"))]
    #[serde(rename_all = "camelCase")]
    pub struct Block {
        /// Permanent and opaque, unique in the layout.
        pub id: String,
        /// A reverse-DNS name, such as `weave.thread` (`props.threadId`) or `weave.terminal`
        /// (`props.terminalId`). A client without the type shows the type and props as text.
        #[serde(rename = "type")]
        pub block_type: String,
        /// What the type needs, as it defines.
        #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
        pub props: serde_json::Map<String, serde_json::Value>,
    }

    /// A Block over a tab's tree.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    #[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
    #[cfg_attr(feature = "schema", schemars(rename = "SessionFloating"))]
    #[serde(rename_all = "camelCase")]
    pub struct Floating {
        pub block: Block,
        /// Where it is while it isn't minimized, and where it comes back to.
        pub frame: Frame,
        /// Put away: clients show it as its name, to bring back, in place of its frame.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        pub minimized: bool,
    }

    /// Where a floating Block is, as fractions of its tab's width and height from its top left.
    #[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
    #[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
    #[cfg_attr(feature = "schema", schemars(rename = "SessionFrame"))]
    #[serde(rename_all = "camelCase")]
    pub struct Frame {
        pub x: f64,
        pub y: f64,
        pub width: f64,
        pub height: f64,
    }
}
