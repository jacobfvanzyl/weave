//! A scripted ACP v1 agent that exercises the client end to end, in tests and in the real TUI.
//!
//! A prompt's first word picks a script (a leading `/` is accepted, as slash commands send):
//!
//! | Prompt | Script |
//! | --- | --- |
//! | `read <path>` | `fs/read_text_file` inside a read tool call |
//! | `write <path> <text>` | permission request, then `fs/write_text_file` with a diff |
//! | `run <shell command>` | `terminal/create` embedded in a tool call, waited for and released |
//! | `run-limited <bytes> <command>` | `run` with an output byte limit |
//! | `kill-after <ms> <command>` | `run` that kills the command after a delay |
//! | `plan` | a plan whose entries progress |
//! | `slow <n>` | `n` message chunks, slowly, honoring cancellation |
//! | `ask` | a form elicitation using every field type |
//! | `connect` | a URL elicitation, completed shortly after consent |
//! | `mcp` | lists the MCP servers the session was given |
//! | `think` | thought chunks, then a message |
//! | `delegate` | two subagents (draft RFD) that report work in their own sessions |
//! | `delegate-legacy` | the same in the RFD's earlier draft, as some adapters send it |
//! | `compact` | a context compaction with a streamed summary (Preview), when the client asks for them |
//! | `switch-mode` | an agent-initiated mode change (`current_mode_update`, `config_option_update`) |
//! | `withdraw` | a permission request withdrawn with `$/cancel_request` |
//! | `extension` | a `_`-prefixed request (expects "method not found") and notification |
//!
//! Echoed prompts also list any non-text content blocks they carried.
//! | anything else | echoes the prompt |
//!
//! It supports the whole v1 session lifecycle (new, load with replay, resume, list with
//! pagination, close, delete), config options and modes, `agent` and `terminal` sign-in, and
//! logout. With a state file, sessions and sign-in survive across processes.

mod state;
mod turn;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use agent_client_protocol::Agent;
use agent_client_protocol::Client;
use agent_client_protocol::ConnectTo;
use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use agent_client_protocol::schema::v1::AgentAuthCapabilities;
use agent_client_protocol::schema::v1::AgentCapabilities;
use agent_client_protocol::schema::v1::AuthMethod;
use agent_client_protocol::schema::v1::AuthMethodAgent;
use agent_client_protocol::schema::v1::AuthMethodTerminal;
use agent_client_protocol::schema::v1::AuthenticateRequest;
use agent_client_protocol::schema::v1::AuthenticateResponse;
use agent_client_protocol::schema::v1::AvailableCommand;
use agent_client_protocol::schema::v1::AvailableCommandInput;
use agent_client_protocol::schema::v1::AvailableCommandsUpdate;
use agent_client_protocol::schema::v1::CancelNotification;
use agent_client_protocol::schema::v1::CloseSessionRequest;
use agent_client_protocol::schema::v1::CloseSessionResponse;
use agent_client_protocol::schema::v1::ContentBlock;
use agent_client_protocol::schema::v1::ContentChunk;
use agent_client_protocol::schema::v1::DeleteSessionRequest;
use agent_client_protocol::schema::v1::DeleteSessionResponse;
use agent_client_protocol::schema::v1::Implementation;
use agent_client_protocol::schema::v1::InitializeRequest;
use agent_client_protocol::schema::v1::InitializeResponse;
use agent_client_protocol::schema::v1::ListSessionsRequest;
use agent_client_protocol::schema::v1::ListSessionsResponse;
use agent_client_protocol::schema::v1::LoadSessionRequest;
use agent_client_protocol::schema::v1::LoadSessionResponse;
use agent_client_protocol::schema::v1::LogoutCapabilities;
use agent_client_protocol::schema::v1::LogoutRequest;
use agent_client_protocol::schema::v1::LogoutResponse;
use agent_client_protocol::schema::v1::McpCapabilities;
use agent_client_protocol::schema::v1::NewSessionRequest;
use agent_client_protocol::schema::v1::NewSessionResponse;
use agent_client_protocol::schema::v1::PromptCapabilities;
use agent_client_protocol::schema::v1::PromptRequest;
use agent_client_protocol::schema::v1::ResumeSessionRequest;
use agent_client_protocol::schema::v1::ResumeSessionResponse;
use agent_client_protocol::schema::v1::SessionAdditionalDirectoriesCapabilities;
use agent_client_protocol::schema::v1::SessionCapabilities;
use agent_client_protocol::schema::v1::SessionCloseCapabilities;
use agent_client_protocol::schema::v1::SessionDeleteCapabilities;
use agent_client_protocol::schema::v1::SessionId;
use agent_client_protocol::schema::v1::SessionInfo;
use agent_client_protocol::schema::v1::SessionListCapabilities;
use agent_client_protocol::schema::v1::SessionResumeCapabilities;
use agent_client_protocol::schema::v1::SessionUpdate;
use agent_client_protocol::schema::v1::SetSessionConfigOptionRequest;
use agent_client_protocol::schema::v1::SetSessionConfigOptionResponse;
use agent_client_protocol::schema::v1::SetSessionModeRequest;
use agent_client_protocol::schema::v1::SetSessionModeResponse;
use agent_client_protocol::schema::v1::UnstructuredCommandInput;

