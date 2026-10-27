//! Render snapshots: how every ACP v1 `session/update` kind and every interactive prompt
//! looks, both in the transcript (scrollback) and in the live viewport.
//!
//! Review changes with `cargo insta review` (or `INSTA_UPDATE=always cargo test` and diff).

use std::path::PathBuf;

use crate::events::ChatEvent;
use crate::session_picker::listing;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use weave_acp_core::schema::AvailableCommand;
use weave_acp_core::schema::AvailableCommandInput;
use weave_acp_core::schema::AvailableCommandsUpdate;
use weave_acp_core::schema::BooleanPropertySchema;
use weave_acp_core::schema::ConfigOptionUpdate;
use weave_acp_core::schema::ContentChunk;
use weave_acp_core::schema::CreateElicitationRequest;
use weave_acp_core::schema::CurrentModeUpdate;
use weave_acp_core::schema::Diff;
use weave_acp_core::schema::ElicitationFormMode;
use weave_acp_core::schema::ElicitationSchema;
use weave_acp_core::schema::ElicitationSessionScope;
use weave_acp_core::schema::ElicitationUrlMode;
use weave_acp_core::schema::EnumOption;
use weave_acp_core::schema::IntegerPropertySchema;
use weave_acp_core::schema::MessageId;
use weave_acp_core::schema::MultiSelectPropertySchema;
use weave_acp_core::schema::PermissionOption;
use weave_acp_core::schema::PermissionOptionKind;
use weave_acp_core::schema::Plan;
use weave_acp_core::schema::PlanEntry;
use weave_acp_core::schema::PlanEntryPriority;
use weave_acp_core::schema::PlanEntryStatus;
use weave_acp_core::schema::PromptResponse;
use weave_acp_core::schema::SessionConfigOption;
use weave_acp_core::schema::SessionConfigOptionCategory;
use weave_acp_core::schema::SessionConfigSelectGroup;
use weave_acp_core::schema::SessionConfigSelectOption;
use weave_acp_core::schema::SessionInfo;
use weave_acp_core::schema::SessionInfoUpdate;
use weave_acp_core::schema::SessionMode;
use weave_acp_core::schema::SessionModeState;
use weave_acp_core::schema::SessionNotification;
use weave_acp_core::schema::SessionUpdate;
use weave_acp_core::schema::StopReason;
use weave_acp_core::schema::StringPropertySchema;
use weave_acp_core::schema::Terminal;
use weave_acp_core::schema::TerminalExitStatus;
use weave_acp_core::schema::ToolCall;
use weave_acp_core::schema::ToolCallContent;
use weave_acp_core::schema::ToolCallLocation;
use weave_acp_core::schema::ToolCallStatus;
use weave_acp_core::schema::ToolCallUpdate;
use weave_acp_core::schema::ToolCallUpdateFields;
use weave_acp_core::schema::ToolKind;
use weave_acp_core::schema::UnstructuredCommandInput;
use weave_acp_core::schema::UsageUpdate;

use crate::chat::ChatWidget;
use crate::chat::SessionAbilities;
use crate::elicitation::ElicitationView;
use crate::permission::PermissionView;
use crate::session::OpenedSession;
use crate::session::Reopened;
use crate::tool_call::ToolCallCell;

const WIDTH: u16 = 72;

fn chat_with(
    modes: Option<SessionModeState>,
    config_options: Vec<SessionConfigOption>,
) -> ChatWidget {
    let abilities = SessionAbilities {
        list: true,
        delete: true,
    };
    let mut chat = ChatWidget::new("Agent".into(), PathBuf::from("/repo"), abilities, WIDTH);
    chat.session_ready(OpenedSession {
        session_id: "s1".into(),
        modes,
        config_options,
        reopened: None,
        notices: Vec::new(),
    });
    chat
}

fn chat() -> ChatWidget {
    chat_with(None, Vec::new())
}

fn send(chat: &mut ChatWidget, update: SessionUpdate) {
    chat.handle_agent_event(ChatEvent::SessionUpdate(SessionNotification::new(
        "s1", update,
    )));
}

