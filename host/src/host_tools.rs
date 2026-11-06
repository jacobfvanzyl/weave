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
//!
//! Given `host`, a tool acts on another of the person's Hosts instead (ADR 0029, WVE-185): the
//! same method, its request worked out here, passed to the service that reaches the person's
//! Hosts, the Dispatcher, as a `service/hostCall` naming the calling session. The Dispatcher
//! sends it there, follows a turn it began, and reports on it with `session/report`, which
//! [`tell`] answers as for this Host's own sessions; this Host keeps no record of it.
//! `list_hosts` lists the Hosts the Dispatcher reaches. Reach is one hop: a turn another Host's
//! agent began here, and a session one started here or anything that session started, reaches
//! no other Host.

use std::path::Path;
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
use weave_acp_core::schema::ToolKind;
use weave_host_protocol::agents::ListAgentsRequest;
use weave_host_protocol::policy::PermissionPolicy;
use weave_host_protocol::policy::Unapproved;
use weave_host_protocol::queue::AddQueuedRequest;
use weave_host_protocol::reports::why;
use weave_host_protocol::sessions::Activity;
use weave_host_protocol::sessions::GetSessionRequest;
use weave_host_protocol::sessions::ListSessionsRequest;
use weave_host_protocol::sessions::RunRequest;
use weave_host_protocol::sessions::RunResponse;
use weave_host_protocol::sessions::TurnOrigin;
use weave_host_protocol::tools::CANCEL_SESSION_TURN;
use weave_host_protocol::tools::ClientToolResult;
use weave_host_protocol::tools::HostCall;
use weave_host_protocol::tools::LIST_AGENTS;
use weave_host_protocol::tools::LIST_HOSTS;
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
use crate::service_tools;
use crate::session::Command;
use crate::session::SessionHandle;
use crate::session::Summary;

/// How far up a chain of starting sessions the Host looks, should one ever loop.
const MAX_CHAIN: usize = 64;

/// The answer to `tool` for the session `caller`, called with `arguments`; none when the call
/// was cancelled first.
pub(crate) async fn call(
    shared: &Arc<Shared>,
    caller: &SessionHandle,
    tool: &str,
    arguments: &Map<String, Value>,
    cancelled: impl Future<Output = ()>,
) -> Option<ClientToolResult> {
    let mut arguments = arguments.clone();
    let answered = match arguments.remove("host") {
        None if tool == LIST_HOSTS => return hosts(shared, caller, cancelled).await,
        None => here(shared, caller, tool, &arguments).await,
        // This Host, by the id list_hosts gives it.
        Some(Value::String(host)) if host == shared.devices.host_id() => {
            here(shared, caller, tool, &arguments).await
        }
        Some(Value::String(host)) => {
            return elsewhere(shared, caller, tool, host, &arguments, cancelled).await;
        }
        Some(_) => Err("host is another Host's id or name, as a string.".to_owned()),
    };
    Some(match answered {
        Ok(text) => ClientToolResult::text(text),
        Err(why) => ClientToolResult::error(why),
    })
}

/// `tool`'s answer on this Host.
async fn here(
    shared: &Arc<Shared>,
    caller: &SessionHandle,
    tool: &str,
    arguments: &Map<String, Value>,
) -> Result<String, String> {
    match tool {
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
    }
}

/// `list_hosts`: the Hosts the service that reaches them lists, and this one's id.
async fn hosts(
    shared: &Arc<Shared>,
    caller: &SessionHandle,
    cancelled: impl Future<Output = ()>,
) -> Option<ClientToolResult> {
    let Some((service, name)) = shared.devices.hosts_service() else {
        return Some(ClientToolResult::error(no_dispatcher(shared)));
    };
    let me = service_tools::caller(&caller.summary());
    shared
        .service_tools
        .call_host(
            &service,
            &name,
            None,
            HostCall::ListHosts,
            me,
            None,
            cancelled,
        )
        .await
}

