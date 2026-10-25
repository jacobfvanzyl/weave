//! Golden fixtures: every message type on the wire, as a snapshot. A change here changes what
//! clients and Hosts say to each other; see "Versioning" in the spec before accepting one.

#![allow(clippy::expect_used)]

use std::collections::BTreeMap;

use agent_client_protocol::JsonRpcMessage;
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::CompleteElicitationNotification;
use agent_client_protocol::schema::v1::ContentBlock;
use agent_client_protocol::schema::v1::ContentChunk;
use agent_client_protocol::schema::v1::CreateElicitationRequest;
use agent_client_protocol::schema::v1::CreateElicitationResponse;
use agent_client_protocol::schema::v1::ElicitationAction;
use agent_client_protocol::schema::v1::ElicitationSessionScope;
use agent_client_protocol::schema::v1::ElicitationUrlMode;
use agent_client_protocol::schema::v1::Implementation;
use agent_client_protocol::schema::v1::InitializeResponse;
use agent_client_protocol::schema::v1::PermissionOption;
use agent_client_protocol::schema::v1::PermissionOptionKind;
use agent_client_protocol::schema::v1::PromptResponse;
use agent_client_protocol::schema::v1::RequestPermissionOutcome;
use agent_client_protocol::schema::v1::RequestPermissionRequest;
use agent_client_protocol::schema::v1::RequestPermissionResponse;
use agent_client_protocol::schema::v1::SelectedPermissionOutcome;
use agent_client_protocol::schema::v1::SessionConfigOptionValue;
use agent_client_protocol::schema::v1::SessionInfo;
use agent_client_protocol::schema::v1::SessionMode;
use agent_client_protocol::schema::v1::SessionModeState;
use agent_client_protocol::schema::v1::SessionNotification;
use agent_client_protocol::schema::v1::SessionUpdate;
use agent_client_protocol::schema::v1::StopReason;
use agent_client_protocol::schema::v1::TerminalExitStatus;
use agent_client_protocol::schema::v1::ToolCallUpdate;
use agent_client_protocol::schema::v1::ToolCallUpdateFields;
use agent_client_protocol::schema::v1::ToolKind;
use pretty_assertions::assert_eq;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use serde_json::json;
use weave_host_protocol::Empty;
use weave_host_protocol::VersionRange;
use weave_host_protocol::agents::AgentRelease;
use weave_host_protocol::agents::AgentSource;
use weave_host_protocol::agents::AgentSummary;
use weave_host_protocol::agents::AgentUpdate;
use weave_host_protocol::agents::AuthenticateAgentRequest;
use weave_host_protocol::agents::GetAgentRequest;
use weave_host_protocol::agents::GetAgentResponse;
use weave_host_protocol::agents::ListAgentsRequest;
use weave_host_protocol::agents::ListAgentsResponse;
use weave_host_protocol::agents::LogoutAgentRequest;
use weave_host_protocol::agents::TerminalSignInRequest;
use weave_host_protocol::agents::TerminalSignInResponse;
use weave_host_protocol::agents::UPDATES_FEATURE;
use weave_host_protocol::agents::UpdateAgentRequest;
use weave_host_protocol::agents::UpdateAgentResponse;
use weave_host_protocol::agents::UpdateAvailableNotification;
use weave_host_protocol::devices::DEVICES_FEATURE;
use weave_host_protocol::devices::Device;
use weave_host_protocol::devices::DeviceInfo;
use weave_host_protocol::devices::DevicePairedNotification;
use weave_host_protocol::devices::Jwk;
use weave_host_protocol::devices::ListDevicesRequest;
use weave_host_protocol::devices::ListDevicesResponse;
use weave_host_protocol::devices::NewDevice;
use weave_host_protocol::devices::OfferDeviceRequest;
use weave_host_protocol::devices::OfferDeviceResponse;
use weave_host_protocol::devices::RevokeDeviceRequest;
use weave_host_protocol::events::ElicitationCompletedNotification;
use weave_host_protocol::events::SessionChangedNotification;
use weave_host_protocol::events::SessionEvent;
use weave_host_protocol::events::SessionEventNotification;
use weave_host_protocol::files::FileEntry;
use weave_host_protocol::files::FileKind;
use weave_host_protocol::files::ListFilesRequest;
use weave_host_protocol::files::ListFilesResponse;
use weave_host_protocol::hello::AcpInfo;
use weave_host_protocol::hello::Auth;
use weave_host_protocol::hello::ChallengeRequest;
use weave_host_protocol::hello::ChallengeResponse;
use weave_host_protocol::hello::ClientCapabilities;
use weave_host_protocol::hello::ClientInfo;
use weave_host_protocol::hello::HelloRequest;
use weave_host_protocol::hello::HelloResponse;
use weave_host_protocol::hello::HostInfo;
use weave_host_protocol::host::DrainRequest;
use weave_host_protocol::host::DrainResponse;
use weave_host_protocol::host::EnvironmentSource;
use weave_host_protocol::host::HostStatus;
use weave_host_protocol::host::Service;
use weave_host_protocol::host::ShutdownRequest;
use weave_host_protocol::host::StatusRequest;
use weave_host_protocol::pending::AnswerPendingRequest;
use weave_host_protocol::pending::PendingAddedNotification;
use weave_host_protocol::pending::PendingKind;
use weave_host_protocol::pending::PendingRequest;
use weave_host_protocol::pending::PendingResolvedNotification;
use weave_host_protocol::pending::Resolution;
use weave_host_protocol::policy::PermissionPolicy;
use weave_host_protocol::queue::AddQueuedRequest;
use weave_host_protocol::queue::AddQueuedResponse;
use weave_host_protocol::queue::QueuePause;
use weave_host_protocol::queue::QueuedPrompt;
use weave_host_protocol::queue::RemoveQueuedRequest;
use weave_host_protocol::queue::RemoveQueuedResponse;
use weave_host_protocol::queue::ResumeQueueRequest;
use weave_host_protocol::sessions::Activity;
use weave_host_protocol::sessions::AttachSessionRequest;
use weave_host_protocol::sessions::AttachSessionResponse;
use weave_host_protocol::sessions::CloseSessionRequest;
use weave_host_protocol::sessions::CloseWhen;
use weave_host_protocol::sessions::CreateSessionRequest;
use weave_host_protocol::sessions::DeleteSessionRequest;
use weave_host_protocol::sessions::DetachSessionRequest;
use weave_host_protocol::sessions::GetSessionRequest;
use weave_host_protocol::sessions::GetSessionResponse;
use weave_host_protocol::sessions::JournalHead;
use weave_host_protocol::sessions::JournalPosition;
use weave_host_protocol::sessions::LatestTurn;
use weave_host_protocol::sessions::ListSessionsRequest;
use weave_host_protocol::sessions::ListSessionsResponse;
use weave_host_protocol::sessions::RenameSessionRequest;
use weave_host_protocol::sessions::ReopenSessionRequest;
use weave_host_protocol::sessions::ReopenSessionResponse;
use weave_host_protocol::sessions::Replay;
use weave_host_protocol::sessions::RunRequest;
use weave_host_protocol::sessions::RunResponse;
use weave_host_protocol::sessions::RunningTurn;
use weave_host_protocol::sessions::SessionAgent;
use weave_host_protocol::sessions::SessionListing;
use weave_host_protocol::sessions::SessionRemovedNotification;
use weave_host_protocol::sessions::SessionState;
use weave_host_protocol::sessions::SessionStatus;
use weave_host_protocol::sessions::SessionUpdatedNotification;
use weave_host_protocol::sessions::SetConfigOptionRequest;
use weave_host_protocol::sessions::SetModeRequest;
use weave_host_protocol::sessions::TurnOrigin;
use weave_host_protocol::sessions::UnwatchSessionsRequest;
use weave_host_protocol::sessions::WatchSessionsRequest;
use weave_host_protocol::sessions::WatchSessionsResponse;
use weave_host_protocol::tools::CLIENT_TOOLS_FEATURE;
use weave_host_protocol::tools::CLIPBOARD_WRITE;
use weave_host_protocol::tools::ClientToolResult;
use weave_host_protocol::tools::catalog;
use weave_host_protocol::tools::host_catalog;
use weave_host_protocol::turns::CancelTurnRequest;
use weave_host_protocol::turns::StartTurnRequest;
use weave_host_protocol::turns::StartTurnResponse;
use weave_host_protocol::turns::SteerOutcome;
use weave_host_protocol::turns::SteerTurnRequest;
use weave_host_protocol::turns::SteerTurnResponse;
use weave_host_protocol::worktrees::CreateWorktreeRequest;
use weave_host_protocol::worktrees::CreateWorktreeResponse;
use weave_host_protocol::worktrees::Divergence;
use weave_host_protocol::worktrees::GitLocation;
use weave_host_protocol::worktrees::ListWorktreesRequest;
use weave_host_protocol::worktrees::ListWorktreesResponse;
use weave_host_protocol::worktrees::ReleaseWorktreeRequest;
use weave_host_protocol::worktrees::ReleaseWorktreeResponse;
use weave_host_protocol::worktrees::RemoveWorktreeRequest;
use weave_host_protocol::worktrees::RemoveWorktreeResponse;
use weave_host_protocol::worktrees::Upstream;
use weave_host_protocol::worktrees::Worktree;