/// End the turn so streamed content commits to the transcript.
fn finish_turn(chat: &mut ChatWidget) {
    chat.handle_agent_event(ChatEvent::TurnEnded {
        session_id: "s1".into(),
        result: Ok(PromptResponse::new(StopReason::EndTurn)),
        replayed: false,
    });
}

fn viewport(chat: &ChatWidget) -> Vec<String> {
    let area = Rect::new(0, 0, WIDTH, chat.desired_height(WIDTH));
    let mut buf = Buffer::empty(area);
    chat.render(area, &mut buf);
    buffer_rows(&buf)
}

fn buffer_rows(buf: &Buffer) -> Vec<String> {
    let area = buf.area;
    (area.y..area.bottom())
        .map(|y| {
            (area.x..area.right())
                .map(|x| buf[(x, y)].symbol())
                .collect::<String>()
                .trim_end()
                .to_owned()
        })
        .collect()
}

/// The transcript written so far and the live viewport, as plain text.
fn screen(chat: &mut ChatWidget) -> String {
    let history: Vec<String> = chat
        .take_history()
        .iter()
        .map(|row| row.line.to_string().trim_end().to_owned())
        .collect();
    format!(
        "── transcript ──\n{}\n── viewport ──\n{}",
        history.join("\n"),
        viewport(chat).join("\n")
    )
}

fn text(value: &str) -> ContentChunk {
    ContentChunk::new(value.into())
}

#[test]
fn update_user_message_chunk() {
    let mut chat = chat();
    for (id, message) in [("m1", "fix the build"), ("m2", "and add a test")] {
        send(
            &mut chat,
            SessionUpdate::UserMessageChunk(text(message).message_id(MessageId::new(id))),
        );
    }
    finish_turn(&mut chat);
    insta::assert_snapshot!(screen(&mut chat));
}

#[test]
fn update_agent_message_chunk() {
    let mut chat = chat();
    let markdown = "## Result\n\nThe build failed in `parser.rs`:\n\n- missing `;` on line 12\n- see [the docs](https://doc.rust-lang.org)\n\n```rust\nlet x = 1;\n```\n";
    for piece in markdown.split_inclusive(' ') {
        send(&mut chat, SessionUpdate::AgentMessageChunk(text(piece)));
    }
    finish_turn(&mut chat);
    insta::assert_snapshot!(screen(&mut chat));
}

#[test]
fn agent_message_alerts() {
    let mut chat = chat();
    let markdown = "> [!NOTE]\n> Threads outlive the TUI.\n\n> [!TIP]\n> `weave --resume` finds the thread again.\n\n> [!IMPORTANT]\n> The Host runs the agents.\n\n> [!WARNING]\n> Quitting the Host ends its threads' turns.\n\n> [!CAUTION]\n> Agent text is untrusted.\n\n> A plain quote.\n";
    for piece in markdown.split_inclusive(' ') {
        send(&mut chat, SessionUpdate::AgentMessageChunk(text(piece)));
    }
    finish_turn(&mut chat);
    insta::assert_snapshot!(screen(&mut chat));
}

/// The fake agent's rich Markdown, streamed: diagrams, math, alerts, inline HTML and code, and
/// what falls back to its source.
#[test]
fn agent_message_rich_markdown() {
    let mut chat = chat();
    for piece in weave_fake_agent::MARKDOWN.split_inclusive(' ') {
        send(&mut chat, SessionUpdate::AgentMessageChunk(text(piece)));
    }
    finish_turn(&mut chat);
    insta::assert_snapshot!(screen(&mut chat));
}

#[test]
fn update_agent_thought_chunk() {
    let mut chat = chat();
    send(
        &mut chat,
        SessionUpdate::AgentThoughtChunk(text("The tests fail because the fixture moved.\n")),
    );
    send(
        &mut chat,
        SessionUpdate::AgentMessageChunk(text("Found it.")),
    );
    finish_turn(&mut chat);
    insta::assert_snapshot!(screen(&mut chat));
}

