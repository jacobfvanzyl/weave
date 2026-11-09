//! The tools the Host offers a thread's agent through the Host MCP server (`weave`), of two
//! kinds:
//!
//! - Client tools, which an attached client runs on its own device (ADR 0009). A call is a
//!   pending request for one client, the one that sent the running turn's latest prompt or
//!   steer; it answers with the tool's result.
//! - Host tools, which the Host answers itself, for the calling thread. Each is a Host protocol
//!   method seen from inside the thread, answered by the same code (ADR 0020): no tool does
//!   what no client request can. They need no client, so they work in headless threads. They
//!   read and act on any thread on the Host (ADR 0023), and start delegated threads: threads
//!   of their own that the calling thread starts. Given `host`, they act on another of the
//!   person's Hosts instead (ADR 0029), through the service that reaches them, the Dispatcher,
//!   as a `service/hostCall`.
//! - Service tools, which a service declares and answers over its own connection (ADR 0027,
//!   WVE-171): agents see them as `<service>__<tool>`, and a call is a `service/toolCall` for
//!   the service that declared it, naming the calling thread.

use std::path::PathBuf;

use agent_client_protocol::JsonRpcNotification;
use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::JsonRpcResponse;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::Empty;
use crate::agents::ListAgentsRequest;
use crate::policy::PermissionPolicy;
use crate::queue::AddQueuedRequest;
use crate::threads::GetThreadRequest;
use crate::threads::ListThreadsRequest;
use crate::threads::RunRequest;
use crate::threads::ThreadId;
use crate::turns::CancelTurnRequest;
use crate::turns::SteerTurnRequest;

/// The [`crate::hello::HelloResponse::features`] entry of a Host that offers client tools.
pub const CLIENT_TOOLS_FEATURE: &str = "clientTools";

/// Put text on the clipboard of the device that sent the turn.
pub const CLIPBOARD_WRITE: &str = "clipboard_write";

/// The Host tool that renames the calling thread, as `thread/rename` does.
pub const RENAME_THREAD: &str = "rename_thread";

/// The Host tool that lists the Host's threads, as `threads/list` does.
pub const LIST_THREADS: &str = "list_threads";

/// The Host tool that reads one thread and its latest turn, as `threads/get` does.
pub const READ_THREAD: &str = "read_thread";

/// The Host tool that starts a delegated thread with a turn, as `thread/run` does.
pub const START_THREAD: &str = "start_thread";

/// The Host tool that sends a thread a prompt, as `queue/add` does.
pub const PROMPT_THREAD: &str = "prompt_thread";

/// The Host tool that steers a thread's running turn, as `turn/steer` does.
pub const STEER_THREAD: &str = "steer_thread";

/// The Host tool that cancels a thread's running turn, as `turn/cancel` does.
pub const CANCEL_THREAD_TURN: &str = "cancel_thread_turn";

/// The Host tool that lists the agents threads can run, as `agents/list` does.
pub const LIST_AGENTS: &str = "list_agents";

/// The Host tool that lists the person's other Hosts and whether each can be reached, as the
/// service that reaches them answers [`HostCall::ListHosts`].
pub const LIST_HOSTS: &str = "list_hosts";

/// The Host tool that lists the person's Projects (WVE-208), as the service that reaches the
/// person's Hosts answers [`HostCall::ListProjects`].
pub const LIST_PROJECTS: &str = "list_projects";

/// The tool kinds a permission policy names, for the tools that take one.
const TOOL_KINDS: [&str; 10] = [
    "read",
    "edit",
    "delete",
    "move",
    "search",
    "execute",
    "think",
    "fetch",
    "switch_mode",
    "other",
];

/// A tool in one of the Host's catalogs, as agents see it in `tools/list`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub name: String,
    pub title: String,
    pub description: String,
    pub input_schema: Value,
}

/// Every client tool the Host defines, in the order agents see them.
pub fn catalog() -> Vec<Tool> {
    vec![Tool {
        name: CLIPBOARD_WRITE.to_owned(),
        title: "Copy to clipboard".to_owned(),
        description: "Put text on the clipboard of the person's device: the device of the \
                      person who sent the current turn. It fails when nobody is connected, as \
                      in a headless run, so don't retry it then."
            .to_owned(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "The text to put on the clipboard."}
            },
            "required": ["text"],
            "additionalProperties": false
        }),
    }]
}