/// A request or notification as sent: its method and params, after a round trip.
fn message<M: JsonRpcMessage + Serialize + DeserializeOwned>(message: &M) -> Value {
    let untyped = message.to_untyped_message().expect("converts");
    let params = round_trip(message);
    assert_eq!(
        serde_json::to_value(&untyped.params).ok(),
        Some(params.clone())
    );
    json!({"method": untyped.method, "params": params})
}

/// A response or a part of one, after a round trip.
fn round_trip<T: Serialize + DeserializeOwned>(value: &T) -> Value {
    let json = serde_json::to_value(value).expect("serializes");
    let back: T = serde_json::from_value(json.clone()).expect("deserializes");
    assert_eq!(
        serde_json::to_value(&back).expect("serializes"),
        json,
        "a round trip changed it"
    );
    json
}

fn text(text: &str) -> ContentBlock {
    ContentBlock::from(text.to_owned())
}

fn agent() -> AgentSummary {
    AgentSummary {
        id: "claude".to_owned(),
        name: "Claude".to_owned(),
        source: AgentSource::Preset,
        version: Some("0.31.0".to_owned()),
        installed: true,
        description: None,
    }
}

fn initialize() -> InitializeResponse {
    InitializeResponse::new(ProtocolVersion::V1)
        .agent_info(Implementation::new("claude-agent-acp", "0.31.0"))
}

fn permission() -> RequestPermissionRequest {
    RequestPermissionRequest::new(
        "s-1",
        ToolCallUpdate::new("t-1", ToolCallUpdateFields::new().title("Write a.rs")),
        vec![
            PermissionOption::new("once", "Allow once", PermissionOptionKind::AllowOnce),
            PermissionOption::new("no", "Reject", PermissionOptionKind::RejectOnce),
        ],
    )
}

fn pending() -> PendingRequest {
    PendingRequest {
        id: "p-1".to_owned(),
        session_id: Some("s-1".into()),
        created_at: 1_760_180_001_000,
        request: PendingKind::Permission {
            request: permission(),
        },
    }
}

fn release(version: &str) -> AgentRelease {
    AgentRelease {
        name: "@agentclientprotocol/claude-agent-acp".to_owned(),
        version: version.to_owned(),
    }
}

fn update() -> AgentUpdate {
    AgentUpdate {
        agent_id: "claude".to_owned(),
        name: "@agentclientprotocol/claude-agent-acp".to_owned(),
        running: "0.31.0".to_owned(),
        latest: "0.32.0".to_owned(),
    }
}

