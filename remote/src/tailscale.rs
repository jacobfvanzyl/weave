//! A program's Tailscale Serve entry (ADR 0016): the one that forwards an HTTPS port of its
//! own, the port its loopback WebSocket listens on, so the tailnet's devices reach it. The
//! program makes it when remote access turns on and removes it when it turns off, through the
//! `tailscale` command, and touches no other entry: the Dispatcher's is on 7342. Hosts made one
//! on 7341 until devices reached them through the Dispatcher (WVE-197), and remove it now. Only
//! an entry under the computer's tailnet name now counts: one under a name it had before being
//! renamed gives a URL that no longer resolves.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use futures::future::BoxFuture;
use serde_json::Value;

use crate::access::Serve;

/// Where the Mac app keeps its command, and where Homebrew puts one, when `PATH` has neither,
/// as for a program launchd started. Elsewhere, as on Linux, `PATH` has it.
const MAC_CANDIDATES: [&str; 3] = [
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

/// How long a `tailscale` command may take. `tailscale serve` waits, rather than failing, for
/// Serve to be enabled on a tailnet that has it off.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);

/// A Serve entry that forwards to a program's WebSocket.
#[derive(Debug, PartialEq, Eq)]
pub struct Entry {
    /// What devices connect to, as `wss://`.
    pub url: String,
    /// Funnel puts this entry on the internet, not just the tailnet.
    pub funnel: bool,
}

/// The `tailscale` command, on `PATH`, or on macOS where the Mac app or Homebrew put it.
fn binary() -> PathBuf {
    let on_path = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join("tailscale"))
            .find(|candidate| candidate.is_file())
    });
    let candidates: &[&str] = if cfg!(target_os = "macos") {
        &MAC_CANDIDATES
    } else {
        &[]
    };
    on_path
        .or_else(|| {
            candidates
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
    } else if stdout == "Logged out." || stderr == "Logged out." {
        Err(
            "Tailscale is logged out on this computer. Sign it in to your tailnet (`tailscale \
             up`), then pair again"
                .to_owned(),
        )
    } else if needs_root(&stderr) {
        Err(format!(
            "Tailscale lets only root change Serve while its config serves a path or Unix socket, \
             as another program's entry does here: run `sudo {shown}` yourself"
        ))
    } else if needs_operator(&stderr) {
        Err(
            "Tailscale lets only root and its operator change Serve on this computer. Make \
             yourself its operator, once, with `sudo tailscale set --operator=$USER`, then pair \
             again"
                .to_owned(),
        )
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

/// Whether `tailscale` was refused for not being root, as on Linux, where it says to use
/// `sudo` or `tailscale set --operator`.
fn needs_operator(stderr: &str) -> bool {
    stderr.contains("set --operator")
}

/// Whether `tailscale` was refused, operator or not, because Serve's config has an entry for a
/// path or a Unix socket, as another program's may, which only root (or an operator who can
/// `sudo tailscale`) may send along with a change.
fn needs_root(stderr: &str) -> bool {
    stderr.contains("must be root")
}

/// `tailscale serve status --json`.
async fn serve_status() -> Result<Value, String> {
    let output = tailscale(&["serve", "status", "--json"]).await?;
    if output.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&output).map_err(|error| format!("reading Serve's status: {error}"))
}

/// This computer's name on the tailnet, as `tailscale status` gives it, without the final dot;
/// none when it can't say.
async fn node_name() -> Option<String> {
    let output = tailscale(&["status", "--json", "--peers=false"])
        .await
        .ok()?;
    node_name_in(&serde_json::from_str(&output).ok()?)
}

fn node_name_in(status: &Value) -> Option<String> {
    let name = status.get("Self")?.get("DNSName")?.as_str()?;
    let name = name.trim_end_matches('.');
    (!name.is_empty()).then(|| name.to_ascii_lowercase())
}

/// The Serve entry in `status` that forwards to `listen` under `node`, the computer's tailnet
/// name (any name when it isn't known), background ones and those of `tailscale serve` running
/// in a terminal alike.
pub fn entry_for(status: &Value, listen: SocketAddr, node: Option<&str>) -> Option<Entry> {
    configs(status)
        .into_iter()
        .find_map(|config| entry_in(config, listen, node))
}

/// Serve's background config in `status`, and each `tailscale serve` running in a terminal.
fn configs(status: &Value) -> Vec<&Value> {
    let mut configs = vec![status];
    if let Some(foreground) = status.get("Foreground").and_then(Value::as_object) {
        configs.extend(foreground.values());
    }
    configs
}

/// Whether a Serve site's `host:port` is under `node`, or any name when it isn't known.
fn under(host_port: &str, node: Option<&str>) -> bool {
    let host = host_port
        .rsplit_once(':')
        .map_or(host_port, |(host, _)| host);
    node.is_none_or(|node| host.eq_ignore_ascii_case(node))
}

fn entry_in(config: &Value, listen: SocketAddr, node: Option<&str>) -> Option<Entry> {
    let web = config.get("Web")?.as_object()?;
    for (host_port, site) in web {
        if !under(host_port, node) {
            continue;
        }
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

/// Whether Serve already uses `port` for something other than `listen`, on the tailnet or
/// through Funnel. Sites on it that forward to `listen`, as one under a name the computer had
/// before being renamed does, leave it free for an entry under its name now.
fn port_taken(status: &Value, port: u16, listen: SocketAddr) -> bool {
    let used = status
        .get("TCP")
        .and_then(Value::as_object)
        .is_some_and(|tcp| tcp.contains_key(&port.to_string()));
    if !used {
        return false;
    }
    let suffix = format!(":{port}");
    let mut ours = false;
    for site in configs(status)
        .into_iter()
        .filter_map(|config| config.get("Web")?.as_object())
        .flatten()
        .filter(|(host_port, _)| host_port.ends_with(&suffix))
        .map(|(_, site)| site)
    {
        let proxies = site
            .get("Handlers")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .map(|(_, handler)| handler.get("Proxy").and_then(Value::as_str));
        for proxy in proxies {
            if !proxy.is_some_and(|proxy| forwards_to(proxy, listen)) {
                return true;
            }
            ours = true;
        }
    }
    !ours
}

/// The real Serve, through the `tailscale` command.
pub struct TailscaleServe {
    /// The program, in messages: "the Dispatcher".
    pub what: &'static str,
}

impl TailscaleServe {
    /// The entry a Host made before WVE-197, on 7341 or where `[remote] listen` moved it,
    /// which it removes now.
    pub const HOST: Self = Self { what: "the Host" };

    /// The Dispatcher's entry, on port 7342.
    pub const DISPATCHER: Self = Self {
        what: "the Dispatcher",
    };

    async fn entry(&self, listen: SocketAddr) -> Result<String, String> {
        let status = serve_status().await?;
        let node = node_name().await;
        if let Some(entry) = entry_for(&status, listen, node.as_deref()) {
            return checked(entry, self.what);
        }
        let port = listen.port();
        if port_taken(&status, port, listen) {
            return Err(format!(
                "Tailscale Serve already uses HTTPS port {port} for something else; free it"
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
        entry_for(&status, listen, node.as_deref()).map_or_else(
            || Err(format!("Tailscale Serve made no entry for {}", self.what)),
            |entry| checked(entry, self.what),
        )
    }
}

/// A Serve entry's URL, unless Funnel puts it on the internet.
fn checked(entry: Entry, what: &str) -> Result<String, String> {
    if entry.funnel {
        return Err(format!(
            "Tailscale Funnel puts {what}'s WebSocket on the internet; remote clients are for \
             your tailnet only. Turn Funnel off for it, then pair"
        ));
    }
    Ok(entry.url)
}

impl Serve for TailscaleServe {
    fn ensure(&self, listen: SocketAddr) -> BoxFuture<'_, Result<String, String>> {
        Box::pin(self.entry(listen))
    }

    fn remove(&self, listen: SocketAddr) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let status = serve_status().await?;
            let node = node_name().await;
            if entry_for(&status, listen, node.as_deref()).is_none() {
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
            entry_for(&status, listen(), Some("mac.example.ts.net")),
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
        let entry = entry_for(&status, listen(), None).expect("the entry");
        assert_eq!(
            entry,
            Entry {
                url: "wss://mac.example.ts.net/weave".to_owned(),
                funnel: true,
            }
        );
        assert!(checked(entry, "the Host").is_err());
    }

    #[test]
    fn foreground_serves_count_and_other_ports_dont() {
        let status = json!({
            "Foreground": {"session-1": {"Web": {
                "mac.example.ts.net:7341": {"Handlers": {"/": {"Proxy": "http://[::1]:7341"}}},
            }}},
        });
        assert!(entry_for(&status, listen(), Some("mac.example.ts.net")).is_some());
        let elsewhere = json!({"Web": {
            "mac.example.ts.net:7341": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:7342"}}},
        }});
        assert_eq!(entry_for(&elsewhere, listen(), None), None);
        assert_eq!(entry_for(&json!({}), listen(), None), None);
    }

    #[test]
    fn a_port_serving_something_else_is_taken() {
        let status = json!({"TCP": {"7341": {"HTTPS": true}}});
        assert!(port_taken(&status, 7341, listen()));
        assert!(!port_taken(&status, 7342, listen()));
        assert!(!port_taken(&Value::Null, 7341, listen()));
        let elsewhere = json!({
            "TCP": {"7341": {"HTTPS": true}},
            "Web": {"mac.example.ts.net:7341": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:3000"}}}},
        });
        assert!(port_taken(&elsewhere, 7341, listen()));
    }

    /// homelab-1's, renamed from bazzite with the Host's entry under its old name.
    fn renamed() -> Value {
        json!({
            "TCP": {"443": {"HTTPS": true}, "7341": {"HTTPS": true}},
            "Web": {
                "bazzite.example.ts.net:443": {"Handlers": {"/": {"Proxy": "unix:/run/rex/serve.sock"}}},
                "bazzite.example.ts.net:7341": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:7341"}}},
                "homelab-1.example.ts.net:443": {"Handlers": {"/": {"Proxy": "unix:/run/rex/serve.sock"}}},
            }
        })
    }

    #[test]
    fn an_entry_under_a_name_the_computer_had_before_is_gone() {
        let status = renamed();
        assert_eq!(
            entry_for(&status, listen(), Some("homelab-1.example.ts.net")),
            None
        );
        // Its port is free for one under the name now, which is the one that counts.
        assert!(!port_taken(&status, 7341, listen()));
        let mut remade = status;
        remade["Web"]["homelab-1.example.ts.net:7341"] =
            json!({"Handlers": {"/": {"Proxy": "http://127.0.0.1:7341"}}});
        assert_eq!(
            entry_for(&remade, listen(), Some("homelab-1.example.ts.net")).map(|entry| entry.url),
            Some("wss://homelab-1.example.ts.net:7341".to_owned())
        );
        // Without the name, as when `tailscale status` fails, any name counts, as before.
        assert!(entry_for(&renamed(), listen(), None).is_some());
    }

    #[test]
    fn the_computers_name_is_read_from_status() {
        let status =
            json!({"Self": {"DNSName": "Homelab-1.example.ts.net.", "HostName": "homelab"}});
        assert_eq!(
            node_name_in(&status).as_deref(),
            Some("homelab-1.example.ts.net")
        );
        assert_eq!(node_name_in(&json!({"Self": {"DNSName": ""}})), None);
        assert_eq!(node_name_in(&json!({})), None);
    }

    #[test]
    fn a_refusal_for_not_being_root_asks_for_the_operator() {
        let refused = "Access denied: serve config denied\n\nUse 'sudo tailscale serve --bg \
                       --https=7341 http://127.0.0.1:7341'.\nTo not require root, use 'sudo \
                       tailscale set --operator=$USER' once.";
        assert!(needs_operator(refused));
        assert!(!needs_operator("tailscaled is not running"));
    }

    #[test]
    fn a_refusal_over_another_programs_socket_entry_asks_for_root() {
        let refused = "sending serve config: 401 Unauthorized: must be root, or be an operator \
                       and able to run 'sudo tailscale' to serve a path or Unix socket";
        assert!(needs_root(refused));
        assert!(!needs_operator(refused));
        assert!(!needs_root("tailscaled is not running"));
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