/// Every Host tool the Host defines, in the order agents see them, after the client tools.
pub fn host_catalog() -> Vec<Tool> {
    let thread_id = json!({
        "type": "string",
        "description": "The thread's id, as list_threads or start_thread gave it."
    });
    let key = json!({
        "type": "string",
        "description": "Optional: a name of your choosing, such as a UUID, so that calling again \
                        with the same key after a failure starts nothing twice.",
        "minLength": 1,
        "maxLength": crate::turns::MAX_KEY
    });
    let host = json!({
        "type": "string",
        "description": "Optional: another of the person's weave Hosts, by the id or name \
                        list_hosts gives, to act there instead of on this thread's Host."
    });
    let project = |what: &str| {
        json!({
            "type": "string",
            "description": format!(
                "Optional: one of the person's Projects, by the name or id list_projects \
                 gives, {what}"
            )
        })
    };
    vec![
        rename_thread(),
        Tool {
            name: LIST_HOSTS.to_owned(),
            title: "List the person's other Hosts".to_owned(),
            description: "List the person's other weave Hosts, usually other computers, which \
                          this thread's Host reaches through the person's Dispatcher: each \
                          one's id and name, whether the Dispatcher is connected to it now, and \
                          if not, why: refused (it revoked the Dispatcher), down (its computer \
                          answered but its weave Host didn't), unreachable (nothing answered), \
                          or otherHost. The other tools take one as host, to list, read, start \
                          and prompt threads there. Pairing Hosts with the Dispatcher is the \
                          person's to do. Answers with this Host's id and the Hosts as JSON."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        },
        Tool {
            name: LIST_PROJECTS.to_owned(),
            title: "List the person's Projects".to_owned(),
            description: "List the person's Projects: named pieces of their work, each a git \
                          repository or a directory, with at most one location on each of \
                          their weave Hosts, at whatever path it has there. Each has its id, \
                          name, kind (git or directory), its repository's remote, and its \
                          locations: a Host's id and the path there; hosts gives every Host's \
                          name. start_thread and list_threads take one as project, to work in \
                          it on a Host that has it without knowing its path there. Making and \
                          changing Projects is the person's to do, with `weave projects`. \
                          Answers with this Host's id, the Projects and the Hosts as JSON."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        },
        Tool {
            name: LIST_THREADS.to_owned(),
            title: "List threads".to_owned(),
            description: "List the threads of the weave Host this thread runs in, across \
                          agents and directories, most recently active first: each one's id, \
                          agent, directory, title, whether it is open and running, and which \
                          thread started it. Answers with the Host's threads/list result as \
                          JSON."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "host": host,
                    "project": project("to list only the threads in it on the Host listed: \
                        none where it has no location. Not with cwd or repo."),
                    "agentId": {"type": "string", "description": "Only this agent's threads, \
                        such as claude or codex, with the agent's own history of the directory."},
                    "cwd": {"type": "string", "description": "Only threads in this absolute \
                        directory."},
                    "repo": {"type": "string", "description": "Only threads in this git \
                        repository's worktrees, given by any directory in it. Not with agentId."},
                    "activity": {"type": "string", "enum": ["idle", "running", "waiting"],
                        "description": "Only the open threads doing this: idle, running a \
                        turn, or waiting on a person. Not with agentId."}
                },
                "additionalProperties": false
            }),
        },
        Tool {
            name: LIST_AGENTS.to_owned(),
            title: "List agents".to_owned(),
            description: "List the agents the weave Host can start threads with: each one's \
                          id, name, and what it's for when its configuration says, and which \
                          is the default. Use it to choose an agent for start_thread. Answers \
                          with the Host's agents/list result as JSON."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {"host": host},
                "additionalProperties": false
            }),
        },
        Tool {
            name: READ_THREAD.to_owned(),
            title: "Read a thread".to_owned(),
            description: "Read one thread of the weave Host: how it lists, and its latest \
                          turn, or the one turnId names: the prompt, its state (queued, \
                          running, waiting on a person, or how it ended), and the agent's last \
                          message in it. Use it to read the full answer of a thread you \
                          prompted, or any other thread. Answers with the Host's threads/get \
                          result as JSON."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "host": host,
                    "threadId": thread_id,
                    "turnId": {"type": "string", "description": "Optional: a turn of the \
                        thread, as prompt_thread (its queuedId) or start_thread gave it."}
                },
                "required": ["threadId"],
                "additionalProperties": false
            }),
        },
        Tool {
            name: START_THREAD.to_owned(),
            title: "Start a thread with another agent".to_owned(),
            description: "Hand work to another agent: start a thread with it in the weave Host \
                          and send it a prompt. It works on its own, in a thread people can \
                          watch and answer from their weave clients. This answers once its turn \
                          has started; when the turn ends, you'll get a message saying how it \
                          ended, with the start of the agent's answer, so don't wait or poll for \
                          it. It can approve only the tool kinds your own thread approves. Give \
                          threadId to prompt an existing thread instead of a new one."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "host": host,
                    "agentId": {"type": "string", "description": "The agent to start; \
                        list_agents says which there are and what each is for."},
                    "prompt": {"type": "string", "description": "What to ask of it: everything \
                        it needs to know, since it doesn't see this conversation."},
                    "project": project("to work in its location on the Host it starts on, \
                        which has to have one: in a git Project, the repository's main \
                        checkout."),
                    "cwd": {"type": "string", "description": "The absolute directory it works \
                        in, or one under the home of its Host as ~/…; yours when absent. With \
                        project, a directory inside the Project relative to it instead, such \
                        as app. With host and neither: when your directory is in a Project, \
                        the Project's location there, in the same subdirectory; otherwise the \
                        same directory under the home there, which has to be a checkout of the \
                        same repository: its main checkout when yours is another worktree, \
                        since your branch may not be there."},
                    "threadId": {"type": "string", "description": "An existing thread, to \
                        prompt instead of starting one."},
                    "approve": {
                        "type": "array",
                        "items": {"type": "string", "enum": TOOL_KINDS},
                        "description": "Tool kinds it may use without asking anyone; yours when \
                            absent, and never more than yours."
                    },
                    "otherwise": {
                        "type": "string",
                        "enum": ["ask", "reject"],
                        "description": "What happens to tool calls it doesn't approve: ask the \
                            people attached, or reject them. Yours when absent; it rejects if \
                            you do."
                    },
                    "key": key
                },
                "required": ["agentId", "prompt"],
                "additionalProperties": false
            }),
        },
        Tool {
            name: PROMPT_THREAD.to_owned(),
            title: "Prompt a thread".to_owned(),
            description: "Send a prompt to any open thread of the weave Host, one you started \
                          or another: it starts a turn at once if none runs, or waits in the \
                          thread's queue for the running one to end. When the turn ends, you'll \
                          get a message saying how it ended. Its answer's queuedId names the \
                          turn, for read_thread."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "host": host,
                    "threadId": thread_id,
                    "prompt": {"type": "string", "description": "What to ask of it."},
                    "key": key
                },
                "required": ["threadId", "prompt"],
                "additionalProperties": false
            }),
        },
        Tool {
            name: STEER_THREAD.to_owned(),
            title: "Steer a thread".to_owned(),
            description: "Send a message into the running turn of any thread of the weave Host, \
                          to correct or add to what it's doing, without starting another turn. \
                          If no turn runs, nothing is sent: use prompt_thread instead."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "host": host,
                    "threadId": thread_id,
                    "prompt": {"type": "string", "description": "The message for its turn."}
                },
                "required": ["threadId", "prompt"],
                "additionalProperties": false
            }),
        },
        Tool {
            name: CANCEL_THREAD_TURN.to_owned(),
            title: "Cancel a thread's turn".to_owned(),
            description: "Stop the running turn of any thread of the weave Host. The thread \
                          stays, and can be prompted again."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {"host": host, "threadId": thread_id},
                "required": ["threadId"],
                "additionalProperties": false
            }),
        },
    ]
}