/// Why no call reaches another Host from this one.
fn no_dispatcher(shared: &Shared) -> String {
    format!(
        "No Dispatcher reaches the person's other Hosts from this Host ({}): the person pairs \
         one with each of their Hosts, with `weave hosts add`.",
        shared.devices.host_id()
    )
}

/// `tool` on another of the person's Hosts, `host`: its request worked out here, passed to the
/// service that reaches them.
async fn elsewhere(
    shared: &Arc<Shared>,
    caller: &SessionHandle,
    tool: &str,
    host: String,
    arguments: &Map<String, Value>,
    cancelled: impl Future<Output = ()>,
) -> Option<ClientToolResult> {
    let fail = |why: String| Some(ClientToolResult::error(why));
    if matches!(tool, RENAME_SESSION | LIST_HOSTS) {
        return fail(format!("{tool} acts on this Host, so it takes no host."));
    }
    let me = caller.summary();
    if let Some(from) = from_other_host(shared, &me) {
        return fail(format!(
            "This thread works for a thread on another Host ({from}), so it reaches no other \
             Host: a Host's agents reach the person's other Hosts only one hop away."
        ));
    }
    let (call, room) = match request(shared, &me, tool, &host, arguments) {
        Ok(asked) => asked,
        Err(why) => return fail(why),
    };
    let Some((service, name)) = shared.devices.hosts_service() else {
        return fail(no_dispatcher(shared));
    };
    let caller = service_tools::caller(&me);
    shared
        .service_tools
        .call_host(&service, &name, Some(host), call, caller, room, cancelled)
        .await
}

/// The request `tool` makes of another Host, `host`, for the session `me`, and, for one that
/// starts a delegated session, how many more of `me`'s may run on other Hosts.
fn request(
    shared: &Shared,
    me: &Summary,
    tool: &str,
    host: &str,
    arguments: &Map<String, Value>,
) -> Result<(HostCall, Option<u32>), String> {
    let call = match tool {
        LIST_SESSIONS => HostCall::ListSessions(parse(arguments)?),
        LIST_AGENTS => HostCall::ListAgents(ListAgentsRequest::default()),
        READ_SESSION => HostCall::GetSession(parse(arguments)?),
        STEER_SESSION => {
            let arguments: SteerArguments = parse(arguments)?;
            HostCall::Steer(SteerTurnRequest {
                session_id: arguments.session_id,
                prompt: vec![ContentBlock::from(arguments.prompt)],
                caller: None,
                origin: None,
            })
        }
        CANCEL_SESSION_TURN => HostCall::Cancel(parse::<CancelTurnRequest>(arguments)?),
        PROMPT_SESSION => {
            let arguments: PromptArguments = parse(arguments)?;
            HostCall::Queue(AddQueuedRequest {
                session_id: arguments.session_id,
                prompt: vec![ContentBlock::from(arguments.prompt)],
                key: arguments.key,
                caller: None,
                origin: None,
            })
        }
        START_SESSION => return start_elsewhere(shared, me, host, arguments),
        _ => return Err(format!("The Host doesn't answer {tool}.")),
    };
    Ok((call, None))
}

/// Where a session the session `me` starts on another Host, `host`, works when its agent names
/// no directory: the same one under the home there, `~/…`, in a checkout of the same
/// repository, its main one, since another worktree's branch may not be there.
fn counterpart(
    shared: &Shared,
    me: &Summary,
    host: &str,
) -> Result<(PathBuf, Option<String>), String> {
    let real = |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let (dir, remote) = match &me.git {
        Some(git) => {
            let cwd = real(&me.cwd);
            let within = cwd
                .strip_prefix(real(&git.worktree))
                .unwrap_or(Path::new(""));
            let repo = real(&git.repo);
            let dir = if within.as_os_str().is_empty() {
                repo
            } else {
                repo.join(within)
            };
            (dir, git.remote.clone())
        }
        None => (real(&me.cwd), None),
    };
    let home = real(&shared.home());
    let under = dir.strip_prefix(&home).map_err(|_| {
        format!(
            "This thread works in {}, outside its home, so it has no counterpart on {host}: \
             give cwd, a directory there.",
            dir.display()
        )
    })?;
    let there = if under.as_os_str().is_empty() {
        PathBuf::from("~")
    } else {
        Path::new("~").join(under)
    };
    Ok((there, remote))
}

