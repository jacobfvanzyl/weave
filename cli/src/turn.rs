//! Waiting for one turn of a thread, for `weave threads follow`, `threads prompt --wait` and
//! `weave run` (WVE-108): which turn it is, what of the thread's journal to print meanwhile, and
//! when to stop: when the turn ends, when it waits on a person (unless asked to wait through
//! that), or at a deadline. The turn goes on whenever this stops waiting before its end.
//!
//! A shared Host that goes away, as one that crashes or is stopped does, is waited for, and the
//! thread followed again from the last event seen once it's back (WVE-168). A turn the Host
//! stopped under that the thread continues is followed into its successor, the continuation, as
//! one turn: it ends as that ends.

use std::collections::BTreeMap;
use std::io::Write;
use std::time::Duration;

use anyhow::Context;
use anyhow::anyhow;
use clap::Args;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::time::Instant;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::PromptResponse;
use weave_acp_core::schema::SessionUpdate;
use weave_acp_core::schema::StopReason;
use weave_host::DaemonPaths;
use weave_host_client::HostConnection;
use weave_host_client::HostEvent;
use weave_host_protocol::errors;
use weave_host_protocol::events::ThreadEvent;
use weave_host_protocol::events::ThreadEventNotification;
use weave_host_protocol::pending::PendingId;
use weave_host_protocol::pending::PendingKind;
use weave_host_protocol::pending::PendingRequest;
use weave_host_protocol::threads::AttachThreadRequest;
use weave_host_protocol::threads::GetThreadRequest;
use weave_host_protocol::threads::JournalPosition;
use weave_host_protocol::threads::ThreadId;
use weave_host_protocol::threads::ThreadState;
use weave_host_protocol::turns::TurnId;

use crate::exit;
use crate::exit::Status;
use crate::host::control_with_events;

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
    /// The Host went away, and this can't reach it again; why, if it said.
    Lost(Option<String>),
    /// The thread's work goes on in this one, its successor, which following moves on to
    /// unless it waits for a turn's end.
    Succeeded(ThreadId),
}

/// How long a Host that went away has to come back, and to take the thread up again.
const RECONNECT_WINDOW: Duration = Duration::from_secs(60);
const RECONNECT_INTERVAL: Duration = Duration::from_millis(250);

/// The connection a follower reads the Host by, and how to reach the Host again when it goes.
pub(crate) struct Link {
    pub(crate) connection: HostConnection,
    pub(crate) events: UnboundedReceiver<HostEvent>,
    /// The shared Host's; none for a Host in this process, which ends with it.
    paths: Option<DaemonPaths>,
}

impl Link {
    pub(crate) fn new(
        connection: HostConnection,
        events: UnboundedReceiver<HostEvent>,
        paths: Option<DaemonPaths>,
    ) -> Self {
        Self {
            connection,
            events,
            paths,
        }
    }

    /// Reach the Host again, waiting for it to come back until `until`.
    async fn reconnect(&mut self, until: Instant) -> anyhow::Result<()> {
        let paths = self
            .paths
            .clone()
            .ok_or_else(|| exit::unreachable(anyhow!("lost the weave Host")))?;
        loop {
            match control_with_events(&paths).await {
                Ok(Some((connection, events))) => {
                    let old = std::mem::replace(&mut self.connection, connection);
                    old.shutdown().await;
                    self.events = events;
                    return Ok(());
                }
                Ok(None) | Err(_) if Instant::now() < until => {
                    tokio::time::sleep(RECONNECT_INTERVAL).await;
                }
                Ok(None) => {
                    return Err(exit::unreachable(anyhow!(
                        "lost the weave Host, which didn't come back"
                    )));
                }
                Err(error) => return Err(error.context("lost the weave Host")),
            }
        }
    }
}

