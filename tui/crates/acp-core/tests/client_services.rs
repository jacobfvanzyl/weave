//! The client's ACP services against the scripted fake agent, over an in-memory transport.

// Test helpers outside `#[test]` functions fail fast too.
#![allow(clippy::expect_used)]

use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;

use agent_client_protocol::Channel;
use pretty_assertions::assert_eq;
use tokio::sync::mpsc::UnboundedReceiver;
use weave_acp_core::AgentConnection;
use weave_acp_core::AgentEvent;
use weave_acp_core::ClientOptions;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::SessionConfigKind;
use weave_acp_core::schema::SessionConfigOption;
use weave_acp_core::schema::SessionConfigOptionValue;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::SessionUpdate;
use weave_acp_core::schema::StopReason;
use weave_acp_core::schema::TerminalExitStatus;
use weave_acp_core::schema::TextContent;
use weave_acp_core::schema::ToolCallContent;

struct Harness {
    connection: AgentConnection,
    events: UnboundedReceiver<AgentEvent>,
    session_id: SessionId,
    dir: tempfile::TempDir,
}

/// What one turn produced, flattened for assertions.
#[derive(Default)]
struct TurnLog {
    message: String,
    updates: Vec<SessionUpdate>,
    terminal_output: String,
    exits: Vec<TerminalExitStatus>,
    stop_reason: Option<StopReason>,
}

impl Harness {
    async fn start(options: ClientOptions) -> Self {
        let (client_side, agent_side) = Channel::duplex();
        tokio::spawn(weave_fake_agent::serve(agent_side));
        let (connection, events) = AgentConnection::connect(client_side, options)
            .await
            .expect("connect");
        connection.initialize().await.expect("initialize");
        let dir = tempfile::tempdir().expect("tempdir");
        let cwd = dir.path().canonicalize().expect("canonical tempdir");
        let session = connection.new_session(cwd).await.expect("session/new");
        Self {
            connection,
            events,
            session_id: session.session_id,
            dir,
        }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir
            .path()
            .canonicalize()
            .expect("canonical tempdir")
            .join(name)
    }