#[test]
fn update_tool_call() {
    let mut chat = chat();
    send(
        &mut chat,
        SessionUpdate::ToolCall(
            ToolCall::new("t1", "Search for TODOs")
                .kind(ToolKind::Search)
                .status(ToolCallStatus::InProgress)
                .locations(vec![ToolCallLocation::new("/repo/src")]),
        ),
    );
    send(
        &mut chat,
        SessionUpdate::ToolCall(ToolCall::new("t2", "Edit main.rs").kind(ToolKind::Edit)),
    );
    insta::assert_snapshot!(screen(&mut chat));
}

#[test]
fn update_tool_call_update() {
    let mut chat = chat();
    send(
        &mut chat,
        SessionUpdate::ToolCall(ToolCall::new("read", "Read Cargo.toml").kind(ToolKind::Read)),
    );
    send(
        &mut chat,
        SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            "read",
            ToolCallUpdateFields::new()
                .status(ToolCallStatus::Completed)
                .content(vec![
                    weave_acp_core::schema::ContentBlock::from("[package]\nname = \"demo\"").into(),
                ]),
        )),
    );
    send(
        &mut chat,
        SessionUpdate::ToolCall(
            ToolCall::new("edit", "Edit lib.rs")
                .kind(ToolKind::Edit)
                .status(ToolCallStatus::Completed)
                .content(vec![ToolCallContent::Diff(
                    Diff::new("/repo/src/lib.rs", "fn a() {}\nfn b() {}\n")
                        .old_text("fn a() {}\n".to_owned()),
                )]),
        ),
    );
    send(
        &mut chat,
        SessionUpdate::ToolCall(
            ToolCall::new("test", "Run tests")
                .kind(ToolKind::Execute)
                .status(ToolCallStatus::InProgress)
                .content(vec![ToolCallContent::Terminal(Terminal::new("term-1"))]),
        ),
    );
    chat.handle_agent_event(ChatEvent::TerminalOutput {
        terminal_id: "term-1".into(),
        text: "running 3 tests\n\u{1b}[31mFAILED\u{1b}[0m parser::empty\n".into(),
    });
    chat.handle_agent_event(ChatEvent::TerminalExited {
        terminal_id: "term-1".into(),
        status: TerminalExitStatus::new().exit_code(101),
    });
    send(
        &mut chat,
        SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            "test",
            ToolCallUpdateFields::new().status(ToolCallStatus::Failed),
        )),
    );
    insta::assert_snapshot!(screen(&mut chat));
}

#[test]
fn update_plan() {
    let mut chat = chat();
    let entry = |content: &str, status| PlanEntry::new(content, PlanEntryPriority::Medium, status);
    send(
        &mut chat,
        SessionUpdate::Plan(Plan::new(vec![
            entry("Reproduce the failure", PlanEntryStatus::Completed),
            entry("Fix the parser", PlanEntryStatus::InProgress),
            entry("Add a regression test", PlanEntryStatus::Pending),
        ])),
    );
    insta::assert_snapshot!(screen(&mut chat));
}

#[test]
fn update_available_commands_update() {
    let mut chat = chat();
    send(
        &mut chat,
        SessionUpdate::AvailableCommandsUpdate(AvailableCommandsUpdate::new(vec![
            AvailableCommand::new("review", "Review the current changes"),
            AvailableCommand::new("test", "Run the test suite").input(
                AvailableCommandInput::Unstructured(UnstructuredCommandInput::new("filter")),
            ),
        ])),
    );
    chat.handle_paste("/");
    insta::assert_snapshot!(screen(&mut chat));
}

#[test]
fn update_current_mode_update() {
    let modes = SessionModeState::new(
        "ask",
        vec![
            SessionMode::new("ask", "Ask"),
            SessionMode::new("code", "Code"),
        ],
    );
    let mut chat = chat_with(Some(modes), Vec::new());
    send(
        &mut chat,
        SessionUpdate::CurrentModeUpdate(CurrentModeUpdate::new("code")),
    );
    insta::assert_snapshot!(screen(&mut chat));
}