fn rename_thread() -> Tool {
    Tool {
        name: RENAME_THREAD.to_owned(),
        title: "Rename this thread".to_owned(),
        description: "Give this thread a new title: the name people see for it in their \
                      weave thread lists, on every device. Use it when the person asks for a \
                      name, or when the work has moved on and the title misleads. Keep it \
                      short and specific. It doesn't change the title you keep yourself."
            .to_owned(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "The new title, up to 200 characters.",
                    "minLength": 1,
                    "maxLength": crate::threads::MAX_TITLE
                }
            },
            "required": ["title"],
            "additionalProperties": false
        }),
    }
}

/// The [`crate::hello::HelloResponse::features`] entry of a Host that takes service tools.
pub const SERVICE_TOOLS_FEATURE: &str = "serviceTools";

/// The most tools one service declares.
pub const MAX_SERVICE_TOOLS: usize = 64;

/// The longest name agents see for a tool, with the `mcp__weave__` Claude Code puts before it:
/// it leaves out tools whose whole name is longer than 128 characters.
pub const MAX_SERVICE_TOOL_NAME: usize = 128 - "mcp__weave__".len();

/// `service/declareTools`: the tools a service serves, replacing those it declared before
/// (feature `serviceTools`). The Host keeps them, across the service's reconnects and its own
/// restarts, and offers them to the agent of every thread set up from then on, as
/// `<service>__<tool>`; a thread already open keeps the tools it started with. Only a service
/// may declare tools. Each name is letters, digits, `_` and `-`, and the names agents see may
/// be no longer than [`MAX_SERVICE_TOOL_NAME`] nor another service's. Answered with those names.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "service/declareTools", response = DeclareToolsResponse)]
#[serde(rename_all = "camelCase")]
pub struct DeclareToolsRequest {
    pub tools: Vec<Tool>,
    /// The service reaches the person's other Hosts (feature `otherHosts`, ADR 0029): the Host
    /// sends it the Host tool calls that name another Host, as `service/hostCall`, until
    /// another service says so too. Kept with its tools.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hosts: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcResponse)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct DeclareToolsResponse {
    /// The tools' names as agents see them, in order.
    pub names: Vec<String>,
}