use crate::state::Settings;
use crate::state::State;
use crate::state::StoredSession;
pub use crate::state::interactive_login;
use crate::state::new_session_id;
use crate::state::now;
use crate::turn::Turn;
use crate::turn::notify;

/// How a fake agent instance behaves.
#[derive(Clone, Debug)]
pub struct FakeAgentConfig {
    /// Persist sessions and sign-in here, so later processes see them.
    pub state_path: Option<PathBuf>,
    /// Refuse session work with `auth_required` until a sign-in method succeeds.
    pub require_auth: bool,
    /// Sessions per `session/list` page.
    pub page_size: usize,
    /// Advertise only what every agent must support, to check a client gates the rest.
    pub minimal: bool,
}

impl Default for FakeAgentConfig {
    fn default() -> Self {
        Self {
            state_path: None,
            require_auth: false,
            page_size: 20,
            minimal: false,
        }
    }
}

impl FakeAgentConfig {
    /// `WEAVE_FAKE_AGENT_STATE`, `WEAVE_FAKE_AGENT_REQUIRE_AUTH=1`, `WEAVE_FAKE_AGENT_PAGE_SIZE`.
    pub fn from_env() -> Self {
        let defaults = Self::default();
        Self {
            state_path: std::env::var_os("WEAVE_FAKE_AGENT_STATE").map(PathBuf::from),
            require_auth: std::env::var("WEAVE_FAKE_AGENT_REQUIRE_AUTH")
                .is_ok_and(|value| value == "1"),
            page_size: std::env::var("WEAVE_FAKE_AGENT_PAGE_SIZE")
                .ok()
                .and_then(|size| size.parse().ok())
                .unwrap_or(defaults.page_size),
            minimal: std::env::var("WEAVE_FAKE_AGENT_MINIMAL").is_ok_and(|value| value == "1"),
        }
    }
}

/// Serve one client until it disconnects, configured from the environment.
pub async fn serve(transport: impl ConnectTo<Agent> + 'static) -> Result<(), Error> {
    serve_with(transport, FakeAgentConfig::from_env()).await
}

