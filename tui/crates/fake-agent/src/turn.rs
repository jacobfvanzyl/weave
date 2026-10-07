//! One prompt turn: the script its first word selects. Every update it sends is also
//! recorded in the session's history for `session/load` to replay.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use agent_client_protocol::Client;
use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use agent_client_protocol::schema::v1::BooleanPropertySchema;
use agent_client_protocol::schema::v1::ClientCapabilities;
use agent_client_protocol::schema::v1::CompleteElicitationNotification;
use agent_client_protocol::schema::v1::ContentBlock;
use agent_client_protocol::schema::v1::ContentChunk;
use agent_client_protocol::schema::v1::CreateElicitationRequest;
use agent_client_protocol::schema::v1::CreateTerminalRequest;
use agent_client_protocol::schema::v1::Diff;
use agent_client_protocol::schema::v1::ElicitationAction;
use agent_client_protocol::schema::v1::ElicitationContentValue;
use agent_client_protocol::schema::v1::ElicitationFormMode;
use agent_client_protocol::schema::v1::ElicitationSchema;
use agent_client_protocol::schema::v1::ElicitationSessionScope;
use agent_client_protocol::schema::v1::ElicitationUrlMode;
use agent_client_protocol::schema::v1::EnumOption;
use agent_client_protocol::schema::v1::IntegerPropertySchema;
use agent_client_protocol::schema::v1::KillTerminalRequest;
use agent_client_protocol::schema::v1::McpServer;
use agent_client_protocol::schema::v1::MultiSelectPropertySchema;
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
use agent_client_protocol::schema::v1::SessionId;
use agent_client_protocol::schema::v1::SessionInfoUpdate;
use agent_client_protocol::schema::v1::SessionNotification;
use agent_client_protocol::schema::v1::SessionUpdate;
use agent_client_protocol::schema::v1::StopReason;
use agent_client_protocol::schema::v1::StringPropertySchema;
use agent_client_protocol::schema::v1::Terminal;
use agent_client_protocol::schema::v1::TerminalOutputRequest;
use agent_client_protocol::schema::v1::ToolCall;
use agent_client_protocol::schema::v1::ToolCallContent;
use agent_client_protocol::schema::v1::ToolCallLocation;
use agent_client_protocol::schema::v1::ToolCallStatus;
use agent_client_protocol::schema::v1::ToolCallUpdate;
use agent_client_protocol::schema::v1::ToolCallUpdateFields;
use agent_client_protocol::schema::v1::ToolKind;
use agent_client_protocol::schema::v1::WaitForTerminalExitRequest;
use agent_client_protocol::schema::v1::WriteTextFileRequest;

use crate::lock;
use crate::state::Cancellation;
use crate::state::State;
use crate::state::now;

static TOOL_CALLS: AtomicU64 = AtomicU64::new(1);

fn next_tool_call_id() -> String {
    format!("call-{}", TOOL_CALLS.fetch_add(1, Ordering::Relaxed))
}

pub(crate) struct Turn {
    pub session_id: SessionId,
    pub client: ClientCapabilities,
    pub cancel: Arc<Cancellation>,
    pub mcp_servers: Vec<McpServer>,
    pub state: Arc<Mutex<State>>,
}

impl Turn {
    pub async fn run(
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
        let text = text.trim().to_owned();
        self.record(SessionUpdate::UserMessageChunk(ContentChunk::new(
            ContentBlock::from(text.clone()),
        )));
        self.name_session(cx, &text)?;

        let (command, rest) = text.split_once(char::is_whitespace).unwrap_or((&text, ""));
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
            "ask" => self.ask(cx).await?,
            "connect" => self.connect(cx).await?,
            "mcp" => self.list_mcp_servers(cx).await?,
            _ => self.say(cx, &format!("You said: {text}")).await?,
        }

