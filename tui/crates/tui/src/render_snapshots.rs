//! Render snapshots: how every ACP v1 `session/update` kind and every interactive prompt
//! looks, both in the transcript (scrollback) and in the live viewport.
//!
//! Review changes with `cargo insta review` (or `INSTA_UPDATE=always cargo test` and diff).

use std::path::PathBuf;

use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use weave_acp_core::AgentEvent;
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
use weave_acp_core::schema::ListSessionsResponse;
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
        cwd: None,
    });
    chat
}

fn chat() -> ChatWidget {
    chat_with(None, Vec::new())
}

fn send(chat: &mut ChatWidget, update: SessionUpdate) {
    chat.handle_agent_event(AgentEvent::SessionUpdate(SessionNotification::new(
        "s1", update,
    )));
}

/// End the turn so streamed content commits to the transcript.
fn finish_turn(chat: &mut ChatWidget) {
    chat.handle_agent_event(AgentEvent::TurnEnded {
        session_id: "s1".into(),
        result: Ok(PromptResponse::new(StopReason::EndTurn)),
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
        .map(|line| line.to_string().trim_end().to_owned())
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
    chat.handle_agent_event(AgentEvent::TerminalOutput {
        terminal_id: "term-1".into(),
        text: "running 3 tests\n\u{1b}[31mFAILED\u{1b}[0m parser::empty\n".into(),
    });
    chat.handle_agent_event(AgentEvent::TerminalExited {
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
        Ok(ListSessionsResponse::new(vec![
            SessionInfo::new("a", "/repo").title("Fix the flaky parser test".to_owned()),
            SessionInfo::new("b", "/repo"),
        ])
        .next_cursor("page-2".to_owned())),
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
fn disconnected() {
    let mut chat = chat();
    chat.handle_agent_event(AgentEvent::Disconnected(None));
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
        cwd: None,
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
