//! Waiting for one turn of a thread, for `weave threads follow`, `threads prompt --wait` and
//! `weave run` (WVE-108): which turn it is, what of the thread's journal to print meanwhile, and
//! when to stop: when the turn ends, when it waits on a person (unless asked to wait through
//! that), or at a deadline. The turn goes on whenever this stops waiting before its end.

use std::collections::BTreeMap;
use std::time::Duration;

use anyhow::anyhow;
use clap::Args;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::time::Instant;
use weave_acp_core::schema::PromptResponse;
use weave_acp_core::schema::SessionId;
use weave_host_client::HostEvent;
use weave_host_protocol::events::SessionEvent;
use weave_host_protocol::pending::PendingId;
use weave_host_protocol::pending::PendingKind;
use weave_host_protocol::pending::PendingRequest;
use weave_host_protocol::sessions::SessionState;
use weave_host_protocol::turns::TurnId;

use crate::exit;
use crate::exit::Status;
use crate::run::Output;
use crate::run::describe_stop;

/// How long to wait for a turn, and whether through its waiting on a person.
#[derive(Args, Clone, Debug, Default)]
pub(crate) struct WaitArgs {
    /// Stop waiting after this long, exiting 8; the turn goes on. Seconds, or with a unit:
    /// 500ms, 90s, 5m, 2h.
    #[arg(long, value_name = "DURATION", value_parser = parse_timeout)]
    pub(crate) timeout: Option<Duration>,

    /// Wait on while the turn waits on a person to answer it, rather than exiting 7.
    #[arg(long)]
    pub(crate) keep_waiting: bool,
}

impl WaitArgs {
    /// When to stop waiting, from now.
    pub(crate) fn deadline(&self) -> Option<Instant> {
        self.timeout.map(|timeout| Instant::now() + timeout)
    }
}

/// Which turn to wait for.
pub(crate) enum Pick {
    /// The turn by this id, whenever it starts, or started.
    Turn(TurnId),
    /// The first turn to start after this position in the journal.
    After(u64),
}

/// What of the thread's journal to print.
pub(crate) enum Print {
    /// Everything after this position.
    After(u64),
    /// The turn's own events, from its start to its end.
    Turn,
}

/// Why waiting stopped.
#[derive(Debug)]
pub(crate) enum Outcome {
    /// The turn ended: how, as the agent answered its prompt, or why it failed.
    Ended {
        response: Option<PromptResponse>,
        error: Option<agent_client_protocol::Error>,
    },
    /// A person must answer something in it: what.
    Waiting(String),
    /// The deadline passed first.
    TimedOut,
    /// The thread closed, for this reason.
    Closed(String),
    /// Its prompt was taken out of the queue before it started.
    Removed,
}

/// Following a thread for one of its turns.
pub(crate) struct Follower {
    session_id: SessionId,
    pick: Pick,
    print: Print,
    /// Stop when the turn ends, or waits on a person.
    until_ends: bool,
    /// Wait on while the turn waits on a person.
    keep_waiting: bool,
    /// The journal's head when this attached: events up to it are the journal so far.
    head: u64,
    caught_up: bool,
    /// The turn, once known.
    turn: Option<TurnId>,
    /// Its start has been seen.
    started: bool,
    /// Its start has been seen, and its end not yet.
    in_turn: bool,
    /// Requests waiting on a person, and what each asks.
    asks: BTreeMap<PendingId, String>,
}

impl Follower {
    /// Following the thread that `state` describes, as this client attached to it.
    pub(crate) fn new(state: &SessionState, pick: Pick, print: Print) -> Self {
        let turn = match &pick {
            Pick::Turn(turn) => Some(turn.clone()),
            Pick::After(_) => None,
        };
        let head = state.journal.head;
        Self {
            session_id: state.session_id.clone(),
            pick,
            print,
            until_ends: false,
            keep_waiting: false,
            head,
            caught_up: head == 0,
            turn,
            started: false,
            in_turn: false,
            asks: state
                .pending
                .iter()
                .filter_map(|pending| Some((pending.id.clone(), asks(pending)?)))
                .collect(),
        }
    }

