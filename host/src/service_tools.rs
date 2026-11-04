//! Tools a service declares and answers over its own connection (ADR 0027, WVE-171): how the
//! Dispatcher's tools reach agents without the Host ever connecting to it.
//!
//! - **Declared and kept.** `service/declareTools` replaces a service's tools, kept with its
//!   paired device in `devices.json` ([`crate::devices`]), so they outlast the service's
//!   reconnects and the Host's restarts, and go when it's revoked. Every thread set up after
//!   offers them, as `<service>__<tool>`: the agent's tool list is fixed at setup, so a thread
//!   already open keeps its own.
//! - **Served.** The connection that declared them last serves them: a call is a
//!   `service/toolCall` notification to it, naming the calling thread, and the service answers
//!   with `service/answerTool`. A call while no connection serves them fails at once; one whose
//!   connection ends first fails as one that may have run.
//! - **Host calls.** A Host tool call naming another of the person's Hosts (ADR 0029) goes the
//!   same way to the service that said it reaches them, as a `service/hostCall`.

use std::collections::HashMap;
use std::sync::Mutex;

use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use serde_json::Map;
use serde_json::Value;
use tokio::sync::oneshot;
use weave_host_protocol::HostClient;
use weave_host_protocol::devices::DeviceId;
use weave_host_protocol::tools::ClientToolResult;
use weave_host_protocol::tools::HostCall;
use weave_host_protocol::tools::HostCallNotification;
use weave_host_protocol::tools::MAX_SERVICE_TOOL_NAME;
use weave_host_protocol::tools::MAX_SERVICE_TOOLS;
use weave_host_protocol::tools::Tool;
use weave_host_protocol::tools::ToolCallCancelledNotification;
use weave_host_protocol::tools::ToolCallNotification;
use weave_host_protocol::tools::ToolCaller;

use crate::session::ClientId;
use crate::session::Summary;
use crate::session::lock;

/// A service's tool as a thread offers it: the name agents see, the service's own name for it,
/// and the service that answers it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Offered {
    pub(crate) tool: Tool,
    pub(crate) own: String,
    pub(crate) service: DeviceId,
    /// The service's name, for the errors agents see.
    pub(crate) service_name: String,
}

/// The connections serving services' tools, and the calls waiting on them.
#[derive(Default)]
pub(crate) struct ServiceTools {
    serving: Mutex<HashMap<DeviceId, (ClientId, ConnectionTo<HostClient>)>>,
    calls: Mutex<HashMap<String, Waiting>>,
}

struct Waiting {
    service: DeviceId,
    client: ClientId,
    reply: oneshot::Sender<ClientToolResult>,
}

impl ServiceTools {
    /// The connection `client`, of the service `service`, serves its tools from now on.
    pub(crate) fn serve(&self, service: &str, client: ClientId, cx: ConnectionTo<HostClient>) {
        lock(&self.serving).insert(service.to_owned(), (client, cx));
    }

    /// The connection `client` ended: it serves nothing, and calls it hadn't answered fail.
    pub(crate) fn disconnected(&self, client: ClientId) {
        lock(&self.serving).retain(|_, (serving, _)| *serving != client);
        let failed: Vec<Waiting> = lock(&self.calls)
            .extract_if(|_, waiting| waiting.client == client)
            .map(|(_, waiting)| waiting)
            .collect();
        for waiting in failed {
            let _ = waiting.reply.send(ClientToolResult::error(
                "The service went away before answering; the call may have run.",
            ));
        }
    }

    /// Call `offered` for `caller` with `arguments`: the service's answer, or why there's none.
    pub(crate) async fn call(
        &self,
        offered: &Offered,
        arguments: Map<String, Value>,
        caller: ToolCaller,
        cancelled: impl Future<Output = ()>,
    ) -> Option<ClientToolResult> {
        let sent = Sent::Tool(ToolCallNotification {
            call_id: String::new(),
            tool: offered.own.clone(),
            arguments,
            caller,
        });
        let what = format!("{} can't run now", offered.tool.name);
        self.ask(
            &offered.service,
            &offered.service_name,
            &what,
            sent,
            cancelled,
        )
        .await
    }

