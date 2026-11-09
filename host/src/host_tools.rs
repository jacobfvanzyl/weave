//! Host tools (ADR 0020): what the Host answers itself for the thread whose agent calls a tool
//! on the Host MCP server. Each is a Host protocol method seen from inside the thread, answered
//! by the same code as the client request; its answer is the method's, as JSON text, or a tool
//! error saying why the method failed.
//!
//! An agent reads and acts on any thread on its Host (ADR 0023). Some tools start delegated
//! threads: threads of their own that the calling thread starts, which approve nothing the
//! calling thread's policy doesn't; `[delegation]` caps how deep threads start threads and
//! how many of one thread's run at once. When a turn the calling thread's agent began ends,
//! or waits on a person, the Host reports it to the calling thread ([`tell`]): into its running
//! turn, or else through its queue.
//!
//! Given `host`, a tool acts on another of the person's Hosts instead (ADR 0029, WVE-185): the
//! same method, its request worked out here, passed to the service that reaches the person's
//! Hosts, the Dispatcher, as a `service/hostCall` naming the calling thread. The Dispatcher
//! sends it there, follows a turn it began, and reports on it with `thread/report`, which
//! [`tell`] answers as for this Host's own threads; this Host keeps no record of it.
//! `list_hosts` lists the Hosts the Dispatcher reaches.
//!
//! Given `project`, `start_thread` and `list_threads` work in one of the person's Projects
//! (WVE-208), which the Dispatcher keeps: `list_projects` lists them, and a call that names one
//! asks the Dispatcher for them first and works out the Project's location on the Host it acts
//! on. A thread started on another Host with no directory goes to the location there of the
//! Project the calling thread's directory is in, when it's in one, rather than the same path
//! under the home there. Reach is one hop: a turn another Host's
//! agent began here, and a thread one started here or anything that thread started, reaches
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
use weave_acp_core::schema::ToolKind;
use weave_host_protocol::agents::ListAgentsRequest;
use weave_host_protocol::dispatcher::Project;
use weave_host_protocol::dispatcher::ProjectKind;
use weave_host_protocol::policy::PermissionPolicy;
use weave_host_protocol::policy::Unapproved;
use weave_host_protocol::projects::ListedProjects;
use weave_host_protocol::projects::containing;
use weave_host_protocol::projects::containing_directory;
use weave_host_protocol::projects::inside;
use weave_host_protocol::queue::AddQueuedRequest;
use weave_host_protocol::reports::why;
use weave_host_protocol::threads::Activity;
use weave_host_protocol::threads::GetThreadRequest;
use weave_host_protocol::threads::ListThreadsRequest;
use weave_host_protocol::threads::ListThreadsResponse;
use weave_host_protocol::threads::RunRequest;
use weave_host_protocol::threads::RunResponse;
use weave_host_protocol::threads::ThreadId;
use weave_host_protocol::threads::TurnOrigin;
use weave_host_protocol::tools::CANCEL_THREAD_TURN;
use weave_host_protocol::tools::ClientToolResult;
use weave_host_protocol::tools::HostCall;
use weave_host_protocol::tools::LIST_AGENTS;
use weave_host_protocol::tools::LIST_HOSTS;
use weave_host_protocol::tools::LIST_PROJECTS;
use weave_host_protocol::tools::LIST_THREADS;
use weave_host_protocol::tools::PROMPT_THREAD;
use weave_host_protocol::tools::READ_THREAD;
use weave_host_protocol::tools::RENAME_THREAD;
use weave_host_protocol::tools::START_THREAD;
use weave_host_protocol::tools::STEER_THREAD;
use weave_host_protocol::turns::CancelTurnRequest;
use weave_host_protocol::turns::SteerOutcome;
use weave_host_protocol::turns::SteerTurnRequest;
use weave_host_protocol::turns::TurnId;

use crate::Shared;
use crate::client;
use crate::service_tools;
use crate::thread::Command;
use crate::thread::Summary;
use crate::thread::ThreadHandle;

/// How far up a chain of starting threads the Host looks, should one ever loop.
const MAX_CHAIN: usize = 64;