fn config_options(model: &str) -> Vec<SessionConfigOption> {
    vec![
        SessionConfigOption::select(
            "mode",
            "Mode",
            "ask",
            vec![
                SessionConfigSelectOption::new("ask", "Ask"),
                SessionConfigSelectOption::new("code", "Code"),
            ],
        )
        .category(SessionConfigOptionCategory::Mode),
        SessionConfigOption::select(
            "model",
            "Model",
            model.to_owned(),
            vec![
                SessionConfigSelectGroup::new(
                    "fast",
                    "Fast",
                    vec![SessionConfigSelectOption::new("small", "Small")],
                ),
                SessionConfigSelectGroup::new(
                    "smart",
                    "Smart",
                    vec![SessionConfigSelectOption::new("large", "Large")],
                ),
            ],
        )
        .category(SessionConfigOptionCategory::Model),
        SessionConfigOption::boolean("verbose", "Verbose", false),
    ]
}

#[test]
fn update_config_option_update() {
    let mut chat = chat_with(None, config_options("small"));
    send(
        &mut chat,
        SessionUpdate::ConfigOptionUpdate(ConfigOptionUpdate::new(config_options("large"))),
    );
    insta::assert_snapshot!(screen(&mut chat));
}

#[test]
fn update_session_info_update() {
    let mut chat = chat();
    send(
        &mut chat,
        SessionUpdate::SessionInfoUpdate(
            SessionInfoUpdate::new().title("Fix the flaky parser test".to_owned()),
        ),
    );
    insta::assert_snapshot!(screen(&mut chat));
}

#[test]
fn update_usage_update() {
    let mut chat = chat();
    send(
        &mut chat,
        SessionUpdate::UsageUpdate(UsageUpdate::new(48_000, 200_000)),
    );
    insta::assert_snapshot!(screen(&mut chat));
}

fn render_view(height: u16, render: impl FnOnce(Rect, &mut Buffer)) -> String {
    let area = Rect::new(0, 0, WIDTH, height);
    let mut buf = Buffer::empty(area);
    render(area, &mut buf);
    buffer_rows(&buf).join("\n")
}

#[test]
fn prompt_permission() {
    // The subject comes from the tool call, as a live permission request's does.
    let call = ToolCallCell::new(
        ToolCall::new("t1", "cargo test")
            .kind(ToolKind::Execute)
            .status(ToolCallStatus::Pending)
            .raw_input(serde_json::json!({"command": "cargo test"})),
    );
    let view = PermissionView::new(
        call.permission_subject(&PathBuf::from("/repo")),
        vec![
            PermissionOption::new("once", "Allow once", PermissionOptionKind::AllowOnce),
            PermissionOption::new(
                "always",
                "Always allow cargo",
                PermissionOptionKind::AllowAlways,
            ),
            PermissionOption::new("no", "Reject", PermissionOptionKind::RejectOnce),
        ],
    );
    insta::assert_snapshot!(render_view(view.desired_height(WIDTH), |area, buf| view
        .render(area, buf)));
}

#[test]
fn prompt_elicitation_form() {
    let schema = ElicitationSchema::new()
        .title("Deployment")
        .property(
            "environment",
            StringPropertySchema::new()
                .title("Environment")
                .one_of(vec![
                    EnumOption::new("staging", "Staging"),
                    EnumOption::new("production", "Production"),
                ]),
            true,
        )
        .property(
            "replicas",
            IntegerPropertySchema::new()
                .title("Replicas")
                .minimum(1)
                .default_value(2),
            false,
        )
        .property(
            "notify",
            BooleanPropertySchema::new()
                .title("Notify team")
                .default_value(true),
            false,
        )
        .property(
            "regions",
            MultiSelectPropertySchema::new(vec!["eu".into(), "us".into()]).title("Regions"),
            false,
        );
    let request = CreateElicitationRequest::new(
        ElicitationFormMode::new(ElicitationSessionScope::new("s1"), schema),
        "Where should this deploy?",
    );
    let view = ElicitationView::new(&request, "Agent").expect("form");
    insta::assert_snapshot!(render_view(view.desired_height(WIDTH), |area, buf| {
        view.render(area, buf);
    }));
}

