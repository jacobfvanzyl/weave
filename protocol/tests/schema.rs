//! The Host protocol as one JSON Schema, for clients in other languages: every request, answer
//! and notification, the ACP types they carry, which method takes and gives which, and the
//! protocol's constants. The app generates its TypeScript from the snapshot
//! (`app/scripts/protocol-types.ts`), so a change here shows up there as a stale file.

#![allow(clippy::expect_used)]

use agent_client_protocol::JsonRpcMessage;
use agent_client_protocol::JsonRpcRequest;
use schemars::JsonSchema;
use schemars::SchemaGenerator;
use schemars::generate::SchemaSettings;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use weave_host_protocol::OLDEST_SUPPORTED_VERSION;
use weave_host_protocol::PROTOCOL_VERSION;
use weave_host_protocol::agents;
use weave_host_protocol::devices;
use weave_host_protocol::errors;
use weave_host_protocol::events;
use weave_host_protocol::files;
use weave_host_protocol::hello;
use weave_host_protocol::host;
use weave_host_protocol::pending;
use weave_host_protocol::sessions;
use weave_host_protocol::tools;
use weave_host_protocol::turns;
use weave_host_protocol::websocket;
use weave_host_protocol::worktrees;

/// `T`'s name among the definitions, defining it there if the generator inlined it.
fn define<T: JsonSchema>(
    generator: &mut SchemaGenerator,
    inlined: &mut Map<String, Value>,
) -> String {
    let schema = generator.subschema_for::<T>();
    match schema.get("$ref").and_then(Value::as_str) {
        Some(reference) => reference.trim_start_matches("#/$defs/").to_owned(),
        None => {
            let name = T::schema_name().into_owned();
            inlined.insert(name.clone(), schema.to_value());
            name
        }
    }
}

/// Each request's method, checked against the type's own, with what it takes and gives.
macro_rules! requests {
    ($generator:ident, $inlined:ident; $($method:literal => $request:ty),* $(,)?) => {{
        let mut table = Map::new();
        $(
            assert!(
                <$request as JsonRpcMessage>::matches_method($method),
                "{} isn't {}",
                stringify!($request),
                $method,
            );
            let params = define::<$request>(&mut $generator, &mut $inlined);
            let result = define::<<$request as JsonRpcRequest>::Response>(&mut $generator, &mut $inlined);
            table.insert($method.to_owned(), json!({"params": params, "result": result}));
        )*
        table
    }};
}

/// Each notification's method, checked against the type's own, with what it carries.
macro_rules! notifications {
    ($generator:ident, $inlined:ident; $($method:literal => $notification:ty),* $(,)?) => {{
        let mut table = Map::new();
        $(
            assert!(
                <$notification as JsonRpcMessage>::matches_method($method),
                "{} isn't {}",
                stringify!($notification),
                $method,
            );
            table.insert($method.to_owned(), json!(define::<$notification>(&mut $generator, &mut $inlined)));
        )*
        table
    }};
}