    /// Run one prompt to completion, answering permission requests with `answer`.
    async fn turn(&mut self, prompt: &str, answer: &str) -> TurnLog {
        self.connection
            .prompt(
                self.session_id.clone(),
                vec![ContentBlock::Text(TextContent::new(prompt))],
            )
            .expect("prompt");
        let mut log = TurnLog::default();
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
}

fn diffs(log: &TurnLog) -> Vec<(PathBuf, Option<String>, String)> {
    log.updates
        .iter()
        .filter_map(|update| match update {
            SessionUpdate::ToolCallUpdate(update) => update.fields.content.clone(),
            _ => None,
        })
        .flatten()
        .filter_map(|content| match content {
            ToolCallContent::Diff(diff) => Some((diff.path, diff.old_text, diff.new_text)),
            _ => None,
        })
        .collect()
}

fn current_value(options: &[SessionConfigOption], id: &str) -> String {
    let option = options
        .iter()
        .find(|option| option.id.to_string() == id)
        .expect("option");
    match &option.kind {
        SessionConfigKind::Select(select) => select.current_value.to_string(),
        SessionConfigKind::Boolean(boolean) => boolean.current_value.to_string(),
        _ => panic!("unexpected option kind"),
    }
}

#[tokio::test]
async fn writes_create_parent_directories_and_reads_return_the_content() {
    let mut harness = Harness::start(ClientOptions::default()).await;
    let path = harness.path("nested/notes.txt");

    let log = harness
        .turn(&format!("write {} hello world", path.display()), "allow")
        .await;
    assert_eq!(log.stop_reason, Some(StopReason::EndTurn));
    assert_eq!(
        std::fs::read_to_string(&path).expect("written"),
        "hello world\n"
    );
    // The file did not exist, so the agent's read failed and the diff has no old text.
    assert_eq!(
        diffs(&log),
        [(path.clone(), None, "hello world\n".to_owned())]
    );

    let log = harness
        .turn(&format!("read {}", path.display()), "allow")
        .await;
    assert!(log.message.contains("Read 1 lines"), "{}", log.message);
}

#[tokio::test]
async fn a_rejected_write_never_touches_the_disk() {
    let mut harness = Harness::start(ClientOptions::default()).await;
    let path = harness.path("untouched.txt");

    let log = harness
        .turn(&format!("write {} nope", path.display()), "reject")
        .await;
    assert!(
        log.message.contains("Permission was not granted"),
        "{}",
        log.message
    );
    assert!(!path.exists());
}

#[tokio::test]
async fn relative_paths_are_rejected() {
    let mut harness = Harness::start(ClientOptions::default()).await;
    let log = harness.turn("read relative.txt", "allow").await;
    assert!(
        log.message.contains("path must be absolute"),
        "{}",
        log.message
    );
}

#[tokio::test]
async fn terminals_stream_output_and_report_exit() {
    let mut harness = Harness::start(ClientOptions::default()).await;
    let log = harness
        .turn("run printf 'one\\ntwo\\n'; exit 3", "allow")
        .await;

    assert_eq!(log.terminal_output, "one\ntwo\n");
    assert_eq!(log.exits.len(), 1);
    assert_eq!(log.exits[0].exit_code, Some(3));
    assert!(
        log.message.contains("exited with code 3 after 8 bytes"),
        "{}",
        log.message
    );
}

#[tokio::test]
async fn slash_commands_arrive_as_prompt_text() {
    let mut harness = Harness::start(ClientOptions::default()).await;
    let log = harness.turn("/run echo via-slash", "allow").await;
    assert_eq!(log.terminal_output, "via-slash\n");
}

#[tokio::test]
async fn commands_default_to_the_session_directory() {
    let mut harness = Harness::start(ClientOptions::default()).await;
    let log = harness.turn("run pwd", "allow").await;
    let cwd = harness
        .dir
        .path()
        .canonicalize()
        .expect("canonical tempdir");
    assert_eq!(Path::new(log.terminal_output.trim()), cwd);
}

#[tokio::test]
async fn output_limits_keep_the_newest_bytes_at_a_character_boundary() {
    let mut harness = Harness::start(ClientOptions::default()).await;
    // 7 bytes: a, é (2), 日 (3), b. Keeping 5 would start inside é, so 4 remain: 日b.
    let log = harness.turn("run-limited 5 printf 'aé日b'", "allow").await;
    assert!(
        log.message.contains("after 4 bytes of output (truncated)"),
        "{}",
        log.message
    );
}

#[tokio::test]
async fn killing_a_command_stops_its_whole_process_group() {
    let mut harness = Harness::start(ClientOptions::default()).await;
    let started = Instant::now();
    // A background child shares the group; a unique duration finds any survivor.
    let log = harness
        .turn("kill-after 200 sleep 31.4159 & sleep 31.4159", "allow")
        .await;

    assert!(started.elapsed() < Duration::from_secs(5));
    let survivors = std::process::Command::new("pgrep")
        .args(["-f", "sleep 31.4159"])
        .output()
        .expect("pgrep");
    assert!(
        survivors.stdout.is_empty(),
        "left running: {}",
        String::from_utf8_lossy(&survivors.stdout)
    );
    assert_eq!(log.exits.len(), 1);
    assert_eq!(log.exits[0].signal.as_deref(), Some("SIGKILL"));
    assert!(
        log.message.contains("was stopped by SIGKILL"),
        "{}",
        log.message
    );
}

#[tokio::test]
async fn withheld_services_are_not_advertised() {
    let options = ClientOptions {
        read_files: false,
        write_files: false,
        terminals: false,
    };
    let mut harness = Harness::start(options).await;
    let log = harness.turn("run echo hi", "allow").await;
    assert!(
        log.message.contains("does not offer terminals"),
        "{}",
        log.message
    );
    let log = harness.turn("write /tmp/never.txt x", "allow").await;
    assert!(
        log.message.contains("does not offer fs/write_text_file"),
        "{}",
        log.message
    );
}

#[tokio::test]
async fn config_options_and_modes_round_trip() {
    let harness = Harness::start(ClientOptions::default()).await;
    let handle = harness.connection.handle();
    let session = harness.session_id.clone();

    let options = handle
        .set_config_option(
            session.clone(),
            "model".into(),
            SessionConfigOptionValue::value_id("large"),
        )
        .await
        .expect("set model");
    assert_eq!(current_value(&options, "model"), "large");

    // Boolean options exist only because the client advertised support for them.
    let options = handle
        .set_config_option(
            session.clone(),
            "verbose".into(),
            SessionConfigOptionValue::boolean(true),
        )
        .await
        .expect("set verbose");
    assert_eq!(current_value(&options, "verbose"), "true");

    let invalid = handle
        .set_config_option(
            session.clone(),
            "model".into(),
            SessionConfigOptionValue::value_id("nope"),
        )
        .await;
    assert!(invalid.is_err());

    handle
        .set_mode(session, "code".into())
        .await
        .expect("set mode");
}

#[tokio::test]
async fn cancelling_ends_the_turn_as_cancelled() {
    let mut harness = Harness::start(ClientOptions::default()).await;
    harness
        .connection
        .prompt(
            harness.session_id.clone(),
            vec![ContentBlock::Text(TextContent::new("slow 50"))],
        )
        .expect("prompt");
    let mut cancelled = false;
    loop {
        let event = tokio::time::timeout(Duration::from_secs(10), harness.events.recv())
            .await
            .expect("timed out")
            .expect("closed");
        match event {
            AgentEvent::SessionUpdate(_) if !cancelled => {
                harness
                    .connection
                    .cancel(harness.session_id.clone())
                    .expect("cancel");
                cancelled = true;
            }
            AgentEvent::TurnEnded { result, .. } => {
                assert_eq!(result.expect("response").stop_reason, StopReason::Cancelled);
                return;
            }
            _ => {}
        }
    }
}
