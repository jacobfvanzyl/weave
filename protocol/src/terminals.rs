//! Terminals on the Host's computer, which clients show beside a thread (ADR 0022).
//!
//! A terminal is a shell that belongs to a worktree, or to a directory outside a repository. A
//! holder keeps it alive outside the Host, and later a Rex block may. Where it shows is each
//! client's choice, so nothing here describes panes or layout. The concepts and names follow
//! Rex's block model in this protocol's casing: `format`, `write` and `resize`, and the
//! properties `pwd`, `title`, `process`, `size` and `program_status`. What weave adds to Rex's
//! model (`opened_from`, `command`, the snapshot restore) is optional, and clients work without
//! it.
//!
//! [`ListTerminalsRequest`] and [`WatchTerminalsRequest`] give a scope's terminals,
//! [`NewTerminalRequest`] starts one, and [`AttachTerminalRequest`] gives a ticket for its
//! stream, a WebSocket of its own ([`stream`]). Remote clients may use all of them, since a
//! client that can start an agent in a directory can already run anything there.

use std::path::PathBuf;

use agent_client_protocol::JsonRpcNotification;
use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::JsonRpcResponse;
use agent_client_protocol::schema::v1::SessionId;
use serde::Deserialize;
use serde::Serialize;

use crate::Timestamp;

/// The Host offers the `terminals/*` methods and the terminal stream, in `features`.
pub const FEATURE: &str = "terminals";