fn schema() -> Value {
    let mut generator = SchemaSettings::draft2020_12().into_generator();
    let mut inlined = Map::new();
    let requests = requests! { generator, inlined;
        "host/hello" => hello::HelloRequest,
        "host/challenge" => hello::ChallengeRequest,
        "host/status" => host::StatusRequest,
        "host/shutdown" => host::ShutdownRequest,
        "agents/list" => agents::ListAgentsRequest,
        "agents/get" => agents::GetAgentRequest,
        "agents/authenticate" => agents::AuthenticateAgentRequest,
        "agents/terminalSignIn" => agents::TerminalSignInRequest,
        "agents/logout" => agents::LogoutAgentRequest,
        "agents/update" => agents::UpdateAgentRequest,
        "devices/offer" => devices::OfferDeviceRequest,
        "devices/list" => devices::ListDevicesRequest,
        "devices/revoke" => devices::RevokeDeviceRequest,
        "files/list" => files::ListFilesRequest,
        "sessions/list" => sessions::ListSessionsRequest,
        "sessions/watch" => sessions::WatchSessionsRequest,
        "sessions/unwatch" => sessions::UnwatchSessionsRequest,
        "session/create" => sessions::CreateSessionRequest,
        "session/attach" => sessions::AttachSessionRequest,
        "session/detach" => sessions::DetachSessionRequest,
        "session/close" => sessions::CloseSessionRequest,
        "session/delete" => sessions::DeleteSessionRequest,
        "session/setMode" => sessions::SetModeRequest,
        "session/setConfigOption" => sessions::SetConfigOptionRequest,
        "session/reopen" => sessions::ReopenSessionRequest,
        "session/rename" => sessions::RenameSessionRequest,
        "session/run" => sessions::RunRequest,
        "turn/start" => turns::StartTurnRequest,
        "turn/steer" => turns::SteerTurnRequest,
        "turn/cancel" => turns::CancelTurnRequest,
        "pending/answer" => pending::AnswerPendingRequest,
        "worktrees/list" => worktrees::ListWorktreesRequest,
        "worktrees/create" => worktrees::CreateWorktreeRequest,
        "worktrees/remove" => worktrees::RemoveWorktreeRequest,
        "worktrees/release" => worktrees::ReleaseWorktreeRequest,
    };
    let notifications = notifications! { generator, inlined;
        "session/event" => events::SessionEventNotification,
        "session/changed" => events::SessionChangedNotification,
        "sessions/updated" => sessions::SessionUpdatedNotification,
        "sessions/removed" => sessions::SessionRemovedNotification,
        "session/elicitationCompleted" => events::ElicitationCompletedNotification,
        "pending/added" => pending::PendingAddedNotification,
        "pending/resolved" => pending::PendingResolvedNotification,
        "agents/updateAvailable" => agents::UpdateAvailableNotification,
        "devices/paired" => devices::DevicePairedNotification,
    };
    let mut definitions = generator.take_definitions(true);
    definitions.extend(inlined);
    // Two types with one name come out as `Name` and `Name2`, by the order they were met, and a
    // client's types would follow that order. The Host's own types and ACP's must not share one.
    for name in definitions.keys() {
        let base = name.trim_end_matches(|c: char| c.is_ascii_digit());
        assert!(
            base == name || !definitions.contains_key(base),
            "two types are both called {base}; rename one for the schema with #[schemars(rename)]",
        );
    }
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "HostProtocolSchema",
        "description": "The weave Host protocol (docs/specs/wve-85-host-protocol.md), generated from protocol/.",
        "type": "object",
        "x-weave-requests": requests,
        "x-weave-notifications": notifications,
        "x-weave-constants": {
            "protocol": {"version": PROTOCOL_VERSION, "oldestSupported": OLDEST_SUPPORTED_VERSION},
            "websocket": {
                "subprotocol": websocket::SUBPROTOCOL,
                "appOrigin": websocket::APP_ORIGIN,
                "maxMessage": websocket::MAX_MESSAGE,
                "closeRevoked": websocket::CLOSE_REVOKED,
                "closeBehind": websocket::CLOSE_BEHIND,
                "closeUnauthenticated": websocket::CLOSE_UNAUTHENTICATED,
            },
            "errors": {
                "unauthenticated": errors::UNAUTHENTICATED,
                "incompatibleProtocol": errors::INCOMPATIBLE_PROTOCOL,
                "unknownAgent": errors::UNKNOWN_AGENT,
                "unknownSession": errors::UNKNOWN_SESSION,
                "sessionNotOpen": errors::SESSION_NOT_OPEN,
                "turnRunning": errors::TURN_RUNNING,
                "alreadyResolved": errors::ALREADY_RESOLVED,
                "wrongAgent": errors::WRONG_AGENT,
                "requiresTerminal": errors::REQUIRES_TERMINAL,
                "forbidden": errors::FORBIDDEN,
                "notTarget": errors::NOT_TARGET,
                "remoteUnavailable": errors::REMOTE_UNAVAILABLE,
                "worktreeBusy": errors::WORKTREE_BUSY,
                "notARepository": errors::NOT_A_REPOSITORY,
                "gitFailed": errors::GIT_FAILED,
                "uncommittedChanges": errors::UNCOMMITTED_CHANGES,
            },
            "features": {
                "steer": turns::STEER_FEATURE,
                "devices": devices::DEVICES_FEATURE,
                "agentUpdates": agents::UPDATES_FEATURE,
                "clientTools": tools::CLIENT_TOOLS_FEATURE,
                "watch": sessions::WATCH_FEATURE,
                "listFiles": files::LIST_FEATURE,
                "rename": sessions::RENAME_FEATURE,
                "worktrees": worktrees::FEATURE,
            },
            "files": {"maxEntries": files::MAX_ENTRIES},
            "sessions": {"maxTitle": sessions::MAX_TITLE},
            "clientTools": {"clipboardWrite": tools::CLIPBOARD_WRITE},
            "hostTools": {"renameSession": tools::RENAME_SESSION},
        },
        "$defs": definitions,
    })
}

#[test]
fn host_protocol() {
    insta::assert_json_snapshot!("host_protocol", schema());
}