    /// Pass `call`, a Host tool call naming `host`, to the service `service`, named `name`,
    /// that reaches the person's Hosts: its answer, or why there's none.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn call_host(
        &self,
        service: &DeviceId,
        name: &str,
        host: Option<String>,
        call: HostCall,
        caller: ToolCaller,
        room: Option<u32>,
        cancelled: impl Future<Output = ()>,
    ) -> Option<ClientToolResult> {
        let sent = Sent::Host(HostCallNotification {
            call_id: String::new(),
            host,
            call,
            caller,
            room,
        });
        let what = "this Host can't reach the person's other Hosts now";
        self.ask(service, name, what, sent, cancelled).await
    }

    /// Send `sent` to `service`, named `name`, and wait for its answer; or say `what` can't
    /// happen, and why.
    async fn ask(
        &self,
        service: &DeviceId,
        name: &str,
        what: &str,
        mut sent: Sent,
        cancelled: impl Future<Output = ()>,
    ) -> Option<ClientToolResult> {
        let serving = lock(&self.serving).get(service).cloned();
        let Some((client, cx)) = serving else {
            return Some(ClientToolResult::error(format!(
                "{name} isn't connected to this Host, so {what}."
            )));
        };
        let call_id = crate::devices::random_id(12);
        let (reply, answered) = oneshot::channel();
        lock(&self.calls).insert(
            call_id.clone(),
            Waiting {
                service: service.clone(),
                client,
                reply,
            },
        );
        let sent = match &mut sent {
            Sent::Tool(notification) => {
                notification.call_id.clone_from(&call_id);
                cx.send_notification(notification.clone())
            }
            Sent::Host(notification) => {
                notification.call_id.clone_from(&call_id);
                cx.send_notification(notification.clone())
            }
        };
        if sent.is_err() {
            lock(&self.calls).remove(&call_id);
            return Some(ClientToolResult::error(format!(
                "{name} went away, so {what}."
            )));
        }
        tokio::select! {
            answer = answered => Some(answer.unwrap_or_else(|_| {
                ClientToolResult::error("The Host stopped before the service answered.")
            })),
            () = cancelled => {
                lock(&self.calls).remove(&call_id);
                let _ = cx.send_notification(ToolCallCancelledNotification { call_id });
                None
            }
        }
    }

    /// `service/answerTool`: `service`'s answer to the call `call_id`, which was made to it.
    pub(crate) fn answer(
        &self,
        service: &str,
        call_id: &str,
        result: ClientToolResult,
    ) -> Result<(), Error> {
        let mut calls = lock(&self.calls);
        match calls.get(call_id) {
            Some(waiting) if waiting.service == service => {}
            _ => {
                return Err(Error::invalid_params().data(format!(
                    "no call {call_id} waits on this service: it was answered, cancelled or \
                     made to another"
                )));
            }
        }
        if let Some(waiting) = calls.remove(call_id) {
            let _ = waiting.reply.send(result);
        }
        Ok(())
    }
}

/// The session `summary` lists as a service hears of it calling.
pub(crate) fn caller(summary: &Summary) -> ToolCaller {
    ToolCaller {
        session_id: summary.session_id.clone(),
        agent_id: summary.agent_id.clone(),
        cwd: summary.cwd.clone(),
        policy: summary.policy.clone(),
        labels: summary.labels.clone(),
    }
}

/// What a call to a service sends it.
enum Sent {
    Tool(ToolCallNotification),
    Host(HostCallNotification),
}

/// What a service named `name` puts before its tools' names: its name lowercased, with
/// anything but letters and digits made `_`.
pub(crate) fn prefix(name: &str) -> String {
    let slug: String = name
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    if slug.is_empty() {
        "service".to_owned()
    } else {
        slug
    }
}

/// `tools` as agents see them for the service `prefix`, or why they can't be declared.
pub(crate) fn named(prefix: &str, tools: &[Tool]) -> Result<Vec<String>, String> {
    if tools.len() > MAX_SERVICE_TOOLS {
        return Err(format!(
            "a service declares at most {MAX_SERVICE_TOOLS} tools, not {}",
            tools.len()
        ));
    }
    let mut names: Vec<String> = Vec::new();
    for tool in tools {
        let name = &tool.name;
        if name.is_empty()
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(format!(
                "a tool's name is letters, digits, _ and - only: {name:?}"
            ));
        }
        let seen = format!("{prefix}__{name}");
        if seen.len() > MAX_SERVICE_TOOL_NAME {
            return Err(format!(
                "{seen} is longer than the {MAX_SERVICE_TOOL_NAME} characters agents take"
            ));
        }
        if names.contains(&seen) {
            return Err(format!("{name} is declared twice"));
        }
        names.push(seen);
    }
    Ok(names)
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use serde_json::json;

    use super::*;

    fn tool(name: &str) -> Tool {
        Tool {
            name: name.to_owned(),
            title: name.to_owned(),
            description: String::new(),
            input_schema: json!({"type": "object"}),
        }
    }

    #[test]
    fn a_services_tools_are_named_for_it_and_fit_agents_limits() {
        assert_eq!(prefix("Dispatcher"), "dispatcher");
        assert_eq!(prefix("Jaco's bot"), "jaco_s_bot");
        assert_eq!(
            named("dispatcher", &[tool("add_schedule"), tool("list-bots")]),
            Ok(vec![
                "dispatcher__add_schedule".to_owned(),
                "dispatcher__list-bots".to_owned()
            ])
        );
        assert!(named("dispatcher", &[tool("has space")]).is_err());
        assert!(named("dispatcher", &[tool("")]).is_err());
        assert!(named("dispatcher", &[tool("twice"), tool("twice")]).is_err());
        let long = "x".repeat(MAX_SERVICE_TOOL_NAME);
        assert!(named("dispatcher", &[tool(&long)]).is_err());
        let many: Vec<Tool> = (0..=MAX_SERVICE_TOOLS)
            .map(|n| tool(&format!("t{n}")))
            .collect();
        assert!(named("dispatcher", &many).is_err());
    }
}
