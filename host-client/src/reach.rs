//! Reaching a Host over its WebSocket as a paired device, and why it couldn't be: what the
//! Dispatcher says when a Host it pairs with (ADR 0027) is asleep, down, someone else, or
//! refuses it.

use std::time::Duration;

use tokio::sync::mpsc;
use weave_host_protocol::dispatcher::Reachability;
use weave_host_protocol::errors;
use weave_host_protocol::hello::ClientCapabilities;
use weave_host_protocol::hello::ClientInfo;

use crate::ConnectError;
use crate::Credentials;
use crate::HostConnection;
use crate::HostEvent;
use crate::remote::CloseReason;
use crate::remote::answered_without_host;
use crate::remote::connect_websocket;

/// Why a Host couldn't be reached: refused, down, unreachable or another Host, and how.
#[derive(Debug)]
pub struct Unreached {
    pub status: Reachability,
    pub why: String,
}

impl Unreached {
    pub fn new(status: Reachability, why: impl Into<String>) -> Self {
        Self {
            status,
            why: why.into(),
        }
    }

    /// Nothing answered, or the connection failed.
    pub fn unreachable(why: impl Into<String>) -> Self {
        Self::new(Reachability::Unreachable, why)
    }

    /// It refused the key, as after revoking it: pairing again is the way back, so trying
    /// again won't help.
    pub fn refused(&self) -> bool {
        self.status == Reachability::Refused
    }
}

impl std::fmt::Display for Unreached {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.why)
    }
}

/// What the person likely calls the Host at `url`: its tailnet name's first label, as in
/// `wss://mac-mini.example.ts.net:7341`.
pub fn tailnet_name(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = rest.split(['/', '?']).next().unwrap_or(rest);
    let host = match authority.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') && port.bytes().all(|b| b.is_ascii_digit()) => {
            host
        }
        _ => authority,
    };
    if host.parse::<std::net::IpAddr>().is_ok() || host.starts_with('[') {
        return host.to_owned();
    }
    host.split('.').next().unwrap_or(host).to_owned()
}

/// A connection to a Host, its messages, and how it closed once it has.
pub type Reached = (
    HostConnection,
    mpsc::UnboundedReceiver<HostEvent>,
    CloseReason,
);

/// Connect to the Host at `url` as `client` and say hello with `credentials`, within
/// `timeout`. `me` is who is connecting, as a refusal says it: "this Host", "the Dispatcher".
pub async fn reach(
    url: &str,
    client: ClientInfo,
    credentials: Credentials,
    timeout: Duration,
    me: &str,
) -> Result<Reached, Unreached> {
    let attempt = async {
        let (transport, closed) =
            connect_websocket(url)
                .await
                .map_err(|error| match answered_without_host(&error) {
                    Some(status) => Unreached::new(
                        Reachability::Down,
                        format!(
                            "its computer answered at {url} (HTTP {status}), but no weave Host \
                             did: the Host may not be running there"
                        ),
                    ),
                    None => Unreached::unreachable(format!("nothing answered at {url}: {error}")),
                })?;
        HostConnection::connect_with(
            transport,
            client,
            ClientCapabilities::default(),
            credentials,
        )
        .await
        .map_err(|error| match error {
            ConnectError::Refused(error) if errors::is(&error, errors::UNAUTHENTICATED) => {
                Unreached::new(
                    Reachability::Refused,
                    format!("it refused {me}: {}", error.message),
                )
            }
            ConnectError::WrongHost => Unreached::new(
                Reachability::OtherHost,
                format!(
                    "another weave Host answers at {url} now: pair again with the one that \
                     should be there"
                ),
            ),
            other => Unreached::unreachable(other.to_string()),
        })
        .map(|(connection, events)| (connection, events, closed))
    };
    tokio::time::timeout(timeout, attempt)
        .await
        .unwrap_or_else(|_| {
            Err(Unreached::unreachable(format!(
                "it didn't answer within {} seconds",
                timeout.as_secs_f32()
            )))
        })
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn a_host_is_named_by_its_tailnet_name() {
        assert_eq!(
            tailnet_name("wss://mac-mini.example.ts.net:7341"),
            "mac-mini"
        );
        assert_eq!(tailnet_name("wss://studio.example.ts.net"), "studio");
        assert_eq!(tailnet_name("ws://127.0.0.1:7341"), "127.0.0.1");
        assert_eq!(tailnet_name("wss://box:7341/path"), "box");
    }
}
