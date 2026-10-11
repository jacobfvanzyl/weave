//! The two roles over the ACP SDK's JSON-RPC layer: typed requests reach a Host's handlers,
//! and what nobody handles falls through as the protocol says.

#![allow(clippy::expect_used)]

use agent_client_protocol::Channel;
use agent_client_protocol::ConnectionTo;
use agent_client_protocol::ErrorCode;
use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::JsonRpcResponse;
use agent_client_protocol::Role;
use pretty_assertions::assert_eq;
use serde::Deserialize;
use serde::Serialize;
use weave_host_protocol::Host;
use weave_host_protocol::HostClient;
use weave_host_protocol::VersionRange;
use weave_host_protocol::hello::AcpInfo;
use weave_host_protocol::hello::Auth;
use weave_host_protocol::hello::ClientCapabilities;
use weave_host_protocol::hello::ClientInfo;
use weave_host_protocol::hello::HelloRequest;
use weave_host_protocol::hello::HelloResponse;
use weave_host_protocol::hello::HostInfo;

/// A method this Host doesn't have.
#[derive(Clone, Debug, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "host/later", response = Later)]
struct LaterRequest {}

#[derive(Clone, Debug, Serialize, Deserialize, JsonRpcResponse)]
struct Later {}

#[tokio::test]
async fn a_client_reaches_a_hosts_handlers() {
    let (client_end, host_end) = Channel::duplex();
    tokio::spawn(
        Host.builder()
            .on_receive_request(
                async move |request: HelloRequest, responder, _cx| {
                    responder.respond(HelloResponse {
                        protocol: request
                            .protocol
                            .highest_common(VersionRange::supported())
                            .unwrap_or_default(),
                        client_id: "c1".to_owned(),
                        host: HostInfo {
                            version: "test".to_owned(),
                            pid: 1,
                            started_at: 0,
                        },
                        features: Vec::new(),
                        acp: AcpInfo {
                            protocol_version: 1,
                            unstable: Vec::new(),
                        },
                    })
                },
                agent_client_protocol::on_receive_request!(),
            )
            .connect_to(host_end),
    );
    HostClient
        .builder()
        .connect_with(client_end, async |cx: ConnectionTo<Host>| {
            let hello = cx
                .send_request(HelloRequest {
                    protocol: VersionRange::supported(),
                    client: ClientInfo {
                        name: "test".to_owned(),
                        version: "0".to_owned(),
                    },
                    auth: Auth::Local,
                    capabilities: ClientCapabilities::default(),
                })
                .block_task()
                .await
                .expect("hello answered");
            assert_eq!(hello.protocol, 2);
            assert_eq!(hello.client_id, "c1");

            let unknown = cx
                .send_request(LaterRequest {})
                .block_task()
                .await
                .expect_err("no handler");
            assert_eq!(unknown.code, ErrorCode::MethodNotFound);
            Ok(())
        })
        .await
        .expect("the connection runs");
}
