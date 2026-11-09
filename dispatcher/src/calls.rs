//! Host tool calls naming another of the person's Hosts (ADR 0029, WVE-185). The Dispatcher
//! says it reaches the person's Hosts when it declares its tools on each, so a Host passes it
//! the calls its agents make with `host`, as `service/hostCall`, over the Dispatcher's own
//! connection. The Dispatcher sends the request to the named Host only while it's connected
//! there, naming the calling thread as its `caller`, and answers with `service/answerTool`.
//!
//! A call that starts a turn, `thread/run` or `queue/add`, is written down first, as a
//! delivery under a key made from the calling Host, thread and the agent's own key, so it
//! lands once however often it's sent. One whose answer is lost is sent again on the named
//! Host's next connection, as any delivery is, and the calling thread is told then whether it
//! started. The turn it began is followed there ([`crate::follows`]) and reported on.
//!
//! `list_projects` the Dispatcher answers itself, as `list_hosts`: Hosts know nothing of
//! Projects, so a Host whose agent names one asks it for them first and works the directory
//! out (WVE-208).
//!
//! Reach is one hop: a thread another Host's agent started can't reach a third. Its Host
//! refuses such a call, and so does the Dispatcher, from the calling thread's listing.

use std::sync::Arc;

use agent_client_protocol::Error;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use weave_host_client::HostHandle;
use weave_host_protocol::policy::PermissionPolicy;
use weave_host_protocol::projects::ListedProjects;
use weave_host_protocol::projects::NamedHost;
use weave_host_protocol::reports::why;
use weave_host_protocol::threads::OtherThread;
use weave_host_protocol::threads::ReportThreadRequest;
use weave_host_protocol::threads::RunResponse;
use weave_host_protocol::threads::ThreadId;
use weave_host_protocol::tools::AnswerToolRequest;
use weave_host_protocol::tools::ClientToolResult;
use weave_host_protocol::tools::HostCall;
use weave_host_protocol::tools::HostCallNotification;
use weave_host_protocol::tools::ToolCaller;
use weave_host_protocol::turns::TurnId;

use crate::Shared;
use crate::link;
use crate::store::Call;
use crate::store::Delivery;
use crate::store::StoredHost;
use crate::store::Work;
use crate::store::answered_thread;

/// Answer `call`, which came from `calling` over `from`.
pub(crate) async fn answer(
    shared: Arc<Shared>,
    calling: StoredHost,
    from: HostHandle,
    call: HostCallNotification,
) {
    let HostCallNotification {
        call_id,
        host,
        call,
        caller,
        room,
    } = call;
    let result = match respond(&shared, &calling, host.as_deref(), call, &caller, room).await {
        Ok(text) => ClientToolResult::text(text),
        Err(why) => ClientToolResult::error(why),
    };
    if let Err(error) = from.send(AnswerToolRequest { call_id, result }).await {
        tracing::debug!(host = %calling.host_id, %error, "answering a Host's call failed");
    }
}

/// The text the agent gets for `call`, or why it failed.
async fn respond(
    shared: &Shared,
    calling: &StoredHost,
    host: Option<&str>,
    call: HostCall,
    caller: &ToolCaller,
    room: Option<u32>,
) -> Result<String, String> {
    match call {
        HostCall::ListHosts => return hosts(shared, calling),
        HostCall::ListProjects => return projects(shared, calling),
        _ => {}
    }
    let host = host.ok_or("A call to another Host names it.")?;
    let named = resolve(shared, calling, host)?;
    if let Some(from) = shared
        .thread(&calling.host_id, &caller.thread_id)
        .and_then(|listing| listing.started_by_host)
    {
        return Err(format!(
            "This thread works for a thread on another Host ({from}), so it reaches no other \
             Host: a Host's agents reach the person's other Hosts only one hop away."
        ));
    }
    let handle = shared.handle(&named.host_id).ok_or_else(|| {
        let seen = shared.seen(&named.host_id);
        let why = seen
            .why
            .unwrap_or_else(|| "the Dispatcher isn't connected to it".to_owned());
        format!("{} can't be reached now: {why}.", named.name)
    })?;
    let there = |error: Error| format!("On {}: {}", named.name, why(&error));
    let me = OtherThread {
        thread_id: caller.thread_id.clone(),
        host: calling.host_id.clone(),
        host_name: Some(calling.name.clone()),
    };
    match call {
        HostCall::ListHosts => hosts(shared, calling),
        HostCall::ListProjects => projects(shared, calling),
        HostCall::ListThreads(request) => to_text(&handle.send(request).await.map_err(there)?),
        HostCall::ListAgents(request) => to_text(&handle.send(request).await.map_err(there)?),
        HostCall::GetThread(request) => to_text(&handle.send(request).await.map_err(there)?),
        HostCall::Cancel(request) => to_text(&handle.send(request).await.map_err(there)?),
        HostCall::Steer(mut request) => {
            request.caller = Some(me);
            request.origin = None;
            to_text(&handle.send(request).await.map_err(there)?)
        }
        HostCall::Queue(mut request) => {
            request.caller = Some(me);
            request.origin = None;
            request.key = Some(key(calling, &caller.thread_id, request.key));
            let call = Call {
                calling_host: calling.host_id.clone(),
                caller: caller.thread_id.to_string(),
                delegated: false,
                lost: false,
            };
            let answer = begin(
                shared,
                &named,
                &handle,
                Work::Queue(request),
                &call,
                "prompt_thread",
            )
            .await?;
            to_text(&answer)
        }
        HostCall::Run(request) => {
            let mut request = *request;
            let delegated = request.thread_id.is_none();
            if delegated && let Some(room) = room {
                let running = shared
                    .store
                    .delegated_running(&calling.host_id, &caller.thread_id.0)
                    .map_err(|why| {
                        format!("The Dispatcher couldn't count this thread's threads: {why}.")
                    })?;
                if running >= room {
                    return Err(format!(
                        "This thread may start no more delegated threads now: {running} of its \
                         run on other Hosts, and with those on its own Host that's as many as \
                         its Host allows (`[delegation] running`). Wait to hear that one \
                         finished, or cancel one with cancel_thread_turn."
                    ));
                }
            }
            request.policy = request.policy.within(&caller.policy);
            request.caller = Some(me);
            request.origin = None;
            request.attach = false;
            request.key = Some(key(calling, &caller.thread_id, request.key));
            let policy = request.policy.clone();
            let call = Call {
                calling_host: calling.host_id.clone(),
                caller: caller.thread_id.to_string(),
                delegated,
                lost: false,
            };
            let answer = begin(
                shared,
                &named,
                &handle,
                Work::Run(request),
                &call,
                "start_thread",
            )
            .await?;
            let ran: RunResponse = serde_json::from_value(answer)
                .map_err(|error| format!("{} answered oddly: {error}.", named.name))?;
            to_text(&Started {
                thread_id: ran.thread_id,
                turn_id: ran.turn_id,
                policy: ran.policy.unwrap_or(policy),
                host: named.host_id.clone(),
            })
        }
    }
}

