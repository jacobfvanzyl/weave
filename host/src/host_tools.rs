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
//! Given `host`, a tool acts on a peer Host instead (ADR 0017, WVE-109): the same method, sent
//! over this Host's connection to the peer, naming the calling session as its `caller`. The
//! peer runs the session and holds its pending requests; this Host follows a turn its agent
//! began there and reports on it as on its own (`peers.rs`). `list_hosts` lists the peers.
//! Reach is one hop: a turn a peer's agent began here, and a session a peer's agent started
//! here or anything that session started, reaches none of this Host's peers.

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

use weave_host_protocol::peers::ListPeersResponse;

use crate::Shared;
use crate::client;
use crate::peers::Begin;
use crate::peers::Begun;
use crate::peers::Peers;
use crate::peers::Sending;
use crate::session::Command;
use crate::session::SessionHandle;
use crate::session::Summary;

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
    let mut arguments = arguments.clone();
    let answered = match arguments.remove("host") {
        None => here(shared, caller, tool, &arguments).await,
        // This Host, by the id list_hosts gives it.
        Some(Value::String(host)) if host == shared.devices.host_id() => {
            here(shared, caller, tool, &arguments).await
        }
        Some(Value::String(host)) => on_peer(shared, caller, tool, &host, &arguments).await,
        Some(_) => Err("host is a peer Host's id or name, as a string.".to_owned()),
    };
    match answered {
        Ok(text) => ClientToolResult::text(text),
        Err(why) => ClientToolResult::error(why),
    }
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
        LIST_HOSTS => hosts(shared).await,
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

/// `list_hosts`: `peers/list`, checking which peers can be reached now.
async fn hosts(shared: &Arc<Shared>) -> Result<String, String> {
    let listed = match &shared.peers {
        Some(peers) => peers.list(shared, true).await,
        None => ListPeersResponse {
            host_id: shared.devices.host_id(),
            peers: Vec::new(),
        },
    };
    to_text(&listed)
}

/// `tool`'s answer on the peer Host `host` names, through this Host's connection to it.
async fn on_peer(
    shared: &Arc<Shared>,
    caller: &SessionHandle,
    tool: &str,
    host: &str,
    arguments: &Map<String, Value>,
) -> Result<String, String> {
    if matches!(tool, RENAME_SESSION | LIST_HOSTS) {
        return Err(format!("{tool} acts on this Host, so it takes no host."));
    }
    let peers = shared
        .peers
        .as_ref()
        .ok_or("This Host doesn't pair with other Hosts.")?;
    let me = caller.summary();
    if let Some(from) = from_peer(shared, &me) {
        return Err(format!(
            "This thread works for a thread on another Host ({from}), so it reaches none of \
             this Host's peers: a Host's agents reach its own peers only, one hop away."
        ));
    }
    let (host_id, name) = peers.resolve(host)?;
    match tool {
        START_SESSION => return start_on(shared, peers, &me, &host_id, &name, arguments).await,
        PROMPT_SESSION => return prompt_on(shared, peers, &me, host_id, arguments).await,
        _ => {}
    }
    let handle = peers
        .reach(shared, &host_id)
        .await
        .map_err(|why| format!("{name} can't be reached: {why}."))?;
    let there = |error: Error| format!("On {name}: {}", why(&error));
    match tool {
        LIST_SESSIONS => {
            let request: ListSessionsRequest = parse(arguments)?;
            to_text(&handle.send(request).await.map_err(there)?)
        }
        LIST_AGENTS => to_text(
            &handle
                .send(ListAgentsRequest::default())
                .await
                .map_err(there)?,
        ),
        READ_SESSION => {
            let request: GetSessionRequest = parse(arguments)?;
            to_text(&handle.send(request).await.map_err(there)?)
        }
        STEER_SESSION => {
            let arguments: SteerArguments = parse(arguments)?;
            let request = SteerTurnRequest {
                session_id: arguments.session_id,
                prompt: vec![ContentBlock::from(arguments.prompt)],
                caller: Some(me.session_id),
            };
            to_text(&handle.send(request).await.map_err(there)?)
        }
        CANCEL_SESSION_TURN => {
            let request: CancelTurnRequest = parse(arguments)?;
            to_text(&handle.send(request).await.map_err(there)?)
        }
        _ => Err(format!("The Host doesn't answer {tool}.")),
    }
}

