//! Shared harness: the real client connected to the fake agent over an in-memory channel.

// Test helpers outside `#[test]` functions fail fast too.
#![allow(clippy::expect_used, dead_code)]

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use agent_client_protocol::Channel;
use tokio::sync::mpsc::UnboundedReceiver;
use weave_acp_core::AgentConnection;
use weave_acp_core::AgentEvent;
use weave_acp_core::ClientOptions;
use weave_acp_core::SessionSetup;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::CreateElicitationRequest;
use weave_acp_core::schema::ElicitationContentValue;
use weave_acp_core::schema::ElicitationId;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::SessionUpdate;
use weave_acp_core::schema::StopReason;
use weave_acp_core::schema::TerminalExitStatus;
use weave_acp_core::schema::TextContent;
use weave_fake_agent::FakeAgentConfig;

pub struct Harness {
    pub connection: AgentConnection,
    pub events: UnboundedReceiver<AgentEvent>,
    pub session_id: SessionId,
    pub dir: tempfile::TempDir,
    /// How the next elicitation is answered.
    pub elicitation_reply: ElicitationReply,
}

pub enum ElicitationReply {
    Accept(Option<BTreeMap<String, ElicitationContentValue>>),
    Decline,
    Cancel,
}

/// What one turn produced, flattened for assertions.
#[derive(Default)]
pub struct TurnLog {
    pub message: String,
    pub updates: Vec<SessionUpdate>,
    pub terminal_output: String,
    pub exits: Vec<TerminalExitStatus>,
    pub elicitations: Vec<CreateElicitationRequest>,
    pub completions: Vec<ElicitationId>,
    pub withdrawals: usize,
    pub stop_reason: Option<StopReason>,
}

impl Harness {
    pub async fn start(options: ClientOptions) -> Self {
        Self::start_with(options, FakeAgentConfig::default()).await
    }

    /// Connect and initialize without opening a session.
    pub async fn connect(
        options: ClientOptions,
        config: FakeAgentConfig,
    ) -> (AgentConnection, UnboundedReceiver<AgentEvent>) {
        let (client_side, agent_side) = Channel::duplex();
        tokio::spawn(weave_fake_agent::serve_with(agent_side, config));
        let (connection, events) = AgentConnection::connect(client_side, options)
            .await
            .expect("connect");
        connection.initialize().await.expect("initialize");
        (connection, events)
    }

    pub async fn start_with(options: ClientOptions, config: FakeAgentConfig) -> Self {
        let (connection, events) = Self::connect(options, config).await;
        let dir = tempfile::tempdir().expect("tempdir");
        let session = connection
            .new_session(&setup_for(&dir))
            .await
            .expect("session/new");
        Self {
            connection,
            events,
            session_id: session.session_id,
            dir,
            elicitation_reply: ElicitationReply::Cancel,
        }
    }

    pub fn setup(&self) -> SessionSetup {
        setup_for(&self.dir)
    }

    pub fn path(&self, name: &str) -> PathBuf {
        self.dir
            .path()
            .canonicalize()
            .expect("canonical tempdir")
            .join(name)
    }

    /// Run one prompt to completion, answering permission requests with `answer`.
    pub async fn turn(&mut self, prompt: &str, answer: &str) -> TurnLog {
        self.connection
            .prompt(
                self.session_id.clone(),
                vec![ContentBlock::Text(TextContent::new(prompt))],
            )
            .expect("prompt");
        let mut log = TurnLog::default();
        let mut held = Vec::new();
        loop {
            let event = tokio::time::timeout(Duration::from_secs(10), self.events.recv())
                .await
                .expect("turn timed out")
                .expect("event stream closed");
            match event {
                AgentEvent::SessionUpdate(notification) => {
                    if let SessionUpdate::AgentMessageChunk(chunk) = &notification.update
                        && let ContentBlock::Text(text) = &chunk.content
                    {
                        log.message.push_str(&text.text);
                    }
                    log.updates.push(notification.update);
                }
                // "hold" leaves the request open until the agent withdraws it.
                AgentEvent::PermissionRequested(request) if answer == "hold" => held.push(request),
                AgentEvent::PermissionRequested(request) => {
                    let option = request
                        .request
                        .options
                        .iter()
                        .find(|option| option.option_id.to_string() == answer)
                        .map(|option| option.option_id.clone())
                        .expect("permission option");
                    request.select(option).expect("answer permission");
                }
                AgentEvent::ElicitationRequested(request) => {
                    log.elicitations.push(request.request.clone());
                    match std::mem::replace(&mut self.elicitation_reply, ElicitationReply::Cancel) {
                        ElicitationReply::Accept(content) => request.accept(content),
                        ElicitationReply::Decline => request.decline(),
                        ElicitationReply::Cancel => request.cancel(),
                    }
                    .expect("answer elicitation");
                }
                AgentEvent::ElicitationCompleted(id) => log.completions.push(id),
                AgentEvent::RequestWithdrawn(key) => {
                    log.withdrawals += 1;
                    if let Some(index) = held.iter().position(|request| request.key == key) {
                        held.remove(index)
                            .withdrawn()
                            .expect("answer withdrawn request");
                    }
                }
                AgentEvent::TerminalOutput { text, .. } => log.terminal_output.push_str(&text),
                AgentEvent::TerminalExited { status, .. } => log.exits.push(status),
                AgentEvent::TurnEnded { result, .. } => {
                    log.stop_reason = Some(result.expect("prompt response").stop_reason);
                    return log;
                }
                AgentEvent::Disconnected(error) => panic!("disconnected: {error:?}"),
            }
        }
    }

    /// Every event already queued, without waiting.
    pub fn drain(&mut self) -> Vec<AgentEvent> {
        std::iter::from_fn(|| self.events.try_recv().ok()).collect()
    }
}

pub fn setup_for(dir: &tempfile::TempDir) -> SessionSetup {
    SessionSetup {
        cwd: dir.path().canonicalize().expect("canonical tempdir"),
        ..SessionSetup::default()
    }
}

/// The text of message chunks among `events`, by kind.
pub fn transcript(events: &[AgentEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::SessionUpdate(notification) => match &notification.update {
                SessionUpdate::UserMessageChunk(chunk) => {
                    Some(format!("user: {}", text_of(&chunk.content)))
                }
                SessionUpdate::AgentMessageChunk(chunk) => {
                    Some(format!("agent: {}", text_of(&chunk.content)))
                }
                _ => None,
            },
            _ => None,
        })
        .collect()
}

fn text_of(content: &ContentBlock) -> String {
    match content {
        ContentBlock::Text(text) => text.text.clone(),
        _ => String::new(),
    }
}
