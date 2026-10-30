//! Host tools (ADR 0020): what the Host answers itself for the session whose agent calls a tool
//! on the Host MCP server. Each is a Host protocol method seen from inside the session, answered
//! by the same code as the client request; its answer is the method's, as JSON text, or a tool
//! error saying why the method failed.
//!
//! An agent reads and acts on any session on its Host (ADR 0023). Some tools start delegated
//! sessions: sessions of their own that the calling session starts, which approve nothing the
//! calling session's policy doesn't; `[delegation]` caps how deep sessions start sessions and
//! how many of one session's run at once. When a turn the calling session's agent began ends,
//! or waits on a person, the Host reports it to the calling session ([`tell`]): into its running
//! turn, or else through its queue.

use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::Error;
use serde::Deserialize;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::StopReason;
use weave_acp_core::schema::ToolKind;
use weave_host_protocol::agents::ListAgentsRequest;
use weave_host_protocol::policy::PermissionPolicy;
use weave_host_protocol::policy::Unapproved;
use weave_host_protocol::queue::AddQueuedRequest;
use weave_host_protocol::sessions::Activity;
use weave_host_protocol::sessions::GetSessionRequest;
use weave_host_protocol::sessions::LatestTurn;
use weave_host_protocol::sessions::ListSessionsRequest;
use weave_host_protocol::sessions::RunRequest;
use weave_host_protocol::sessions::RunResponse;
use weave_host_protocol::sessions::SessionListing;
use weave_host_protocol::sessions::TurnOrigin;
use weave_host_protocol::tools::CANCEL_SESSION_TURN;
use weave_host_protocol::tools::ClientToolResult;
use weave_host_protocol::tools::LIST_AGENTS;
use weave_host_protocol::tools::LIST_SESSIONS;
use weave_host_protocol::tools::PROMPT_SESSION;
use weave_host_protocol::tools::READ_SESSION;
use weave_host_protocol::tools::RENAME_SESSION;
use weave_host_protocol::tools::START_SESSION;
use weave_host_protocol::tools::STEER_SESSION;
use weave_host_protocol::turns::CancelTurnRequest;
use weave_host_protocol::turns::SteerOutcome;
use weave_host_protocol::turns::SteerTurnRequest;
use weave_host_protocol::turns::TurnId;

use crate::Shared;
use crate::client;
use crate::session::Command;
use crate::session::SessionHandle;

/// How far up a chain of starting sessions the Host looks, should one ever loop.
const MAX_CHAIN: usize = 64;
/// How much of a delegated agent's last message its starting session is told.
const MESSAGE_CHARS: usize = 2_000;

/// The answer to `tool` for the session `caller`, called with `arguments`.
pub(crate) async fn call(
    shared: &Arc<Shared>,
    caller: &SessionHandle,
    tool: &str,
    arguments: &Map<String, Value>,
) -> ClientToolResult {
    let answered = match tool {
        RENAME_SESSION => rename(caller, arguments).await,
        LIST_SESSIONS => match parse::<ListSessionsRequest>(arguments) {
            Ok(request) => answer(client::list_sessions(shared, request).await),
            Err(why) => Err(why),
        },
        LIST_AGENTS => answer(client::list_agents(shared, ListAgentsRequest::default()).await),
        READ_SESSION => match parse::<GetSessionRequest>(arguments) {
            Ok(request) => answer(client::get_session(shared, request).await),
            Err(why) => Err(why),
        },
        START_SESSION => start(shared, caller, arguments).await,
        PROMPT_SESSION => prompt(shared, caller, arguments).await,
        STEER_SESSION => steer(shared, caller, arguments).await,
        CANCEL_SESSION_TURN => cancel(shared, arguments),
        _ => Err(format!("The Host doesn't answer {tool}.")),
    };
    match answered {
        Ok(text) => ClientToolResult::text(text),
        Err(why) => ClientToolResult::error(why),
    }
}

