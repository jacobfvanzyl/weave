//! Reading Tailscale Serve's configuration, never changing it: the URL devices reach the
//! Host's WebSocket at, and whether Funnel would put it on the internet.

use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::Context;
use serde_json::Value;

/// Where the Mac app keeps its command when it isn't on `PATH`.
const MAC_APP: &str = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/// A Serve entry that forwards to the Host's WebSocket.
#[derive(Debug, PartialEq, Eq)]
pub struct Entry {
    /// What devices connect to, as `wss://`.
    pub url: String,
    /// Funnel puts this entry on the internet, not just the tailnet.
    pub funnel: bool,
}

/// `tailscale serve status --json`.
pub fn serve_status() -> anyhow::Result<Value> {
    let output = std::process::Command::new(binary())
        .args(["serve", "status", "--json"])
        .output()
        .context("running `tailscale serve status --json`; is Tailscale installed?")?;
    anyhow::ensure!(
        output.status.success(),
        "`tailscale serve status --json` failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    serde_json::from_slice(&output.stdout).context("reading `tailscale serve status --json`")
}

fn binary() -> PathBuf {
    let on_path = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join("tailscale"))
            .find(|candidate| candidate.is_file())
    });
    on_path.unwrap_or_else(|| PathBuf::from(MAC_APP))
}

/// The Serve entry in `status` that forwards to `listen`, background ones and those of
/// `tailscale serve` running in a terminal alike.
pub fn entry_for(status: &Value, listen: SocketAddr) -> Option<Entry> {
    let mut configs = vec![status];
    if let Some(foreground) = status.get("Foreground").and_then(Value::as_object) {
        configs.extend(foreground.values());
    }
    configs
        .into_iter()
        .find_map(|config| entry_in(config, listen))
}

fn entry_in(config: &Value, listen: SocketAddr) -> Option<Entry> {
    let web = config.get("Web")?.as_object()?;
    for (host_port, site) in web {
        let Some(handlers) = site.get("Handlers").and_then(Value::as_object) else {
            continue;
        };
        for (path, handler) in handlers {
            let Some(proxy) = handler.get("Proxy").and_then(Value::as_str) else {
                continue;
            };
            if !forwards_to(proxy, listen) {
                continue;
            }
            let address = host_port.strip_suffix(":443").unwrap_or(host_port);
            let path = path.trim_end_matches('/');
            let funnel = config
                .get("AllowFunnel")
                .and_then(|funnel| funnel.get(host_port))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            return Some(Entry {
                url: format!("wss://{address}{path}"),
                funnel,
            });
        }
    }
    None
}

/// Whether a Serve proxy target, such as `http://127.0.0.1:7341`, is `listen`.
fn forwards_to(proxy: &str, listen: SocketAddr) -> bool {
    let target = proxy
        .strip_prefix("http://")
        .unwrap_or(proxy)
        .trim_end_matches('/');
    let Some((host, port)) = target.rsplit_once(':') else {
        return false;
    };
    let loopback = matches!(host, "127.0.0.1" | "localhost" | "[::1]");
    loopback && port.parse::<u16>().ok() == Some(listen.port())
}

/// The command that makes the Serve entry for `listen`, on an HTTPS port of its own.
pub fn serve_command(listen: SocketAddr) -> String {
    let port = listen.port();
    format!("tailscale serve --bg --https={port} http://127.0.0.1:{port}")
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use serde_json::json;

    use super::*;

    fn listen() -> SocketAddr {
        "127.0.0.1:7341".parse().expect("an address")
    }

    #[test]
    fn the_entry_forwarding_to_the_host_gives_the_url() {
        let status = json!({
            "TCP": {"8443": {"HTTPS": true}, "7341": {"HTTPS": true}},
            "Web": {
                "mac.example.ts.net:8443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:3000"}}},
                "mac.example.ts.net:7341": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:7341"}}},
            }
        });
        assert_eq!(
            entry_for(&status, listen()),
            Some(Entry {
                url: "wss://mac.example.ts.net:7341".to_owned(),
                funnel: false,
            })
        );
    }

    #[test]
    fn a_path_and_port_443_and_funnel_are_read() {
        let status = json!({
            "Web": {
                "mac.example.ts.net:443": {"Handlers": {"/weave/": {"Proxy": "localhost:7341"}}},
            },
            "AllowFunnel": {"mac.example.ts.net:443": true}
        });
        assert_eq!(
            entry_for(&status, listen()),
            Some(Entry {
                url: "wss://mac.example.ts.net/weave".to_owned(),
                funnel: true,
            })
        );
    }

    #[test]
    fn foreground_serves_count_and_other_ports_dont() {
        let status = json!({
            "Foreground": {"session-1": {"Web": {
                "mac.example.ts.net:7341": {"Handlers": {"/": {"Proxy": "http://[::1]:7341"}}},
            }}},
        });
        assert!(entry_for(&status, listen()).is_some());
        let elsewhere = json!({"Web": {
            "mac.example.ts.net:7341": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:7342"}}},
        }});
        assert_eq!(entry_for(&elsewhere, listen()), None);
        assert_eq!(entry_for(&json!({}), listen()), None);
    }
}