pub async fn serve_with(
    transport: impl ConnectTo<Agent> + 'static,
    config: FakeAgentConfig,
) -> Result<(), Error> {
    let state = Arc::new(Mutex::new(State::new(config)));
    let on_init = Arc::clone(&state);
    let on_auth = Arc::clone(&state);
    let on_logout = Arc::clone(&state);
    let on_new = Arc::clone(&state);
    let on_load = Arc::clone(&state);
    let on_resume = Arc::clone(&state);
    let on_list = Arc::clone(&state);
    let on_close = Arc::clone(&state);
    let on_delete = Arc::clone(&state);
    let on_mode = Arc::clone(&state);
    let on_config = Arc::clone(&state);
    let on_prompt = Arc::clone(&state);
    let on_cancel = state;
    Agent
        .builder()
        .name("weave-fake-agent")
        .on_receive_request(
            async move |request: InitializeRequest, responder, _cx| {
                let mut state = lock(&on_init);
                state.client = request.client_capabilities;
                let mut methods = vec![AuthMethod::Agent(
                    AuthMethodAgent::new("token", "Token").description("Sign in immediately"),
                )];
                if state.client.auth.terminal {
                    methods.push(AuthMethod::Terminal(
                        AuthMethodTerminal::new("terminal-login", "Terminal login")
                            .description("Confirm sign-in in a terminal")
                            .args(vec!["--login".to_owned()])
                            .env(std::collections::HashMap::from([(
                                "WEAVE_FAKE_LOGIN".to_owned(),
                                "1".to_owned(),
                            )])),
                    ));
                }
                let capabilities = if state.config.minimal {
                    AgentCapabilities::new()
                } else {
                    AgentCapabilities::new()
                        .load_session(true)
                        .prompt_capabilities(
                            PromptCapabilities::new()
                                .image(true)
                                .audio(true)
                                .embedded_context(true),
                        )
                        .mcp_capabilities(McpCapabilities::new().http(true))
                        .auth(AgentAuthCapabilities::new().logout(LogoutCapabilities::new()))
                        .session_capabilities(
                            SessionCapabilities::new()
                                .list(SessionListCapabilities::new())
                                .resume(SessionResumeCapabilities::new())
                                .close(SessionCloseCapabilities::new())
                                .delete(SessionDeleteCapabilities::new())
                                .additional_directories(
                                    SessionAdditionalDirectoriesCapabilities::new(),
                                ),
                        )
                };
                responder.respond(
                    InitializeResponse::new(request.protocol_version)
                        .agent_capabilities(capabilities)
                        .auth_methods(methods)
                        .agent_info(
                            Implementation::new("weave-fake-agent", env!("CARGO_PKG_VERSION"))
                                .title("Fake Agent"),
                        ),
                )
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: AuthenticateRequest, responder, _cx| {
                let mut state = lock(&on_auth);
                if request.method_id.to_string() != "token" {
                    return responder.respond_with_error(
                        Error::invalid_params().data("unknown or non-agent method"),
                    );
                }
                state.authenticated = true;
                state.persist();
                responder.respond(AuthenticateResponse::new())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: LogoutRequest, responder, _cx| {
                let mut state = lock(&on_logout);
                state.authenticated = false;
                state.persist();
                responder.respond(LogoutResponse::new())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: NewSessionRequest, responder, cx: ConnectionTo<Client>| {
                let session_id = {
                    let mut state = lock(&on_new);
                    if let Err(error) = state.require_auth() {
                        return responder.respond_with_error(error);
                    }
                    let session_id = new_session_id();
                    state.sessions.push(StoredSession {
                        id: session_id.to_string(),
                        cwd: request.cwd,
                        title: None,
                        updated_at: now(),
                        history: Vec::new(),
                    });
                    let (modes, options) = state.open(&session_id, request.mcp_servers);
                    state.persist();
                    responder.respond(
                        NewSessionResponse::new(session_id.clone())
                            .modes(modes)
                            .config_options(options),
                    )?;
                    session_id
                };
                advertise_commands(&cx, &session_id)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: LoadSessionRequest, responder, cx: ConnectionTo<Client>| {
                let mut state = lock(&on_load);
                if let Err(error) = state.require_auth() {
                    return responder.respond_with_error(error);
                }
                let Some(history) = state
                    .stored(&request.session_id)
                    .map(|session| session.history.clone())
                else {
                    return responder.respond_with_error(Error::resource_not_found(Some(
                        request.session_id.to_string(),
                    )));
                };
                // Replay everything before responding, as the protocol requires. Compactions
                // go only to a client that asked for them.
                let compaction = state.client_supports_compaction();
                for update in history {
                    let update = match update {
                        SessionUpdate::CompactionUpdate(_) if !compaction => {
                            SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::from(
                                "Context compacted.",
                            )))
                        }
                        update => update,
                    };
                    notify(&cx, &request.session_id, update)?;
                }
                let (modes, options) = state.open(&request.session_id, request.mcp_servers);
                responder.respond(
                    LoadSessionResponse::new()
                        .modes(modes)
                        .config_options(options),
                )?;
                advertise_commands(&cx, &request.session_id)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: ResumeSessionRequest, responder, cx: ConnectionTo<Client>| {
                let mut state = lock(&on_resume);
                if let Err(error) = state.require_auth() {
                    return responder.respond_with_error(error);
                }
                if state.stored(&request.session_id).is_none() {
                    return responder.respond_with_error(Error::resource_not_found(Some(
                        request.session_id.to_string(),
                    )));
                }
                let (modes, options) = state.open(&request.session_id, request.mcp_servers);
                responder.respond(
                    ResumeSessionResponse::new()
                        .modes(modes)
                        .config_options(options),
                )?;
                advertise_commands(&cx, &request.session_id)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: ListSessionsRequest, responder, _cx| {
                let state = lock(&on_list);
                if let Err(error) = state.require_auth() {
                    return responder.respond_with_error(error);
                }
                let mut sessions: Vec<&StoredSession> = state
                    .sessions
                    .iter()
                    .filter(|session| request.cwd.as_ref().is_none_or(|cwd| *cwd == session.cwd))
                    .collect();
                sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
                let Some(start) = request
                    .cursor
                    .as_deref()
                    .map_or(Some(0), |cursor| cursor.parse::<usize>().ok())
                else {
                    return responder
                        .respond_with_error(Error::invalid_params().data("invalid cursor"));
                };
                let page_size = state.config.page_size.max(1);
                let page = sessions
                    .iter()
                    .skip(start)
                    .take(page_size)
                    .map(|session| {
                        SessionInfo::new(session.id.clone(), session.cwd.clone())
                            .title(session.title.clone())
                            .updated_at(session.updated_at.clone())
                    })
                    .collect();
                let next =
                    (start + page_size < sessions.len()).then(|| (start + page_size).to_string());
                responder.respond(ListSessionsResponse::new(page).next_cursor(next))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: CloseSessionRequest, responder, _cx| {
                let mut state = lock(&on_close);
                match state.live.remove(&request.session_id) {
                    // Closing cancels any running turn, as session/cancel would.
                    Some(session) => {
                        session.cancel.cancel();
                        responder.respond(CloseSessionResponse::new())
                    }
                    None => responder
                        .respond_with_error(Error::invalid_params().data("session is not active")),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: DeleteSessionRequest, responder, _cx| {
                let mut state = lock(&on_delete);
                let id = request.session_id.to_string();
                state.sessions.retain(|session| session.id != id);
                if let Some(session) = state.live.remove(&request.session_id) {
                    session.cancel.cancel();
                }
                state.persist();
                responder.respond(DeleteSessionResponse::new())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: SetSessionModeRequest, responder, _cx| {
                let mut state = lock(&on_mode);
                let Some(session) = state.live.get_mut(&request.session_id) else {
                    return responder
                        .respond_with_error(Error::invalid_params().data("unknown session"));
                };
                if !Settings::is_mode(&request.mode_id.to_string()) {
                    return responder
                        .respond_with_error(Error::invalid_params().data("unknown mode"));
                }
                session.settings.mode = request.mode_id.to_string();
                responder.respond(SetSessionModeResponse::new())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: SetSessionConfigOptionRequest, responder, _cx| {
                let mut state = lock(&on_config);
                let booleans = state.client_supports_booleans();
                let Some(session) = state.live.get_mut(&request.session_id) else {
                    return responder
                        .respond_with_error(Error::invalid_params().data("unknown session"));
                };
                match session
                    .settings
                    .set(&request.config_id.to_string(), &request.value, booleans)
                {
                    Ok(()) => responder.respond(SetSessionConfigOptionResponse::new(
                        session.settings.config_options(booleans),
                    )),
                    Err(error) => responder.respond_with_error(error),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: PromptRequest, responder, cx: ConnectionTo<Client>| {
                let turn = {
                    let state = lock(&on_prompt);
                    let Some(session) = state.live.get(&request.session_id) else {
                        return responder.respond_with_error(
                            Error::invalid_params().data("session is not active"),
                        );
                    };
                    session.cancel.reset();
                    Turn {
                        session_id: request.session_id.clone(),
                        client: state.client.clone(),
                        cancel: Arc::clone(&session.cancel),
                        mcp_servers: session.mcp_servers.clone(),
                        state: Arc::clone(&on_prompt),
                    }
                };
                let script_cx = cx.clone();
                cx.spawn(async move {
                    responder.respond_with_result(turn.run(&script_cx, request).await)
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_notification(
            async move |notification: CancelNotification, _cx| {
                if let Some(session) = lock(&on_cancel).live.get(&notification.session_id) {
                    session.cancel.cancel();
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .connect_to(transport)
        .await
}

fn advertise_commands(cx: &ConnectionTo<Client>, session_id: &SessionId) -> Result<(), Error> {
    let command =
        |name: &str, description: &str, hint: Option<&str>| {
            AvailableCommand::new(name, description).input(hint.map(|hint| {
                AvailableCommandInput::Unstructured(UnstructuredCommandInput::new(hint))
            }))
        };
    let commands = vec![
        command(
            "read",
            "Read a file through the client",
            Some("absolute path"),
        ),
        command(
            "write",
            "Write a file through the client",
            Some("absolute path, then text"),
        ),
        command(
            "run",
            "Run a shell command in a client terminal",
            Some("shell command"),
        ),
        command(
            "kill-after",
            "Run a command and kill it after a delay",
            Some("milliseconds, then command"),
        ),
        command("plan", "Show a plan that progresses", None),
        command("slow", "Stream chunks slowly", Some("number of chunks")),
        command("ask", "Ask a few questions with a form", None),
        command("connect", "Connect an account through a URL", None),
        command("mcp", "List the MCP servers this session has", None),
        command("think", "Reason out loud, then answer", None),
        command("compact", "Compact the context, keeping a summary", None),
        command("delegate", "Delegate to two subagents", None),
        command(
            "delegate-legacy",
            "Delegate in the subagent RFD's earlier draft",
            None,
        ),
        command(
            "switch-mode",
            "Switch modes on the agent's own initiative",
            None,
        ),
        command(
            "withdraw",
            "Ask permission, then withdraw the request",
            None,
        ),
        command(
            "extension",
            "Send the client an extension request and notification",
            None,
        ),
    ];
    notify(
        cx,
        session_id,
        SessionUpdate::AvailableCommandsUpdate(AvailableCommandsUpdate::new(commands)),
    )
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