/// The thread whose agent calls a service tool.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ToolCaller {
    pub thread_id: ThreadId,
    pub agent_id: String,
    pub cwd: PathBuf,
    /// Its permission policy, which what the call starts should approve no more than.
    pub policy: PermissionPolicy,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
}

/// `service/toolCall`, to the service that declared the tool: a thread's agent called it.
/// The service answers with `service/answerTool`; the agent waits until it does.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcNotification)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[notification(method = "service/toolCall")]
#[serde(rename_all = "camelCase")]
pub struct ToolCallNotification {
    pub call_id: String,
    /// The tool as the service declared it, without its prefix.
    pub tool: String,
    #[serde(default)]
    pub arguments: Map<String, Value>,
    pub caller: ToolCaller,
}

/// What a Host tool call naming another of the person's Hosts asks there: the Host protocol
/// method the tool is, and its request as the calling Host made it, with the directory under
/// the home, the policy within the calling thread's and the request key it worked out. The
/// service names the calling thread as the `caller`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(tag = "method", content = "params")]
pub enum HostCall {
    /// `list_hosts`: the Hosts the service reaches, and whether it's connected to each now.
    #[serde(rename = "hosts/list")]
    ListHosts,
    /// `list_projects`, and what `project` names to the thread tools that take it: the
    /// person's Projects, answered with [`crate::projects::ListedProjects`] (WVE-208).
    #[serde(rename = "projects/list")]
    ListProjects,
    #[serde(rename = "threads/list")]
    ListThreads(ListThreadsRequest),
    #[serde(rename = "agents/list")]
    ListAgents(ListAgentsRequest),
    #[serde(rename = "threads/get")]
    GetThread(GetThreadRequest),
    #[serde(rename = "thread/run")]
    Run(Box<RunRequest>),
    #[serde(rename = "queue/add")]
    Queue(AddQueuedRequest),
    #[serde(rename = "turn/steer")]
    Steer(SteerTurnRequest),
    #[serde(rename = "turn/cancel")]
    Cancel(CancelTurnRequest),
}

/// `service/hostCall` (feature `otherHosts`), to the service that said it reaches the person's
/// Hosts: a thread's agent called a Host tool naming another Host. The service answers with
/// `service/answerTool`, as for a tool call, with the method's answer as JSON text or a tool
/// error; `service/toolCallCancelled` says the agent stopped waiting.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcNotification)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[notification(method = "service/hostCall")]
#[serde(rename_all = "camelCase")]
pub struct HostCallNotification {
    pub call_id: String,
    /// The Host the agent named, by the id or name `list_hosts` gave; absent for
    /// [`HostCall::ListHosts`] and [`HostCall::ListProjects`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    pub call: HostCall,
    pub caller: ToolCaller,
    /// For a call that starts a delegated thread: how many more of the caller's delegated
    /// threads may run on other Hosts, its Host's `[delegation] running` less those running
    /// there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room: Option<u32>,
}

/// `service/toolCallCancelled`: the agent stopped waiting for the call; answering it now does
/// nothing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonRpcNotification)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[notification(method = "service/toolCallCancelled")]
#[serde(rename_all = "camelCase")]
pub struct ToolCallCancelledNotification {
    pub call_id: String,
}

/// `service/answerTool`: the result of a call made to this service, which only it may answer,
/// once.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonRpcRequest)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[request(method = "service/answerTool", response = Empty)]
#[serde(rename_all = "camelCase")]
pub struct AnswerToolRequest {
    pub call_id: String,
    pub result: ClientToolResult,
}

/// A client's answer to a client tool call: MCP's `CallToolResult`, which the agent gets as it
/// is.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ClientToolResult {
    /// MCP content blocks, such as `{"type": "text", "text": "…"}`.
    #[serde(default)]
    pub content: Vec<Value>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_error: bool,
}

impl ClientToolResult {
    /// A result with one text block.
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            content: vec![json!({"type": "text", "text": text.into()})],
            is_error: false,
        }
    }

    /// A failure, with why.
    pub fn error(why: impl Into<String>) -> Self {
        Self {
            is_error: true,
            ..Self::text(why)
        }
    }
}