/// Following a thread for one of its turns.
pub(crate) struct Follower {
    thread_id: ThreadId,
    pick: Pick,
    print: Print,
    /// Stop when the turn ends, or waits on a person.
    until_ends: bool,
    /// Wait on while the turn waits on a person.
    keep_waiting: bool,
    /// The journal's head when this attached: events up to it are the journal so far.
    head: u64,
    caught_up: bool,
    /// The last event seen, to follow on from after the Host comes back.
    position: JournalPosition,
    /// The turn ended interrupted, as this saw: a continuation may follow it.
    interrupted: Option<agent_client_protocol::Error>,
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
    pub(crate) fn new(state: &ThreadState, pick: Pick, print: Print) -> Self {
        let turn = match &pick {
            Pick::Turn(turn) => Some(turn.clone()),
            Pick::After(_) => None,
        };
        let head = state.journal.head;
        Self {
            thread_id: state.thread_id.clone(),
            pick,
            print,
            until_ends: false,
            keep_waiting: false,
            head,
            caught_up: head == 0,
            position: JournalPosition {
                journal: state.journal.id.clone(),
                seq: 0,
            },
            interrupted: None,
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
    /// the turn's end, until the thread closes; through the Host going away and coming back.
    pub(crate) async fn follow(
        &mut self,
        link: &mut Link,
        out: &mut Output,
        deadline: Option<Instant>,
    ) -> anyhow::Result<Outcome> {
        loop {
            let event = tokio::select! {
                event = link.events.recv() => event,
                () = sleep_until(deadline) => return Ok(Outcome::TimedOut),
            };
            match self.handle(event, out)? {
                Some(Outcome::Lost(_)) => {
                    if let Some(outcome) = self.reattach(link, out, deadline).await? {
                        return Ok(outcome);
                    }
                }
                Some(outcome) => return Ok(outcome),
                None => {}
            }
        }
    }

    /// After the Host went away: wait for it to come back, then follow the thread again from
    /// the last event seen. A thread the Host hasn't taken up again is read instead, for the
    /// turn's end, or its continuation's: why waiting stops, if it does.
    pub(crate) async fn reattach(
        &mut self,
        link: &mut Link,
        out: &mut Output,
        deadline: Option<Instant>,
    ) -> anyhow::Result<Option<Outcome>> {
        eprintln!("weave: lost the weave Host; waiting for it to come back");
        let window = Instant::now() + RECONNECT_WINDOW;
        let until = deadline.map_or(window, |deadline| deadline.min(window));
        link.reconnect(until).await?;
        loop {
            let attached = link
                .connection
                .send(AttachThreadRequest {
                    thread_id: self.thread_id.clone(),
                    after: Some(self.position.clone()),
                    agent_id: None,
                    cwd: None,
                    trace: false,
                    observe: true,
                })
                .await;
            match attached {
                Ok(attached) => {
                    self.reattached(&attached.state);
                    return Ok(None);
                }
                Err(error) if errors::is(&error, errors::THREAD_NOT_OPEN) => {
                    if let Some(outcome) = self.read_over(&link.connection, out).await? {
                        return Ok(Some(outcome));
                    }
                    if Instant::now() >= until {
                        return Ok(Some(match deadline {
                            Some(deadline) if deadline <= Instant::now() => Outcome::TimedOut,
                            _ => Outcome::Lost(Some(
                                "the weave Host came back, but hasn't taken the thread up again"
                                    .to_owned(),
                            )),
                        }));
                    }
                    tokio::time::sleep(RECONNECT_INTERVAL).await;
                }
                Err(error) => {
                    return Err(anyhow::Error::from(error).context("following the thread"));
                }
            }
        }
    }

    /// The turn's end, read without attaching, once it and any continuations are over.
    async fn read_over(
        &mut self,
        connection: &HostConnection,
        out: &Output,
    ) -> anyhow::Result<Option<Outcome>> {
        if !self.until_ends {
            return Ok(None);
        }
        let Some(mut turn) = self.turn.clone() else {
            return Ok(None);
        };
        loop {
            let got = connection
                .send(GetThreadRequest {
                    thread_id: self.thread_id.clone(),
                    turn_id: Some(turn.clone()),
                })
                .await
                .context("reading the thread")?;
            let Some(latest) = got.latest_turn.filter(|latest| latest.state.is_over()) else {
                return Ok(None);
            };
            match latest.continued_in {
                Some(next) => {
                    continued(&turn, &next, out);
                    self.turn = Some(next.clone());
                    self.pick = Pick::Turn(next.clone());
                    turn = next;
                }
                None => {
                    if let Some(message) = latest.message.filter(|_| !out.is_json()) {
                        println!("{message}");
                    }
                    return Ok(Some(Outcome::Ended {
                        response: latest.response,
                        error: latest.error,
                    }));
                }
            }
        }
    }

    /// Following the thread again, as `state` describes it, after the last event seen.
    fn reattached(&mut self, state: &ThreadState) {
        self.head = state.journal.head;
        self.caught_up = self.head <= self.position.seq;
        if state.journal.id != self.position.journal {
            self.position = JournalPosition {
                journal: state.journal.id.clone(),
                seq: 0,
            };
        }
        self.asks = state
            .pending
            .iter()
            .filter_map(|pending| Some((pending.id.clone(), asks(pending)?)))
            .collect();
    }

    /// Handle one thing the Host sent: why waiting stops, if it does.
    pub(crate) fn handle(
        &mut self,
        event: Option<HostEvent>,
        out: &mut Output,
    ) -> anyhow::Result<Option<Outcome>> {
        match event {
            Some(HostEvent::Event(notification)) if notification.thread_id == self.thread_id => {
                let seq = notification.seq;
                self.position.seq = seq;
                if let Some(outcome) = self.continues(&notification.event, seq, out) {
                    return Ok(Some(outcome));
                }
                let starts = self.starts(&notification.event, seq);
                let printed = match self.print {
                    Print::After(after) => seq > after,
                    Print::Turn => self.in_turn || starts,
                };
                if printed {
                    out.event(&self.thread_id, &notification)?;
                }
                if seq >= self.head {
                    self.caught_up = true;
                }
                match notification.event {
                    ThreadEvent::TurnStarted { .. } if starts => {
                        self.started = true;
                        self.in_turn = true;
                    }
                    ThreadEvent::TurnEnded {
                        thread_id,
                        response,
                        error,
                    } if thread_id == self.thread_id && self.in_turn => {
                        self.in_turn = false;
                        // A continuation starts with an interrupted turn's end, journaled
                        // before anyone could attach: one comes next if any does.
                        match error {
                            Some(error)
                                if self.until_ends
                                    && errors::is(&error, errors::INTERRUPTED)
                                    && seq < self.head =>
                            {
                                self.interrupted = Some(error);
                            }
                            error if self.until_ends => {
                                return Ok(Some(Outcome::Ended { response, error }));
                            }
                            _ => {}
                        }
                    }
                    ThreadEvent::Unqueued { queued_id, .. }
                        if !self.started && self.turn.as_ref() == Some(&queued_id) =>
                    {
                        return Ok(Some(Outcome::Removed));
                    }
                    ThreadEvent::ContinuedIn { successor, .. } if !self.until_ends => {
                        return Ok(Some(Outcome::Succeeded(successor)));
                    }
                    ThreadEvent::Closed { reason, .. } => {
                        return Ok(Some(Outcome::Closed(reason)));
                    }
                    _ => {}
                }
                Ok(self.waiting())
            }
            Some(HostEvent::PendingAdded(added)) if added.thread_id == self.thread_id => {
                if let Some(what) = asks(&added.pending) {
                    if (!self.until_ends || self.keep_waiting) && !out.is_json() {
                        eprintln!("weave: the thread is waiting on a person: it {what}");
                    }
                    self.asks.insert(added.pending.id.clone(), what);
                }
                Ok(self.waiting())
            }
            Some(HostEvent::PendingResolved(resolved)) if resolved.thread_id == self.thread_id => {
                self.asks.remove(&resolved.pending_id);
                Ok(None)
            }
            Some(HostEvent::Disconnected(error)) => {
                Ok(Some(Outcome::Lost(error.map(|error| error.to_string()))))
            }
            None => Ok(Some(Outcome::Lost(None))),
            Some(_) => Ok(None),
        }
    }

    /// After the turn waited for ended interrupted: follow `event`, at `seq`, into its
    /// continuation, or stop when another turn of the thread's starts first, it closes, or the
    /// journal as it was on attaching holds no continuation.
    fn continues(&mut self, event: &ThreadEvent, seq: u64, out: &Output) -> Option<Outcome> {
        let error = self.interrupted.take()?;
        let ended = || {
            Some(Outcome::Ended {
                response: None,
                error: Some(error.clone()),
            })
        };
        match event {
            ThreadEvent::TurnStarted {
                thread_id,
                turn_id: Some(next),
                continues: Some(continues),
                ..
            } if *thread_id == self.thread_id && self.turn.as_ref() == Some(continues) => {
                if let Some(turn) = &self.turn {
                    continued(turn, next, out);
                }
                self.turn = Some(next.clone());
                self.pick = Pick::Turn(next.clone());
                self.in_turn = true;
                None
            }
            ThreadEvent::TurnStarted { thread_id, .. } if *thread_id == self.thread_id => ended(),
            ThreadEvent::Closed { .. } => ended(),
            _ if seq >= self.head => ended(),
            _ => {
                self.interrupted = Some(error);
                None
            }
        }
    }

    /// Whether `event`, at `seq`, starts the turn waited for: its own id's, or the first after
    /// the position.
    fn starts(&mut self, event: &ThreadEvent, seq: u64) -> bool {
        let ThreadEvent::TurnStarted {
            thread_id,
            turn_id,
            queued_id,
            ..
        } = event
        else {
            return false;
        };
        if *thread_id != self.thread_id || self.started {
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

/// Say that `turn` was cut off and goes on in `next`.
fn continued(turn: &TurnId, next: &TurnId, out: &Output) {
    if !out.is_json() {
        eprintln!(
            "weave: the weave Host stopped while turn {turn} ran; the thread continued it in turn \
             {next}"
        );
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
    thread_id: &ThreadId,
    turn: Option<&TurnId>,
    json: bool,
    closed_ok: bool,
) -> anyhow::Result<Status> {
    let again = match turn {
        Some(turn) => format!("weave threads follow {thread_id} --turn {turn}"),
        None => format!("weave threads follow {thread_id} --until-turn-ends"),
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
                "weave: thread {thread_id} is waiting on a person: it {what}. Answer it with \
                 `weave --resume {thread_id}` or in the app; `{again}` waits on."
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
                "the prompt was taken out of {thread_id}'s queue before its turn started"
            ));
        }
        Outcome::Succeeded(_) => Status::Success,
        Outcome::Lost(why) => {
            let lost = match why {
                Some(why) => anyhow!("lost the weave Host: {why}"),
                None => anyhow!("lost the weave Host"),
            };
            return Err(exit::unreachable(lost));
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

pub(crate) fn describe_stop(reason: StopReason) -> &'static str {
    match reason {
        StopReason::Cancelled => "cancelled",
        StopReason::MaxTokens => "the agent reached its token limit",
        StopReason::MaxTurnRequests => "too many model requests",
        StopReason::Refusal => "the agent refused",
        _ => "for an unrecognized reason",
    }
}

/// The reply as it streams: text to stdout, tool calls noted on stderr; or every journal event
/// as a JSON line. `weave threads follow` prints a thread it follows the same way.
pub(crate) struct Output {
    json: bool,
    /// Whether the last thing written to stdout ended its line.
    at_line_start: bool,
}

impl Output {
    pub(crate) fn new(json: bool) -> Self {
        Self {
            json,
            at_line_start: true,
        }
    }

    pub(crate) fn event(
        &mut self,
        thread_id: &ThreadId,
        notification: &ThreadEventNotification,
    ) -> anyhow::Result<()> {
        if self.json {
            let mut stdout = std::io::stdout().lock();
            writeln!(stdout, "{}", serde_json::to_string(notification)?)?;
            return Ok(stdout.flush()?);
        }
        match &notification.event {
            ThreadEvent::Update { notification } if notification.session_id == *thread_id => {
                self.update(&notification.update)
            }
            ThreadEvent::Notice { text } => {
                self.break_line()?;
                eprintln!("weave: {text}");
                Ok(())
            }
            _ => Ok(()),
        }
    }

    fn update(&mut self, update: &SessionUpdate) -> anyhow::Result<()> {
        let mut stdout = std::io::stdout().lock();
        match update {
            SessionUpdate::AgentMessageChunk(chunk) => {
                if let ContentBlock::Text(text) = &chunk.content {
                    write!(stdout, "{}", text.text)?;
                    self.at_line_start = text.text.ends_with('\n');
                }
            }
            SessionUpdate::ToolCall(call) => {
                eprintln!("• {}", call.title);
            }
            _ => {}
        }
        Ok(stdout.flush()?)
    }

    /// End the reply's line, so what goes to stderr starts on one of its own.
    fn break_line(&mut self) -> anyhow::Result<()> {
        if !self.at_line_start {
            println!();
            self.at_line_start = true;
        }
        Ok(std::io::stdout().flush()?)
    }

    pub(crate) fn is_json(&self) -> bool {
        self.json
    }

    pub(crate) fn finish(&mut self) -> anyhow::Result<()> {
        if !self.json && !self.at_line_start {
            println!();
        }
        Ok(())
    }
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