/// The answer to `tool` for the thread `caller`, called with `arguments`; none when the call
/// was cancelled first.
pub(crate) async fn call(
    shared: &Arc<Shared>,
    caller: &ThreadHandle,
    tool: &str,
    arguments: &Map<String, Value>,
    cancelled: impl Future<Output = ()>,
) -> Option<ClientToolResult> {
    let mut cancelled = std::pin::pin!(cancelled);
    let mut arguments = arguments.clone();
    let host = match arguments.remove("host") {
        None => None,
        // This Host, by the id list_hosts gives it.
        Some(Value::String(host)) if host == shared.devices.host_id() => None,
        Some(Value::String(host)) => Some(host),
        Some(_) => {
            return Some(ClientToolResult::error(
                "host is another Host's id or name, as a string.",
            ));
        }
    };
    let project = match (tool, arguments.remove("project")) {
        (_, None) => None,
        (LIST_THREADS | START_THREAD, Some(Value::String(project))) => Some(project),
        (LIST_THREADS | START_THREAD, Some(_)) => {
            return Some(ClientToolResult::error(
                "project is a Project's name or id, as a string.",
            ));
        }
        (_, Some(_)) => {
            return Some(ClientToolResult::error(format!("{tool} takes no project.")));
        }
    };
    if host.is_none() {
        match tool {
            LIST_HOSTS => return dispatcher(shared, caller, HostCall::ListHosts, cancelled).await,
            LIST_PROJECTS => {
                return dispatcher(shared, caller, HostCall::ListProjects, cancelled).await;
            }
            _ => {}
        }
    }
    // A Project named, or a thread started elsewhere with no directory, which goes where the
    // caller's Project is there, if it's in one.
    let guess = tool == START_THREAD && host.is_some() && !arguments.contains_key("cwd");
    let listed = if project.is_some() || guess {
        match projects(shared, caller, cancelled.as_mut()).await? {
            Ok(listed) => Some(listed),
            Err(why) => return Some(ClientToolResult::error(why)),
        }
    } else {
        None
    };
    let scope = Scope {
        named: project.as_deref(),
        listed: listed.as_ref(),
    };
    let answered = match host {
        None => here(shared, caller, tool, &arguments, scope).await,
        Some(host) => {
            return elsewhere(shared, caller, tool, host, &arguments, scope, cancelled).await;
        }
    };
    Some(match answered {
        Ok(text) => ClientToolResult::text(text),
        Err(why) => ClientToolResult::error(why),
    })
}

/// The Projects a call works with.
#[derive(Clone, Copy)]
struct Scope<'a> {
    /// The Project its agent named, as `project`.
    named: Option<&'a str>,
    /// The person's Projects, as the Dispatcher listed them, when the call needs them: always
    /// when it names one.
    listed: Option<&'a ListedProjects>,
}

impl<'a> Scope<'a> {
    /// The Project named, among those listed; or why there's none of that name.
    fn named(&self) -> Result<Option<(&'a Project, &'a ListedProjects)>, String> {
        match (self.named, self.listed) {
            (Some(by), Some(listed)) => Ok(Some((listed.project(by)?, listed))),
            _ => Ok(None),
        }
    }
}

/// `tool`'s answer on this Host.
async fn here(
    shared: &Arc<Shared>,
    caller: &ThreadHandle,
    tool: &str,
    arguments: &Map<String, Value>,
    scope: Scope<'_>,
) -> Result<String, String> {
    match tool {
        RENAME_THREAD => rename(caller, arguments).await,
        LIST_THREADS => list(shared, arguments, scope).await,
        LIST_AGENTS => answer(client::list_agents(shared, ListAgentsRequest::default()).await),
        READ_THREAD => match parse::<GetThreadRequest>(arguments) {
            Ok(request) => answer(client::get_thread(shared, request).await),
            Err(why) => Err(why),
        },
        START_THREAD => start(shared, caller, arguments, scope).await,
        PROMPT_THREAD => prompt(shared, caller, arguments).await,
        STEER_THREAD => steer(shared, caller, arguments).await,
        CANCEL_THREAD_TURN => cancel(shared, arguments),
        _ => Err(format!("The Host doesn't answer {tool}.")),
    }
}