    /// Stop once the turn ends, or waits on a person unless `keep_waiting`.
    pub(crate) fn until_ends(mut self, keep_waiting: bool) -> Self {
        self.until_ends = true;
        self.keep_waiting = keep_waiting;
        self
    }

    /// The turn, once known.
    pub(crate) fn turn(&self) -> Option<&TurnId> {
        self.turn.as_ref()
    }

    /// Handle what the Host sent until waiting stops, or with no deadline and not waiting for
    /// the turn's end, until the thread closes.
    pub(crate) async fn follow(
        &mut self,
        events: &mut UnboundedReceiver<HostEvent>,
        out: &mut Output,
        deadline: Option<Instant>,
    ) -> anyhow::Result<Outcome> {
        loop {
            let event = tokio::select! {
                event = events.recv() => event,
                () = sleep_until(deadline) => return Ok(Outcome::TimedOut),
            };
            if let Some(outcome) = self.handle(event, out)? {
                return Ok(outcome);
            }
        }
    }

    /// Handle one thing the Host sent: why waiting stops, if it does.
    pub(crate) fn handle(
        &mut self,
        event: Option<HostEvent>,
        out: &mut Output,
    ) -> anyhow::Result<Option<Outcome>> {
        match event {
            Some(HostEvent::Event(notification)) if notification.session_id == self.session_id => {
                let seq = notification.seq;
                let starts = self.starts(&notification.event, seq);
                let printed = match self.print {
                    Print::After(after) => seq > after,
                    Print::Turn => self.in_turn || starts,
                };
                if printed {
                    out.event(&self.session_id, &notification)?;
                }
                if seq >= self.head {
                    self.caught_up = true;
                }
                match notification.event {
                    SessionEvent::TurnStarted { .. } if starts => {
                        self.started = true;
                        self.in_turn = true;
                    }
                    SessionEvent::TurnEnded {
                        session_id,
                        response,
                        error,
                    } if session_id == self.session_id && self.in_turn => {
                        self.in_turn = false;
                        if self.until_ends {
                            return Ok(Some(Outcome::Ended { response, error }));
                        }
                    }
                    SessionEvent::Unqueued { queued_id, .. }
                        if !self.started && self.turn.as_ref() == Some(&queued_id) =>
                    {
                        return Ok(Some(Outcome::Removed));
                    }
                    SessionEvent::Closed { reason } => return Ok(Some(Outcome::Closed(reason))),
                    _ => {}
                }
                Ok(self.waiting())
            }
            Some(HostEvent::PendingAdded(added)) if added.session_id == self.session_id => {
                if let Some(what) = asks(&added.pending) {
                    if (!self.until_ends || self.keep_waiting) && !out.is_json() {
                        eprintln!("weave: the thread is waiting on a person: it {what}");
                    }
                    self.asks.insert(added.pending.id.clone(), what);
                }
                Ok(self.waiting())
            }
            Some(HostEvent::PendingResolved(resolved))
                if resolved.session_id == self.session_id =>
            {
                self.asks.remove(&resolved.pending_id);
                Ok(None)
            }
            Some(HostEvent::Disconnected(Some(error))) => {
                Err(exit::unreachable(anyhow!("lost the weave Host: {error}")))
            }
            Some(HostEvent::Disconnected(None)) | None => {
                Err(exit::unreachable(anyhow!("lost the weave Host")))
            }
            Some(_) => Ok(None),
        }
    }

    /// Whether `event`, at `seq`, starts the turn waited for: its own id's, or the first after
    /// the position.
    fn starts(&mut self, event: &SessionEvent, seq: u64) -> bool {
        let SessionEvent::TurnStarted {
            session_id,
            turn_id,
            queued_id,
            ..
        } = event
        else {
            return false;
        };
        if *session_id != self.session_id || self.started {
            return false;
        }
        let id = turn_id.as_ref().or(queued_id.as_ref());
        match &self.pick {
            Pick::Turn(wanted) => id == Some(wanted),
            Pick::After(after) if seq > *after => {
                self.turn = id.cloned();
                true
            }
            Pick::After(_) => false,
        }
    }

