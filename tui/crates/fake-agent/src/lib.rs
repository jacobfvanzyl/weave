//! A scripted ACP v1 agent that exercises the client end to end, in tests and in the real TUI.
//!
//! A prompt's first word picks a script:
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
//! | anything else | echoes the prompt |
//!
//! Sessions offer modes plus `mode`, grouped `model`, and (when the client supports it)
//! boolean `verbose` config options.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use agent_client_protocol::Agent;
use agent_client_protocol::Client;
use agent_client_protocol::ConnectTo;
use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use agent_client_protocol::schema::v1::AgentCapabilities;
use agent_client_protocol::schema::v1::AvailableCommand;
use agent_client_protocol::schema::v1::AvailableCommandInput;
use agent_client_protocol::schema::v1::AvailableCommandsUpdate;
use agent_client_protocol::schema::v1::CancelNotification;
use agent_client_protocol::schema::v1::ClientCapabilities;
use agent_client_protocol::schema::v1::ContentBlock;
use agent_client_protocol::schema::v1::ContentChunk;
use agent_client_protocol::schema::v1::CreateTerminalRequest;
use agent_client_protocol::schema::v1::Diff;
use agent_client_protocol::schema::v1::Implementation;
use agent_client_protocol::schema::v1::InitializeRequest;
use agent_client_protocol::schema::v1::InitializeResponse;
use agent_client_protocol::schema::v1::KillTerminalRequest;
use agent_client_protocol::schema::v1::NewSessionRequest;
use agent_client_protocol::schema::v1::NewSessionResponse;
use agent_client_protocol::schema::v1::PermissionOption;
use agent_client_protocol::schema::v1::PermissionOptionKind;
use agent_client_protocol::schema::v1::Plan;
use agent_client_protocol::schema::v1::PlanEntry;
use agent_client_protocol::schema::v1::PlanEntryPriority;
use agent_client_protocol::schema::v1::PlanEntryStatus;
use agent_client_protocol::schema::v1::PromptRequest;
use agent_client_protocol::schema::v1::PromptResponse;
use agent_client_protocol::schema::v1::ReadTextFileRequest;
use agent_client_protocol::schema::v1::ReleaseTerminalRequest;
use agent_client_protocol::schema::v1::RequestPermissionOutcome;
use agent_client_protocol::schema::v1::RequestPermissionRequest;
use agent_client_protocol::schema::v1::SessionConfigOption;
use agent_client_protocol::schema::v1::SessionConfigOptionCategory;
use agent_client_protocol::schema::v1::SessionConfigOptionValue;
use agent_client_protocol::schema::v1::SessionConfigSelectGroup;
use agent_client_protocol::schema::v1::SessionConfigSelectOption;
use agent_client_protocol::schema::v1::SessionId;
use agent_client_protocol::schema::v1::SessionMode;
use agent_client_protocol::schema::v1::SessionModeState;
use agent_client_protocol::schema::v1::SessionNotification;
use agent_client_protocol::schema::v1::SessionUpdate;
use agent_client_protocol::schema::v1::SetSessionConfigOptionRequest;
use agent_client_protocol::schema::v1::SetSessionConfigOptionResponse;
use agent_client_protocol::schema::v1::SetSessionModeRequest;
use agent_client_protocol::schema::v1::SetSessionModeResponse;
use agent_client_protocol::schema::v1::StopReason;
use agent_client_protocol::schema::v1::Terminal;
use agent_client_protocol::schema::v1::TerminalOutputRequest;
use agent_client_protocol::schema::v1::ToolCall;
use agent_client_protocol::schema::v1::ToolCallContent;
use agent_client_protocol::schema::v1::ToolCallLocation;
use agent_client_protocol::schema::v1::ToolCallStatus;
use agent_client_protocol::schema::v1::ToolCallUpdate;
use agent_client_protocol::schema::v1::ToolCallUpdateFields;
use agent_client_protocol::schema::v1::ToolKind;
use agent_client_protocol::schema::v1::UnstructuredCommandInput;
use agent_client_protocol::schema::v1::WaitForTerminalExitRequest;
use agent_client_protocol::schema::v1::WriteTextFileRequest;
use tokio::sync::Notify;