/// `call`, which the service that reaches the person's Hosts answers itself: `list_hosts` or
/// `list_projects`.
async fn dispatcher(
    shared: &Arc<Shared>,
    caller: &ThreadHandle,
    call: HostCall,
    cancelled: impl Future<Output = ()>,
) -> Option<ClientToolResult> {
    let Some((service, name)) = shared.devices.hosts_service() else {
        return Some(ClientToolResult::error(no_dispatcher(shared)));
    };
    let me = service_tools::caller(&caller.summary());
    shared
        .service_tools
        .call_host(&service, &name, None, call, me, None, cancelled)
        .await
}

/// The person's Projects, which the service that reaches their Hosts keeps, for a call that
/// names one or may fall in one; or why they can't be had.
async fn projects(
    shared: &Arc<Shared>,
    caller: &ThreadHandle,
    cancelled: impl Future<Output = ()>,
) -> Option<Result<ListedProjects, String>> {
    let answer = dispatcher(shared, caller, HostCall::ListProjects, cancelled).await?;
    let text = text_of(&answer);
    Some(if answer.is_error {
        Err(text)
    } else {
        serde_json::from_str(&text)
            .map_err(|error| format!("The Dispatcher listed the Projects oddly: {error}."))
    })
}

/// The text of a tool's answer.
fn text_of(answer: &ClientToolResult) -> String {
    answer
        .content
        .iter()
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect()
}

/// `list_threads` on this Host, only those in the Project named when there is one.
async fn list(
    shared: &Arc<Shared>,
    arguments: &Map<String, Value>,
    scope: Scope<'_>,
) -> Result<String, String> {
    let request: ListThreadsRequest = parse(arguments)?;
    let Some((project, listed)) = scope.named()? else {
        return answer(client::list_threads(shared, request).await);
    };
    no_directory(&request)?;
    let mut threads = client::list_threads(shared, request)
        .await
        .map_err(|error| why(&error))?;
    let projects = real_here(listed);
    threads.threads.retain(|thread| {
        let cwd = real(&thread.info.cwd);
        let repo = thread.git.as_ref().map(|git| real(&git.repo));
        containing_directory(&projects, &listed.host_id, &cwd, repo.as_deref())
            .is_some_and(|found| found.id == project.id)
    });
    to_text(&threads)
}

/// Refuse a `list_threads` that names a directory as well as a Project.
fn no_directory(request: &ListThreadsRequest) -> Result<(), String> {
    if request.cwd.is_some() || request.repo.is_some() {
        return Err("list_threads takes project or a directory, cwd or repo, not both.".to_owned());
    }
    Ok(())
}

/// `answer`, threads another Host listed, with only those in `project` there, `host`.
fn only_in(
    answer: ClientToolResult,
    project: &Project,
    listed: &ListedProjects,
    host: &str,
) -> ClientToolResult {
    if answer.is_error {
        return answer;
    }
    let mut threads: ListThreadsResponse = match serde_json::from_str(&text_of(&answer)) {
        Ok(threads) => threads,
        Err(error) => {
            return ClientToolResult::error(format!("{host} listed its threads oddly: {error}."));
        }
    };
    let host_id = listed.host(host).map(|host| host.host_id.as_str());
    threads.threads.retain(|thread| {
        host_id.is_some_and(|host_id| {
            containing(&listed.projects, host_id, thread)
                .is_some_and(|found| found.id == project.id)
        })
    });
    match to_text(&threads) {
        Ok(text) => ClientToolResult::text(text),
        Err(why) => ClientToolResult::error(why),
    }
}

/// `listed`'s Projects, with their locations on this Host as their real paths, to compare with
/// the real paths of directories here.
fn real_here(listed: &ListedProjects) -> Vec<Project> {
    let mut projects = listed.projects.clone();
    for location in projects
        .iter_mut()
        .flat_map(|project| &mut project.locations)
    {
        if location.host_id == listed.host_id {
            location.path = real(&location.path);
        }
    }
    projects
}

