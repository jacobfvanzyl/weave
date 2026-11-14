//! Reports (ADR 0023): what the Host tells a thread of a turn its agent began in another
//! thread, when the turn ends or waits on a person. The Host writes them for its own
//! threads' turns, and the Dispatcher for turns on another of the person's Hosts (ADR 0029),
//! in the same words, which [`ended_text`] and [`waiting_text`] give.

use agent_client_protocol::Error;
use agent_client_protocol::v1::schema::StopReason;
use serde_json::Value;

use crate::pending::PendingKind;
use crate::pending::PendingRequest;
use crate::threads::LatestTurn;
use crate::threads::ThreadId;
use crate::threads::ThreadListing;

/// How much of a delegated agent's last message its starting thread is told.
pub const MESSAGE_CHARS: usize = 2_000;

/// What a person must answer in a thread another thread's agent began a turn in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Asks {
    /// Permission for a tool call, by its title when it has one.
    Permission(Option<String>),
    /// An elicitation, by its message.
    Elicitation(String),
}

impl Asks {
    /// What a person must answer in `pending`; nothing for a client tool call.
    pub fn of(pending: &PendingRequest) -> Option<Self> {
        match &pending.request {
            PendingKind::Permission { request } => {
                Some(Self::Permission(request.tool_call.fields.title.clone()))
            }
            PendingKind::Elicitation { request } => {
                Some(Self::Elicitation(request.message.clone()))
            }
            PendingKind::ClientTool { .. } => None,
        }
    }
}

/// A thread as a report names it: its title, agent and id, and the Host it's on when it
/// isn't the told thread's.
pub struct Named<'a> {
    pub thread_id: &'a ThreadId,
    pub title: Option<&'a str>,
    pub agent_id: &'a str,
    /// The other Host's name.
    pub host: Option<&'a str>,
}

impl<'a> Named<'a> {
    pub fn of(listing: &'a ThreadListing, host: Option<&'a str>) -> Self {
        Self {
            thread_id: &listing.info.session_id,
            title: listing.info.title.as_deref(),
            agent_id: &listing.agent_id,
            host,
        }
    }
}

impl std::fmt::Display for Named<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let id = self.thread_id;
        match self.title {
            Some(title) => write!(f, "“{title}” ({}, {id})", self.agent_id)?,
            None => write!(f, "{id} ({})", self.agent_id)?,
        }
        match self.host {
            Some(host) => write!(f, " on {host}"),
            None => Ok(()),
        }
    }
}

/// The report on a thread to the thread whose agent began a turn there, when the turn ends:
/// how, and the start of the agent's last message.
pub fn ended_text(named: &Named<'_>, latest: Option<&LatestTurn>) -> String {
    let how = match latest {
        Some(LatestTurn {
            error: Some(error), ..
        }) => format!("failed its turn: {}", why(error)),
        Some(LatestTurn {
            response: Some(response),
            ..
        }) => match response.stop_reason {
            StopReason::EndTurn => "finished its turn".to_owned(),
            StopReason::Cancelled => "had its turn cancelled".to_owned(),
            StopReason::MaxTokens => "stopped: its agent reached its token limit".to_owned(),
            StopReason::MaxTurnRequests => {
                "stopped: its turn made too many model requests".to_owned()
            }
            StopReason::Refusal => "stopped: its agent refused to go on".to_owned(),
            _ => "stopped its turn".to_owned(),
        },
        _ => "ended its turn".to_owned(),
    };
    let mut text = format!("[weave] Thread {named} {how}.");
    if let Some(message) = latest.and_then(|turn| turn.message.as_deref()) {
        let shown: String = message.chars().take(MESSAGE_CHARS).collect();
        text.push_str(" Its agent's last message:\n\n");
        text.push_str(&shown);
        if shown.len() < message.len() {
            text.push_str("\n\n[…] read_thread gives the rest");
            if let Some(host) = named.host {
                text.push_str(&format!(", with host {host}"));
            }
            text.push('.');
        }
    }
    text
}

/// The report on a thread to the thread whose agent began a turn there, when a person must
/// answer something in it.
pub fn waiting_text(named: &Named<'_>, asks: &Asks) -> String {
    let what = match asks {
        Asks::Permission(Some(title)) => format!("asks permission for “{title}”"),
        Asks::Permission(None) => "asks permission for a tool call".to_owned(),
        Asks::Elicitation(message) => format!("asks: “{message}”"),
    };
    let host = named
        .host
        .map_or_else(String::new, |host| format!(" connected to {host}"));
    format!(
        "[weave] Thread {named} is waiting on a person: it {what}. Someone attached to it in a \
         weave client{host} has to answer; you can't. Tell the person if they need to."
    )
}

/// Why `error` happened, as its message and the text of its data.
pub fn why(error: &Error) -> String {
    match error.data.as_ref() {
        Some(Value::String(data)) => format!("{}: {data}", error.message),
        Some(data) if !data.is_null() => format!("{}: {data}", error.message),
        _ => error.message.clone(),
    }
}