/// The request key to send a peer for `key`, an agent's in `caller`, or a new one, so that this
/// Host can send it again when the peer doesn't answer. Every session of this Host is one
/// client to the peer, whose keys are its own across clients, so the key names the session too:
/// two agents' keys never meet, and one agent's retry is the same request.
fn peer_key(caller: &SessionId, key: Option<String>) -> String {
    use base64::Engine as _;
    use sha2::Digest as _;
    let key = key.unwrap_or_else(|| crate::devices::random_id(16));
    let digest = sha2::Sha256::digest(format!("{caller}\n{key}").as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

/// `prompt_session` on a peer: `queue/add` there, recorded first and followed here.
async fn prompt_on(
    shared: &Arc<Shared>,
    peers: &Peers,
    me: &Summary,
    host_id: String,
    arguments: &Map<String, Value>,
) -> Result<String, String> {
    let arguments: PromptArguments = parse(arguments)?;
    let request = AddQueuedRequest {
        session_id: arguments.session_id,
        prompt: vec![ContentBlock::from(arguments.prompt)],
        key: Some(peer_key(&me.session_id, arguments.key)),
        caller: Some(me.session_id.clone()),
    };
    let sending = Sending {
        host_id,
        caller: me.session_id.clone(),
        delegated: false,
        request: Begin::Queue(request),
    };
    match peers.begin(shared, sending).await? {
        Begun::Queue(added) => to_text(&added),
        Begun::Run(ran) => to_text(&ran),
    }
}

/// Where a session the session `me` starts on the peer `name` works when its agent names no
/// directory: the same one under the home there, `~/…`, in a checkout of the same repository,
/// its main one, since another worktree's branch may not be there.
fn counterpart(
    peers: &Peers,
    me: &Summary,
    name: &str,
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
    let home = real(&peers.home());
    let under = dir.strip_prefix(&home).map_err(|_| {
        format!(
            "This thread works in {}, outside its home, so it has no counterpart on {name}: \
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

/// The peer Host the session `me` works for, if one: one whose agent began its running turn,
/// or, up the sessions that started it, one whose agent started one of them.
fn from_peer(shared: &Shared, me: &Summary) -> Option<String> {
    if let Some(host) = &me.turn_from_peer {
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

/// `start_session` on a peer: `session/run` there, its session a delegated session of the
/// caller's, recorded first and followed here.
async fn start_on(
    shared: &Arc<Shared>,
    peers: &Peers,
    me: &Summary,
    host_id: &str,
    name: &str,
    arguments: &Map<String, Value>,
) -> Result<String, String> {
    let arguments: StartArguments = parse(arguments)?;
    let (cwd, remote) = match arguments.cwd {
        Some(cwd) => (cwd, None),
        None => counterpart(peers, me, name)?,
    };
    let limits = shared
        .load_config()
        .map_err(|error| why(&error))?
        .delegation;
    if arguments.session_id.is_none() {
        let depth = depth(shared, &me.session_id);
        if depth >= limits.depth() {
            return Err(too_deep(depth, limits.depth()));
        }
        room(shared, &me.session_id, limits.running())?;
    }
    let policy = asked(&arguments.approve, arguments.otherwise, &me.policy);
    let request = RunRequest {
        agent_id: arguments.agent_id,
        cwd,
        remote,
        session_id: arguments.session_id.clone(),
        additional_directories: Vec::new(),
        prompt: vec![ContentBlock::from(arguments.prompt)],
        policy: policy.clone(),
        attach: false,
        trace: false,
        key: Some(peer_key(&me.session_id, arguments.key)),
        caller: Some(me.session_id.clone()),
    };
    let sending = Sending {
        host_id: host_id.to_owned(),
        caller: me.session_id.clone(),
        delegated: arguments.session_id.is_none(),
        request: Begin::Run(request),
    };
    let ran = match peers.begin(shared, sending).await? {
        Begun::Run(ran) => ran,
        Begun::Queue(added) => return to_text(&added),
    };
    to_text(&Started {
        session_id: ran.session_id,
        turn_id: ran.turn_id,
        policy: ran.policy.unwrap_or(policy),
        host: Some(host_id.to_owned()),
    })
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
    /// The peer Host it's on, when it isn't this one.
    #[serde(skip_serializing_if = "Option::is_none")]
    host: Option<String>,
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
        prompt: vec![ContentBlock::from(arguments.prompt)],
        policy: policy.clone(),
        attach: false,
        trace: false,
        key: arguments.key,
        caller: None,
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
        host: None,
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
/// peer Host that one is on when it isn't this one.
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

/// Whether `caller` may have one more delegated session running than now.
fn room(shared: &Shared, caller: &SessionId, running: u32) -> Result<(), String> {
    let busy = shared
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
        + shared
            .peers
            .as_ref()
            .map_or(0, |peers| peers.delegated_running(caller));
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

/// A session as a report names it: its title, agent and id, and the peer Host it's on when it
/// isn't this one.
pub(crate) struct Named<'a> {
    pub(crate) session_id: &'a SessionId,
    pub(crate) title: Option<&'a str>,
    pub(crate) agent_id: &'a str,
    /// The peer Host's name.
    pub(crate) host: Option<&'a str>,
}

impl<'a> Named<'a> {
    pub(crate) fn of(listing: &'a SessionListing, host: Option<&'a str>) -> Self {
        Self {
            session_id: &listing.info.session_id,
            title: listing.info.title.as_deref(),
            agent_id: &listing.agent_id,
            host,
        }
    }
}

impl std::fmt::Display for Named<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let id = self.session_id;
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

/// The report on a session to the session whose agent began a turn there, when the turn ends:
/// how, and the start of the agent's last message.
pub(crate) fn ended_text(named: &Named<'_>, latest: Option<&LatestTurn>) -> String {
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
            text.push_str("\n\n[…] read_session gives the rest");
            if let Some(host) = named.host {
                text.push_str(&format!(", with host {host}"));
            }
            text.push('.');
        }
    }
    text
}

/// The report on a session to the session whose agent began a turn there, when a person must
/// answer something in it.
pub(crate) fn waiting_text(named: &Named<'_>, asks: &Asks) -> String {
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

/// Report on `about` to the session `caller`, whose agent began a turn there: into its running
/// turn if its agent takes steers, otherwise through its queue, which starts its next turn. A
/// caller that isn't open is taken up again for it. One that can't be is left untold, and
/// `about`'s journal says so. `about` is on the peer Host `host` when there is one.
pub(crate) async fn tell(
    shared: Arc<Shared>,
    caller: SessionId,
    about: SessionId,
    host: Option<String>,
    text: String,
) {
    let host_name = host
        .as_ref()
        .and_then(|host| shared.peers.as_ref()?.name_of(host));
    let origin = TurnOrigin::Session {
        session_id: about.clone(),
        host,
        host_name,
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
                caller: None,
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

/// Why `error` happened, as its message and the text of its data.
pub(crate) fn why(error: &Error) -> String {
    match error.data.as_ref() {
        Some(Value::String(data)) => format!("{}: {data}", error.message),
        Some(data) if !data.is_null() => format!("{}: {data}", error.message),
        _ => error.message.clone(),
    }
}