/// What `start_thread` on another Host answers.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Started {
    thread_id: ThreadId,
    /// The turn it started, for read_thread.
    #[serde(skip_serializing_if = "Option::is_none")]
    turn_id: Option<TurnId>,
    /// The policy the thread runs under, within the calling thread's.
    policy: PermissionPolicy,
    /// The Host it's on.
    host: String,
}

/// Write `work` down for `named` as `call`, then send it: the Host's answer, or why there's
/// none. One whose answer is lost is sent again later, and its caller told what came of it.
async fn begin(
    shared: &Shared,
    named: &StoredHost,
    handle: &HostHandle,
    work: Work,
    call: &Call,
    tool: &str,
) -> Result<Value, String> {
    let delivery = shared
        .store
        .add_call(&named.host_id, work, call)
        .map_err(|why| format!("The Dispatcher couldn't write the call down: {why}."))?;
    match link::send(handle, &delivery.work).await {
        Ok(answer) => {
            if let Err(why) = shared.store.delivered(&delivery.id, &answer) {
                tracing::warn!(delivery = %delivery.id, %why, "recording a delivery failed");
            }
            // Its link looks at the turn now followed, which may have ended already.
            shared.wake(&named.host_id);
            Ok(answer)
        }
        Err(error) if error.code == Error::internal_error().code => {
            if let Err(why) = shared.store.lost(&delivery.id) {
                tracing::warn!(delivery = %delivery.id, %why, "recording a lost answer failed");
            }
            Err(format!(
                "{} stopped answering before it said whether it took {tool}. The Dispatcher \
                 keeps asking, with the same request key, and tells this thread what happened.",
                named.name
            ))
        }
        Err(error) => {
            if let Err(why) = shared.store.failed(&delivery.id, &error.message) {
                tracing::warn!(delivery = %delivery.id, %why, "recording a delivery failed");
            }
            Err(format!("On {}: {}", named.name, why(&error)))
        }
    }
}

/// Delivery `delivery` reached its Host on a connection after the one its call was made on:
/// tell the caller whether it started, if the answer it got was lost.
pub(crate) fn settled(
    shared: &Shared,
    named: &StoredHost,
    delivery: &Delivery,
    refused: Option<&str>,
) {
    let call = match shared.store.call(&delivery.id) {
        Ok(Some(call)) if call.lost => call,
        Ok(_) => return,
        Err(why) => {
            tracing::warn!(delivery = %delivery.id, %why, "reading a call failed");
            return;
        }
    };
    let (thread_id, what) = match &delivery.work {
        Work::Run(request) => (
            request.thread_id.clone(),
            "the thread your thread asked start_thread for",
        ),
        Work::Queue(request) => (
            Some(request.thread_id.clone()),
            "the prompt your thread asked prompt_thread for",
        ),
        _ => return,
    };
    let text = match (refused, delivery.answer.as_ref()) {
        (Some(why), _) => format!(
            "[weave] {} refused {what}, after it stopped answering: {why}.",
            named.name
        ),
        (None, answer) => {
            let field = |name: &str| answer.and_then(|answer| answer.get(name)?.as_str());
            let thread = answer
                .and_then(answered_thread)
                .map(str::to_owned)
                .or_else(|| thread_id.as_ref().map(ToString::to_string))
                .unwrap_or_default();
            let turn = field("turnId").or_else(|| field("queuedId")).unwrap_or("?");
            format!(
                "[weave] {} took {what} after all: thread {thread} there has turn {turn}, \
                 and you'll hear how it ends.",
                named.name
            )
        }
    };
    let about = OtherThread {
        thread_id: delivery
            .answer
            .as_ref()
            .and_then(answered_thread)
            .map(|id| ThreadId::new(id.to_owned()))
            .or(thread_id)
            .unwrap_or_else(|| ThreadId::new(String::new())),
        host: named.host_id.clone(),
        host_name: Some(named.name.clone()),
    };
    report(shared, &call.calling_host, &call.caller, about, text);
}