fn session_agent(version: &str) -> SessionAgent {
    SessionAgent {
        id: "claude".to_owned(),
        name: "Claude".to_owned(),
        initialize: initialize(),
        release: Some(release(version)),
    }
}

fn state() -> SessionState {
    SessionState {
        session_id: "s-1".into(),
        agent: session_agent("0.31.0"),
        cwd: "/repo".into(),
        additional_directories: vec!["/docs".into()],
        git: Some(git()),
        title: Some("Fix the parser".to_owned()),
        state: SessionStatus::Open,
        activity: Activity::Waiting,
        clients: 2,
        blank: false,
        policy: PermissionPolicy::ask(),
        modes: Some(SessionModeState::new(
            "default",
            vec![
                SessionMode::new("default", "Default"),
                SessionMode::new("plan", "Plan"),
            ],
        )),
        config_options: Vec::new(),
        turns: vec![RunningTurn {
            session_id: "s-1".into(),
            started_at: 1_760_180_000_000,
            origin: TurnOrigin::Client {
                name: "weave-tui".to_owned(),
                id: "c7".to_owned(),
                device: None,
            },
        }],
        queue: vec![queued()],
        queue_paused: None,
        pending: vec![pending()],
        subagents: vec!["s-1-child".into()],
        journal: JournalHead {
            id: "j-1760180000000".to_owned(),
            head: 41,
        },
        notices: vec!["The agent doesn't support MCP server docs over SSE; skipped".to_owned()],
        trace: None,
        update: Some(update()),
        started_by: None,
    }
}

fn tui() -> TurnOrigin {
    TurnOrigin::Client {
        name: "weave-tui".to_owned(),
        id: "c7".to_owned(),
        device: None,
    }
}

fn queued() -> QueuedPrompt {
    QueuedPrompt {
        id: "q-3".to_owned(),
        prompt: vec![text("then update the docs")],
        origin: tui(),
        queued_at: 1_760_180_000_500,
    }
}

fn host_info() -> HostInfo {
    HostInfo {
        id: "8ZpX3kqW1m0aLr9TQv2cYw".to_owned(),
        version: "0.1.0".to_owned(),
        pid: 4242,
        started_at: 1_760_180_000_000,
    }
}

fn acp_info() -> AcpInfo {
    AcpInfo {
        protocol_version: 1,
        unstable: vec!["session_compaction".to_owned(), "subagents".to_owned()],
    }
}

fn jwk() -> Jwk {
    Jwk {
        kty: "EC".to_owned(),
        crv: "P-256".to_owned(),
        x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU".to_owned(),
        y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0".to_owned(),
    }
}

fn device() -> Device {
    Device {
        id: "d-3q8Hf0aZ".to_owned(),
        name: "Jaco's iPad".to_owned(),
        paired_at: 1_760_180_000_000,
        last_seen_at: Some(1_760_180_005_000),
        connections: 1,
    }
}

fn listing() -> SessionListing {
    SessionListing {
        info: SessionInfo::new("s-1", "/repo").title("Fix the parser".to_owned()),
        agent_id: "claude".to_owned(),
        state: SessionStatus::Open,
        activity: Some(Activity::Running),
        clients: 1,
        headless: false,
        last_activity_at: Some(1_760_180_001_234),
        git: Some(git()),
        started_by: None,
    }
}

fn git() -> GitLocation {
    GitLocation {
        repo: "/repo".into(),
        worktree: "/repo".into(),
        branch: Some("main".to_owned()),
        remote: Some("github.com/jacobfvanzyl/weave".to_owned()),
    }
}

#[test]
fn hello() {
    insta::assert_json_snapshot!(
        "hello_request",
        message(&HelloRequest {
            protocol: VersionRange::supported(),
            client: ClientInfo {
                name: "weave-tui".to_owned(),
                version: "0.1.0".to_owned(),
            },
            auth: Auth::Local,
            capabilities: ClientCapabilities {
                terminal_sign_in: true,
                client_tools: Vec::new(),
            },
        })
    );
    insta::assert_json_snapshot!(
        "hello_request_client_tools",
        message(&HelloRequest {
            protocol: VersionRange::supported(),
            client: ClientInfo {
                name: "weave-tui".to_owned(),
                version: "0.1.0".to_owned(),
            },
            auth: Auth::Local,
            capabilities: ClientCapabilities {
                terminal_sign_in: true,
                client_tools: vec![CLIPBOARD_WRITE.to_owned()],
            },
        })
    );
    insta::assert_json_snapshot!(
        "hello_response_client_tools",
        round_trip(&HelloResponse {
            protocol: 2,
            client_id: "c7".to_owned(),
            host: host_info(),
            features: vec![CLIENT_TOOLS_FEATURE.to_owned()],
            acp: acp_info(),
            device: None,
        })
    );
    insta::assert_json_snapshot!(
        "hello_response",
        round_trip(&HelloResponse {
            protocol: 2,
            client_id: "c7".to_owned(),
            host: host_info(),
            features: Vec::new(),
            acp: acp_info(),
            device: None,
        })
    );
    insta::assert_json_snapshot!(
        "hello_response_remote",
        round_trip(&HelloResponse {
            protocol: 2,
            client_id: "c9".to_owned(),
            host: host_info(),
            features: vec![DEVICES_FEATURE.to_owned()],
            acp: acp_info(),
            device: Some(DeviceInfo {
                id: "d-3q8Hf0aZ".to_owned(),
                name: "Jaco's iPad".to_owned(),
            }),
        })
    );
    insta::assert_json_snapshot!(
        "hello_request_device",
        message(&HelloRequest {
            protocol: VersionRange::supported(),
            client: ClientInfo {
                name: "weave-ios".to_owned(),
                version: "0.1.0".to_owned(),
            },
            auth: Auth::Device {
                device_id: "d-3q8Hf0aZ".to_owned(),
                signature: "MEUCIQDsig".to_owned(),
            },
            capabilities: ClientCapabilities::default(),
        })
    );
    insta::assert_json_snapshot!(
        "hello_request_pair",
        message(&HelloRequest {
            protocol: VersionRange::supported(),
            client: ClientInfo {
                name: "weave-ios".to_owned(),
                version: "0.1.0".to_owned(),
            },
            auth: Auth::Pair {
                code: "4F1N2K7Q9R3T5V8W0X6Y2Z4A1B".to_owned(),
                device: NewDevice {
                    name: "Jaco's iPad".to_owned(),
                    public_key: jwk(),
                },
            },
            capabilities: ClientCapabilities::default(),
        })
    );
    insta::assert_json_snapshot!("challenge_request", message(&ChallengeRequest {}));
    insta::assert_json_snapshot!(
        "challenge_response",
        round_trip(&ChallengeResponse {
            host_id: "8ZpX3kqW1m0aLr9TQv2cYw".to_owned(),
            nonce: "q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7k8l9z0x1c".to_owned(),
            expires_at: 1_760_180_030_000,
        })
    );
    insta::assert_json_snapshot!(
        "auth",
        round_trip(&Auth::Token {
            token: "secret".to_owned()
        })
    );
}