/// A terminal as clients see it. `HostTerminal` in the schema, apart from ACP's `Terminal`, an
/// agent's Host-run terminal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "schema", schemars(rename = "HostTerminal"))]
#[serde(rename_all = "camelCase")]
pub struct Terminal {
    /// Permanent and opaque: a holder's, or later a Rex block's.
    pub id: String,
    /// The worktree it belongs to, or its directory outside a repository; symlinks resolved.
    pub scope: PathBuf,
    /// The person's name for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// The session it was opened from, whose clients show it by default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opened_from: Option<SessionId>,
    /// What the program titled it (OSC 0 and 2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The directory the shell last reported (OSC 7), as a path on the Host's computer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pwd: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<TerminalProcesses>,
    pub size: TerminalSize,
    /// weave's, from OSC 133: whether a command runs, or how the last one ended. Absent where
    /// the owner doesn't report it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<TerminalCommand>,
    /// The program's status records (OSC 7501), as Rex keeps them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub program_status: Vec<ProgramStatus>,
    pub started_at: Timestamp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct TerminalProcesses {
    /// The process group in the terminal's foreground: the shell, or the command it runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground: Option<TerminalProcess>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct TerminalProcess {
    pub pid: i32,
    pub name: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct TerminalCommand {
    pub running: bool,
    /// The command line, while it runs, when the shell said it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// How the last command ended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

/// An OSC 7501 record, with `title` and `msg` decoded.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ProgramStatus {
    /// `build/test`; absent for the root record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub state: ProgramState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<BlockedKind>,
    /// 0 to 100.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub msg: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum ProgramState {
    Idle,
    Working,
    Done,
    Blocked,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum BlockedKind {
    Permission,
    Question,
    Auth,
}

/// `terminals/list`: the terminals of the scope `directory` is in, oldest first.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "terminals/list", response = TerminalsResponse)]
#[serde(rename_all = "camelCase")]
pub struct ListTerminalsRequest {
    /// Any directory: its scope is the deepest worktree it's in, or the directory itself
    /// outside a repository.
    pub directory: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct TerminalsResponse {
    pub scope: PathBuf,
    pub terminals: Vec<Terminal>,
}

/// `terminals/watch`: a scope's terminals as `terminals/list` gives them, then a
/// [`TerminalUpdatedNotification`] or [`TerminalRemovedNotification`] for every change in that
/// scope, until the connection ends or the client sends `terminals/unwatch`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "terminals/watch", response = TerminalsResponse)]
#[serde(rename_all = "camelCase")]
pub struct WatchTerminalsRequest {
    pub directory: PathBuf,
}

/// `terminals/unwatch`: stop what `terminals/watch` sends for `scope`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "terminals/unwatch", response = crate::Empty)]
#[serde(rename_all = "camelCase")]
pub struct UnwatchTerminalsRequest {
    pub scope: PathBuf,
}

/// `terminals/updated`, to clients watching its scope: a terminal started or changed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcNotification)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[notification(method = "terminals/updated")]
#[serde(rename_all = "camelCase")]
pub struct TerminalUpdatedNotification {
    pub terminal: Terminal,
}

/// `terminals/removed`, to clients watching its scope: a terminal ended.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcNotification)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[notification(method = "terminals/removed")]
#[serde(rename_all = "camelCase")]
pub struct TerminalRemovedNotification {
    pub id: String,
    pub scope: PathBuf,
    /// How its program ended, when the Host saw it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

/// `terminals/new`: a terminal in `directory`, belonging to its scope. A holder starts the
/// person's login shell there, or runs `command` under it, as Ghostty starts a shell.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "terminals/new", response = TerminalResponse)]
#[serde(rename_all = "camelCase")]
pub struct NewTerminalRequest {
    pub directory: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opened_from: Option<SessionId>,
    /// A command and its arguments, run under a login shell instead of an interactive one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<Vec<String>>,
    /// Its first size; 80×24 when absent. The first client to attach usually sets it again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<TerminalSize>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct TerminalResponse {
    pub terminal: Terminal,
}

/// `terminals/close`: hang up the terminal's program, which ends it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "terminals/close", response = crate::Empty)]
#[serde(rename_all = "camelCase")]
pub struct CloseTerminalRequest {
    pub id: String,
}

/// `terminals/setLabel`: name the terminal, or clear its name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "terminals/setLabel", response = TerminalResponse)]
#[serde(rename_all = "camelCase")]
pub struct SetTerminalLabelRequest {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// `terminals/write`: text as if typed, for clients that don't attach. `\r` is Enter.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "terminals/write", response = crate::Empty)]
#[serde(rename_all = "camelCase")]
pub struct WriteTerminalRequest {
    pub id: String,
    pub text: String,
}

/// `terminals/format`: the terminal's visible screen through the formatter, or with its history.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "terminals/format", response = FormatTerminalResponse)]
#[serde(rename_all = "camelCase")]
pub struct FormatTerminalRequest {
    pub id: String,
    #[serde(default)]
    pub format: TerminalFormat,
    /// The history above the screen too.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub history: bool,
    /// Trailing whitespace and blank lines trimmed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub trim: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum TerminalFormat {
    /// The characters alone.
    #[default]
    Text,
    /// VT sequences with styles, cursor, modes and palette, which a terminal restores from.
    Vt,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct FormatTerminalResponse {
    pub content: String,
}

/// `terminals/attach`: a ticket for the terminal's stream, good once, for
/// [`stream::TICKET_LIFETIME_MS`], to the device that asked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "terminals/attach", response = AttachTerminalResponse)]
#[serde(rename_all = "camelCase")]
pub struct AttachTerminalRequest {
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct AttachTerminalResponse {
    pub ticket: String,
    pub expires_at: Timestamp,
}

/// A terminal's stream: a WebSocket of its own on the Host's remote listener, with subprotocol
/// [`stream::SUBPROTOCOL`] and the same `Origin` rules as the Host protocol's.
///
/// The client's first text frame is a [`stream::Open`]; the Host answers with a
/// [`stream::Opened`], then binary frames of a kind byte and a payload, and text frames of
/// [`stream::Message`]. The client sends input as binary frames and resizes as text frames.
pub mod stream {
    use serde::Deserialize;
    use serde::Serialize;

    use super::Terminal;
    use super::TerminalSize;

    /// The subprotocol a terminal stream's upgrade must ask for.
    pub const SUBPROTOCOL: &str = "weave-terminal";
    /// How long a ticket stays good.
    pub const TICKET_LIFETIME_MS: crate::Timestamp = 30 * 1000;

    /// From the Host: a restore, a snapshot in chunks or the formatter's VT, which replaces the
    /// client's screen.
    pub const RESTORE: u8 = 0x01;
    /// From the Host: the program's output, unchanged.
    pub const OUTPUT: u8 = 0x03;
    /// From the client: input, encoded by its libghostty-vt from the terminal's modes.
    pub const INPUT: u8 = 0x10;

    /// The ticket was missing, used, late or another device's.
    pub const CLOSE_TICKET: u16 = 4010;
    /// The terminal ended, after [`Message::Exited`].
    pub const CLOSE_EXITED: u16 = 4011;

    /// The client's first text frame.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    #[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
    #[cfg_attr(feature = "schema", schemars(rename = "TerminalStreamOpen"))]
    #[serde(rename_all = "camelCase")]
    pub struct Open {
        pub ticket: String,
        /// The client's size, which is the terminal's once the client types.
        pub size: TerminalSize,
        /// The Ghostty commit and snapshot format the client's libghostty-vt decodes, as
        /// `weave-holder --version` names its own.
        pub codec: String,
    }

    /// The Host's first text frame: the terminal as the restore has it, so a VT restore is drawn
    /// at its `size`, and how the restore that follows comes.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    #[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
    #[cfg_attr(feature = "schema", schemars(rename = "TerminalStreamOpened"))]
    #[serde(rename_all = "camelCase")]
    pub struct Opened {
        pub terminal: Terminal,
        pub restore: Restore,
        /// How many bytes of restore follow, in [`RESTORE`] frames, before the output does.
        pub restore_bytes: u64,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
    #[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
    #[cfg_attr(feature = "schema", schemars(rename = "TerminalRestore"))]
    #[serde(rename_all = "camelCase")]
    pub enum Restore {
        /// A libghostty snapshot of the client's codec, history included.
        Snapshot,
        /// The formatter's VT of the screen, without history, for a client of another codec.
        Vt,
    }

    /// The Host's later text frames.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    #[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
    #[cfg_attr(feature = "schema", schemars(rename = "TerminalStreamMessage"))]
    #[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
    pub enum Message {
        Updated(Box<Terminal>),
        Bell {},
        Notification {
            title: String,
            body: String,
        },
        Progress {
            /// `remove`, `set`, `error`, `indeterminate` or `pause`.
            state: String,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            progress: Option<u8>,
        },
        /// To the device that last typed only.
        Clipboard {
            text: String,
        },
        /// The client fell behind: a new restore of `restore_bytes` follows and replaces its
        /// screen, a VT one drawn at `size`.
        Resync {
            restore: Restore,
            restore_bytes: u64,
            size: TerminalSize,
        },
        /// The terminal took a new size here, in order with the output, so the client's screen
        /// takes it at the same point as the owner's.
        Resized(TerminalSize),
        /// The program ended; the Host closes the stream after it.
        Exited {
            exit_code: i32,
        },
    }

    /// The client's text frames after [`Open`].
    #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
    #[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
    #[cfg_attr(feature = "schema", schemars(rename = "TerminalStreamClientMessage"))]
    #[serde(rename_all = "camelCase")]
    pub enum ClientMessage {
        Resize(TerminalSize),
    }
}