/// `path` with its links resolved, or as it is when it can't be.
fn real(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// A git Project's remote, which the Host it starts a thread on checks its clone has.
fn remote_of(project: &Project) -> Option<String> {
    match project.kind {
        ProjectKind::Git => project.remote.clone(),
        ProjectKind::Directory => None,
    }
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
    caller: &ThreadHandle,
    tool: &str,
    host: String,
    arguments: &Map<String, Value>,
    scope: Scope<'_>,
    cancelled: impl Future<Output = ()>,
) -> Option<ClientToolResult> {
    let fail = |why: String| Some(ClientToolResult::error(why));
    if matches!(tool, RENAME_THREAD | LIST_HOSTS | LIST_PROJECTS) {
        return fail(format!("{tool} acts on this Host, so it takes no host."));
    }
    let me = caller.summary();
    if let Some(from) = from_other_host(shared, &me) {
        return fail(format!(
            "This thread works for a thread on another Host ({from}), so it reaches no other \
             Host: a Host's agents reach the person's other Hosts only one hop away."
        ));
    }
    let (call, room) = match request(shared, &me, tool, &host, arguments, scope) {
        Ok(asked) => asked,
        Err(why) => return fail(why),
    };
    let named = match scope.named() {
        Ok(named) => named.filter(|_| tool == LIST_THREADS),
        Err(why) => return fail(why),
    };
    let Some((service, name)) = shared.devices.hosts_service() else {
        return fail(no_dispatcher(shared));
    };
    let caller = service_tools::caller(&me);
    let answer = shared
        .service_tools
        .call_host(
            &service,
            &name,
            Some(host.clone()),
            call,
            caller,
            room,
            cancelled,
        )
        .await?;
    Some(match named {
        Some((project, listed)) => only_in(answer, project, listed, &host),
        None => answer,
    })
}

/// The request `tool` makes of another Host, `host`, for the thread `me`, and, for one that
/// starts a delegated thread, how many more of `me`'s may run on other Hosts.
fn request(
    shared: &Shared,
    me: &Summary,
    tool: &str,
    host: &str,
    arguments: &Map<String, Value>,
    scope: Scope<'_>,
) -> Result<(HostCall, Option<u32>), String> {
    let call = match tool {
        LIST_THREADS => {
            let request: ListThreadsRequest = parse(arguments)?;
            if scope.named()?.is_some() {
                no_directory(&request)?;
            }
            HostCall::ListThreads(request)
        }
        LIST_AGENTS => HostCall::ListAgents(ListAgentsRequest::default()),
        READ_THREAD => HostCall::GetThread(parse(arguments)?),
        STEER_THREAD => {
            let arguments: SteerArguments = parse(arguments)?;
            HostCall::Steer(SteerTurnRequest {
                thread_id: arguments.thread_id,
                prompt: vec![ContentBlock::from(arguments.prompt)],
                caller: None,
                origin: None,
            })
        }
        CANCEL_THREAD_TURN => HostCall::Cancel(parse::<CancelTurnRequest>(arguments)?),
        PROMPT_THREAD => {
            let arguments: PromptArguments = parse(arguments)?;
            HostCall::Queue(AddQueuedRequest {
                thread_id: arguments.thread_id,
                prompt: vec![ContentBlock::from(arguments.prompt)],
                key: arguments.key,
                caller: None,
                origin: None,
            })
        }
        START_THREAD => return start_elsewhere(shared, me, host, arguments, scope),
        _ => return Err(format!("The Host doesn't answer {tool}.")),
    };
    Ok((call, None))
}

/// Where a thread the thread `me` starts on another Host, `host`, works when its agent names
/// no directory: the same one under the home there, `~/…`, in a checkout of the same
/// repository, its main one, since another worktree's branch may not be there.
fn counterpart(
    shared: &Shared,
    me: &Summary,
    host: &str,
) -> Result<(PathBuf, Option<String>), String> {
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

/// Where a thread the thread `me` starts on another Host, `host`, works when its agent names
/// no directory and `me`'s directory is in one of the person's Projects: the Project's location
/// there, in the same subdirectory as `me` in its own. In a git Project that's the main
/// checkout there, since another worktree's branch may not be there. None when `me`'s
/// directory is in no Project; why not when the Project has no location there.
fn in_project_there(
    listed: &ListedProjects,
    me: &Summary,
    host: &str,
) -> Option<Result<(PathBuf, Option<String>), String>> {
    let projects = real_here(listed);
    let cwd = real(&me.cwd);
    let repo = me.git.as_ref().map(|git| real(&git.repo));
    let project = containing_directory(&projects, &listed.host_id, &cwd, repo.as_deref())?;
    let here = &project.location(&listed.host_id)?.path;
    let within = match &me.git {
        Some(git) if repo.as_ref() == Some(here) => cwd.strip_prefix(real(&git.worktree)),
        _ => cwd.strip_prefix(here),
    }
    .unwrap_or(Path::new(""));
    Some(listed.location(project, Some(host)).map(|location| {
        let dir = if within.as_os_str().is_empty() {
            location.path.clone()
        } else {
            location.path.join(within)
        };
        (dir, remote_of(project))
    }))
}

/// The other Host the thread `me` works for, if one: one whose agent began its running turn,
/// or, up the threads that started it, one whose agent started one of them.
fn from_other_host(shared: &Shared, me: &Summary) -> Option<String> {
    if let Some(host) = &me.turn_from_host {
        return Some(host.clone());
    }
    let mut current = me.thread_id.clone();
    for _ in 0..MAX_CHAIN {
        let (starter, host) = started_by(shared, &current)?;
        if host.is_some() {
            return host;
        }
        current = starter;
    }
    None
}

/// `start_thread` on another Host, `host`: `thread/run` there, its thread a delegated
/// thread of `me`'s when it starts one, with as much room as `me` has left.
fn start_elsewhere(
    shared: &Shared,
    me: &Summary,
    host: &str,
    arguments: &Map<String, Value>,
    scope: Scope<'_>,
) -> Result<(HostCall, Option<u32>), String> {
    let arguments: StartArguments = parse(arguments)?;
    let (cwd, remote) = match (scope.named()?, arguments.cwd) {
        (Some((project, listed)), cwd) => {
            let location = listed.location(project, Some(host))?;
            (inside(&location.path, cwd.as_deref())?, remote_of(project))
        }
        (None, Some(cwd)) => (cwd, None),
        (None, None) => match scope
            .listed
            .and_then(|listed| in_project_there(listed, me, host))
        {
            Some(there) => there?,
            None => counterpart(shared, me, host)?,
        },
    };
    let limits = shared
        .load_config()
        .map_err(|error| why(&error))?
        .delegation;
    let room = if arguments.thread_id.is_none() {
        let depth = depth(shared, &me.thread_id);
        if depth >= limits.depth() {
            return Err(too_deep(depth, limits.depth()));
        }
        room(shared, &me.thread_id, limits.running())?;
        let busy = u32::try_from(busy_here(shared, &me.thread_id)).unwrap_or(u32::MAX);
        Some(limits.running().saturating_sub(busy))
    } else {
        None
    };
    let policy = asked(&arguments.approve, arguments.otherwise, &me.policy);
    let request = RunRequest {
        agent_id: arguments.agent_id,
        cwd,
        remote,
        thread_id: arguments.thread_id,
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

/// `rename_thread`: `thread/rename` for the calling thread.
async fn rename(caller: &ThreadHandle, arguments: &Map<String, Value>) -> Result<String, String> {
    let asked = arguments
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let title = crate::thread::title(asked).map_err(|why| format!("Not renamed: {why}."))?;
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
    thread_id: Option<ThreadId>,
    approve: Option<Vec<ToolKind>>,
    otherwise: Option<Unapproved>,
    key: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Started {
    thread_id: ThreadId,
    /// The turn it started, for read_thread.
    #[serde(skip_serializing_if = "Option::is_none")]
    turn_id: Option<TurnId>,
    /// The policy the thread runs under, within the calling thread's.
    policy: PermissionPolicy,
}

/// `start_thread`: `thread/run`, for a new delegated thread of the caller's or for any
/// thread again.
async fn start(
    shared: &Arc<Shared>,
    caller: &ThreadHandle,
    arguments: &Map<String, Value>,
    scope: Scope<'_>,
) -> Result<String, String> {
    let arguments: StartArguments = parse(arguments)?;
    let me = caller.summary();
    let cwd = match scope.named()? {
        Some((project, listed)) => {
            let location = listed.location(project, None)?;
            inside(&location.path, arguments.cwd.as_deref())?
        }
        None => arguments.cwd.clone().unwrap_or_else(|| me.cwd.clone()),
    };
    let limits = shared
        .load_config()
        .map_err(|error| why(&error))?
        .delegation;
    match &arguments.thread_id {
        Some(target) => {
            if one_more(shared, &me.thread_id, target) {
                room(shared, &me.thread_id, limits.running())?;
            }
        }
        None => {
            let depth = depth(shared, &me.thread_id);
            if depth >= limits.depth() {
                return Err(too_deep(depth, limits.depth()));
            }
            room(shared, &me.thread_id, limits.running())?;
        }
    }
    let policy = asked(&arguments.approve, arguments.otherwise, &me.policy);
    let request = RunRequest {
        agent_id: arguments.agent_id,
        cwd,
        remote: None,
        thread_id: arguments.thread_id,
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
    let origin = TurnOrigin::Thread {
        thread_id: me.thread_id.clone(),
        host: None,
        host_name: None,
        report: false,
    };
    let RunResponse {
        thread_id, turn_id, ..
    } = client::run_as(shared, request, None, origin, Some(me.thread_id.clone()))
        .await
        .map_err(|error| why(&error))?;
    // An open thread it prompted again keeps its own policy.
    let policy = shared
        .registry()
        .live(&thread_id)
        .map_or(policy, |thread| thread.summary().policy);
    to_text(&Started {
        thread_id,
        turn_id,
        policy,
    })
}

/// The policy a delegated thread asks for: `approve` and `otherwise`, the caller's where
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
    thread_id: ThreadId,
    prompt: String,
    key: Option<String>,
}

/// `prompt_thread`: `queue/add`.
async fn prompt(
    shared: &Arc<Shared>,
    caller: &ThreadHandle,
    arguments: &Map<String, Value>,
) -> Result<String, String> {
    let arguments: PromptArguments = parse(arguments)?;
    let me = caller.summary().thread_id;
    if one_more(shared, &me, &arguments.thread_id) {
        let limits = shared
            .load_config()
            .map_err(|error| why(&error))?
            .delegation;
        room(shared, &me, limits.running())?;
    }
    let request = AddQueuedRequest {
        thread_id: arguments.thread_id,
        prompt: vec![ContentBlock::from(arguments.prompt)],
        key: arguments.key,
        caller: None,
        origin: None,
    };
    let origin = TurnOrigin::Thread {
        thread_id: me,
        host: None,
        host_name: None,
        report: false,
    };
    answer(client::add_queued(shared, request, origin).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SteerArguments {
    thread_id: ThreadId,
    prompt: String,
}

/// `steer_thread`: `turn/steer`.
async fn steer(
    shared: &Arc<Shared>,
    caller: &ThreadHandle,
    arguments: &Map<String, Value>,
) -> Result<String, String> {
    let arguments: SteerArguments = parse(arguments)?;
    let request = SteerTurnRequest {
        thread_id: arguments.thread_id,
        prompt: vec![ContentBlock::from(arguments.prompt)],
        caller: None,
        origin: None,
    };
    let origin = TurnOrigin::Thread {
        thread_id: caller.summary().thread_id,
        host: None,
        host_name: None,
        report: false,
    };
    answer(client::steer_turn(shared, request, origin).await)
}

/// `cancel_thread_turn`: `turn/cancel`.
fn cancel(shared: &Arc<Shared>, arguments: &Map<String, Value>) -> Result<String, String> {
    let request: CancelTurnRequest = parse(arguments)?;
    answer(client::cancel_turn(shared, request))
}

/// The thread that started `thread_id`, or the one it belongs to as a subagent.
fn starter(shared: &Shared, thread_id: &ThreadId) -> Option<ThreadId> {
    started_by(shared, thread_id).map(|(starter, _)| starter)
}

/// The thread that started `thread_id`, or the one it belongs to as a subagent, and the
/// other Host that one is on when it isn't this one.
fn started_by(shared: &Shared, thread_id: &ThreadId) -> Option<(ThreadId, Option<String>)> {
    let registry = shared.registry();
    let root = registry.root(thread_id);
    match registry.threads.get(&root) {
        Some(thread) => {
            let summary = thread.summary();
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

/// How many levels below a thread a person started `thread_id` is.
fn depth(shared: &Shared, thread_id: &ThreadId) -> u32 {
    let mut current = thread_id.clone();
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

/// Whether `thread_id` is open and running a turn or waiting on a request.
fn is_busy(shared: &Shared, thread_id: &ThreadId) -> bool {
    shared
        .registry()
        .live(thread_id)
        .is_some_and(|thread| thread.summary().activity != Activity::Idle)
}

/// Whether a turn in `target` would have one more of `caller`'s delegated threads running than
/// now: `target` is one `caller` started, and it is idle.
fn one_more(shared: &Shared, caller: &ThreadId, target: &ThreadId) -> bool {
    starter(shared, target).as_ref() == Some(caller) && !is_busy(shared, target)
}

/// How many of `caller`'s delegated threads on this Host run a turn or wait on a request.
fn busy_here(shared: &Shared, caller: &ThreadId) -> usize {
    shared
        .registry()
        .threads
        .values()
        .map(ThreadHandle::summary)
        .filter(|summary| {
            summary.started_by.as_ref() == Some(caller)
                && summary.started_by_host.is_none()
                && summary.activity != Activity::Idle
        })
        .count()
}

/// Whether `caller` may have one more delegated thread running on this Host than now. Its
/// delegated threads on other Hosts the Dispatcher counts, against the room a call there says
/// is left; this Host keeps no record of them.
fn room(shared: &Shared, caller: &ThreadId, running: u32) -> Result<(), String> {
    let busy = busy_here(shared, caller);
    if busy < usize::try_from(running).unwrap_or(usize::MAX) {
        return Ok(());
    }
    Err(format!(
        "This thread already has {busy} delegated thread{} running, as many as the Host \
         allows (`[delegation] running`). Wait to hear that one finished, or cancel one with \
         cancel_thread_turn.",
        if busy == 1 { "" } else { "s" }
    ))
}

/// Report on `about` to the thread `caller`, whose agent began a turn there, or to the last of
/// its successors when it names one, where its work goes on (WVE-168): into its running turn if
/// its agent takes steers, otherwise through its queue, which starts its next turn. A caller
/// that isn't open is taken up again for it. One that can't be is left untold, and `about`'s
/// journal says so when it's here. `about` is on the other Host `host` names, by its id and
/// name, when it isn't this one.
pub(crate) async fn tell(
    shared: Arc<Shared>,
    caller: ThreadId,
    about: ThreadId,
    host: Option<(String, Option<String>)>,
    text: String,
) -> Result<(), String> {
    let caller = shared.registry().latest_successor(&caller);
    let elsewhere = host.is_some();
    let (host, host_name) = host.unzip();
    let origin = TurnOrigin::Thread {
        thread_id: about.clone(),
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
                    thread_id: caller.clone(),
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
                thread_id: caller.clone(),
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
        tracing::warn!(%caller, %about, %why, "couldn't report on a thread to its caller");
        if !elsewhere && let Some(thread) = shared.registry().live(&about) {
            let _ = thread.send(Command::Notice {
                text: format!(
                    "Thread {caller}, whose agent began this turn, couldn't be told how it went: \
                     {why}"
                ),
            });
        }
    }
    open
}

/// Make sure `thread_id` is open, taking it up again under its own policy if it isn't.
async fn open(shared: &Arc<Shared>, thread_id: &ThreadId) -> Result<(), String> {
    if shared.registry().live(thread_id).is_some() {
        return Ok(());
    }
    // Another report may be taking it up already; this one waits, and finds it open.
    let _one = shared.taking_up_for_reports.lock().await;
    if shared.registry().live(thread_id).is_some() {
        return Ok(());
    }
    let recorded = shared
        .registry()
        .known
        .get(thread_id)
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
        thread_id.clone(),
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