#[test]
fn devices() {
    insta::assert_json_snapshot!(
        "offer_device_request",
        message(&OfferDeviceRequest {
            name: Some("Jaco's iPad".to_owned()),
        })
    );
    insta::assert_json_snapshot!(
        "offer_device_response",
        round_trip(&OfferDeviceResponse {
            code: "4F1N2K7Q9R3T5V8W0X6Y2Z4A1B".to_owned(),
            expires_at: 1_760_180_300_000,
            url: Some("wss://mac.example.ts.net:7341".to_owned()),
        })
    );
    insta::assert_json_snapshot!(
        "device_paired_notification",
        message(&DevicePairedNotification { device: device() })
    );
    insta::assert_json_snapshot!("list_devices_request", message(&ListDevicesRequest {}));
    insta::assert_json_snapshot!(
        "list_devices_response",
        round_trip(&ListDevicesResponse {
            devices: vec![device()],
        })
    );
    insta::assert_json_snapshot!(
        "revoke_device_request",
        message(&RevokeDeviceRequest {
            device_id: "d-3q8Hf0aZ".to_owned(),
        })
    );
}

#[test]
fn agents() {
    insta::assert_json_snapshot!(
        "list_agents_request",
        message(&ListAgentsRequest {
            include_registry: true,
            refresh: false,
        })
    );
    insta::assert_json_snapshot!(
        "list_agents_response",
        round_trip(&ListAgentsResponse {
            agents: vec![agent()],
            default_agent: Some("claude".to_owned()),
        })
    );
    insta::assert_json_snapshot!(
        "get_agent_request",
        message(&GetAgentRequest {
            agent_id: "claude".to_owned(),
        })
    );
    insta::assert_json_snapshot!(
        "get_agent_response",
        round_trip(&GetAgentResponse {
            agent: agent(),
            initialize: initialize(),
        })
    );
    insta::assert_json_snapshot!(
        "authenticate_agent_request",
        message(&AuthenticateAgentRequest {
            agent_id: "claude".to_owned(),
            method_id: "oauth".into(),
        })
    );
    insta::assert_json_snapshot!(
        "terminal_sign_in_request",
        message(&TerminalSignInRequest {
            agent_id: "claude".to_owned(),
            method_id: "login".into(),
        })
    );
    insta::assert_json_snapshot!(
        "terminal_sign_in_response",
        round_trip(&TerminalSignInResponse {
            command: "claude-agent-acp".to_owned(),
            args: vec!["--login".to_owned()],
            env: BTreeMap::from([("LOG".to_owned(), "debug".to_owned())]),
        })
    );
    insta::assert_json_snapshot!(
        "logout_agent_request",
        message(&LogoutAgentRequest {
            agent_id: "claude".to_owned(),
        })
    );
    insta::assert_json_snapshot!("empty", round_trip(&Empty {}));
}