    /// Stop waiting, when the turn waits on a person and waiting through that wasn't asked.
    fn waiting(&self) -> Option<Outcome> {
        if !self.until_ends || self.keep_waiting || !self.caught_up || !self.in_turn {
            return None;
        }
        let what = self.asks.values().next()?;
        Some(Outcome::Waiting(what.clone()))
    }
}

/// What a person must answer in `pending`; nothing for a client tool call, which a client
/// answers.
fn asks(pending: &PendingRequest) -> Option<String> {
    match &pending.request {
        PendingKind::Permission { request } => Some(match &request.tool_call.fields.title {
            Some(title) => format!("asks permission for “{title}”"),
            None => "asks permission for a tool call".to_owned(),
        }),
        PendingKind::Elicitation { request } => Some(format!("asks: “{}”", request.message)),
        PendingKind::ClientTool { .. } => None,
    }
}

pub(crate) async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

/// The status `outcome` exits with, saying on stderr why when the turn didn't simply end and
/// how to wait for it again when it goes on. `closed_ok`: a thread closing while nothing waited
/// for a turn's end is how following it ends.
pub(crate) fn report(
    outcome: Outcome,
    session_id: &SessionId,
    turn: Option<&TurnId>,
    json: bool,
    closed_ok: bool,
) -> anyhow::Result<Status> {
    let again = match turn {
        Some(turn) => format!("weave threads follow {session_id} --turn {turn}"),
        None => format!("weave threads follow {session_id} --until-turn-ends"),
    };
    Ok(match outcome {
        Outcome::Ended {
            response: Some(response),
            ..
        } => {
            let status = Status::of_stop(response.stop_reason);
            if status != Status::Success && !json {
                eprintln!(
                    "weave: the turn stopped: {}",
                    describe_stop(response.stop_reason)
                );
            }
            status
        }
        Outcome::Ended {
            response: None,
            error,
        } => {
            match error {
                Some(error) => eprintln!("weave: the turn failed: {error}"),
                None => eprintln!("weave: the turn ended unexplained"),
            }
            Status::TurnFailed
        }
        Outcome::Waiting(what) => {
            eprintln!(
                "weave: thread {session_id} is waiting on a person: it {what}. Answer it with \
                 `weave --resume {session_id}` or in the app; `{again}` waits on."
            );
            Status::Waiting
        }
        Outcome::TimedOut => {
            eprintln!("weave: stopped waiting; the turn goes on, and `{again}` waits on.");
            Status::TimedOut
        }
        Outcome::Closed(reason) => {
            eprintln!("weave: the thread closed: {reason}");
            if closed_ok {
                Status::Success
            } else {
                Status::TurnFailed
            }
        }
        Outcome::Removed => {
            return Err(anyhow!(
                "the prompt was taken out of {session_id}'s queue before its turn started"
            ));
        }
    })
}

/// A `--timeout`: a number of seconds, or with a unit, `500ms`, `90s`, `5m` or `2h`.
pub(crate) fn parse_timeout(text: &str) -> Result<Duration, String> {
    let text = text.trim();
    let split = text
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(text.len());
    let (number, unit) = text.split_at(split);
    let number: f64 = number
        .parse()
        .map_err(|_| format!("{text:?} isn't a duration, such as 90s, 5m or 2h"))?;
    let seconds = match unit.trim() {
        "ms" => number / 1000.0,
        "" | "s" => number,
        "m" => number * 60.0,
        "h" => number * 3600.0,
        other => return Err(format!("{other:?} isn't a unit: use ms, s, m or h")),
    };
    Duration::try_from_secs_f64(seconds).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn a_timeout_is_seconds_or_has_a_unit() {
        assert_eq!(parse_timeout("90"), Ok(Duration::from_secs(90)));
        assert_eq!(parse_timeout("90s"), Ok(Duration::from_secs(90)));
        assert_eq!(parse_timeout("1.5s"), Ok(Duration::from_millis(1500)));
        assert_eq!(parse_timeout("500ms"), Ok(Duration::from_millis(500)));
        assert_eq!(parse_timeout("5m"), Ok(Duration::from_secs(300)));
        assert_eq!(parse_timeout("2h"), Ok(Duration::from_secs(7200)));
        assert!(parse_timeout("soon").is_err());
        assert!(parse_timeout("5d").is_err());
    }
}