/// The report to `caller`, on `calling_host`, of `text` about `about`.
pub(crate) fn report_work(caller: &str, about: OtherThread, text: String) -> Work {
    Work::Report(ReportThreadRequest {
        thread_id: ThreadId::new(caller.to_owned()),
        about,
        text,
        key: None,
    })
}

/// Write down the report to `caller`, on `calling_host`, of `text` about `about`, and send it.
pub(crate) fn report(
    shared: &Shared,
    calling_host: &str,
    caller: &str,
    about: OtherThread,
    text: String,
) {
    match shared
        .store
        .add_delivery(calling_host, report_work(caller, about, text))
    {
        Ok(_) => shared.wake(calling_host),
        Err(why) => tracing::warn!(host = %calling_host, %why, "writing a report down failed"),
    }
}

/// `list_hosts`: the calling Host's id, and every other Host the Dispatcher is paired with.
fn hosts(shared: &Shared, calling: &StoredHost) -> Result<String, String> {
    let listed = shared
        .listed_hosts()
        .map_err(|error| format!("The Dispatcher couldn't list its Hosts: {}.", why(&error)))?;
    let hosts: Vec<Value> = listed
        .into_iter()
        .filter(|host| host.host_id != calling.host_id)
        .map(|host| {
            let mut listed = json!({
                "hostId": host.host_id,
                "name": host.name,
                "connected": host.connected,
                "status": host.status,
            });
            if let Some(why) = host.why {
                listed["why"] = json!(why);
            }
            listed
        })
        .collect();
    to_text(&json!({"hostId": calling.host_id, "hosts": hosts}))
}

/// `list_projects`: the person's Projects, and the names of every Host the Dispatcher is paired
/// with, the calling one's too, which the Projects' locations name by id. The calling Host
/// works out what `project` names to its thread tools from it (WVE-208).
fn projects(shared: &Shared, calling: &StoredHost) -> Result<String, String> {
    let projects = shared.projects().map_err(|error| {
        format!(
            "The Dispatcher couldn't list its Projects: {}.",
            why(&error)
        )
    })?;
    let hosts = shared
        .store
        .hosts()
        .map_err(|why| format!("The Dispatcher couldn't read its Hosts: {why}."))?
        .into_iter()
        .map(|host| NamedHost {
            host_id: host.host_id,
            name: host.name,
        })
        .collect();
    to_text(&ListedProjects {
        host_id: calling.host_id.clone(),
        projects,
        hosts,
    })
}

/// The Host `by` names, by id or name: one the Dispatcher is paired with, other than the
/// calling Host.
fn resolve(shared: &Shared, calling: &StoredHost, by: &str) -> Result<StoredHost, String> {
    let stored = shared
        .store
        .hosts()
        .map_err(|why| format!("The Dispatcher couldn't read its Hosts: {why}."))?;
    let found = stored
        .iter()
        .find(|stored| stored.host_id == by)
        .or_else(|| {
            stored
                .iter()
                .find(|stored| stored.name.eq_ignore_ascii_case(by))
        });
    match found {
        Some(found) if found.host_id == calling.host_id => Err(format!(
            "{by} is this thread's own Host: leave host out to act here."
        )),
        Some(found) => Ok(found.clone()),
        None => {
            let known: Vec<String> = stored
                .iter()
                .filter(|stored| stored.host_id != calling.host_id)
                .map(|stored| format!("{} ({})", stored.name, stored.host_id))
                .collect();
            Err(if known.is_empty() {
                format!("The Dispatcher reaches no Host {by}, nor any other Host than this one.")
            } else {
                format!(
                    "The Dispatcher reaches no Host {by}; it reaches {}.",
                    known.join(", ")
                )
            })
        }
    }
}

/// The request key the named Host gets for `key`, an agent's in `caller` on `calling`, or a new
/// one: every calling Host's threads are one client to the named Host, whose keys are its own
/// across clients, so the key names the Host and thread too, and two agents' keys never meet.
fn key(calling: &StoredHost, caller: &ThreadId, key: Option<String>) -> String {
    use base64::Engine as _;
    use sha2::Digest as _;
    let key = key.unwrap_or_else(crate::store::random_id);
    let digest = sha2::Sha256::digest(format!("{}\n{caller}\n{key}", calling.host_id).as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
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
