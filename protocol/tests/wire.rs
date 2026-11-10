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
use weave_host_protocol::PROTOCOL_VERSION;
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
use weave_host_protocol::dispatcher::AddProjectRequest;
use weave_host_protocol::dispatcher::CARRY_FEATURE;
use weave_host_protocol::dispatcher::CarriedStream;
use weave_host_protocol::dispatcher::CarryRequest;
use weave_host_protocol::dispatcher::DispatcherAddress;
use weave_host_protocol::dispatcher::DispatcherHello;
use weave_host_protocol::dispatcher::GetProjectRequest;
use weave_host_protocol::dispatcher::HostCarried;
use weave_host_protocol::dispatcher::HostCarryRequest;
use weave_host_protocol::dispatcher::HostUnavailable;
use weave_host_protocol::dispatcher::JoinDispatcherRequest;
use weave_host_protocol::dispatcher::JoinDispatcherResponse;
use weave_host_protocol::dispatcher::JoinedDispatcher;
use weave_host_protocol::dispatcher::LeaveDispatcherRequest;
use weave_host_protocol::dispatcher::ListProjectsRequest;
use weave_host_protocol::dispatcher::ListProjectsResponse;
use weave_host_protocol::dispatcher::NewLocation;
use weave_host_protocol::dispatcher::OpenHostRequest;
use weave_host_protocol::dispatcher::OpenedHost;
use weave_host_protocol::dispatcher::PROJECTS_FEATURE;
use weave_host_protocol::dispatcher::Project;
use weave_host_protocol::dispatcher::ProjectKind;
use weave_host_protocol::dispatcher::ProjectLocation;
use weave_host_protocol::dispatcher::ProjectResponse;
use weave_host_protocol::dispatcher::Reachability;
use weave_host_protocol::dispatcher::RemoveProjectRequest;
use weave_host_protocol::dispatcher::UpdateProjectRequest;
use weave_host_protocol::dispatcher::carry_message;
use weave_host_protocol::events::ElicitationCompletedNotification;
use weave_host_protocol::events::ThreadChangedNotification;
use weave_host_protocol::events::ThreadEvent;
use weave_host_protocol::events::ThreadEventNotification;
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
use weave_host_protocol::host::ServeEntryLeft;
use weave_host_protocol::host::Service;
use weave_host_protocol::host::ShutdownRequest;
use weave_host_protocol::host::StatusRequest;
use weave_host_protocol::mcp::McpServerSource;
use weave_host_protocol::mcp::McpServerState;
use weave_host_protocol::mcp::McpServerStatus;
use weave_host_protocol::mcp::McpTransport;
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
use weave_host_protocol::threads::Activity;
use weave_host_protocol::threads::AttachThreadRequest;
use weave_host_protocol::threads::AttachThreadResponse;
use weave_host_protocol::threads::CloseThreadRequest;
use weave_host_protocol::threads::CloseWhen;
use weave_host_protocol::threads::ContextUsage;
use weave_host_protocol::threads::CreateThreadRequest;
use weave_host_protocol::threads::DeleteThreadRequest;
use weave_host_protocol::threads::DetachThreadRequest;
use weave_host_protocol::threads::GetThreadRequest;
use weave_host_protocol::threads::GetThreadResponse;
use weave_host_protocol::threads::JournalHead;
use weave_host_protocol::threads::JournalPosition;
use weave_host_protocol::threads::LabelThreadRequest;
use weave_host_protocol::threads::LabelThreadResponse;
use weave_host_protocol::threads::LastCompaction;
use weave_host_protocol::threads::LatestTurn;
use weave_host_protocol::threads::ListThreadsRequest;
use weave_host_protocol::threads::ListThreadsResponse;
use weave_host_protocol::threads::OtherThread;
use weave_host_protocol::threads::RenameThreadRequest;
use weave_host_protocol::threads::ReopenThreadRequest;
use weave_host_protocol::threads::ReopenThreadResponse;
use weave_host_protocol::threads::Replay;
use weave_host_protocol::threads::ReportThreadRequest;
use weave_host_protocol::threads::RunRequest;
use weave_host_protocol::threads::RunResponse;
use weave_host_protocol::threads::RunningTurn;
use weave_host_protocol::threads::ServiceOrigin;
use weave_host_protocol::threads::SetConfigOptionRequest;
use weave_host_protocol::threads::SetModeRequest;
use weave_host_protocol::threads::SetSuccessorRequest;
use weave_host_protocol::threads::ThreadAgent;
use weave_host_protocol::threads::ThreadListing;
use weave_host_protocol::threads::ThreadRemovedNotification;
use weave_host_protocol::threads::ThreadState;
use weave_host_protocol::threads::ThreadStatus;
use weave_host_protocol::threads::ThreadUpdatedNotification;
use weave_host_protocol::threads::TurnOrigin;
use weave_host_protocol::threads::TurnState;
use weave_host_protocol::threads::UnwatchThreadsRequest;
use weave_host_protocol::threads::WatchThreadsRequest;
use weave_host_protocol::threads::WatchThreadsResponse;
use weave_host_protocol::tools::AnswerToolRequest;
use weave_host_protocol::tools::CLIENT_TOOLS_FEATURE;
use weave_host_protocol::tools::CLIPBOARD_WRITE;
use weave_host_protocol::tools::ClientToolResult;
use weave_host_protocol::tools::DeclareToolsRequest;
use weave_host_protocol::tools::DeclareToolsResponse;
use weave_host_protocol::tools::HostCall;
use weave_host_protocol::tools::HostCallNotification;
use weave_host_protocol::tools::Tool;
use weave_host_protocol::tools::ToolCallCancelledNotification;
use weave_host_protocol::tools::ToolCallNotification;
use weave_host_protocol::tools::ToolCaller;
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
        thread_id: Some("s-1".into()),
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

fn thread_agent(version: &str) -> ThreadAgent {
    ThreadAgent {
        id: "claude".to_owned(),
        name: "Claude".to_owned(),
        initialize: initialize(),
        release: Some(release(version)),
    }
}

/// The Host's own server, connected, a configured server passed on, and one skipped.
fn mcp_servers() -> Vec<McpServerStatus> {
    vec![
        McpServerStatus {
            name: "weave".to_owned(),
            source: McpServerSource::Host,
            transport: Some(McpTransport::Acp),
            state: McpServerState::Connected,
            reason: None,
        },
        McpServerStatus {
            name: "github".to_owned(),
            source: McpServerSource::Config,
            transport: Some(McpTransport::Stdio),
            state: McpServerState::Passed,
            reason: None,
        },
        McpServerStatus {
            name: "docs".to_owned(),
            source: McpServerSource::Config,
            transport: None,
            state: McpServerState::Skipped,
            reason: Some("the agent does not support the sse transport".to_owned()),
        },
    ]
}

fn state() -> ThreadState {
    ThreadState {
        thread_id: "s-1".into(),
        agent: thread_agent("0.31.0"),
        cwd: "/repo".into(),
        additional_directories: vec!["/docs".into()],
        git: Some(git()),
        title: Some("Fix the parser".to_owned()),
        state: ThreadStatus::Open,
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
            thread_id: "s-1".into(),
            started_at: 1_760_180_000_000,
            origin: TurnOrigin::Client {
                name: "weave-tui".to_owned(),
                id: "c7".to_owned(),
                device: None,
            },
            turn_id: Some("t-7".to_owned()),
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
        mcp_servers: mcp_servers(),
        trace: None,
        update: Some(update()),
        started_by: None,
        started_by_host: None,
        continued_in: None,
        labels: Vec::new(),
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
        service: false,
    }
}