#[test]
fn sessions() {
    insta::assert_json_snapshot!(
        "list_sessions_request",
        message(&ListSessionsRequest {
            agent_id: Some("claude".to_owned()),
            cwd: Some("/repo".into()),
            repo: None,
            cursor: None,
        })
    );
    insta::assert_json_snapshot!(
        "list_sessions_request_in_a_repository",
        message(&ListSessionsRequest {
            repo: Some("/repo/src".into()),
            ..ListSessionsRequest::default()
        })
    );
    insta::assert_json_snapshot!(
        "list_sessions_response",
        round_trip(&ListSessionsResponse {
            sessions: vec![listing()],
            next_cursor: Some("page-2".to_owned()),
        })
    );
    insta::assert_json_snapshot!("watch_sessions_request", message(&WatchSessionsRequest {}));
    insta::assert_json_snapshot!(
        "watch_sessions_response",
        round_trip(&WatchSessionsResponse {
            sessions: vec![listing()],
        })
    );
    insta::assert_json_snapshot!(
        "unwatch_sessions_request",
        message(&UnwatchSessionsRequest {})
    );
    insta::assert_json_snapshot!(
        "session_updated_notification",
        message(&SessionUpdatedNotification { session: listing() })
    );
    insta::assert_json_snapshot!(
        "session_removed_notification",
        message(&SessionRemovedNotification {
            session_id: "s-1".into(),
        })
    );
    insta::assert_json_snapshot!(
        "create_session_request",
        message(&CreateSessionRequest {
            agent_id: "claude".to_owned(),
            cwd: "/repo".into(),
            additional_directories: Vec::new(),
            mode: Some("plan".to_owned()),
            policy: None,
            trace: false,
        })
    );
    insta::assert_json_snapshot!("session_state", round_trip(&state()));
    insta::assert_json_snapshot!(
        "attach_session_request",
        message(&AttachSessionRequest {
            session_id: "s-1".into(),
            after: Some(JournalPosition {
                journal: "j-1760180000000".to_owned(),
                seq: 40,
            }),
            agent_id: None,
            cwd: None,
            trace: false,
        })
    );
    insta::assert_json_snapshot!(
        "attach_session_response",
        round_trip(&AttachSessionResponse {
            state: state(),
            replay: Replay {
                from: 41,
                reset: false,
            },
        })
    );
    insta::assert_json_snapshot!(
        "detach_session_request",
        message(&DetachSessionRequest {
            session_id: "s-1".into(),
            close: CloseWhen::IfUnused,
        })
    );
    insta::assert_json_snapshot!(
        "close_session_request",
        message(&CloseSessionRequest {
            session_id: "s-1".into(),
        })
    );
    insta::assert_json_snapshot!(
        "delete_session_request",
        message(&DeleteSessionRequest {
            session_id: "s-1".into(),
            agent_id: Some("claude".to_owned()),
        })
    );
    insta::assert_json_snapshot!(
        "rename_session_request",
        message(&RenameSessionRequest {
            session_id: "s-1".into(),
            title: "Parser fixes".to_owned(),
        })
    );
    insta::assert_json_snapshot!(
        "set_mode_request",
        message(&SetModeRequest {
            session_id: "s-1".into(),
            mode_id: "plan".into(),
        })
    );
    insta::assert_json_snapshot!(
        "set_config_option_request",
        message(&SetConfigOptionRequest {
            session_id: "s-1".into(),
            config_id: "thinking".into(),
            value: SessionConfigOptionValue::Boolean { value: true },
        })
    );
    insta::assert_json_snapshot!(
        "run_request",
        message(&RunRequest {
            agent_id: "codex".to_owned(),
            cwd: "/repo".into(),
            session_id: None,
            additional_directories: Vec::new(),
            prompt: vec![text("fix the tests")],
            policy: PermissionPolicy::headless(vec![ToolKind::Read, ToolKind::Edit]),
            attach: false,
            trace: false,
            key: None,
        })
    );
    insta::assert_json_snapshot!(
        "run_request_keyed",
        message(&RunRequest {
            agent_id: "codex".to_owned(),
            cwd: "/repo".into(),
            session_id: None,
            additional_directories: Vec::new(),
            prompt: vec![text("fix the tests")],
            policy: PermissionPolicy::headless(vec![ToolKind::Read]),
            attach: false,
            trace: false,
            key: Some("nightly-2026-10-23".to_owned()),
        })
    );
    insta::assert_json_snapshot!(
        "run_response",
        round_trip(&RunResponse {
            session_id: "s-2".into(),
            state: None,
        })
    );
}

#[test]
fn files() {
    insta::assert_json_snapshot!(
        "list_files_request",
        message(&ListFilesRequest {
            path: Some("/Users/jaco/Projects".into()),
            hidden: true,
        })
    );
    insta::assert_json_snapshot!(
        "list_files_response",
        round_trip(&ListFilesResponse {
            path: "/Users/jaco/Projects".into(),
            parent: Some("/Users/jaco".into()),
            home: "/Users/jaco".into(),
            entries: vec![
                FileEntry {
                    name: "weave".to_owned(),
                    kind: FileKind::Directory,
                },
                FileEntry {
                    name: "notes.md".to_owned(),
                    kind: FileKind::File,
                },
                FileEntry {
                    name: "socket".to_owned(),
                    kind: FileKind::Other,
                },
            ],
            truncated: false,
        })
    );
}

#[test]
fn worktrees() {
    insta::assert_json_snapshot!(
        "list_worktrees_request",
        message(&ListWorktreesRequest {
            repo: "/Users/jaco/Projects/weave".into(),
        })
    );
    insta::assert_json_snapshot!(
        "list_worktrees_response",
        round_trip(&ListWorktreesResponse {
            repo: "/Users/jaco/Projects/weave".into(),
            remote: Some("github.com/jacobfvanzyl/weave".to_owned()),
            default_branch: Some("main".to_owned()),
            worktrees: vec![
                Worktree {
                    path: "/Users/jaco/Projects/weave".into(),
                    branch: Some("main".to_owned()),
                    head: Some("4ec84ecd295eb5d9052c10dc5cc2f28a082c7fff".to_owned()),
                    primary: true,
                    changes: false,
                    divergence: Some(Divergence::default()),
                    upstream: Some(Upstream {
                        name: "origin/main".to_owned(),
                        divergence: Divergence {
                            ahead: 0,
                            behind: 2,
                        },
                    }),
                    sessions: vec!["s-1".into()],
                },
                Worktree {
                    path: "/Users/jaco/Projects/weave.feature-auth".into(),
                    branch: Some("feature/auth".to_owned()),
                    head: Some("b772e68a3d0c4f1e9b2a7c5d8e6f1a2b3c4d5e6f".to_owned()),
                    primary: false,
                    changes: true,
                    divergence: Some(Divergence {
                        ahead: 3,
                        behind: 1,
                    }),
                    upstream: None,
                    sessions: Vec::new(),
                },
                Worktree {
                    path: "/Users/jaco/Projects/weave.review".into(),
                    branch: None,
                    head: Some("41ee083c9d7e5f2a1b3c4d5e6f7a8b9c0d1e2f3a".to_owned()),
                    primary: false,
                    changes: false,
                    divergence: None,
                    upstream: None,
                    sessions: Vec::new(),
                },
            ],
        })
    );
    insta::assert_json_snapshot!(
        "create_worktree_request",
        message(&CreateWorktreeRequest {
            repo: "/Users/jaco/Projects/weave".into(),
            branch: "feature/auth".to_owned(),
            base: Some("main".to_owned()),
        })
    );
    insta::assert_json_snapshot!(
        "create_worktree_response",
        round_trip(&CreateWorktreeResponse {
            path: "/Users/jaco/Projects/weave.feature-auth".into(),
            branch: "feature/auth".to_owned(),
            created_branch: true,
        })
    );
    insta::assert_json_snapshot!(
        "remove_worktree_request",
        message(&RemoveWorktreeRequest {
            path: "/Users/jaco/Projects/weave.feature-auth".into(),
            force: true,
            delete_branch: false,
        })
    );
    insta::assert_json_snapshot!(
        "remove_worktree_response",
        round_trip(&RemoveWorktreeResponse {
            closed: vec!["s-2".into()],
            branch: Some("feature/auth".to_owned()),
            branch_deleted: false,
        })
    );
    insta::assert_json_snapshot!(
        "release_worktree_request",
        message(&ReleaseWorktreeRequest {
            path: "/Users/jaco/Projects/weave.feature-auth".into(),
        })
    );
    insta::assert_json_snapshot!(
        "release_worktree_response",
        round_trip(&ReleaseWorktreeResponse {
            closed: vec!["s-2".into()],
        })
    );
}