#[test]
fn prompt_elicitation_url() {
    let request = CreateElicitationRequest::new(
        ElicitationUrlMode::new(
            ElicitationSessionScope::new("s1"),
            "e1",
            "https://github.com/login/oauth/authorize?client_id=abc",
        ),
        "Connect your GitHub account.",
    );
    let view = ElicitationView::new(&request, "Agent").expect("url");
    insta::assert_snapshot!(render_view(view.desired_height(WIDTH), |area, buf| {
        view.render(area, buf);
    }));
}

#[test]
fn picker_sessions() {
    let mut chat = chat();
    chat.handle_key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::CONTROL));
    // Untimed entries keep the snapshot independent of the clock.
    chat.sessions_listed(
        Ok(weave_host_protocol::sessions::ListSessionsResponse {
            sessions: vec![
                listing(
                    SessionInfo::new("a", "/repo").title("Fix the flaky parser test".to_owned()),
                ),
                listing(SessionInfo::new("b", "/repo")),
            ],
            next_cursor: Some("page-2".to_owned()),
        }),
        false,
    );
    insta::assert_snapshot!(screen(&mut chat));
}

#[test]
fn picker_settings() {
    let mut chat = chat_with(None, config_options("small"));
    chat.handle_key(KeyEvent::new(KeyCode::Char('o'), KeyModifiers::CONTROL));
    insta::assert_snapshot!(screen(&mut chat));
}

#[test]
fn turn_running_with_a_queued_message() {
    let mut chat = chat();
    chat.handle_paste("first");
    chat.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    chat.handle_paste("follow-up");
    chat.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    insta::assert_snapshot!(screen(&mut chat));
}

#[test]
fn turn_running_with_a_message_to_steer_it() {
    let mut chat = chat();
    chat.set_steerable(true);
    chat.handle_paste("first");
    chat.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    chat.handle_paste("use main instead");
    insta::assert_snapshot!(screen(&mut chat));
}

#[test]
fn disconnected() {
    let mut chat = chat();
    chat.handle_agent_event(ChatEvent::Disconnected(None));
    insta::assert_snapshot!(screen(&mut chat));
}

/// A fullscreen widget with session `s1` open.
fn fullscreen_chat() -> ChatWidget {
    let abilities = SessionAbilities {
        list: true,
        delete: true,
    };
    let mut chat =
        ChatWidget::new("Agent".into(), PathBuf::from("/repo"), abilities, WIDTH).fullscreen();
    chat.session_ready(OpenedSession {
        session_id: "s1".into(),
        modes: None,
        config_options: Vec::new(),
        reopened: None,
        notices: Vec::new(),
    });
    chat
}

fn full_screen(chat: &ChatWidget, height: u16) -> String {
    let area = Rect::new(0, 0, WIDTH, height);
    let mut buf = Buffer::empty(area);
    chat.render_screen(area, &mut buf);
    buffer_rows(&buf).join("\n")
}

/// A fullscreen conversation long enough to scroll, mid-turn with a tool call running.
fn long_conversation() -> ChatWidget {
    let mut chat = fullscreen_chat();
    for turn in 1..=3 {
        chat.handle_paste(&format!("question {turn}"));
        chat.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        send(
            &mut chat,
            SessionUpdate::AgentMessageChunk(text(&format!(
                "Answer {turn}, first line.\nAnd a second line."
            ))),
        );
        if turn < 3 {
            finish_turn(&mut chat);
        }
    }
    send(
        &mut chat,
        SessionUpdate::ToolCall(
            ToolCall::new("t1", "Run tests")
                .kind(ToolKind::Execute)
                .status(ToolCallStatus::InProgress),
        ),
    );
    chat
}

#[test]
fn fullscreen_following_the_newest_output() {
    let chat = long_conversation();
    insta::assert_snapshot!(full_screen(&chat, 16));
}

#[test]
fn fullscreen_reading_earlier_output_as_more_arrives() {
    let mut chat = long_conversation();
    full_screen(&chat, 16);
    chat.handle_key(KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE));
    send(
        &mut chat,
        SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            "t1",
            ToolCallUpdateFields::new().status(ToolCallStatus::Completed),
        )),
    );
    insta::assert_snapshot!(full_screen(&chat, 16));
}

fn release(version: &str) -> weave_host_protocol::agents::AgentRelease {
    weave_host_protocol::agents::AgentRelease {
        name: "@agentclientprotocol/claude-agent-acp".into(),
        version: version.into(),
    }
}