        let state = lock(&self.state);
        state.persist();
        let stop_reason = if self.cancel.is_cancelled() {
            StopReason::Cancelled
        } else {
            StopReason::EndTurn
        };
        Ok(PromptResponse::new(stop_reason))
    }

    /// Append to the session's replayable history.
    fn record(&self, update: SessionUpdate) {
        let mut state = lock(&self.state);
        if let Some(session) = state.stored_mut(&self.session_id) {
            session.history.push(update);
            session.updated_at = now();
        }
    }

    /// Title an untitled session after its first prompt, as agents typically do.
    fn name_session(&self, cx: &ConnectionTo<Client>, prompt: &str) -> Result<(), Error> {
        let title: String = prompt.chars().take(40).collect();
        let named = {
            let mut state = lock(&self.state);
            match state.stored_mut(&self.session_id) {
                Some(session) if session.title.is_none() => {
                    session.title = Some(title.clone());
                    true
                }
                _ => false,
            }
        };
        if named {
            let info = SessionInfoUpdate::new().title(title).updated_at(now());
            notify(cx, &self.session_id, SessionUpdate::SessionInfoUpdate(info))?;
        }
        Ok(())
    }

    fn update(&self, cx: &ConnectionTo<Client>, update: SessionUpdate) -> Result<(), Error> {
        self.record(update.clone());
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
        // A replay has no live terminal to show, so its history carries the output as text,
        // recorded ahead of the final status so it is in place when the call completes.
        let transcript = ContentBlock::from(output.output.clone());
        self.record(SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            id.clone(),
            ToolCallUpdateFields::new().content(vec![transcript.into()]),
        )));
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

    /// Form elicitation covering every supported field type.
    async fn ask(&self, cx: &ConnectionTo<Client>) -> Result<(), Error> {
        let supported = self
            .client
            .elicitation
            .as_ref()
            .is_some_and(|elicitation| elicitation.form.is_some());
        if !supported {
            return self
                .say(cx, "The client does not offer form elicitation.")
                .await;
        }
        let colors = ["red", "green", "blue"]
            .map(|color| EnumOption::new(color, capitalize(color)))
            .to_vec();
        let toppings = ["cheese", "olives", "basil"]
            .map(|topping| EnumOption::new(topping, capitalize(topping)))
            .to_vec();
        let schema = ElicitationSchema::new()
            .title("About you")
            .property(
                "name",
                StringPropertySchema::new().title("Name").min_length(1),
                true,
            )
            .property(
                "age",
                IntegerPropertySchema::new()
                    .title("Age")
                    .minimum(0)
                    .maximum(150),
                false,
            )
            .property(
                "color",
                StringPropertySchema::new()
                    .title("Favorite color")
                    .one_of(colors),
                false,
            )
            .property(
                "subscribe",
                BooleanPropertySchema::new()
                    .title("Subscribe")
                    .default_value(true),
                false,
            )
            .property(
                "toppings",
                MultiSelectPropertySchema::titled(toppings).title("Toppings"),
                false,
            );
        let request = CreateElicitationRequest::new(
            ElicitationFormMode::new(
                ElicitationSessionScope::new(self.session_id.clone()),
                schema,
            ),
            "Tell me a little about yourself.",
        );
        match cx.send_request(request).block_task().await?.action {
            ElicitationAction::Accept(accepted) => {
                let content = accepted.content.unwrap_or_default();
                let summary = content
                    .iter()
                    .map(|(name, value)| format!("{name}={}", describe(value)))
                    .collect::<Vec<_>>()
                    .join(", ");
                self.say(cx, &format!("Thanks! You told me: {summary}."))
                    .await
            }
            ElicitationAction::Decline => self.say(cx, "You declined to answer.").await,
            _ => self.say(cx, "You dismissed the question.").await,
        }
    }

    /// URL elicitation, completed out of band a moment after the user consents.
    async fn connect(&self, cx: &ConnectionTo<Client>) -> Result<(), Error> {
        let supported = self
            .client
            .elicitation
            .as_ref()
            .is_some_and(|elicitation| elicitation.url.is_some());
        if !supported {
            return self
                .say(cx, "The client does not offer URL elicitation.")
                .await;
        }
        let elicitation_id = format!("connect-{}", next_tool_call_id());
        let request = CreateElicitationRequest::new(
            ElicitationUrlMode::new(
                ElicitationSessionScope::new(self.session_id.clone()),
                elicitation_id.clone(),
                "https://example.com/oauth/authorize?client=weave-fake-agent",
            ),
            "Connect your Example account.",
        );
        match cx.send_request(request).block_task().await?.action {
            ElicitationAction::Accept(_) => {
                self.say(cx, "Waiting for you to finish connecting… ")
                    .await?;
                if self.cancel.sleep(Duration::from_millis(800)).await {
                    return Ok(());
                }
                cx.send_notification(CompleteElicitationNotification::new(elicitation_id))?;
                self.say(cx, "Connected.").await
            }
            ElicitationAction::Decline => self.say(cx, "You declined to connect.").await,
            _ => self.say(cx, "You dismissed the connection request.").await,
        }
    }

    async fn list_mcp_servers(&self, cx: &ConnectionTo<Client>) -> Result<(), Error> {
        if self.mcp_servers.is_empty() {
            return self.say(cx, "The client sent no MCP servers.").await;
        }
        let servers = self
            .mcp_servers
            .iter()
            .map(|server| match server {
                McpServer::Stdio(server) => {
                    format!("{} (stdio {})", server.name, server.command.display())
                }
                McpServer::Http(server) => format!("{} (http {})", server.name, server.url),
                McpServer::Sse(server) => format!("{} (sse {})", server.name, server.url),
                _ => "an MCP server of an unknown transport".to_owned(),
            })
            .collect::<Vec<_>>()
            .join("; ");
        self.say(cx, &format!("MCP servers: {servers}.")).await
    }
}

fn capitalize(word: &str) -> String {
    let mut chars = word.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

fn describe(value: &ElicitationContentValue) -> String {
    match value {
        ElicitationContentValue::String(text) => text.clone(),
        ElicitationContentValue::Integer(number) => number.to_string(),
        ElicitationContentValue::Number(number) => number.to_string(),
        ElicitationContentValue::Boolean(flag) => flag.to_string(),
        ElicitationContentValue::StringArray(items) => format!("[{}]", items.join(" ")),
        _ => "?".to_owned(),
    }
}

pub(crate) fn notify(
    cx: &ConnectionTo<Client>,
    session_id: &SessionId,
    update: SessionUpdate,
) -> Result<(), Error> {
    cx.send_notification(SessionNotification::new(session_id.clone(), update))
}
