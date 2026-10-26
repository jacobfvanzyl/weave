//! What keeps terminals alive for the Host, behind one interface (ADR 0022): holders today
//! (`holder.rs`), and later Rex blocks. Nothing above it depends on which owner a terminal has.
//!
//! The interface is the holder protocol's messages: the Host sends requests under Rex's method
//! names and input, and an owner sends answers, Rex's events, restores and output. An owner that
//! isn't a holder translates its own API into them. The channels are bounded, so a client that
//! reads slowly holds the owner back instead of the Host buffering for it.

use std::collections::BTreeMap;
use std::path::PathBuf;

use agent_client_protocol::Error;
use agent_client_protocol::schema::v1::SessionId;
use futures::future::BoxFuture;
use serde_json::Value;
use tokio::sync::mpsc;
use weave_host_protocol::terminals::TerminalSize;

/// How many messages wait in a connection's channel before its owner is held back: with
/// restores and output in chunks of up to 64 KiB, a few MiB.
pub(crate) const CHANNEL_DEPTH: usize = 64;

/// Keeps terminals alive outside the Host.
pub trait Owner: Send + Sync + 'static {
    /// The terminals it keeps, each of which answers; it forgets those that don't.
    fn find(&self) -> BoxFuture<'_, Vec<String>>;

    /// Starts a terminal, and gives its id once it answers.
    fn start(&self, start: Start) -> BoxFuture<'_, Result<String, Error>>;

    /// A connection to one of its terminals.
    fn connect<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Wire, Error>>;
}

/// A terminal to start.
#[derive(Clone, Debug)]
pub struct Start {
    pub id: String,
    /// Where the program starts.
    pub directory: PathBuf,
    /// The worktree, or directory outside a repository, the terminal belongs to.
    pub scope: PathBuf,
    pub label: Option<String>,
    pub opened_from: Option<SessionId>,
    /// A command to run under a login shell instead of an interactive shell.
    pub command: Option<Vec<String>>,
    pub size: TerminalSize,
    /// The environment the program starts in: the agents' (WVE-141).
    pub env: BTreeMap<String, String>,
}

/// What the Host sends an owner, in the holder protocol's terms.
#[derive(Debug)]
pub enum Outgoing {
    /// A request by Rex's method name, answered by an [`Incoming::Answer`] of the same id.
    Request {
        id: u64,
        method: String,
        args: Value,
    },
    /// Bytes as typed.
    Input(Vec<u8>),
}

/// What an owner sends the Host.
#[derive(Debug)]
pub enum Incoming {
    Answer {
        id: u64,
        result: Result<Value, String>,
    },
    /// One of Rex's terminal events, or weave's additions (`event.rs` in the holder).
    Event { kind: String, payload: Value },
    /// A chunk of a restore: a snapshot, or the formatter's VT.
    Restore(Vec<u8>),
    /// The program's output.
    Output(Vec<u8>),
}

/// One connection to a terminal: what the Host sends and what it's sent. Dropping it closes the
/// connection.
pub struct Wire {
    pub outgoing: mpsc::Sender<Outgoing>,
    pub incoming: mpsc::Receiver<Incoming>,
}