fn listing() -> ThreadListing {
    ThreadListing {
        info: SessionInfo::new("s-1", "/repo").title("Fix the parser".to_owned()),
        agent_id: "claude".to_owned(),
        state: ThreadStatus::Open,
        activity: Some(Activity::Running),
        clients: 1,
        headless: false,
        last_activity_at: Some(1_760_180_001_234),
        git: Some(git()),
        started_by: None,
        started_by_host: None,
        opened_by: Some(TurnOrigin::Client {
            name: "weave-app".to_owned(),
            id: "c9".to_owned(),
            device: Some("Jaco's iPad".to_owned()),
        }),
        opened_at: Some(1_760_180_000_500),
        continued_in: None,
        labels: Vec::new(),
        context: None,
        last_compaction: None,
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
            protocol: PROTOCOL_VERSION,
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
            protocol: PROTOCOL_VERSION,
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
            protocol: PROTOCOL_VERSION,
            client_id: "c9".to_owned(),
            host: host_info(),
            features: vec![CARRY_FEATURE.to_owned()],
            acp: acp_info(),
            device: Some(DeviceInfo {
                id: "d-3q8Hf0aZ".to_owned(),
                name: "Jaco's iPad".to_owned(),
                service: false,
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
                    service: false,
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

/// Services, such as the Dispatcher, and the person's other Hosts it reaches for a Host's
/// agents (ADR 0029): turns there name the thread on the calling Host that asks, and reports
/// name the thread they're on.
#[test]
fn services_and_other_hosts() {
    insta::assert_json_snapshot!(
        "service_pairing",
        round_trip(&Auth::Pair {
            code: "4F1N2K7Q9R3T5V8W0X6Y2Z4A1B".to_owned(),
            device: NewDevice {
                name: "Dispatcher".to_owned(),
                public_key: jwk(),
                service: true,
            },
        })
    );
    insta::assert_json_snapshot!(
        "service_device",
        round_trip(&Device {
            name: "Dispatcher".to_owned(),
            service: true,
            ..device()
        })
    );
    insta::assert_json_snapshot!(
        "service_device_info",
        round_trip(&DeviceInfo {
            id: "d-3q8Hf0aZ".to_owned(),
            name: "Dispatcher".to_owned(),
            service: true,
        })
    );
    let caller = OtherThread {
        thread_id: "sess-a".into(),
        host: "h-2Lm9".to_owned(),
        host_name: Some("mini".to_owned()),
    };
    let run = RunRequest {
        agent_id: "codex".to_owned(),
        cwd: "~/src/app".into(),
        remote: Some("github.com/jaco/app".to_owned()),
        thread_id: None,
        additional_directories: Vec::new(),
        mode: None,
        prompt: vec![ContentBlock::from("Review the auth change")],
        policy: PermissionPolicy::ask(),
        attach: false,
        trace: false,
        key: Some("Yk9…".to_owned()),
        caller: Some(caller),
        origin: None,
        labels: Vec::new(),
    };
    insta::assert_json_snapshot!("other_host_run_request", message(&run));
    insta::assert_json_snapshot!(
        "service_run_request",
        message(&RunRequest {
            agent_id: "claude".to_owned(),
            cwd: "/Users/jaco/src/app".into(),
            remote: None,
            thread_id: None,
            additional_directories: Vec::new(),
            mode: None,
            prompt: vec![ContentBlock::from(
                "Review yesterday's merged pull requests"
            )],
            policy: PermissionPolicy::ask(),
            attach: false,
            trace: false,
            key: Some("daily-review@1760180000000".to_owned()),
            caller: None,
            origin: Some(ServiceOrigin {
                label: "schedule daily-review".to_owned(),
                id: "o-01J9Z".to_owned(),
            }),
            labels: Vec::new(),
        })
    );
    insta::assert_json_snapshot!(
        "service_turn_origin",
        round_trip(&TurnOrigin::Service {
            name: "Dispatcher".to_owned(),
            label: "schedule daily-review".to_owned(),
            id: "o-01J9Z".to_owned(),
        })
    );
    insta::assert_json_snapshot!(
        "other_host_turn_origin",
        round_trip(&TurnOrigin::Thread {
            thread_id: "sess-a".into(),
            host: Some("h-2Lm9".to_owned()),
            host_name: Some("mini".to_owned()),
            report: false,
        })
    );
    insta::assert_json_snapshot!(
        "declare_tools_hosts_request",
        message(&DeclareToolsRequest {
            tools: Vec::new(),
            hosts: true,
        })
    );
    let tool_caller = ToolCaller {
        thread_id: "sess-a".into(),
        agent_id: "claude".to_owned(),
        cwd: "/Users/jaco/src/app".into(),
        policy: PermissionPolicy::ask(),
        labels: Vec::new(),
    };
    insta::assert_json_snapshot!(
        "host_call_notification",
        message(&HostCallNotification {
            call_id: "c-2".to_owned(),
            host: Some("studio".to_owned()),
            call: HostCall::Run(Box::new(RunRequest {
                caller: None,
                key: None,
                ..run
            })),
            caller: tool_caller.clone(),
            room: Some(2),
        })
    );
    insta::assert_json_snapshot!(
        "list_hosts_call_notification",
        message(&HostCallNotification {
            call_id: "c-3".to_owned(),
            host: None,
            call: HostCall::ListHosts,
            caller: tool_caller.clone(),
            room: None,
        })
    );
    insta::assert_json_snapshot!(
        "list_projects_call_notification",
        message(&HostCallNotification {
            call_id: "c-4".to_owned(),
            host: None,
            call: HostCall::ListProjects,
            caller: tool_caller,
            room: None,
        })
    );
    insta::assert_json_snapshot!(
        "report_thread_request",
        message(&ReportThreadRequest {
            thread_id: "sess-a".into(),
            about: OtherThread {
                thread_id: "sess-b".into(),
                host: "h-7Rk2".to_owned(),
                host_name: Some("studio".to_owned()),
            },
            text: "[weave] Thread sess-b (codex) on studio finished its turn.".to_owned(),
            key: Some("dispatcher/w-1".to_owned()),
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
fn threads() {
    insta::assert_json_snapshot!(
        "list_threads_request",
        message(&ListThreadsRequest {
            agent_id: Some("claude".to_owned()),
            cwd: Some("/repo".into()),
            repo: None,
            activity: None,
            cursor: None,
            labels: Vec::new(),
        })
    );
    insta::assert_json_snapshot!(
        "list_threads_request_in_a_repository",
        message(&ListThreadsRequest {
            repo: Some("/repo/src".into()),
            ..ListThreadsRequest::default()
        })
    );
    insta::assert_json_snapshot!(
        "list_threads_response",
        round_trip(&ListThreadsResponse {
            threads: vec![listing()],
            next_cursor: Some("page-2".to_owned()),
        })
    );
    insta::assert_json_snapshot!(
        "list_threads_request_by_labels",
        message(&ListThreadsRequest {
            labels: vec!["bot:daily".to_owned()],
            ..ListThreadsRequest::default()
        })
    );
    insta::assert_json_snapshot!(
        "watch_threads_request",
        message(&WatchThreadsRequest::default())
    );
    insta::assert_json_snapshot!(
        "watch_threads_request_by_labels",
        message(&WatchThreadsRequest {
            labels: vec!["dispatcher".to_owned()],
        })
    );
    insta::assert_json_snapshot!(
        "watch_threads_response",
        round_trip(&WatchThreadsResponse {
            threads: vec![listing()],
        })
    );
    insta::assert_json_snapshot!(
        "unwatch_threads_request",
        message(&UnwatchThreadsRequest {})
    );
    insta::assert_json_snapshot!(
        "thread_updated_notification",
        message(&ThreadUpdatedNotification { thread: listing() })
    );
    insta::assert_json_snapshot!(
        "thread_removed_notification",
        message(&ThreadRemovedNotification {
            thread_id: "s-1".into(),
        })
    );
    insta::assert_json_snapshot!(
        "create_thread_request",
        message(&CreateThreadRequest {
            agent_id: "claude".to_owned(),
            cwd: "/repo".into(),
            additional_directories: Vec::new(),
            mode: Some("plan".to_owned()),
            policy: None,
            trace: false,
            labels: Vec::new(),
        })
    );
    insta::assert_json_snapshot!("thread_state", round_trip(&state()));
    insta::assert_json_snapshot!(
        "attach_thread_request",
        message(&AttachThreadRequest {
            thread_id: "s-1".into(),
            after: Some(JournalPosition {
                journal: "j-1760180000000".to_owned(),
                seq: 40,
            }),
            agent_id: None,
            cwd: None,
            trace: false,
            observe: false,
        })
    );
    // A script following a thread observes it.
    insta::assert_json_snapshot!(
        "attach_thread_request_observing",
        message(&AttachThreadRequest {
            thread_id: "s-1".into(),
            after: None,
            agent_id: None,
            cwd: None,
            trace: false,
            observe: true,
        })
    );
    insta::assert_json_snapshot!(
        "attach_thread_response",
        round_trip(&AttachThreadResponse {
            state: state(),
            replay: Replay {
                from: 41,
                reset: false,
            },
        })
    );
    insta::assert_json_snapshot!(
        "detach_thread_request",
        message(&DetachThreadRequest {
            thread_id: "s-1".into(),
            close: CloseWhen::IfUnused,
        })
    );
    insta::assert_json_snapshot!(
        "close_thread_request",
        message(&CloseThreadRequest {
            thread_id: "s-1".into(),
        })
    );
    insta::assert_json_snapshot!(
        "delete_thread_request",
        message(&DeleteThreadRequest {
            thread_id: "s-1".into(),
            agent_id: Some("claude".to_owned()),
        })
    );
    insta::assert_json_snapshot!(
        "rename_thread_request",
        message(&RenameThreadRequest {
            thread_id: "s-1".into(),
            title: "Parser fixes".to_owned(),
        })
    );
    insta::assert_json_snapshot!(
        "label_thread_request",
        message(&LabelThreadRequest {
            thread_id: "s-1".into(),
            add: vec!["bot:daily".to_owned()],
            remove: vec!["draft".to_owned()],
        })
    );
    insta::assert_json_snapshot!(
        "label_thread_response",
        round_trip(&LabelThreadResponse {
            labels: vec!["dispatcher".to_owned(), "bot:daily".to_owned()],
        })
    );
    insta::assert_json_snapshot!(
        "set_successor_request",
        message(&SetSuccessorRequest {
            thread_id: "s-1".into(),
            successor: "s-2".into(),
        })
    );
    insta::assert_json_snapshot!(
        "set_mode_request",
        message(&SetModeRequest {
            thread_id: "s-1".into(),
            mode_id: "plan".into(),
        })
    );
    insta::assert_json_snapshot!(
        "set_config_option_request",
        message(&SetConfigOptionRequest {
            thread_id: "s-1".into(),
            config_id: "thinking".into(),
            value: SessionConfigOptionValue::Boolean { value: true },
        })
    );
    insta::assert_json_snapshot!(
        "run_request",
        message(&RunRequest {
            agent_id: "codex".to_owned(),
            cwd: "/repo".into(),
            remote: None,
            thread_id: None,
            additional_directories: Vec::new(),
            mode: None,
            prompt: vec![text("fix the tests")],
            policy: PermissionPolicy::headless(vec![ToolKind::Read, ToolKind::Edit]),
            attach: false,
            trace: false,
            key: None,
            caller: None,
            origin: None,
            labels: Vec::new(),
        })
    );
    insta::assert_json_snapshot!(
        "run_request_keyed",
        message(&RunRequest {
            agent_id: "codex".to_owned(),
            cwd: "/repo".into(),
            remote: None,
            thread_id: None,
            additional_directories: Vec::new(),
            mode: None,
            prompt: vec![text("fix the tests")],
            policy: PermissionPolicy::headless(vec![ToolKind::Read]),
            attach: false,
            trace: false,
            key: Some("nightly-2026-10-23".to_owned()),
            caller: None,
            origin: None,
            labels: Vec::new(),
        })
    );
    insta::assert_json_snapshot!(
        "run_response",
        round_trip(&RunResponse {
            thread_id: "s-2".into(),
            turn_id: Some("t-1".to_owned()),
            state: None,
            policy: None,
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
                    threads: vec!["s-1".into()],
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
                    threads: Vec::new(),
                },
                Worktree {
                    path: "/Users/jaco/Projects/weave.review".into(),
                    branch: None,
                    head: Some("41ee083c9d7e5f2a1b3c4d5e6f7a8b9c0d1e2f3a".to_owned()),
                    primary: false,
                    changes: false,
                    divergence: None,
                    upstream: None,
                    threads: Vec::new(),
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
            thread_id: "s-1".into(),
            prompt: vec![text("hello")],
            key: None,
        })
    );
    insta::assert_json_snapshot!(
        "start_turn_request_keyed",
        message(&StartTurnRequest {
            thread_id: "s-1".into(),
            prompt: vec![text("hello")],
            key: Some("0b6f8f9e-6d1c-4d55-9a53-2d0f6f7f1c11".to_owned()),
        })
    );
    insta::assert_json_snapshot!(
        "start_turn_response",
        round_trip(&StartTurnResponse {
            seq: 42,
            turn_id: Some("t-4".to_owned()),
        })
    );
    insta::assert_json_snapshot!(
        "cancel_turn_request",
        message(&CancelTurnRequest {
            thread_id: "s-1".into(),
        })
    );
    insta::assert_json_snapshot!(
        "steer_turn_request",
        message(&SteerTurnRequest {
            thread_id: "s-1".into(),
            prompt: vec![text("use the other branch")],
            caller: None,
            origin: None,
        })
    );
    insta::assert_json_snapshot!(
        "steer_turn_response",
        round_trip(&SteerTurnResponse {
            outcome: SteerOutcome::Steered,
            seq: Some(43),
            turn_id: Some("t-4".to_owned()),
        })
    );
    insta::assert_json_snapshot!(
        "steer_turn_response_not_running",
        round_trip(&SteerTurnResponse {
            outcome: SteerOutcome::NotRunning,
            seq: None,
            turn_id: None,
        })
    );
}

#[test]
fn delegated_threads() {
    let delegated = ThreadListing {
        info: SessionInfo::new("s-2", "/repo").title("Port the tests".to_owned()),
        agent_id: "codex".to_owned(),
        started_by: Some("s-1".into()),
        ..listing()
    };
    insta::assert_json_snapshot!(
        "get_thread_request",
        message(&GetThreadRequest {
            thread_id: "s-2".into(),
            turn_id: None,
        })
    );
    insta::assert_json_snapshot!(
        "get_thread_request_for_a_turn",
        message(&GetThreadRequest {
            thread_id: "s-2".into(),
            turn_id: Some("q-3".to_owned()),
        })
    );
    insta::assert_json_snapshot!(
        "get_thread_response",
        round_trip(&GetThreadResponse {
            thread: delegated.clone(),
            latest_turn: Some(LatestTurn {
                turn_id: Some("t-1".to_owned()),
                continues: None,
                continued_in: None,
                state: TurnState::Ended,
                prompt: vec![text("port the parser's tests to the new runner")],
                origin: TurnOrigin::Thread {
                    thread_id: "s-1".into(),
                    report: false,
                    host: None,
                    host_name: None,
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
        "get_thread_response_interrupted_and_continued",
        round_trip(&GetThreadResponse {
            thread: ThreadListing {
                continued_in: Some("s-3".into()),
                labels: vec!["dispatcher".to_owned(), "bot:daily".to_owned()],
                context: Some(ContextUsage {
                    used: 41_200,
                    size: 200_000,
                }),
                last_compaction: Some(LastCompaction {
                    at: 1_760_179_000_000,
                    used: Some(38_000),
                }),
                ..delegated.clone()
            },
            latest_turn: Some(LatestTurn {
                turn_id: Some("t-1".to_owned()),
                continues: None,
                continued_in: Some("t-2".to_owned()),
                state: TurnState::Interrupted,
                prompt: vec![text("port the parser's tests to the new runner")],
                origin: TurnOrigin::Run {},
                started_at: 1_760_180_000_000,
                running: false,
                response: None,
                error: Some(weave_host_protocol::errors::interrupted()),
                message: None,
            }),
        })
    );
    insta::assert_json_snapshot!(
        "get_thread_response_running",
        round_trip(&GetThreadResponse {
            thread: delegated,
            latest_turn: Some(LatestTurn {
                turn_id: Some("t-1".to_owned()),
                continues: None,
                continued_in: None,
                state: TurnState::Waiting,
                prompt: vec![text("port the parser's tests to the new runner")],
                origin: TurnOrigin::Thread {
                    thread_id: "s-1".into(),
                    report: false,
                    host: None,
                    host_name: None,
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
            thread_id: "s-1".into(),
            prompt: vec![text("then update the docs")],
            key: Some("0b6f8f9e-6d1c-4d55-9a53-2d0f6f7f1c12".to_owned()),
            caller: None,
            origin: None,
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
            thread_id: "s-1".into(),
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
            thread_id: "s-1".into(),
        })
    );
    insta::assert_json_snapshot!(
        "attach_thread_response_queue_paused",
        round_trip(&AttachThreadResponse {
            state: ThreadState {
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
    let event = |seq, event| ThreadEventNotification {
        thread_id: "s-1".into(),
        seq,
        at: 1_760_180_001_234,
        event,
    };
    insta::assert_json_snapshot!(
        "event_turn_started",
        message(&event(
            41,
            ThreadEvent::TurnStarted {
                thread_id: "s-1".into(),
                prompt: vec![text("hello")],
                origin: TurnOrigin::Client {
                    name: "weave-tui".to_owned(),
                    id: "c7".to_owned(),
                    device: None,
                },
                queued_id: None,
                turn_id: Some("t-1".to_owned()),
                continues: None,
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_turn_started_remote",
        message(&event(
            41,
            ThreadEvent::TurnStarted {
                thread_id: "s-1".into(),
                prompt: vec![text("hello")],
                origin: TurnOrigin::Client {
                    name: "weave-ios".to_owned(),
                    id: "c9".to_owned(),
                    device: Some("Jaco's iPad".to_owned()),
                },
                queued_id: None,
                turn_id: Some("t-1".to_owned()),
                continues: None,
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_turn_started_from_the_queue",
        message(&event(
            49,
            ThreadEvent::TurnStarted {
                thread_id: "s-1".into(),
                prompt: vec![text("then update the docs")],
                origin: tui(),
                queued_id: Some("q-3".to_owned()),
                turn_id: Some("q-3".to_owned()),
                continues: None,
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_turn_started_by_another_thread",
        message(&event(
            41,
            ThreadEvent::TurnStarted {
                thread_id: "s-2".into(),
                prompt: vec![text("port the parser's tests to the new runner")],
                origin: TurnOrigin::Thread {
                    thread_id: "s-1".into(),
                    report: false,
                    host: None,
                    host_name: None,
                },
                queued_id: None,
                turn_id: Some("t-1".to_owned()),
                continues: None,
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_turn_started_by_a_report",
        message(&event(
            47,
            ThreadEvent::TurnStarted {
                thread_id: "s-1".into(),
                prompt: vec![text(
                    "[weave] Thread s-2 (codex) finished its turn. Its agent's last message:\n\n\
                     Ported 14 tests; all pass."
                )],
                origin: TurnOrigin::Thread {
                    thread_id: "s-2".into(),
                    report: true,
                    host: None,
                    host_name: None,
                },
                queued_id: None,
                turn_id: Some("t-1".to_owned()),
                continues: None,
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_queued",
        message(&event(
            44,
            ThreadEvent::Queued {
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
            ThreadEvent::Unqueued {
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
            ThreadEvent::QueuePaused {
                reason: QueuePause::Cancelled,
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_queue_resumed",
        message(&event(52, ThreadEvent::QueueResumed { by: Some(tui()) }))
    );
    insta::assert_json_snapshot!(
        "event_renamed",
        message(&event(
            39,
            ThreadEvent::Renamed {
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
            ThreadEvent::Renamed {
                title: "Parser fixes".to_owned(),
                by: None,
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_labelled",
        message(&event(
            39,
            ThreadEvent::Labelled {
                labels: vec!["dispatcher".to_owned(), "bot:daily".to_owned()],
                by: None,
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_continued_in",
        message(&event(
            39,
            ThreadEvent::ContinuedIn {
                successor: "s-2".into(),
                by: Some(TurnOrigin::Service {
                    name: "Dispatcher".to_owned(),
                    label: "bot daily".to_owned(),
                    id: "b-1".to_owned(),
                }),
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_notice",
        message(&event(
            40,
            ThreadEvent::Notice {
                text: "This agent can't use client tools.".to_owned(),
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_update",
        message(&event(
            42,
            ThreadEvent::Update {
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
            ThreadEvent::TerminalOutput {
                terminal_id: "term-1".into(),
                data: "ok\n".to_owned(),
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_terminal_exit",
        message(&event(
            44,
            ThreadEvent::TerminalExit {
                terminal_id: "term-1".into(),
                status: TerminalExitStatus::new().exit_code(0),
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_turn_ended",
        message(&event(
            45,
            ThreadEvent::TurnEnded {
                thread_id: "s-1".into(),
                response: Some(PromptResponse::new(StopReason::EndTurn)),
                error: None,
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_turn_interrupted",
        message(&event(
            45,
            ThreadEvent::TurnEnded {
                thread_id: "s-1".into(),
                response: None,
                error: Some(weave_host_protocol::errors::interrupted()),
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_turn_continued",
        message(&event(
            46,
            ThreadEvent::TurnStarted {
                thread_id: "s-1".into(),
                prompt: vec![text(
                    "[weave] The weave Host stopped while your last turn ran…"
                )],
                origin: TurnOrigin::Run {},
                queued_id: None,
                turn_id: Some("t-2".to_owned()),
                continues: Some("t-1".to_owned()),
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_run_started",
        message(&event(
            46,
            ThreadEvent::TurnStarted {
                thread_id: "s-1".into(),
                prompt: vec![text("fix the tests")],
                origin: TurnOrigin::Run {},
                queued_id: None,
                turn_id: Some("t-1".to_owned()),
                continues: None,
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_closed",
        message(&event(
            47,
            ThreadEvent::Closed {
                reason: "idle".to_owned(),
                by: None,
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_closed_by_a_client",
        message(&event(
            48,
            ThreadEvent::Closed {
                reason: "closed by a client".to_owned(),
                by: Some(TurnOrigin::Client {
                    name: "weave-app".to_owned(),
                    id: "c9".to_owned(),
                    device: Some("Jaco's iPad".to_owned()),
                }),
            },
        ))
    );
    insta::assert_json_snapshot!(
        "event_turn_steered",
        message(&event(
            48,
            ThreadEvent::TurnSteered {
                thread_id: "s-1".into(),
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
        "thread_changed_notification",
        message(&ThreadChangedNotification {
            thread_id: "s-1".into(),
            activity: Some(Activity::Idle),
            clients: Some(1),
            title: None,
            blank: None,
            git: None,
            mcp_servers: None,
        })
    );
    insta::assert_json_snapshot!(
        "thread_changed_notification_branch",
        message(&ThreadChangedNotification {
            thread_id: "s-1".into(),
            activity: None,
            clients: None,
            title: None,
            blank: None,
            git: Some(GitLocation {
                worktree: "/repo.feature-auth".into(),
                branch: Some("feature/auth".to_owned()),
                ..git()
            }),
            mcp_servers: None,
        })
    );
    insta::assert_json_snapshot!(
        "thread_changed_notification_mcp_servers",
        message(&ThreadChangedNotification {
            thread_id: "s-1".into(),
            activity: None,
            clients: None,
            title: None,
            blank: None,
            git: None,
            mcp_servers: Some(mcp_servers()),
        })
    );
    insta::assert_json_snapshot!(
        "elicitation_completed_notification",
        message(&ElicitationCompletedNotification {
            thread_id: "s-1".into(),
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
            thread_id: "s-1".into(),
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
        "reopen_thread_request",
        message(&ReopenThreadRequest {
            thread_id: "s-1".into(),
        })
    );
    insta::assert_json_snapshot!(
        "reopen_thread_response",
        round_trip(&ReopenThreadResponse {
            version: Some("0.32.0".to_owned()),
        })
    );
    insta::assert_json_snapshot!(
        "event_agent_reopened",
        message(&ThreadEventNotification {
            thread_id: "s-1".into(),
            seq: 49,
            at: 1_760_180_009_000,
            event: ThreadEvent::AgentReopened {
                agent: Box::new(thread_agent("0.32.0")),
                previous: Some(release("0.31.0")),
                modes: None,
                config_options: Vec::new(),
                failed: None,
            },
        })
    );
    insta::assert_json_snapshot!(
        "event_agent_reopened_on_the_old_version",
        message(&ThreadEventNotification {
            thread_id: "s-1".into(),
            seq: 49,
            at: 1_760_180_009_000,
            event: ThreadEvent::AgentReopened {
                agent: Box::new(thread_agent("0.31.0")),
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
            thread_id: "s-1".into(),
            pending: pending(),
        })
    );
    insta::assert_json_snapshot!(
        "pending_request",
        round_trip(&PendingRequest {
            id: "p-2".to_owned(),
            thread_id: Some("s-1".into()),
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
            thread_id: "s-1".into(),
            pending_id: "p-1".to_owned(),
            outcome: Resolution::Answered,
            by: Some("c7".to_owned()),
        })
    );
    insta::assert_json_snapshot!(
        "answer_pending_request",
        message(&AnswerPendingRequest {
            thread_id: "s-1".into(),
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
            thread_id: "s-1".into(),
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
            thread_id: Some("s-1".into()),
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
            thread_id: "s-1".into(),
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
fn service_tools() {
    let tool = Tool {
        name: "add_schedule".to_owned(),
        title: "Add a schedule".to_owned(),
        description: "Start a turn at the times a cron expression gives.".to_owned(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {"cron": {"type": "string"}},
            "required": ["cron"],
        }),
    };
    insta::assert_json_snapshot!(
        "declare_tools_request",
        message(&DeclareToolsRequest {
            tools: vec![tool],
            hosts: false,
        })
    );
    insta::assert_json_snapshot!(
        "declare_tools_response",
        round_trip(&DeclareToolsResponse {
            names: vec!["dispatcher__add_schedule".to_owned()],
        })
    );
    let mut arguments = serde_json::Map::new();
    arguments.insert("cron".to_owned(), serde_json::json!("0 9 * * *"));
    insta::assert_json_snapshot!(
        "tool_call_notification",
        message(&ToolCallNotification {
            call_id: "c-1".to_owned(),
            tool: "add_schedule".to_owned(),
            arguments,
            caller: ToolCaller {
                thread_id: "s-1".into(),
                agent_id: "claude".to_owned(),
                cwd: "/repo".into(),
                policy: PermissionPolicy::headless(Vec::new()),
                labels: vec!["bot:daily".to_owned()],
            },
        })
    );
    insta::assert_json_snapshot!(
        "tool_call_cancelled_notification",
        message(&ToolCallCancelledNotification {
            call_id: "c-1".to_owned(),
        })
    );
    insta::assert_json_snapshot!(
        "answer_tool_request",
        message(&AnswerToolRequest {
            call_id: "c-1".to_owned(),
            result: ClientToolResult::text("Scheduled every day at nine."),
        })
    );
}

/// The Dispatcher a Host joined, connected over the tailnet.
fn joined() -> JoinedDispatcher {
    JoinedDispatcher {
        id: "D7qK2mN4pR8sT1vX".to_owned(),
        name: "Dispatcher on homelab-1".to_owned(),
        address: DispatcherAddress::Url("wss://homelab-1.example.ts.net:7342".to_owned()),
        host_name: "studio".to_owned(),
        joined_at: 1_760_180_000_000,
        connected: true,
        connected_at: Some(1_760_180_000_500),
        why: None,
    }
}

#[test]
fn joining_the_dispatcher() {
    insta::assert_json_snapshot!(
        "join_dispatcher_request",
        message(&JoinDispatcherRequest {
            address: DispatcherAddress::Url("wss://homelab-1.example.ts.net:7342".to_owned()),
            code: "8M3QK0V4WZ7HC1RP9F2D5XTNAG".to_owned(),
            name: Some("studio".to_owned()),
        })
    );
    insta::assert_json_snapshot!(
        "join_dispatcher_here_request",
        message(&JoinDispatcherRequest {
            address: DispatcherAddress::Socket(
                "/Users/jaco/.local/state/weave/dispatcher/hosts.sock".into()
            ),
            code: "8M3QK0V4WZ7HC1RP9F2D5XTNAG".to_owned(),
            name: None,
        })
    );
    insta::assert_json_snapshot!(
        "join_dispatcher_response",
        round_trip(&JoinDispatcherResponse {
            dispatcher: JoinedDispatcher {
                connected: false,
                connected_at: None,
                why: Some("its connection closed; connecting again".to_owned()),
                ..joined()
            },
        })
    );
    insta::assert_json_snapshot!(
        "leave_dispatcher_request",
        message(&LeaveDispatcherRequest {})
    );
}

/// A device's connection carried to one of the person's Hosts (WVE-195): what the device asks
/// the Dispatcher, what the Dispatcher asks the Host, what the Host presents when it connects
/// for it, and what the device says at hello there. `hosts/open` and `hosts/carry` are the
/// Dispatcher's API, not the Host protocol, so their params stand alone.
#[test]
fn carrying_a_devices_connection() {
    insta::assert_json_snapshot!(
        "open_host_request",
        round_trip(&OpenHostRequest {
            host: "homelab".to_owned(),
            stream: CarriedStream::Host,
        })
    );
    insta::assert_json_snapshot!(
        "open_host_terminal_request",
        round_trip(&OpenHostRequest {
            host: "8ZpX3kqW1m0aLr9TQv2cYw".to_owned(),
            stream: CarriedStream::Terminal,
        })
    );
    insta::assert_json_snapshot!(
        "opened_host",
        round_trip(&OpenedHost {
            host_id: "8ZpX3kqW1m0aLr9TQv2cYw".to_owned(),
            name: "homelab".to_owned(),
        })
    );
    insta::assert_json_snapshot!(
        "host_unavailable",
        round_trip(&HostUnavailable {
            status: Reachability::Unreachable,
            why: "its connection closed; it connects again when it can".to_owned(),
        })
    );
    insta::assert_json_snapshot!(
        "carry_request",
        message(&CarryRequest {
            token: "Zt5mV8qL2xN7rK4wP9sB3dF6gH1jC0aE".to_owned(),
            device: DeviceInfo {
                id: "d-7KQ2M9XW4".to_owned(),
                name: "Jaco's MacBook Air".to_owned(),
                service: false,
            },
            stream: CarriedStream::Host,
        })
    );
    insta::assert_json_snapshot!(
        "host_carry_request",
        round_trip(&HostCarryRequest {
            token: "Zt5mV8qL2xN7rK4wP9sB3dF6gH1jC0aE".to_owned(),
            nonce: "q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7k8l9z0x1c".to_owned(),
        })
    );
    insta::assert_json_snapshot!(
        "host_carried",
        round_trip(&HostCarried {
            signature: "MEUCIQDx7c2vKp3sYh8q0wLr5tNz1mBa6eJ9uGf4dXk2oRsVyAIgT3nWq8LhZ5c1PjK0vMe7xUa2bYr9sDf6gHt4iNo1QwE".to_owned(),
        })
    );
    assert_eq!(
        carry_message(
            "D7qK2mN4pR8sT1vX",
            "8ZpX3kqW1m0aLr9TQv2cYw",
            "Zt5mV8qL2xN7rK4wP9sB3dF6gH1jC0aE",
            "q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7k8l9z0x1c"
        ),
        "weave-dispatcher-carry/1 D7qK2mN4pR8sT1vX 8ZpX3kqW1m0aLr9TQv2cYw \
         Zt5mV8qL2xN7rK4wP9sB3dF6gH1jC0aE q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7k8l9z0x1c"
    );
    insta::assert_json_snapshot!("auth_dispatcher", round_trip(&Auth::Dispatcher));
}

/// The person's Projects (ADR 0031, WVE-189), in the Dispatcher's API: a git Project on two
/// Hosts, and what clients ask about them. The Dispatcher's hello names the feature.
#[test]
fn projects() {
    insta::assert_json_snapshot!(
        "dispatcher_hello",
        round_trip(&DispatcherHello {
            protocol: 2,
            version: "0.1.0".to_owned(),
            id: "D7qK2mN4pR8sT1vX".to_owned(),
            device: None,
            features: vec![PROJECTS_FEATURE.to_owned()],
        })
    );
    let odin = Project {
        id: "p-3f9c2e7d0a1b4c5d6e7f".to_owned(),
        name: "Odin".to_owned(),
        kind: ProjectKind::Git,
        remote: Some("github.com/jacobfvanzyl/odin".to_owned()),
        locations: vec![
            ProjectLocation {
                host_id: "8ZpX3kqW1m0aLr9TQv2cYw".to_owned(),
                path: "/Users/jaco/Projects/odin".into(),
            },
            ProjectLocation {
                host_id: "Lw4nB7cR2tY9uI0oP5aS3d".to_owned(),
                path: "/home/jaco/odin".into(),
            },
        ],
        created_at: 1_760_180_000_000,
        updated_at: 1_760_180_500_000,
    };
    insta::assert_json_snapshot!("list_projects_request", message(&ListProjectsRequest {}));
    insta::assert_json_snapshot!(
        "list_projects_response",
        round_trip(&ListProjectsResponse {
            projects: vec![
                odin.clone(),
                Project {
                    id: "p-0a1b2c3d4e5f60718293".to_owned(),
                    name: "notes".to_owned(),
                    kind: ProjectKind::Directory,
                    remote: None,
                    locations: Vec::new(),
                    created_at: 1_760_180_000_000,
                    updated_at: 1_760_180_000_000,
                },
            ],
        })
    );
    insta::assert_json_snapshot!(
        "get_project_request",
        message(&GetProjectRequest {
            project: "odin".to_owned(),
        })
    );
    insta::assert_json_snapshot!(
        "project_response",
        round_trip(&ProjectResponse { project: odin })
    );
    insta::assert_json_snapshot!(
        "add_project_request",
        message(&AddProjectRequest {
            name: "Odin".to_owned(),
            location: NewLocation {
                host_id: "8ZpX3kqW1m0aLr9TQv2cYw".to_owned(),
                path: "/Users/jaco/Projects/odin".into(),
                kind: ProjectKind::Git,
                remote: Some("github.com/jacobfvanzyl/odin".to_owned()),
            },
        })
    );
    insta::assert_json_snapshot!(
        "update_project_request",
        message(&UpdateProjectRequest {
            project: "p-3f9c2e7d0a1b4c5d6e7f".to_owned(),
            name: None,
            remove_host: None,
            add: Some(NewLocation {
                host_id: "Lw4nB7cR2tY9uI0oP5aS3d".to_owned(),
                path: "/home/jaco/odin".into(),
                kind: ProjectKind::Git,
                remote: Some("github.com/jacobfvanzyl/odin".to_owned()),
            }),
        })
    );
    insta::assert_json_snapshot!(
        "update_project_rename_and_remove_host_request",
        message(&UpdateProjectRequest {
            project: "odin".to_owned(),
            name: Some("odin-engine".to_owned()),
            remove_host: Some("homelab".to_owned()),
            add: None,
        })
    );
    insta::assert_json_snapshot!(
        "remove_project_request",
        message(&RemoveProjectRequest {
            project: "odin".to_owned(),
        })
    );
    // A Dispatcher from before Projects said no features, and a client reads its hello still.
    let older: DispatcherHello = serde_json::from_value(json!({
        "protocol": 2, "version": "0.1.0", "id": "D7qK2mN4pR8sT1vX"
    }))
    .expect("an older hello parses");
    assert!(!older.offers(PROJECTS_FEATURE));
}

#[test]
fn host() {
    insta::assert_json_snapshot!("status_request", message(&StatusRequest {}));
    insta::assert_json_snapshot!(
        "host_status",
        round_trip(&HostStatus {
            protocol: PROTOCOL_VERSION,
            version: "0.1.0".to_owned(),
            pid: 4242,
            started_at: 1_760_180_000_000,
            service: Service::OnDemand,
            environment: EnvironmentSource::LoginShell,
            threads: vec![listing()],
            serve_entry: Some(ServeEntryLeft {
                port: 7341,
                command: "sudo tailscale serve --https=7341 off".to_owned(),
                why: "Tailscale lets only root change Serve while its config serves a Unix socket"
                    .to_owned(),
            }),
            dispatcher: Some(joined()),
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
    let notification: ThreadEventNotification = serde_json::from_value(json!({
        "threadId": "s-1", "seq": 7, "at": 1, "later": true,
        "event": {"kind": "somethingNew", "detail": [1, 2]}
    }))
    .expect("an unknown kind still parses");
    assert_eq!(notification.seq, 7);
    assert!(matches!(notification.event, ThreadEvent::Unknown));

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

fn terminal() -> weave_host_protocol::terminals::Terminal {
    use weave_host_protocol::terminals::BlockedKind;
    use weave_host_protocol::terminals::ProgramState;
    use weave_host_protocol::terminals::ProgramStatus;
    use weave_host_protocol::terminals::Terminal;
    use weave_host_protocol::terminals::TerminalCommand;
    use weave_host_protocol::terminals::TerminalProcess;
    use weave_host_protocol::terminals::TerminalProcesses;
    use weave_host_protocol::terminals::TerminalSize;
    Terminal {
        id: "t-5f3a".to_owned(),
        scope: "/Users/jaco/Projects/weave".into(),
        label: Some("dev server".to_owned()),
        opened_from: Some(weave_host_protocol::threads::ThreadId::new("s-1")),
        title: Some("npm run dev".to_owned()),
        pwd: Some("/Users/jaco/Projects/weave/app".into()),
        process: Some(TerminalProcesses {
            foreground: Some(TerminalProcess {
                pid: 4242,
                name: "node".to_owned(),
            }),
        }),
        size: TerminalSize {
            cols: 100,
            rows: 30,
        },
        command: Some(TerminalCommand {
            running: true,
            command: Some("npm run dev".to_owned()),
            exit_code: None,
        }),
        program_status: vec![ProgramStatus {
            id: Some("build".to_owned()),
            state: ProgramState::Blocked,
            kind: Some(BlockedKind::Question),
            progress: None,
            app: Some("vite".to_owned()),
            title: None,
            msg: Some("Port 5174 is taken; use 5175?".to_owned()),
        }],
        started_at: 1_760_180_000_000,
    }
}

#[test]
fn terminals() {
    use weave_host_protocol::terminals::AttachTerminalRequest;
    use weave_host_protocol::terminals::AttachTerminalResponse;
    use weave_host_protocol::terminals::FormatTerminalRequest;
    use weave_host_protocol::terminals::NewTerminalRequest;
    use weave_host_protocol::terminals::TerminalFormat;
    use weave_host_protocol::terminals::TerminalRemovedNotification;
    use weave_host_protocol::terminals::TerminalSize;
    use weave_host_protocol::terminals::TerminalUpdatedNotification;
    use weave_host_protocol::terminals::TerminalsResponse;
    use weave_host_protocol::terminals::WatchTerminalsRequest;
    use weave_host_protocol::terminals::stream;

    insta::assert_json_snapshot!(
        "watch_terminals_request",
        message(&WatchTerminalsRequest {
            directory: "/Users/jaco/Projects/weave/app".into(),
        })
    );
    insta::assert_json_snapshot!(
        "terminals_response",
        round_trip(&TerminalsResponse {
            scope: "/Users/jaco/Projects/weave".into(),
            terminals: vec![terminal()],
        })
    );
    insta::assert_json_snapshot!(
        "new_terminal_request",
        message(&NewTerminalRequest {
            directory: "/Users/jaco/Projects/weave/app".into(),
            label: Some("dev server".to_owned()),
            opened_from: Some(weave_host_protocol::threads::ThreadId::new("s-1")),
            command: Some(vec!["npm".to_owned(), "run".to_owned(), "dev".to_owned()]),
            size: Some(TerminalSize {
                cols: 100,
                rows: 30
            }),
        })
    );
    insta::assert_json_snapshot!(
        "format_terminal_request",
        message(&FormatTerminalRequest {
            id: "t-5f3a".to_owned(),
            format: TerminalFormat::Vt,
            history: true,
            trim: false,
        })
    );
    insta::assert_json_snapshot!(
        "attach_terminal",
        json!({
            "request": message(&AttachTerminalRequest { id: "t-5f3a".to_owned() }),
            "response": round_trip(&AttachTerminalResponse {
                ticket: "k2Vx".to_owned(),
                expires_at: 1_760_180_030_000,
            }),
        })
    );
    insta::assert_json_snapshot!(
        "terminal_notifications",
        json!([
            message(&TerminalUpdatedNotification {
                terminal: terminal()
            }),
            message(&TerminalRemovedNotification {
                id: "t-5f3a".to_owned(),
                scope: "/Users/jaco/Projects/weave".into(),
                exit_code: Some(0),
            }),
        ])
    );
    insta::assert_json_snapshot!(
        "terminal_stream",
        json!({
            "open": round_trip(&stream::Open {
                ticket: "k2Vx".to_owned(),
                size: TerminalSize { cols: 60, rows: 40 },
                codec: "ghostty fb13fa9602f47590ccfaaea4cd8e178fac2ec8cc snapshot 1".to_owned(),
                history: false,
            }),
            "openWithHistory": round_trip(&stream::Open {
                ticket: "k2Vx".to_owned(),
                size: TerminalSize { cols: 60, rows: 40 },
                codec: "none".to_owned(),
                history: true,
            }),
            "opened": round_trip(&stream::Opened {
                terminal: terminal(),
                restore: stream::Restore::Snapshot,
                restore_bytes: 153_412,
            }),
            "messages": [
                round_trip(&stream::Message::Bell {}),
                round_trip(&stream::Message::Notification {
                    title: "Done".to_owned(),
                    body: "Tests passed".to_owned(),
                }),
                round_trip(&stream::Message::Progress {
                    state: "set".to_owned(),
                    progress: Some(40),
                }),
                round_trip(&stream::Message::Clipboard { text: "hello".to_owned() }),
                round_trip(&stream::Message::Resync {
                    restore: stream::Restore::Vt,
                    restore_bytes: 2_048,
                    size: TerminalSize { cols: 60, rows: 35 },
                }),
                round_trip(&stream::Message::Resized(TerminalSize { cols: 100, rows: 30 })),
                round_trip(&stream::Message::Exited { exit_code: 0 }),
            ],
            "client": round_trip(&stream::ClientMessage::Resize(TerminalSize { cols: 60, rows: 35 })),
            "clientResync": round_trip(&stream::ClientMessage::Resync {}),
        })
    );
}

/// A Session's layout as the app writes it: tabs of rows and columns with Blocks at the leaves,
/// a floating Block and a minimized one.
fn session_layout() -> serde_json::Value {
    use weave_host_protocol::sessions::layout::Block;
    use weave_host_protocol::sessions::layout::Floating;
    use weave_host_protocol::sessions::layout::Frame;
    use weave_host_protocol::sessions::layout::Layout;
    use weave_host_protocol::sessions::layout::Node;
    use weave_host_protocol::sessions::layout::Split;
    use weave_host_protocol::sessions::layout::Tab;
    use weave_host_protocol::sessions::layout::VERSION;

    let block = |id: &str, block_type: &str, props: Value| Block {
        id: id.to_owned(),
        block_type: block_type.to_owned(),
        props: props.as_object().cloned().unwrap_or_default(),
    };
    round_trip(&Layout {
        version: VERSION,
        tabs: vec![
            Tab {
                id: "tab-1".to_owned(),
                title: Some("auth".to_owned()),
                root: Some(Node::Row(Split {
                    children: vec![
                        Node::Block(block("b-1", "weave.thread", json!({"threadId": "s-1"}))),
                        Node::Column(Split {
                            children: vec![
                                Node::Block(block(
                                    "b-2",
                                    "weave.terminal",
                                    json!({"terminalId": "t-5f3a"}),
                                )),
                                Node::Block(block(
                                    "b-3",
                                    "weave.thread",
                                    json!({"threadId": "s-2"}),
                                )),
                            ],
                            sizes: None,
                        }),
                    ],
                    sizes: Some(vec![2.0, 1.0]),
                })),
                floating: vec![
                    Floating {
                        block: block("b-5", "weave.terminal", json!({"terminalId": "t-77c1"})),
                        frame: Frame {
                            x: 0.6,
                            y: 0.05,
                            width: 0.35,
                            height: 0.4,
                        },
                        minimized: false,
                    },
                    Floating {
                        block: block("b-4", "com.example.notes", json!({})),
                        frame: Frame {
                            x: 0.2,
                            y: 0.15,
                            width: 0.6,
                            height: 0.6,
                        },
                        minimized: true,
                    },
                ],
            },
            Tab {
                id: "tab-2".to_owned(),
                title: None,
                root: None,
                floating: Vec::new(),
            },
        ],
    })
}

fn session() -> weave_host_protocol::sessions::Session {
    weave_host_protocol::sessions::Session {
        directory: "/Users/jaco/Projects/weave.feature-auth".into(),
        revision: 7,
        layout: Some(session_layout()),
        git: Some(GitLocation {
            repo: "/Users/jaco/Projects/weave".into(),
            worktree: "/Users/jaco/Projects/weave.feature-auth".into(),
            branch: Some("feature/auth".to_owned()),
            remote: Some("github.com/jacobfvanzyl/weave".to_owned()),
        }),
        created_at: 1_760_180_000_000,
        updated_at: Some(1_760_180_030_000),
        threads: vec![
            weave_host_protocol::threads::ThreadId::new("s-2"),
            weave_host_protocol::threads::ThreadId::new("s-1"),
        ],
        terminals: vec!["t-5f3a".to_owned(), "t-77c1".to_owned()],
    }
}

#[test]
fn sessions() {
    use weave_host_protocol::sessions::AddToSessionRequest;
    use weave_host_protocol::sessions::EndSessionRequest;
    use weave_host_protocol::sessions::GetSessionRequest;
    use weave_host_protocol::sessions::ListSessionsRequest;
    use weave_host_protocol::sessions::ListSessionsResponse;
    use weave_host_protocol::sessions::Session;
    use weave_host_protocol::sessions::SessionEndedNotification;
    use weave_host_protocol::sessions::SessionResponse;
    use weave_host_protocol::sessions::SessionUpdatedNotification;
    use weave_host_protocol::sessions::SetSessionRequest;
    use weave_host_protocol::sessions::UnwatchSessionsRequest;
    use weave_host_protocol::sessions::WatchSessionsRequest;
    use weave_host_protocol::sessions::WatchSessionsResponse;

    insta::assert_json_snapshot!("session_layout", session_layout());
    insta::assert_json_snapshot!(
        "list_sessions",
        json!({
            "request": message(&ListSessionsRequest {}),
            "response": round_trip(&ListSessionsResponse {
                sessions: vec![
                    Session {
                        layout: None,
                        ..session()
                    },
                    // Made by `sessions/add`, before any client set its layout.
                    Session {
                        directory: "/Users/jaco/notes".into(),
                        revision: 0,
                        layout: None,
                        git: None,
                        created_at: 1_760_180_000_000,
                        updated_at: None,
                        threads: vec![weave_host_protocol::threads::ThreadId::new("s-9")],
                        terminals: Vec::new(),
                    },
                ],
            }),
        })
    );
    insta::assert_json_snapshot!(
        "get_session",
        json!({
            "request": message(&GetSessionRequest {
                directory: "/Users/jaco/Projects/weave.feature-auth/app".into(),
            }),
            "response": round_trip(&SessionResponse { session: session() }),
        })
    );
    insta::assert_json_snapshot!(
        "set_session_request",
        message(&SetSessionRequest {
            directory: "/Users/jaco/Projects/weave.feature-auth".into(),
            layout: session_layout(),
            if_revision: Some(6),
        })
    );
    insta::assert_json_snapshot!(
        "watch_sessions",
        json!({
            "one": message(&WatchSessionsRequest {
                directory: Some("/Users/jaco/Projects/weave.feature-auth/app".into()),
            }),
            "every": message(&WatchSessionsRequest::default()),
            "response": round_trip(&WatchSessionsResponse {
                directory: Some("/Users/jaco/Projects/weave.feature-auth".into()),
                sessions: vec![session()],
            }),
            "unwatch": message(&UnwatchSessionsRequest {
                directory: Some("/Users/jaco/Projects/weave.feature-auth".into()),
            }),
            "end": message(&EndSessionRequest {
                directory: "/Users/jaco/notes".into(),
            }),
            "add": message(&AddToSessionRequest {
                directory: "/Users/jaco/notes".into(),
                threads: vec![weave_host_protocol::threads::ThreadId::new("s-9")],
                terminals: vec!["t-5f3a".to_owned()],
            }),
        })
    );
    insta::assert_json_snapshot!(
        "session_notifications",
        json!([
            message(&SessionUpdatedNotification { session: session() }),
            message(&SessionEndedNotification {
                directory: "/Users/jaco/Projects/weave.feature-auth".into(),
            }),
        ])
    );
}
