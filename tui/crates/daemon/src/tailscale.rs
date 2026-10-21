//! The Host's Tailscale Serve entry (ADR 0016): the one that forwards an HTTPS port of the
//! Host's own to its loopback WebSocket, so the tailnet's devices reach it. The Host makes it
//! when remote access turns on and removes it when it turns off, through the `tailscale`
//! command, and touches no other entry.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use futures::future::BoxFuture;
use serde_json::Value;

use crate::remote::Serve;

/// Where the Mac app keeps its command, and where Homebrew puts one, when `PATH` has neither,
/// as for a Host launchd started.
const CANDIDATES: [&str; 3] = [
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

/// How long a `tailscale` command may take. `tailscale serve` waits, rather than failing, for
/// Serve to be enabled on a tailnet that has it off.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);

/// A Serve entry that forwards to the Host's WebSocket.
#[derive(Debug, PartialEq, Eq)]
pub struct Entry {
    /// What devices connect to, as `wss://`.
    pub url: String,
    /// Funnel puts this entry on the internet, not just the tailnet.
    pub funnel: bool,
}

/// The `tailscale` command, on `PATH` or where the Mac app or Homebrew put it.
fn binary() -> PathBuf {
    let on_path = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join("tailscale"))
            .find(|candidate| candidate.is_file())
    });
    on_path
        .or_else(|| {
            CANDIDATES
                .iter()
                .map(PathBuf::from)
                .find(|candidate| candidate.is_file())
        })
        .unwrap_or_else(|| PathBuf::from("tailscale"))
}

/// Runs `tailscale <args>`, giving its output, or why it failed.
async fn tailscale(args: &[&str]) -> Result<String, String> {
    let mut command = tokio::process::Command::new(binary());
    command.args(args).kill_on_drop(true);
    let shown = format!("tailscale {}", args.join(" "));
    let output = match tokio::time::timeout(COMMAND_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            return Err(format!(
                "couldn't run `{shown}` ({error}); is Tailscale installed?"
            ));
        }
        Err(_) => {
            return Err(format!(
                "`{shown}` didn't finish in {} seconds. It waits when Serve is off for your \
                 tailnet: run it in a terminal to see the link that turns Serve on",
                COMMAND_TIMEOUT.as_secs()
            ));
        }
    };
    let text = |bytes: &[u8]| String::from_utf8_lossy(bytes).trim().to_owned();
    let (stdout, stderr) = (text(&output.stdout), text(&output.stderr));
    if output.status.success() {
        Ok(stdout)
    } else if let Some(link) = enable_link(&stdout).or_else(|| enable_link(&stderr)) {
        Err(format!(
            "Serve is off for your tailnet; turn it on at {link}"
        ))
    } else {
        let why = if stderr.is_empty() { stdout } else { stderr };
        Err(format!("`{shown}` failed: {why}"))
    }
}

/// The link `tailscale` gives for turning Serve or HTTPS on for the tailnet.
fn enable_link(output: &str) -> Option<String> {
    output
        .split_whitespace()
        .find(|word| word.starts_with("https://login.tailscale.com/"))
        .map(|link| link.trim_end_matches(['.', ',']).to_owned())
}

/// `tailscale serve status --json`.
async fn serve_status() -> Result<Value, String> {
    let output = tailscale(&["serve", "status", "--json"]).await?;
    if output.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&output).map_err(|error| format!("reading Serve's status: {error}"))
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

/// Whether Serve already uses `port` for something, on the tailnet or through Funnel.
fn port_taken(status: &Value, port: u16) -> bool {
    status
        .get("TCP")
        .and_then(Value::as_object)
        .is_some_and(|tcp| tcp.contains_key(&port.to_string()))
}

/// The real Serve, through the `tailscale` command.
pub struct TailscaleServe;

impl TailscaleServe {
    async fn entry(listen: SocketAddr) -> Result<String, String> {
        let status = serve_status().await?;
        if let Some(entry) = entry_for(&status, listen) {
            return checked(entry);
        }
        let port = listen.port();
        if port_taken(&status, port) {
            return Err(format!(
                "Tailscale Serve already uses HTTPS port {port} for something else; free it, or \
                 move the Host with [remote] listen in the config"
            ));
        }
        tailscale(&[
            "serve",
            "--bg",
            &format!("--https={port}"),
            &format!("http://127.0.0.1:{port}"),
        ])
        .await?;
        tracing::info!(port, "made the Tailscale Serve entry");
        let status = serve_status().await?;
        entry_for(&status, listen).map_or_else(
            || Err("Tailscale Serve made no entry for the Host".to_owned()),
            checked,
        )
    }
}

/// A Serve entry's URL, unless Funnel puts it on the internet.
fn checked(entry: Entry) -> Result<String, String> {
    if entry.funnel {
        return Err(
            "Tailscale Funnel puts the Host's WebSocket on the internet; remote clients are for \
             your tailnet only. Turn Funnel off for it, then pair"
                .to_owned(),
        );
    }
    Ok(entry.url)
}

impl Serve for TailscaleServe {
    fn ensure(&self, listen: SocketAddr) -> BoxFuture<'_, Result<String, String>> {
        Box::pin(Self::entry(listen))
    }

    fn remove(&self, listen: SocketAddr) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let status = serve_status().await?;
            if entry_for(&status, listen).is_none() {
                return Ok(());
            }
            let port = listen.port();
            tailscale(&["serve", &format!("--https={port}"), "off"]).await?;
            tracing::info!(port, "removed the Tailscale Serve entry");
            Ok(())
        })
    }
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
        let entry = entry_for(&status, listen()).expect("the entry");
        assert_eq!(
            entry,
            Entry {
                url: "wss://mac.example.ts.net/weave".to_owned(),
                funnel: true,
            }
        );
        assert!(checked(entry).is_err());
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

    #[test]
    fn a_port_serving_something_else_is_taken() {
        let status = json!({"TCP": {"7341": {"HTTPS": true}}});
        assert!(port_taken(&status, 7341));
        assert!(!port_taken(&status, 7342));
        assert!(!port_taken(&Value::Null, 7341));
    }

    #[test]
    fn the_link_for_turning_serve_on_is_found() {
        let output = "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         \
                      https://login.tailscale.com/f/serve?node=abc123\n";
        assert_eq!(
            enable_link(output).as_deref(),
            Some("https://login.tailscale.com/f/serve?node=abc123")
        );
        assert_eq!(enable_link("nothing to see"), None);
    }
}