/// A chat on a Host that updates agents, its session on 0.86.0 with a conversation to move,
/// with 0.93.0 out.
fn with_update(mut chat: ChatWidget) -> ChatWidget {
    chat = chat.with_updates(true, Default::default());
    chat.set_release(Some(release("0.86.0")));
    chat.session_ready(OpenedSession {
        session_id: "s1".into(),
        modes: None,
        config_options: Vec::new(),
        reopened: Some(Reopened::Loaded),
        notices: Vec::new(),
    });
    chat.update_available(weave_host_protocol::agents::AgentUpdate {
        agent_id: "claude".into(),
        name: "@agentclientprotocol/claude-agent-acp".into(),
        running: "0.86.0".into(),
        latest: "0.93.0".into(),
    });
    chat
}

fn reopened(version: &str, failed: Option<&str>) -> ChatEvent {
    ChatEvent::AgentReopened {
        agent: Box::new(weave_host_protocol::sessions::SessionAgent {
            id: "claude".into(),
            name: "Claude".into(),
            initialize: weave_acp_core::schema::InitializeResponse::new(
                weave_acp_core::ProtocolVersion::V1,
            ),
            release: Some(release(version)),
        }),
        previous: Some(release("0.86.0")),
        modes: None,
        config_options: Vec::new(),
        failed: failed.map(str::to_owned),
        replayed: false,
    }
}

/// `/update` run, its check passed, moving the session; then the journal's word on how the
/// move went, and on one that went back to the old version.
fn updated(mut chat: ChatWidget) -> ChatWidget {
    chat.handle_paste("/update");
    chat.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    chat.agent_updated(Ok("0.93.0".into()));
    chat.session_reopened(&"s1".into(), Ok(()));
    chat.handle_agent_event(reopened("0.93.0", None));
    chat.handle_agent_event(reopened(
        "0.93.0",
        Some("0.94.0 couldn't resume the thread: unknown session"),
    ));
    chat
}

#[test]
fn update_available_notice() {
    let mut chat = with_update(chat());
    insta::assert_snapshot!(screen(&mut chat));
}

#[test]
fn update_available_notice_fullscreen() {
    let chat = with_update(fullscreen_chat());
    insta::assert_snapshot!(full_screen(&chat, 10));
}

#[test]
fn update_moving_the_session() {
    let mut chat = with_update(chat());
    chat.handle_paste("/update");
    chat.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    chat.agent_updated(Ok("0.93.0".into()));
    insta::assert_snapshot!(screen(&mut chat));
}

#[test]
fn update_moved() {
    let mut chat = updated(with_update(chat()));
    insta::assert_snapshot!(screen(&mut chat));
}

#[test]
fn update_moved_fullscreen() {
    let chat = updated(with_update(fullscreen_chat()));
    insta::assert_snapshot!(full_screen(&chat, 18));
}

/// When the turns below began, in milliseconds since the Unix epoch, as the journal dates them.
const TURN_START: u64 = 1_761_400_000_000;

/// `event` from the journal, `seconds` into the turn.
fn journal(chat: &mut ChatWidget, seconds: u64, event: ChatEvent) {
    chat.handle_journal_event(event, TURN_START + seconds * 1000);
}

fn journal_update(chat: &mut ChatWidget, seconds: u64, update: SessionUpdate) {
    journal(
        chat,
        seconds,
        ChatEvent::SessionUpdate(SessionNotification::new("s1", update)),
    );
}

/// A command run in terminal `terminal`, which printed `output`.
fn command(id: &str, command: &str, terminal: &str) -> ToolCall {
    ToolCall::new(id.to_owned(), command)
        .kind(ToolKind::Execute)
        .status(ToolCallStatus::InProgress)
        .raw_input(serde_json::json!({ "command": command }))
        .content(vec![ToolCallContent::Terminal(Terminal::new(
            terminal.to_owned(),
        ))])
}

fn finished(id: &str, seconds: u64, status: ToolCallStatus, chat: &mut ChatWidget) {
    journal_update(
        chat,
        seconds,
        SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            id.to_owned(),
            ToolCallUpdateFields::new().status(status),
        )),
    );
}