#[test]
fn turns() {
    insta::assert_json_snapshot!(
        "start_turn_request",
        message(&StartTurnRequest {
            session_id: "s-1".into(),
            prompt: vec![text("hello")],
            key: None,
        })
    );
    insta::assert_json_snapshot!(
        "start_turn_request_keyed",
        message(&StartTurnRequest {
            session_id: "s-1".into(),
            prompt: vec![text("hello")],
            key: Some("0b6f8f9e-6d1c-4d55-9a53-2d0f6f7f1c11".to_owned()),
        })
    );
    insta::assert_json_snapshot!(
        "start_turn_response",
        round_trip(&StartTurnResponse { seq: 42 })
    );
    insta::assert_json_snapshot!(
        "cancel_turn_request",
        message(&CancelTurnRequest {
            session_id: "s-1".into(),
        })
    );
    insta::assert_json_snapshot!(
        "steer_turn_request",
        message(&SteerTurnRequest {
            session_id: "s-1".into(),
            prompt: vec![text("use the other branch")],
        })
    );
    insta::assert_json_snapshot!(
        "steer_turn_response",
        round_trip(&SteerTurnResponse {
            outcome: SteerOutcome::Steered,
            seq: Some(43),
        })
    );
    insta::assert_json_snapshot!(
        "steer_turn_response_not_running",
        round_trip(&SteerTurnResponse {
            outcome: SteerOutcome::NotRunning,
            seq: None,
        })
    );
}

#[test]
fn delegated_sessions() {
    let delegated = SessionListing {
        info: SessionInfo::new("s-2", "/repo").title("Port the tests".to_owned()),
        agent_id: "codex".to_owned(),
        started_by: Some("s-1".into()),
        ..listing()
    };
    insta::assert_json_snapshot!(
        "get_session_request",
        message(&GetSessionRequest {
            session_id: "s-2".into(),
        })
    );
    insta::assert_json_snapshot!(
        "get_session_response",
        round_trip(&GetSessionResponse {
            session: delegated.clone(),
            latest_turn: Some(LatestTurn {
                prompt: vec![text("port the parser's tests to the new runner")],
                origin: TurnOrigin::Session {
                    session_id: "s-1".into(),
                },
                started_at: 1_760_180_000_000,
                running: false,
                response: Some(PromptResponse::new(StopReason::EndTurn)),
                error: None,
                message: Some("Ported 14 tests; all pass.".to_owned()),
            }),
        })
    );
    insta::assert_json_snapshot!(
        "get_session_response_running",
        round_trip(&GetSessionResponse {
            session: delegated,
            latest_turn: Some(LatestTurn {
                prompt: vec![text("port the parser's tests to the new runner")],
                origin: TurnOrigin::Session {
                    session_id: "s-1".into(),
                },
                started_at: 1_760_180_000_000,
                running: true,
                response: None,
                error: None,
                message: None,
            }),
        })
    );
}

#[test]
fn queue() {
    insta::assert_json_snapshot!(
        "add_queued_request",
        message(&AddQueuedRequest {
            session_id: "s-1".into(),
            prompt: vec![text("then update the docs")],
            key: Some("0b6f8f9e-6d1c-4d55-9a53-2d0f6f7f1c12".to_owned()),
        })
    );
    insta::assert_json_snapshot!(
        "add_queued_response",
        round_trip(&AddQueuedResponse {
            queued_id: "q-3".to_owned(),
            seq: 44,
            started: false,
        })
    );
    insta::assert_json_snapshot!(
        "add_queued_response_started",
        round_trip(&AddQueuedResponse {
            queued_id: "q-4".to_owned(),
            seq: 45,
            started: true,
        })
    );
    insta::assert_json_snapshot!(
        "remove_queued_request",
        message(&RemoveQueuedRequest {
            session_id: "s-1".into(),
            queued_id: "q-3".to_owned(),
        })
    );
    insta::assert_json_snapshot!(
        "remove_queued_response",
        round_trip(&RemoveQueuedResponse {
            removed: Some(queued()),
        })
    );
    insta::assert_json_snapshot!(
        "remove_queued_response_gone",
        round_trip(&RemoveQueuedResponse { removed: None })
    );
    insta::assert_json_snapshot!(
        "resume_queue_request",
        message(&ResumeQueueRequest {
            session_id: "s-1".into(),
        })
    );
    insta::assert_json_snapshot!(
        "attach_session_response_queue_paused",
        round_trip(&AttachSessionResponse {
            state: SessionState {
                activity: Activity::Idle,
                turns: Vec::new(),
                pending: Vec::new(),
                queue_paused: Some(QueuePause::Cancelled),
                ..state()
            },
            replay: Replay {
                from: 1,
                reset: true,
            },
        })
    );
}