/// `rename_session`: `session/rename` for the calling session.
async fn rename(caller: &SessionHandle, arguments: &Map<String, Value>) -> Result<String, String> {
    let asked = arguments
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let title = crate::session::title(asked).map_err(|why| format!("Not renamed: {why}."))?;
    caller
        .finish(|done| Command::Rename {
            title: title.clone(),
            by: None,
            done,
        })
        .await
        .map_err(|_| "The thread has ended.".to_owned())?;
    Ok(format!("Renamed this thread to “{title}”."))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartArguments {
    agent_id: String,
    prompt: String,
    cwd: Option<PathBuf>,
    session_id: Option<SessionId>,
    approve: Option<Vec<ToolKind>>,
    otherwise: Option<Unapproved>,
    key: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Started {
    session_id: SessionId,
    /// The turn it started, for read_session.
    #[serde(skip_serializing_if = "Option::is_none")]
    turn_id: Option<TurnId>,
    /// The policy the session runs under, within the calling session's.
    policy: PermissionPolicy,
}

/// `start_session`: `session/run`, for a new delegated session of the caller's or for any
/// session again.
async fn start(
    shared: &Arc<Shared>,
    caller: &SessionHandle,
    arguments: &Map<String, Value>,
) -> Result<String, String> {
    let arguments: StartArguments = parse(arguments)?;
    let me = caller.summary();
    let limits = shared
        .load_config()
        .map_err(|error| why(&error))?
        .delegation;
    match &arguments.session_id {
        Some(target) => {
            if one_more(shared, &me.session_id, target) {
                room(shared, &me.session_id, limits.running())?;
            }
        }
        None => {
            let depth = depth(shared, &me.session_id);
            if depth >= limits.depth() {
                return Err(format!(
                    "This thread can't start threads: it is {depth} level{} below a thread a \
                     person started, and the Host allows {} (`[delegation] depth`).",
                    if depth == 1 { "" } else { "s" },
                    limits.depth()
                ));
            }
            room(shared, &me.session_id, limits.running())?;
        }
    }
    let asked = PermissionPolicy {
        approve: arguments
            .approve
            .unwrap_or_else(|| me.policy.approve.clone()),
        otherwise: arguments.otherwise.unwrap_or(me.policy.otherwise),
    };
    let policy = asked.within(&me.policy);
    let request = RunRequest {
        agent_id: arguments.agent_id,
        cwd: arguments.cwd.unwrap_or_else(|| me.cwd.clone()),
        session_id: arguments.session_id,
        additional_directories: Vec::new(),
        prompt: vec![ContentBlock::from(arguments.prompt)],
        policy: policy.clone(),
        attach: false,
        trace: false,
        key: arguments.key,
    };
    let origin = TurnOrigin::Session {
        session_id: me.session_id.clone(),
        report: false,
    };
    let RunResponse {
        session_id,
        turn_id,
        ..
    } = client::run_as(shared, request, None, origin, Some(me.session_id.clone()))
        .await
        .map_err(|error| why(&error))?;
    // An open session it prompted again keeps its own policy.
    let policy = shared
        .registry()
        .live(&session_id)
        .map_or(policy, |session| session.summary().policy);
    to_text(&Started {
        session_id,
        turn_id,
        policy,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PromptArguments {
    session_id: SessionId,
    prompt: String,
    key: Option<String>,
}

/// `prompt_session`: `queue/add`.
async fn prompt(
    shared: &Arc<Shared>,
    caller: &SessionHandle,
    arguments: &Map<String, Value>,
) -> Result<String, String> {
    let arguments: PromptArguments = parse(arguments)?;
    let me = caller.summary().session_id;
    if one_more(shared, &me, &arguments.session_id) {
        let limits = shared
            .load_config()
            .map_err(|error| why(&error))?
            .delegation;
        room(shared, &me, limits.running())?;
    }
    let request = AddQueuedRequest {
        session_id: arguments.session_id,
        prompt: vec![ContentBlock::from(arguments.prompt)],
        key: arguments.key,
    };
    let origin = TurnOrigin::Session {
        session_id: me,
        report: false,
    };
    answer(client::add_queued(shared, request, origin).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SteerArguments {
    session_id: SessionId,
    prompt: String,
}

/// `steer_session`: `turn/steer`.
async fn steer(
    shared: &Arc<Shared>,
    caller: &SessionHandle,
    arguments: &Map<String, Value>,
) -> Result<String, String> {
    let arguments: SteerArguments = parse(arguments)?;
    let request = SteerTurnRequest {
        session_id: arguments.session_id,
        prompt: vec![ContentBlock::from(arguments.prompt)],
    };
    let origin = TurnOrigin::Session {
        session_id: caller.summary().session_id,
        report: false,
    };
    answer(client::steer_turn(shared, request, origin).await)
}

/// `cancel_session_turn`: `turn/cancel`.
fn cancel(shared: &Arc<Shared>, arguments: &Map<String, Value>) -> Result<String, String> {
    let request: CancelTurnRequest = parse(arguments)?;
    answer(client::cancel_turn(shared, request))
}

/// The session that started `session_id`, or the one it belongs to as a subagent.
fn starter(shared: &Shared, session_id: &SessionId) -> Option<SessionId> {
    let registry = shared.registry();
    let root = registry.root(session_id);
    match registry.sessions.get(&root) {
        Some(session) => session.summary().started_by,
        None => registry.known.get(&root)?.started_by.clone(),
    }
}

/// How many levels below a session a person started `session_id` is.
fn depth(shared: &Shared, session_id: &SessionId) -> u32 {
    let mut current = session_id.clone();
    let mut depth = 0;
    while let Some(parent) = starter(shared, &current) {
        depth += 1;
        if depth as usize >= MAX_CHAIN {
            break;
        }
        current = parent;
    }
    depth
}

/// Whether `session_id` is open and running a turn or waiting on a request.
fn is_busy(shared: &Shared, session_id: &SessionId) -> bool {
    shared
        .registry()
        .live(session_id)
        .is_some_and(|session| session.summary().activity != Activity::Idle)
}

/// Whether a turn in `target` would have one more of `caller`'s delegated sessions running than
/// now: `target` is one `caller` started, and it is idle.
fn one_more(shared: &Shared, caller: &SessionId, target: &SessionId) -> bool {
    starter(shared, target).as_ref() == Some(caller) && !is_busy(shared, target)
}

/// Whether `caller` may have one more delegated session running than now.
fn room(shared: &Shared, caller: &SessionId, running: u32) -> Result<(), String> {
    let busy = shared
        .registry()
        .sessions
        .values()
        .map(SessionHandle::summary)
        .filter(|summary| {
            summary.started_by.as_ref() == Some(caller) && summary.activity != Activity::Idle
        })
        .count();
    if busy < usize::try_from(running).unwrap_or(usize::MAX) {
        return Ok(());
    }
    Err(format!(
        "This thread already has {busy} delegated thread{} running, as many as the Host \
         allows (`[delegation] running`). Wait to hear that one finished, or cancel one with \
         cancel_session_turn.",
        if busy == 1 { "" } else { "s" }
    ))
}

/// What a person must answer in a session another session's agent began a turn in.
pub(crate) enum Asks {
    /// Permission for a tool call, by its title when it has one.
    Permission(Option<String>),
    /// An elicitation, by its message.
    Elicitation(String),
}

/// A session as a report names it: its title, agent and id.
fn name(listing: &SessionListing) -> String {
    let id = &listing.info.session_id;
    match &listing.info.title {
        Some(title) => format!("“{title}” ({}, {id})", listing.agent_id),
        None => format!("{id} ({})", listing.agent_id),
    }
}

/// The report on a session to the session whose agent began a turn there, when the turn ends:
/// how, and the start of the agent's last message.
pub(crate) fn ended_text(listing: &SessionListing, latest: Option<&LatestTurn>) -> String {
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
    let mut text = format!("[weave] Thread {} {how}.", name(listing));
    if let Some(message) = latest.and_then(|turn| turn.message.as_deref()) {
        let shown: String = message.chars().take(MESSAGE_CHARS).collect();
        text.push_str(" Its agent's last message:\n\n");
        text.push_str(&shown);
        if shown.len() < message.len() {
            text.push_str("\n\n[…] read_session gives the rest.");
        }
    }
    text
}

/// The report on a session to the session whose agent began a turn there, when a person must
/// answer something in it.
pub(crate) fn waiting_text(listing: &SessionListing, asks: &Asks) -> String {
    let what = match asks {
        Asks::Permission(Some(title)) => format!("asks permission for “{title}”"),
        Asks::Permission(None) => "asks permission for a tool call".to_owned(),
        Asks::Elicitation(message) => format!("asks: “{message}”"),
    };
    format!(
        "[weave] Thread {} is waiting on a person: it {what}. Someone attached to it in a weave \
         client has to answer; you can't. Tell the person if they need to.",
        name(listing)
    )
}

/// Report on `about` to the session `caller`, whose agent began a turn there: into its running
/// turn if its agent takes steers, otherwise through its queue, which starts its next turn. A
/// caller that isn't open is taken up again for it. One that can't be is left untold, and
/// `about`'s journal says so.
pub(crate) async fn tell(shared: Arc<Shared>, caller: SessionId, about: SessionId, text: String) {
    let origin = TurnOrigin::Session {
        session_id: about.clone(),
        report: true,
    };
    let prompt = vec![ContentBlock::from(text)];
    let open = match open(&shared, &caller).await {
        Ok(()) => {
            let steered = client::steer_turn(
                &shared,
                SteerTurnRequest {
                    session_id: caller.clone(),
                    prompt: prompt.clone(),
                },
                origin.clone(),
            )
            .await;
            if matches!(&steered, Ok(answer) if answer.outcome == SteerOutcome::Steered) {
                return;
            }
            let request = AddQueuedRequest {
                session_id: caller.clone(),
                prompt,
                key: None,
            };
            client::add_queued(&shared, request, origin)
                .await
                .map(drop)
                .map_err(|error| why(&error))
        }
        Err(why) => Err(why),
    };
    if let Err(why) = open {
        tracing::warn!(%caller, %about, %why, "couldn't report on a session to its caller");
        if let Some(session) = shared.registry().live(&about) {
            let _ = session.send(Command::Notice {
                text: format!(
                    "Thread {caller}, whose agent began this turn, couldn't be told how it went: \
                     {why}"
                ),
            });
        }
    }
}

/// Make sure `session_id` is open, taking it up again under its own policy if it isn't.
async fn open(shared: &Arc<Shared>, session_id: &SessionId) -> Result<(), String> {
    if shared.registry().live(session_id).is_some() {
        return Ok(());
    }
    let recorded = shared
        .registry()
        .known
        .get(session_id)
        .cloned()
        .ok_or_else(|| "the Host has no record of it".to_owned())?;
    let agent_id = recorded
        .agent_id()
        .ok_or_else(|| "its journal names no agent".to_owned())?
        .to_owned();
    client::take_up(
        shared,
        &agent_id,
        recorded.cwd.clone(),
        session_id.clone(),
        recorded.policy.clone(),
    )
    .await
    .map(drop)
    .map_err(|error| why(&error))
}

/// A tool's arguments as the method's params.
fn parse<T: DeserializeOwned>(arguments: &Map<String, Value>) -> Result<T, String> {
    serde_json::from_value(Value::Object(arguments.clone()))
        .map_err(|error| format!("The arguments don't fit the tool: {error}."))
}

/// A method's answer as the tool's: its JSON, or why it failed.
fn answer<T: Serialize>(answered: Result<T, Error>) -> Result<String, String> {
    to_text(&answered.map_err(|error| why(&error))?)
}

/// `value` as JSON text, without the data of images and audio a prompt carried.
fn to_text(value: &impl Serialize) -> Result<String, String> {
    let mut value = serde_json::to_value(value).map_err(|error| error.to_string())?;
    strip_media(&mut value);
    serde_json::to_string_pretty(&value).map_err(|error| error.to_string())
}

fn strip_media(value: &mut Value) {
    match value {
        Value::Object(object) => {
            let media = matches!(
                object.get("type").and_then(Value::as_str),
                Some("image" | "audio")
            );
            if media && object.remove("data").is_some() {
                object.insert("data".to_owned(), json!("(left out)"));
            }
            object.values_mut().for_each(strip_media);
        }
        Value::Array(items) => items.iter_mut().for_each(strip_media),
        _ => {}
    }
}

/// Why `error` happened, as its message and the text of its data.
fn why(error: &Error) -> String {
    match error.data.as_ref() {
        Some(Value::String(data)) => format!("{}: {data}", error.message),
        Some(data) if !data.is_null() => format!("{}: {data}", error.message),
        _ => error.message.clone(),
    }
}