fn terminal_output(chat: &mut ChatWidget, seconds: u64, terminal: &str, text: &str) {
    journal(
        chat,
        seconds,
        ChatEvent::TerminalOutput {
            terminal_id: terminal.to_owned().into(),
            text: text.into(),
        },
    );
}

/// A turn started on another client 2m 20s ago, its prompt dated then.
fn started_elsewhere(chat: &mut ChatWidget, replayed: bool) {
    journal(
        chat,
        0,
        ChatEvent::TurnStarted {
            session_id: "s1".into(),
            prompt: vec!["Fix the flaky parser test".into()],
            elapsed: std::time::Duration::from_secs(140),
            replayed,
        },
    );
}

/// The turn, from its thinking through its tool calls to its answer: a read, a search, the
/// tests (failing, when `fails`), an edit, and the tests again, the last done 2m 17s in.
fn worked(chat: &mut ChatWidget, fails: bool, replayed: bool) {
    started_elsewhere(chat, replayed);
    journal_update(
        chat,
        2,
        SessionUpdate::AgentThoughtChunk(text(
            "**Finding the fixture**\n\nThe test reads a fixture that may have moved.",
        )),
    );
    journal_update(
        chat,
        4,
        SessionUpdate::ToolCall(
            ToolCall::new("read", "Read parser.rs")
                .kind(ToolKind::Read)
                .status(ToolCallStatus::Completed)
                .locations(vec![ToolCallLocation::new("/repo/src/parser.rs")]),
        ),
    );
    journal_update(
        chat,
        5,
        SessionUpdate::ToolCall(
            ToolCall::new("grep", "grep fixtures/")
                .kind(ToolKind::Search)
                .status(ToolCallStatus::Completed)
                .raw_input(serde_json::json!({ "pattern": "fixtures/", "path": "src" })),
        ),
    );
    journal_update(
        chat,
        9,
        SessionUpdate::ToolCall(command("test", "cargo test -p parser", "term-1")),
    );
    let (output, first_run) = if fails {
        ("test parser::empty ... FAILED", ToolCallStatus::Failed)
    } else {
        ("test parser::empty ... ok", ToolCallStatus::Completed)
    };
    terminal_output(chat, 30, "term-1", &format!("running 4 tests\n{output}\n"));
    finished("test", 40, first_run, chat);
    journal_update(
        chat,
        70,
        SessionUpdate::ToolCall(
            ToolCall::new("edit", "Edit parser.rs")
                .kind(ToolKind::Edit)
                .status(ToolCallStatus::Completed)
                .content(vec![ToolCallContent::Diff(
                    Diff::new(
                        "/repo/src/parser.rs",
                        "const FIXTURES: &str = \"tests/fixtures\";\n",
                    )
                    .old_text("const FIXTURES: &str = \"fixtures\";\n".to_owned()),
                )]),
        ),
    );
    journal_update(
        chat,
        100,
        SessionUpdate::ToolCall(command("retest", "cargo test -p parser", "term-2")),
    );
    terminal_output(chat, 130, "term-2", "running 4 tests\ntest result: ok\n");
    finished("retest", 137, ToolCallStatus::Completed, chat);
    journal_update(
        chat,
        138,
        SessionUpdate::AgentMessageChunk(text(
            "Fixed: the test read its fixture from the old path.",
        )),
    );
    journal(
        chat,
        140,
        ChatEvent::TurnEnded {
            session_id: "s1".into(),
            result: Ok(PromptResponse::new(StopReason::EndTurn)),
            replayed,
        },
    );
}

/// The screen in the compact view, then in the detailed one (Ctrl+T).
fn both_views(chat: &mut ChatWidget, compact: u16, detailed: u16) -> String {
    let ctrl_t = KeyEvent::new(KeyCode::Char('t'), KeyModifiers::CONTROL);
    let shown = full_screen(chat, compact);
    chat.handle_key(ctrl_t);
    let full = full_screen(chat, detailed);
    chat.handle_key(ctrl_t);
    format!("── compact ──\n{shown}\n── detailed ──\n{full}")
}