const MODES: [(&str, &str); 2] = [("ask", "Ask"), ("code", "Code")];
/// A model group: id, display name, and its `(id, name)` models.
type ModelGroup = (
    &'static str,
    &'static str,
    &'static [(&'static str, &'static str)],
);

const MODELS: [ModelGroup; 2] = [
    ("fast", "Fast", &[("small", "Small")]),
    ("smart", "Smart", &[("large", "Large"), ("huge", "Huge")]),
];

/// Serve one client until it disconnects.
pub async fn serve(transport: impl ConnectTo<Agent> + 'static) -> Result<(), Error> {
    let state = Arc::new(Mutex::new(State::default()));
    let on_init = Arc::clone(&state);
    let on_new = Arc::clone(&state);
    let on_mode = Arc::clone(&state);
    let on_config = Arc::clone(&state);
    let on_prompt = Arc::clone(&state);
    let on_cancel = state;
    Agent
        .builder()
        .name("weave-fake-agent")
        .on_receive_request(
            async move |request: InitializeRequest, responder, _cx| {
                lock(&on_init).client = request.client_capabilities;
                responder.respond(
                    InitializeResponse::new(request.protocol_version)
                        .agent_capabilities(AgentCapabilities::new())
                        .agent_info(
                            Implementation::new("weave-fake-agent", env!("CARGO_PKG_VERSION"))
                                .title("Fake Agent"),
                        ),
                )
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: NewSessionRequest, responder, cx: ConnectionTo<Client>| {
                let (session_id, response) = lock(&on_new).new_session();
                responder.respond(response)?;
                let commands = AvailableCommandsUpdate::new(commands());
                notify(
                    &cx,
                    &session_id,
                    SessionUpdate::AvailableCommandsUpdate(commands),
                )
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: SetSessionModeRequest, responder, _cx| {
                let mut state = lock(&on_mode);
                let Some(session) = state.sessions.get_mut(&request.session_id) else {
                    return responder
                        .respond_with_error(Error::invalid_params().data("unknown session"));
                };
                if !MODES
                    .iter()
                    .any(|(id, _)| *id == request.mode_id.to_string())
                {
                    return responder
                        .respond_with_error(Error::invalid_params().data("unknown mode"));
                }
                session.mode = request.mode_id.to_string();
                responder.respond(SetSessionModeResponse::new())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: SetSessionConfigOptionRequest, responder, _cx| {
                let mut state = lock(&on_config);
                let booleans = state.client_supports_booleans();
                let Some(session) = state.sessions.get_mut(&request.session_id) else {
                    return responder
                        .respond_with_error(Error::invalid_params().data("unknown session"));
                };
                match session.set(&request.config_id.to_string(), &request.value, booleans) {
                    Ok(()) => responder.respond(SetSessionConfigOptionResponse::new(
                        session.config_options(booleans),
                    )),
                    Err(error) => responder.respond_with_error(error),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: PromptRequest, responder, cx: ConnectionTo<Client>| {
                let Some(turn) = lock(&on_prompt).start_turn(&request.session_id) else {
                    return responder
                        .respond_with_error(Error::invalid_params().data("unknown session"));
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
                if let Some(session) = lock(&on_cancel).sessions.get(&notification.session_id) {
                    session.cancel.cancelled.store(true, Ordering::SeqCst);
                    session.cancel.notify.notify_waiters();
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .connect_to(transport)
        .await
}

#[derive(Default)]
struct State {
    client: ClientCapabilities,
    sessions: HashMap<SessionId, Session>,
    next_session: u64,
}

impl State {
    fn client_supports_booleans(&self) -> bool {
        self.client
            .session
            .as_ref()
            .and_then(|session| session.config_options.as_ref())
            .is_some_and(|config| config.boolean.is_some())
    }

    fn new_session(&mut self) -> (SessionId, NewSessionResponse) {
        self.next_session += 1;
        let session_id = SessionId::new(format!("fake-session-{}", self.next_session));
        let session = Session::default();
        let booleans = self.client_supports_booleans();
        let modes = SessionModeState::new(
            session.mode.clone(),
            MODES
                .iter()
                .map(|(id, name)| SessionMode::new(*id, *name))
                .collect(),
        );
        let response = NewSessionResponse::new(session_id.clone())
            .modes(modes)
            .config_options(session.config_options(booleans));
        self.sessions.insert(session_id.clone(), session);
        (session_id, response)
    }

    fn start_turn(&self, session_id: &SessionId) -> Option<Turn> {
        let session = self.sessions.get(session_id)?;
        session.cancel.cancelled.store(false, Ordering::SeqCst);
        Some(Turn {
            session_id: session_id.clone(),
            client: self.client.clone(),
            cancel: Arc::clone(&session.cancel),
        })
    }
}

struct Session {
    mode: String,
    model: String,
    verbose: bool,
    cancel: Arc<Cancellation>,
}

impl Default for Session {
    fn default() -> Self {
        Self {
            mode: "ask".to_owned(),
            model: "small".to_owned(),
            verbose: false,
            cancel: Arc::new(Cancellation::default()),
        }
    }
}

impl Session {
    fn config_options(&self, booleans: bool) -> Vec<SessionConfigOption> {
        let modes = MODES
            .iter()
            .map(|(id, name)| SessionConfigSelectOption::new(*id, *name))
            .collect::<Vec<_>>();
        let models = MODELS
            .iter()
            .map(|(group, name, models)| {
                let options = models
                    .iter()
                    .map(|(id, name)| SessionConfigSelectOption::new(*id, *name))
                    .collect();
                SessionConfigSelectGroup::new(*group, *name, options)
            })
            .collect::<Vec<_>>();
        let mut options = vec![
            SessionConfigOption::select("mode", "Mode", self.mode.clone(), modes)
                .category(SessionConfigOptionCategory::Mode),
            SessionConfigOption::select("model", "Model", self.model.clone(), models)
                .category(SessionConfigOptionCategory::Model),
        ];
        if booleans {
            options.push(SessionConfigOption::boolean(
                "verbose",
                "Verbose",
                self.verbose,
            ));
        }
        options
    }

    fn set(
        &mut self,
        config_id: &str,
        value: &SessionConfigOptionValue,
        booleans: bool,
    ) -> Result<(), Error> {
        let invalid = || Error::invalid_params().data(format!("invalid value for {config_id}"));
        match (config_id, value) {
            ("mode", SessionConfigOptionValue::ValueId { value })
                if MODES.iter().any(|(id, _)| *id == value.to_string()) =>
            {
                self.mode = value.to_string();
            }
            ("model", SessionConfigOptionValue::ValueId { value })
                if MODELS.iter().any(|(_, _, models)| {
                    models.iter().any(|(id, _)| *id == value.to_string())
                }) =>
            {
                self.model = value.to_string();
            }
            ("verbose", SessionConfigOptionValue::Boolean { value }) if booleans => {
                self.verbose = *value
            }
            _ => return Err(invalid()),
        }
        Ok(())
    }
}

#[derive(Default)]
struct Cancellation {
    cancelled: AtomicBool,
    notify: Notify,
}

impl Cancellation {
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Sleep unless cancelled first. Returns whether the turn was cancelled.
    async fn sleep(&self, duration: Duration) -> bool {
        let notified = self.notify.notified();
        if self.is_cancelled() {
            return true;
        }
        tokio::select! {
            () = notified => true,
            () = tokio::time::sleep(duration) => self.is_cancelled(),
        }
    }
}

struct Turn {
    session_id: SessionId,
    client: ClientCapabilities,
    cancel: Arc<Cancellation>,
}

static TOOL_CALLS: AtomicU64 = AtomicU64::new(1);

fn next_tool_call_id() -> String {
    format!("call-{}", TOOL_CALLS.fetch_add(1, Ordering::Relaxed))
}

impl Turn {
    async fn run(
        self,
        cx: &ConnectionTo<Client>,
        request: PromptRequest,
    ) -> Result<PromptResponse, Error> {
        let text = request
            .prompt
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text(text) => Some(text.text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(" ");
        let text = text.trim();
        let (command, rest) = text.split_once(char::is_whitespace).unwrap_or((text, ""));
        let rest = rest.trim();
        // Advertised commands arrive as `/name …`; bare names work too.
        let command = command.strip_prefix('/').unwrap_or(command);
        match command {
            "read" => self.read(cx, rest).await?,
            "write" => self.write(cx, rest).await?,
            "run" => self.run_command(cx, rest, None, None).await?,
            "run-limited" => {
                let (limit, command) = rest.split_once(' ').unwrap_or(("0", ""));
                self.run_command(cx, command, limit.parse().ok(), None)
                    .await?;
            }
            "kill-after" => {
                let (delay, command) = rest.split_once(' ').unwrap_or(("0", ""));
                let delay = delay.parse().map(Duration::from_millis).ok();
                self.run_command(cx, command, None, delay).await?;
            }
            "plan" => self.plan(cx).await?,
            "slow" => self.slow(cx, rest.parse().unwrap_or(20)).await?,
            _ => self.say(cx, &format!("You said: {text}")).await?,
        }
        let stop_reason = if self.cancel.is_cancelled() {
            StopReason::Cancelled
        } else {
            StopReason::EndTurn
        };
        Ok(PromptResponse::new(stop_reason))
    }

    fn update(&self, cx: &ConnectionTo<Client>, update: SessionUpdate) -> Result<(), Error> {
        notify(cx, &self.session_id, update)
    }

    /// Stream `text` as a message, a few words per chunk.
    async fn say(&self, cx: &ConnectionTo<Client>, text: &str) -> Result<(), Error> {
        let words: Vec<&str> = text.split_inclusive(' ').collect();
        for chunk in words.chunks(3) {
            let chunk = ContentChunk::new(ContentBlock::from(chunk.concat()));
            self.update(cx, SessionUpdate::AgentMessageChunk(chunk))?;
        }
        Ok(())
    }

    fn finish_tool(
        &self,
        cx: &ConnectionTo<Client>,
        id: &str,
        fields: ToolCallUpdateFields,
    ) -> Result<(), Error> {
        self.update(
            cx,
            SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(id.to_owned(), fields)),
        )
    }

    async fn read(&self, cx: &ConnectionTo<Client>, path: &str) -> Result<(), Error> {
        if !self.client.fs.read_text_file {
            return self
                .say(cx, "The client does not offer fs/read_text_file.")
                .await;
        }
        let id = next_tool_call_id();
        self.update(
            cx,
            SessionUpdate::ToolCall(
                ToolCall::new(id.clone(), format!("Read {path}"))
                    .kind(ToolKind::Read)
                    .status(ToolCallStatus::InProgress)
                    .locations(vec![ToolCallLocation::new(path)]),
            ),
        )?;
        let request = ReadTextFileRequest::new(self.session_id.clone(), path);
        match cx.send_request(request).block_task().await {
            Ok(response) => {
                let lines = response.content.lines().count();
                self.finish_tool(
                    cx,
                    &id,
                    ToolCallUpdateFields::new()
                        .status(ToolCallStatus::Completed)
                        .content(vec![ContentBlock::from(response.content).into()]),
                )?;
                self.say(cx, &format!("Read {lines} lines from {path}."))
                    .await
            }
            Err(error) => {
                self.finish_tool(
                    cx,
                    &id,
                    ToolCallUpdateFields::new().status(ToolCallStatus::Failed),
                )?;
                self.say(cx, &format!("Reading failed: {error}")).await
            }
        }
    }

    async fn write(&self, cx: &ConnectionTo<Client>, args: &str) -> Result<(), Error> {
        if !self.client.fs.write_text_file {
            return self
                .say(cx, "The client does not offer fs/write_text_file.")
                .await;
        }
        let (path, content) = args.split_once(' ').unwrap_or((args, ""));
        let content = format!("{content}\n");
        let id = next_tool_call_id();
        let title = format!("Write {path}");
        self.update(
            cx,
            SessionUpdate::ToolCall(
                ToolCall::new(id.clone(), title.clone())
                    .kind(ToolKind::Edit)
                    .status(ToolCallStatus::Pending)
                    .locations(vec![ToolCallLocation::new(path)]),
            ),
        )?;
        let permission = RequestPermissionRequest::new(
            self.session_id.clone(),
            ToolCallUpdate::new(id.clone(), ToolCallUpdateFields::new().title(title)),
            vec![
                PermissionOption::new("allow", "Allow", PermissionOptionKind::AllowOnce),
                PermissionOption::new("reject", "Reject", PermissionOptionKind::RejectOnce),
            ],
        );
        let allowed = match cx.send_request(permission).block_task().await?.outcome {
            RequestPermissionOutcome::Selected(selected) => {
                selected.option_id.to_string() == "allow"
            }
            _ => false,
        };
        if !allowed {
            self.finish_tool(
                cx,
                &id,
                ToolCallUpdateFields::new().status(ToolCallStatus::Failed),
            )?;
            if !self.cancel.is_cancelled() {
                self.say(cx, "Permission was not granted.").await?;
            }
            return Ok(());
        }

        let old_text = if self.client.fs.read_text_file {
            let read = ReadTextFileRequest::new(self.session_id.clone(), path);
            cx.send_request(read)
                .block_task()
                .await
                .ok()
                .map(|response| response.content)
        } else {
            None
        };
        let write = WriteTextFileRequest::new(self.session_id.clone(), path, content.clone());
        match cx.send_request(write).block_task().await {
            Ok(_) => {
                let diff = Diff::new(path, content).old_text(old_text);
                self.finish_tool(
                    cx,
                    &id,
                    ToolCallUpdateFields::new()
                        .status(ToolCallStatus::Completed)
                        .content(vec![ToolCallContent::Diff(diff)]),
                )?;
                self.say(cx, &format!("Wrote {path}.")).await
            }
            Err(error) => {
                self.finish_tool(
                    cx,
                    &id,
                    ToolCallUpdateFields::new().status(ToolCallStatus::Failed),
                )?;
                self.say(cx, &format!("Writing failed: {error}")).await
            }
        }
    }

    async fn run_command(
        &self,
        cx: &ConnectionTo<Client>,
        command: &str,
        output_byte_limit: Option<u64>,
        kill_after: Option<Duration>,
    ) -> Result<(), Error> {
        if !self.client.terminal {
            return self.say(cx, "The client does not offer terminals.").await;
        }
        let create = CreateTerminalRequest::new(self.session_id.clone(), command)
            .output_byte_limit(output_byte_limit);
        let terminal_id = cx.send_request(create).block_task().await?.terminal_id;
        let id = next_tool_call_id();
        self.update(
            cx,
            SessionUpdate::ToolCall(
                ToolCall::new(id.clone(), format!("Run {command}"))
                    .kind(ToolKind::Execute)
                    .status(ToolCallStatus::InProgress)
                    .content(vec![ToolCallContent::Terminal(Terminal::new(
                        terminal_id.clone(),
                    ))]),
            ),
        )?;

        let deadline = kill_after.unwrap_or(Duration::MAX);
        let wait = cx
            .send_request(WaitForTerminalExitRequest::new(
                self.session_id.clone(),
                terminal_id.clone(),
            ))
            .block_task();
        let notified = self.cancel.notify.notified();
        let status = tokio::select! {
            status = wait => Some(status?.exit_status),
            () = tokio::time::sleep(deadline) => None,
            () = notified => None,
        };
        if status.is_none() {
            let kill = KillTerminalRequest::new(self.session_id.clone(), terminal_id.clone());
            cx.send_request(kill).block_task().await?;
        }
        let output = cx
            .send_request(TerminalOutputRequest::new(
                self.session_id.clone(),
                terminal_id.clone(),
            ))
            .block_task()
            .await?;
        let status = match status.or(output.exit_status.clone()) {
            Some(status) => status,
            None => {
                let wait =
                    WaitForTerminalExitRequest::new(self.session_id.clone(), terminal_id.clone());
                cx.send_request(wait).block_task().await?.exit_status
            }
        };
        cx.send_request(ReleaseTerminalRequest::new(
            self.session_id.clone(),
            terminal_id,
        ))
        .block_task()
        .await?;

        let succeeded = status.exit_code == Some(0);
        let tool_status = if succeeded {
            ToolCallStatus::Completed
        } else {
            ToolCallStatus::Failed
        };
        self.finish_tool(cx, &id, ToolCallUpdateFields::new().status(tool_status))?;
        if self.cancel.is_cancelled() {
            return Ok(());
        }
        let ending = match (status.exit_code, &status.signal) {
            (Some(code), _) => format!("exited with code {code}"),
            (None, Some(signal)) => format!("was stopped by {signal}"),
            (None, None) => "ended".to_owned(),
        };
        let truncated = if output.truncated { " (truncated)" } else { "" };
        let bytes = output.output.len();
        self.say(
            cx,
            &format!("The command {ending} after {bytes} bytes of output{truncated}."),
        )
        .await
    }

    async fn plan(&self, cx: &ConnectionTo<Client>) -> Result<(), Error> {
        let steps = ["Inspect the code", "Make the change", "Verify it"];
        for done in 0..=steps.len() {
            let entries = steps
                .iter()
                .enumerate()
                .map(|(index, step)| {
                    let status = match index.cmp(&done) {
                        std::cmp::Ordering::Less => PlanEntryStatus::Completed,
                        std::cmp::Ordering::Equal => PlanEntryStatus::InProgress,
                        std::cmp::Ordering::Greater => PlanEntryStatus::Pending,
                    };
                    PlanEntry::new(*step, PlanEntryPriority::Medium, status)
                })
                .collect();
            self.update(cx, SessionUpdate::Plan(Plan::new(entries)))?;
            if self.cancel.sleep(Duration::from_millis(150)).await {
                return Ok(());
            }
        }
        self.say(cx, "All steps are done.").await
    }

    async fn slow(&self, cx: &ConnectionTo<Client>, chunks: u32) -> Result<(), Error> {
        for chunk in 1..=chunks {
            if self.cancel.is_cancelled() {
                return Ok(());
            }
            let text = ContentBlock::from(format!("Chunk {chunk} of {chunks}.\n"));
            self.update(
                cx,
                SessionUpdate::AgentMessageChunk(ContentChunk::new(text)),
            )?;
            if self.cancel.sleep(Duration::from_millis(200)).await {
                return Ok(());
            }
        }
        Ok(())
    }
}

fn commands() -> Vec<AvailableCommand> {
    let command =
        |name: &str, description: &str, hint: Option<&str>| {
            AvailableCommand::new(name, description).input(hint.map(|hint| {
                AvailableCommandInput::Unstructured(UnstructuredCommandInput::new(hint))
            }))
        };
    vec![
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
    ]
}

fn notify(
    cx: &ConnectionTo<Client>,
    session_id: &SessionId,
    update: SessionUpdate,
) -> Result<(), Error> {
    cx.send_notification(SessionNotification::new(session_id.clone(), update))
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