/// The other Host the session `me` works for, if one: one whose agent began its running turn,
/// or, up the sessions that started it, one whose agent started one of them.
fn from_other_host(shared: &Shared, me: &Summary) -> Option<String> {
    if let Some(host) = &me.turn_from_host {
        return Some(host.clone());
    }
    let mut current = me.session_id.clone();
    for _ in 0..MAX_CHAIN {
        let (starter, host) = started_by(shared, &current)?;
        if host.is_some() {
            return host;
        }
        current = starter;
    }
    None
}

/// `start_session` on another Host, `host`: `session/run` there, its session a delegated
/// session of `me`'s when it starts one, with as much room as `me` has left.
fn start_elsewhere(
    shared: &Shared,
    me: &Summary,
    host: &str,
    arguments: &Map<String, Value>,
) -> Result<(HostCall, Option<u32>), String> {
    let arguments: StartArguments = parse(arguments)?;
    let (cwd, remote) = match arguments.cwd {
        Some(cwd) => (cwd, None),
        None => counterpart(shared, me, host)?,
    };
    let limits = shared
        .load_config()
        .map_err(|error| why(&error))?
        .delegation;
    let room = if arguments.session_id.is_none() {
        let depth = depth(shared, &me.session_id);
        if depth >= limits.depth() {
            return Err(too_deep(depth, limits.depth()));
        }
        room(shared, &me.session_id, limits.running())?;
        let busy = u32::try_from(busy_here(shared, &me.session_id)).unwrap_or(u32::MAX);
        Some(limits.running().saturating_sub(busy))
    } else {
        None
    };
    let policy = asked(&arguments.approve, arguments.otherwise, &me.policy);
    let request = RunRequest {
        agent_id: arguments.agent_id,
        cwd,
        remote,
        session_id: arguments.session_id,
        additional_directories: Vec::new(),
        mode: None,
        prompt: vec![ContentBlock::from(arguments.prompt)],
        policy,
        attach: false,
        trace: false,
        key: arguments.key,
        caller: None,
        origin: None,
        labels: Vec::new(),
    };
    Ok((HostCall::Run(Box::new(request)), room))
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
                return Err(too_deep(depth, limits.depth()));
            }
            room(shared, &me.session_id, limits.running())?;
        }
    }
    let policy = asked(&arguments.approve, arguments.otherwise, &me.policy);
    let request = RunRequest {
        agent_id: arguments.agent_id,
        cwd: arguments.cwd.unwrap_or_else(|| me.cwd.clone()),
        remote: None,
        session_id: arguments.session_id,
        additional_directories: Vec::new(),
        mode: None,
        prompt: vec![ContentBlock::from(arguments.prompt)],
        policy: policy.clone(),
        attach: false,
        trace: false,
        key: arguments.key,
        caller: None,
        origin: None,
        labels: Vec::new(),
    };
    let origin = TurnOrigin::Session {
        session_id: me.session_id.clone(),
        host: None,
        host_name: None,
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

/// The policy a delegated session asks for: `approve` and `otherwise`, the caller's where
/// absent, within the caller's.
fn asked(
    approve: &Option<Vec<ToolKind>>,
    otherwise: Option<Unapproved>,
    caller: &PermissionPolicy,
) -> PermissionPolicy {
    PermissionPolicy {
        approve: approve.clone().unwrap_or_else(|| caller.approve.clone()),
        otherwise: otherwise.unwrap_or(caller.otherwise),
    }
    .within(caller)
}

fn too_deep(depth: u32, allowed: u32) -> String {
    format!(
        "This thread can't start threads: it is {depth} level{} below a thread a person \
         started, and the Host allows {allowed} (`[delegation] depth`).",
        if depth == 1 { "" } else { "s" },
    )
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
        caller: None,
        origin: None,
    };
    let origin = TurnOrigin::Session {
        session_id: me,
        host: None,
        host_name: None,
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
        caller: None,
        origin: None,
    };
    let origin = TurnOrigin::Session {
        session_id: caller.summary().session_id,
        host: None,
        host_name: None,
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
    started_by(shared, session_id).map(|(starter, _)| starter)
}

/// The session that started `session_id`, or the one it belongs to as a subagent, and the
/// other Host that one is on when it isn't this one.
fn started_by(shared: &Shared, session_id: &SessionId) -> Option<(SessionId, Option<String>)> {
    let registry = shared.registry();
    let root = registry.root(session_id);
    match registry.sessions.get(&root) {
        Some(session) => {
            let summary = session.summary();
            Some((summary.started_by?, summary.started_by_host))
        }
        None => {
            let recorded = registry.known.get(&root)?;
            Some((
                recorded.started_by.clone()?,
                recorded.started_by_host.clone(),
            ))
        }
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

/// How many of `caller`'s delegated sessions on this Host run a turn or wait on a request.
fn busy_here(shared: &Shared, caller: &SessionId) -> usize {
    shared
        .registry()
        .sessions
        .values()
        .map(SessionHandle::summary)
        .filter(|summary| {
            summary.started_by.as_ref() == Some(caller)
                && summary.started_by_host.is_none()
                && summary.activity != Activity::Idle
        })
        .count()
}

/// Whether `caller` may have one more delegated session running on this Host than now. Its
/// delegated sessions on other Hosts the Dispatcher counts, against the room a call there says
/// is left; this Host keeps no record of them.
fn room(shared: &Shared, caller: &SessionId, running: u32) -> Result<(), String> {
    let busy = busy_here(shared, caller);
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

/// Report on `about` to the session `caller`, whose agent began a turn there, or to the last of
/// its successors when it names one, where its work goes on (WVE-168): into its running turn if
/// its agent takes steers, otherwise through its queue, which starts its next turn. A caller
/// that isn't open is taken up again for it. One that can't be is left untold, and `about`'s
/// journal says so when it's here. `about` is on the other Host `host` names, by its id and
/// name, when it isn't this one.
pub(crate) async fn tell(
    shared: Arc<Shared>,
    caller: SessionId,
    about: SessionId,
    host: Option<(String, Option<String>)>,
    text: String,
) -> Result<(), String> {
    let caller = shared.registry().latest_successor(&caller);
    let elsewhere = host.is_some();
    let (host, host_name) = host.unzip();
    let origin = TurnOrigin::Session {
        session_id: about.clone(),
        host,
        host_name: host_name.flatten(),
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
                    caller: None,
                    origin: None,
                },
                origin.clone(),
            )
            .await;
            if matches!(&steered, Ok(answer) if answer.outcome == SteerOutcome::Steered) {
                return Ok(());
            }
            let request = AddQueuedRequest {
                session_id: caller.clone(),
                prompt,
                key: None,
                caller: None,
                origin: None,
            };
            client::add_queued(&shared, request, origin)
                .await
                .map(drop)
                .map_err(|error| why(&error))
        }
        Err(why) => Err(why),
    };
    if let Err(why) = &open {
        tracing::warn!(%caller, %about, %why, "couldn't report on a session to its caller");
        if !elsewhere && let Some(session) = shared.registry().live(&about) {
            let _ = session.send(Command::Notice {
                text: format!(
                    "Thread {caller}, whose agent began this turn, couldn't be told how it went: \
                     {why}"
                ),
            });
        }
    }
    open
}

/// Make sure `session_id` is open, taking it up again under its own policy if it isn't.
async fn open(shared: &Arc<Shared>, session_id: &SessionId) -> Result<(), String> {
    if shared.registry().live(session_id).is_some() {
        return Ok(());
    }
    // Another report may be taking it up already; this one waits, and finds it open.
    let _one = shared.taking_up_for_reports.lock().await;
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