/// Click the row that starts with `text`.
fn click(chat: &mut ChatWidget, height: u16, text: &str) {
    use crossterm::event::MouseButton;
    use crossterm::event::MouseEvent;
    use crossterm::event::MouseEventKind;

    let screen = full_screen(chat, height);
    let row = screen
        .lines()
        .position(|row| row.starts_with(text))
        .unwrap_or_else(|| panic!("no row starts with {text:?} in\n{screen}"));
    for kind in [
        MouseEventKind::Down(MouseButton::Left),
        MouseEventKind::Up(MouseButton::Left),
    ] {
        chat.handle_mouse(MouseEvent {
            kind,
            column: 4,
            row: u16::try_from(row).unwrap_or_default(),
            modifiers: KeyModifiers::NONE,
        });
    }
}

#[test]
fn fullscreen_run_closed() {
    let mut chat = fullscreen_chat();
    worked(&mut chat, false, false);
    insta::assert_snapshot!(both_views(&mut chat, 14, 38));
}

#[test]
fn fullscreen_run_open() {
    let mut chat = fullscreen_chat();
    worked(&mut chat, false, false);
    click(&mut chat, 38, "• Ran ");
    insta::assert_snapshot!(both_views(&mut chat, 38, 38));
}

#[test]
fn fullscreen_run_failed() {
    let mut chat = fullscreen_chat();
    worked(&mut chat, true, false);
    insta::assert_snapshot!(both_views(&mut chat, 14, 38));
}

/// A turn of this client's own, at work on a command: undated events are timed as they arrive.
#[test]
fn fullscreen_run_running() {
    let mut chat = fullscreen_chat();
    chat.handle_paste("Fix the flaky parser test");
    chat.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    send(
        &mut chat,
        SessionUpdate::ToolCall(
            ToolCall::new("read", "Read parser.rs")
                .kind(ToolKind::Read)
                .status(ToolCallStatus::Completed)
                .locations(vec![ToolCallLocation::new("/repo/src/parser.rs")]),
        ),
    );
    send(
        &mut chat,
        SessionUpdate::ToolCall(command("test", "cargo test -p parser", "term-1")),
    );
    chat.handle_agent_event(ChatEvent::TerminalOutput {
        terminal_id: "term-1".into(),
        text: "running 4 tests\n".into(),
    });
    insta::assert_snapshot!(both_views(&mut chat, 12, 24));
}

/// One tool call, with thinking before it, folds as a run of more would.
#[test]
fn fullscreen_lone_tool_call() {
    let mut chat = fullscreen_chat();
    started_elsewhere(&mut chat, false);
    journal_update(
        &mut chat,
        2,
        SessionUpdate::AgentThoughtChunk(text("**Running the tests**\n\nThey should pass now.")),
    );
    journal_update(
        &mut chat,
        3,
        SessionUpdate::ToolCall(command("test", "cargo test -p parser", "term-1")),
    );
    terminal_output(
        &mut chat,
        30,
        "term-1",
        "running 4 tests\ntest result: ok\n",
    );
    finished("test", 31, ToolCallStatus::Completed, &mut chat);
    journal_update(
        &mut chat,
        32,
        SessionUpdate::AgentMessageChunk(text("They pass.")),
    );
    journal(
        &mut chat,
        33,
        ChatEvent::TurnEnded {
            session_id: "s1".into(),
            result: Ok(PromptResponse::new(StopReason::EndTurn)),
            replayed: false,
        },
    );
    insta::assert_snapshot!(both_views(&mut chat, 22, 22));
}

/// A replayed thread's runs fold as a live one's did, timed by the journal.
#[test]
fn fullscreen_run_replayed_folds_as_live() {
    let rows = |replayed| {
        let mut chat = fullscreen_chat();
        worked(&mut chat, false, replayed);
        chat.replay_finished();
        full_screen(&chat, 16)
            .lines()
            .filter(|row| row.starts_with("• Ran"))
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        rows(true),
        ["• Ran 2 commands, 1 edit, 1 read, 1 search · 2m 17s"]
    );
    assert_eq!(rows(false), rows(true));
}