#[test]
fn events() {
    let event = |seq, event| SessionEventNotification {
        session_id: "s-1".into(),
        seq,
        at: 1_760_180_001_234,
        event,
    };
    insta::assert_json_snapshot!(
        "event_turn_started",
        message(&event(
            41,
            SessionEvent::TurnStarted {
                session_id: "s-1".into(),
                prompt: vec![text("hello")],
                origin: TurnOrigin::Client {
                    name: "weave-tui".to_owned(),
                    id: "c7".to_owned(),
                    device: None,
                },
                queued_id: None,
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_turn_started_remote",
        message(&event(
            41,
            SessionEvent::TurnStarted {
                session_id: "s-1".into(),
                prompt: vec![text("hello")],
                origin: TurnOrigin::Client {
                    name: "weave-ios".to_owned(),
                    id: "c9".to_owned(),
                    device: Some("Jaco's iPad".to_owned()),
                },
                queued_id: None,
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_turn_started_from_the_queue",
        message(&event(
            49,
            SessionEvent::TurnStarted {
                session_id: "s-1".into(),
                prompt: vec![text("then update the docs")],
                origin: tui(),
                queued_id: Some("q-3".to_owned()),
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_turn_started_by_another_session",
        message(&event(
            41,
            SessionEvent::TurnStarted {
                session_id: "s-2".into(),
                prompt: vec![text("port the parser's tests to the new runner")],
                origin: TurnOrigin::Session {
                    session_id: "s-1".into(),
                },
                queued_id: None,
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_queued",
        message(&event(
            44,
            SessionEvent::Queued {
                queued_id: "q-3".to_owned(),
                prompt: vec![text("then update the docs")],
                origin: tui(),
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_unqueued",
        message(&event(
            50,
            SessionEvent::Unqueued {
                queued_id: "q-5".to_owned(),
                by: Some(TurnOrigin::Client {
                    name: "weave-app".to_owned(),
                    id: "c9".to_owned(),
                    device: Some("Jaco's iPad".to_owned()),
                }),
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_queue_paused",
        message(&event(
            51,
            SessionEvent::QueuePaused {
                reason: QueuePause::Cancelled,
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_queue_resumed",
        message(&event(52, SessionEvent::QueueResumed { by: Some(tui()) }))
    );
    insta::assert_json_snapshot!(
        "event_renamed",
        message(&event(
            39,
            SessionEvent::Renamed {
                title: "Parser fixes".to_owned(),
                by: Some(TurnOrigin::Client {
                    name: "weave-app".to_owned(),
                    id: "c9".to_owned(),
                    device: Some("Jaco's iPad".to_owned()),
                }),
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_renamed_by_its_agent",
        message(&event(
            39,
            SessionEvent::Renamed {
                title: "Parser fixes".to_owned(),
                by: None,
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_notice",
        message(&event(
            40,
            SessionEvent::Notice {
                text: "This agent can't use client tools.".to_owned(),
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_update",
        message(&event(
            42,
            SessionEvent::Update {
                notification: Box::new(SessionNotification::new(
                    "s-1",
                    SessionUpdate::AgentMessageChunk(ContentChunk::new(text("Done."))),
                )),
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_terminal_output",
        message(&event(
            43,
            SessionEvent::TerminalOutput {
                terminal_id: "term-1".into(),
                data: "ok\n".to_owned(),
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_terminal_exit",
        message(&event(
            44,
            SessionEvent::TerminalExit {
                terminal_id: "term-1".into(),
                status: TerminalExitStatus::new().exit_code(0),
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_turn_ended",
        message(&event(
            45,
            SessionEvent::TurnEnded {
                session_id: "s-1".into(),
                response: Some(PromptResponse::new(StopReason::EndTurn)),
                error: None,
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_run_started",
        message(&event(
            46,
            SessionEvent::TurnStarted {
                session_id: "s-1".into(),
                prompt: vec![text("fix the tests")],
                origin: TurnOrigin::Run {},
                queued_id: None,
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_closed",
        message(&event(
            47,
            SessionEvent::Closed {
                reason: "idle".to_owned(),
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_turn_steered",
        message(&event(
            48,
            SessionEvent::TurnSteered {
                session_id: "s-1".into(),
                prompt: vec![text("use the other branch")],
                origin: TurnOrigin::Client {
                    name: "weave-tui".to_owned(),
                    id: "c7".to_owned(),
                    device: None,
                },
            },
        ))
    );
    insta::assert_json_snapshot!(
        "session_changed_notification",
        message(&SessionChangedNotification {
            session_id: "s-1".into(),
            activity: Some(Activity::Idle),
            clients: Some(1),
            title: None,
            blank: None,
            git: None,
        })
    );
    insta::assert_json_snapshot!(
        "session_changed_notification_branch",
        message(&SessionChangedNotification {
            session_id: "s-1".into(),
            activity: None,
            clients: None,
            title: None,
            blank: None,
            git: Some(GitLocation {
                worktree: "/repo.feature-auth".into(),
                branch: Some("feature/auth".to_owned()),
                ..git()
            }),
        })
    );
    insta::assert_json_snapshot!(
        "elicitation_completed_notification",
        message(&ElicitationCompletedNotification {
            session_id: "s-1".into(),
            notification: CompleteElicitationNotification::new("connect-1"),
        })
    );
}

#[test]
fn updates() {
    assert_eq!(UPDATES_FEATURE, "agents/updates");
    insta::assert_json_snapshot!(
        "update_available_notification",
        message(&UpdateAvailableNotification {
            session_id: "s-1".into(),
            update: update(),
        })
    );
    insta::assert_json_snapshot!(
        "update_agent_request",
        message(&UpdateAgentRequest {
            agent_id: "claude".to_owned(),
        })
    );
    insta::assert_json_snapshot!(
        "update_agent_response",
        round_trip(&UpdateAgentResponse {
            version: "0.32.0".to_owned(),
        })
    );
    insta::assert_json_snapshot!(
        "reopen_session_request",
        message(&ReopenSessionRequest {
            session_id: "s-1".into(),
        })
    );
    insta::assert_json_snapshot!(
        "reopen_session_response",
        round_trip(&ReopenSessionResponse {
            version: Some("0.32.0".to_owned()),
        })
    );
    insta::assert_json_snapshot!(
        "event_agent_reopened",
        message(&SessionEventNotification {
            session_id: "s-1".into(),
            seq: 49,
            at: 1_760_180_009_000,
            event: SessionEvent::AgentReopened {
                agent: Box::new(session_agent("0.32.0")),
                previous: Some(release("0.31.0")),
                modes: None,
                config_options: Vec::new(),
                failed: None,
            },
        })
    );
    insta::assert_json_snapshot!(
        "event_agent_reopened_on_the_old_version",
        message(&SessionEventNotification {
            session_id: "s-1".into(),
            seq: 49,
            at: 1_760_180_009_000,
            event: SessionEvent::AgentReopened {
                agent: Box::new(session_agent("0.31.0")),
                previous: Some(release("0.31.0")),
                modes: None,
                config_options: Vec::new(),
                failed: Some("0.32.0 couldn't resume the session: unknown session".to_owned()),
            },
        })
    );
}

#[test]
fn pending_requests() {
    insta::assert_json_snapshot!(
        "pending_added_notification",
        message(&PendingAddedNotification {
            session_id: "s-1".into(),
            pending: pending(),
        })
    );
    insta::assert_json_snapshot!(
        "pending_request",
        round_trip(&PendingRequest {
            id: "p-2".to_owned(),
            session_id: Some("s-1".into()),
            created_at: 1_760_180_001_000,
            request: PendingKind::Elicitation {
                request: CreateElicitationRequest::new(
                    ElicitationUrlMode::new(
                        ElicitationSessionScope::new("s-1"),
                        "connect-1",
                        "https://example.com/oauth",
                    ),
                    "Connect your Example account.",
                ),
            },
        })
    );
    insta::assert_json_snapshot!(
        "pending_resolved_notification",
        message(&PendingResolvedNotification {
            session_id: "s-1".into(),
            pending_id: "p-1".to_owned(),
            outcome: Resolution::Answered,
            by: Some("c7".to_owned()),
        })
    );
    insta::assert_json_snapshot!(
        "answer_pending_request",
        message(&AnswerPendingRequest {
            session_id: "s-1".into(),
            pending_id: "p-1".to_owned(),
            permission: Some(RequestPermissionResponse::new(
                RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new("once")),
            )),
            elicitation: None,
            client_tool: None,
        })
    );
    insta::assert_json_snapshot!(
        "answer_pending_request_2",
        message(&AnswerPendingRequest {
            session_id: "s-1".into(),
            pending_id: "p-2".to_owned(),
            permission: None,
            elicitation: Some(CreateElicitationResponse::new(ElicitationAction::Decline)),
            client_tool: None,
        })
    );
    insta::assert_json_snapshot!(
        "pending_request_client_tool",
        round_trip(&PendingRequest {
            id: "p-3".to_owned(),
            session_id: Some("s-1".into()),
            created_at: 1_760_180_001_000,
            request: PendingKind::ClientTool {
                tool: CLIPBOARD_WRITE.to_owned(),
                arguments: json!({"text": "cargo test -p weave-host"})
                    .as_object()
                    .cloned()
                    .expect("an object"),
                target: "c7".to_owned(),
            },
        })
    );
    insta::assert_json_snapshot!(
        "answer_pending_request_client_tool",
        message(&AnswerPendingRequest {
            session_id: "s-1".into(),
            pending_id: "p-3".to_owned(),
            permission: None,
            elicitation: None,
            client_tool: Some(ClientToolResult::text("Copied to the clipboard.")),
        })
    );
}

#[test]
fn client_tools() {
    insta::assert_json_snapshot!("client_tool_catalog", round_trip(&catalog()));
    insta::assert_json_snapshot!("host_tool_catalog", round_trip(&host_catalog()));
    insta::assert_json_snapshot!(
        "client_tool_error",
        round_trip(&ClientToolResult::error(
            "The person's device isn't connected."
        ))
    );
}

#[test]
fn host() {
    insta::assert_json_snapshot!("status_request", message(&StatusRequest {}));
    insta::assert_json_snapshot!(
        "host_status",
        round_trip(&HostStatus {
            protocol: 2,
            version: "0.1.0".to_owned(),
            pid: 4242,
            started_at: 1_760_180_000_000,
            service: Service::OnDemand,
            environment: EnvironmentSource::LoginShell,
            sessions: vec![listing()],
            remote: Some("127.0.0.1:7341".to_owned()),
        })
    );
    insta::assert_json_snapshot!("shutdown_request", message(&ShutdownRequest {}));
    insta::assert_json_snapshot!(
        "drain_request",
        message(&DrainRequest {
            wait: true,
            except: Some("a-3f9c2e7d".to_owned()),
        })
    );
    insta::assert_json_snapshot!("drain_response", round_trip(&DrainResponse { running: 1 }));
}

/// What a newer Host may send, an older client must still read.
#[test]
fn unknown_event_kinds_and_fields_are_tolerated() {
    let notification: SessionEventNotification = serde_json::from_value(json!({
        "sessionId": "s-1", "seq": 7, "at": 1, "later": true,
        "event": {"kind": "somethingNew", "detail": [1, 2]}
    }))
    .expect("an unknown kind still parses");
    assert_eq!(notification.seq, 7);
    assert!(matches!(notification.event, SessionEvent::Unknown));

    let hello: HelloRequest = serde_json::from_value(json!({
        "protocol": {"min": 2, "max": 3},
        "client": {"name": "ipad", "version": "1"},
        "auth": {"method": "local"},
        "later": {"anything": 1}
    }))
    .expect("unknown fields are ignored");
    assert_eq!(hello.capabilities, ClientCapabilities::default());

    let entry: FileEntry = serde_json::from_value(json!({"name": "fifo", "kind": "namedPipe"}))
        .expect("an unknown kind still parses");
    assert_eq!(entry.kind, FileKind::Other);
}
