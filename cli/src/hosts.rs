//! `weave hosts`: the person's other Hosts this Host pairs with, its peer Hosts, whose threads
//! its agents reach through the Host tools that name one (ADR 0017, WVE-109).
//!
//! `weave hosts add studio` does the pairing over SSH (ADR 0017's way of managing another
//! Host): it runs `weave pair --json` on studio for a code, pairs this Host with it, and then,
//! unless `--one-way`, has studio pair with this Host the same way, so either Host's agents
//! reach the other. Given the URL and code `weave pair` showed there instead, it pairs this way
//! only.

use std::process::Command;
use std::process::Stdio;

use anyhow::Context as _;
use anyhow::bail;
use clap::Args;
use clap::Subcommand;
use weave_host_client::HostConnection;
use weave_host_protocol::devices::OfferDeviceRequest;
use weave_host_protocol::errors;
use weave_host_protocol::peers::AddPeerRequest;
use weave_host_protocol::peers::ListPeersRequest;
use weave_host_protocol::peers::Peer;
use weave_host_protocol::peers::PeerStatus;
use weave_host_protocol::peers::RemovePeerRequest;

use crate::daemon;
use crate::daemon::ago;
use crate::daemon::now_ms;
use crate::devices::Offered;

/// What runs `ssh`, for tests to stand in for it.
const SSH_VARIABLE: &str = "WEAVE_SSH";

#[derive(Args)]
pub struct HostsArgs {
    #[command(subcommand)]
    command: Option<HostsCommand>,
}

#[derive(Subcommand)]
enum HostsCommand {
    /// List your other Hosts this one pairs with, and whether each can be reached (the
    /// default).
    List(ListArgs),
    /// Pair with another of your Hosts, over SSH (`weave hosts add studio`), both ways unless
    /// `--one-way`; or with the URL and code `weave pair` shows there, this way only.
    Add(AddArgs),
    /// Forget another Host. It still lists this Host among its devices until you revoke it
    /// there with `weave devices revoke`.
    Remove(RemoveArgs),
}

#[derive(Args, Default)]
struct ListArgs {
    /// Print them as JSON.
    #[arg(long)]
    json: bool,

    /// Don't try to reach the Hosts this one isn't connected to.
    #[arg(long)]
    no_check: bool,
}

#[derive(Args)]
struct AddArgs {
    /// The other Host: its computer as `ssh` reaches it, such as `studio` or `me@studio`; or
    /// its URL as `weave pair` shows it there, or the `weave://pair` link its QR code holds.
    host: String,

    /// With a URL: the code `weave pair` shows there; the link carries it.
    code: Option<String>,

    /// What to call the other Host; over SSH, the name SSH reaches it by, and otherwise its
    /// tailnet name.
    #[arg(long)]
    name: Option<String>,

    /// Over SSH, pair this way only: this Host's agents reach the other's threads, and not
    /// the other way round.
    #[arg(long)]
    one_way: bool,

    /// Print the other Host as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct RemoveArgs {
    /// The other Host's id or name.
    host: String,
}

/// `weave hosts`: list, add or remove peer Hosts.
pub async fn hosts(args: HostsArgs) -> anyhow::Result<()> {
    let paths = daemon::paths()?;
    let command = args
        .command
        .unwrap_or_else(|| HostsCommand::List(ListArgs::default()));
    let transport = daemon::open(&paths).await?;
    let (connection, _events) = HostConnection::connect(
        transport,
        daemon::client_info("weave-cli"),
        daemon::capabilities("weave-cli"),
    )
    .await?;
    let result = run(&connection, command).await;
    connection.shutdown().await;
    result
}

async fn run(connection: &HostConnection, command: HostsCommand) -> anyhow::Result<()> {
    match command {
        HostsCommand::List(ListArgs { json, no_check }) => {
            let listed = connection
                .send(ListPeersRequest { check: !no_check })
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&listed.peers)?);
            } else {
                print!("{}", describe(&listed.peers, now_ms()));
            }
        }
        HostsCommand::Add(add) => self::add(connection, add).await?,
        HostsCommand::Remove(RemoveArgs { host }) => {
            let listed = connection.send(ListPeersRequest { check: false }).await?;
            let Some(peer) = listed
                .peers
                .iter()
                .find(|peer| peer.host_id == host)
                .or_else(|| {
                    listed
                        .peers
                        .iter()
                        .find(|peer| peer.name.eq_ignore_ascii_case(&host))
                })
            else {
                bail!("no Host {host} pairs with this one; `weave hosts` lists them");
            };
            connection
                .send(RemovePeerRequest {
                    host_id: peer.host_id.clone(),
                })
                .await?;
            println!(
                "Forgot {} ({}). Revoke this Host there too, with `weave devices revoke`.",
                peer.name, peer.host_id
            );
        }
    }
    Ok(())
}

/// How `weave hosts add` reaches the other Host.
#[derive(Debug, PartialEq, Eq)]
enum Reach {
    /// The URL and code `weave pair` showed there.
    Code { url: String, code: String },
    /// The computer, as `ssh` reaches it.
    Ssh(String),
}

async fn add(connection: &HostConnection, add: AddArgs) -> anyhow::Result<()> {
    let AddArgs {
        host,
        code,
        name,
        one_way,
        json,
    } = add;
    let (url, code, name, over) = match reach(&host, code)? {
        Reach::Code { url, code } => (url, code, name, None),
        Reach::Ssh(destination) => {
            let offered: Offered = serde_json::from_str(
                &ssh(&destination, &["pair", "--json"]).context("asking it for a code")?,
            )
            .context("reading what `weave pair --json` said there")?;
            let name = name.or_else(|| Some(ssh_name(&destination)));
            (offered.url, offered.code, name, Some(destination))
        }
    };
    let peer = connection
        .send(AddPeerRequest { url, code, name })
        .await?
        .peer;
    // The other way: that Host pairs with this one, with a code this one offers.
    let back = match (&over, one_way) {
        (Some(destination), false) => Some(pair_back(connection, destination).await),
        _ => None,
    };
    if json {
        println!("{}", serde_json::to_string_pretty(&peer)?);
    } else {
        let name = &peer.name;
        println!(
            "Paired with {name} ({}): this Host's agents reach its threads.",
            peer.host_id
        );
        match (&back, &over) {
            (Some(Ok(())), _) => {
                println!("{name} paired with this Host too: its agents reach this Host's threads.")
            }
            (Some(Err(_)), _) => {}
            (None, Some(_)) => println!(
                "{name} doesn't pair with this Host: its agents can't reach this Host's threads."
            ),
            (None, None) => println!(
                "For {name}'s agents to reach this Host too, run `weave hosts add` there, or here \
                 with the name SSH reaches it by."
            ),
        }
    }
    if let Some(Err(error)) = back {
        return Err(error.context(format!(
            "paired with {} this way, but it couldn't pair with this Host",
            peer.name
        )));
    }
    Ok(())
}

/// Have the Host SSH reaches at `destination` pair with this one, one way.
async fn pair_back(connection: &HostConnection, destination: &str) -> anyhow::Result<()> {
    let offer = match connection.send(OfferDeviceRequest { name: None }).await {
        Ok(offer) => offer,
        Err(error) if errors::is(&error, errors::REMOTE_UNAVAILABLE) => bail!("{}", error.message),
        Err(error) => return Err(error.into()),
    };
    let Some(url) = offer.url else {
        bail!("this Host can't turn remote access on; restart it with `weave daemon restart`");
    };
    ssh(
        destination,
        &["hosts", "add", &url, &offer.code, "--one-way", "--json"],
    )?;
    Ok(())
}

/// How `host` and `code` reach the other Host: a URL or `weave://pair` link with its code, or
/// otherwise a computer SSH reaches.
fn reach(host: &str, code: Option<String>) -> anyhow::Result<Reach> {
    if let Some(query) = host.strip_prefix("weave://pair?") {
        let field = |name: &str| {
            query
                .split('&')
                .find_map(|pair| pair.strip_prefix(name)?.strip_prefix('='))
                .map(percent_decode)
        };
        let (Some(url), Some(linked)) = (field("url"), field("code")) else {
            bail!("the link names no URL and code");
        };
        return Ok(Reach::Code {
            url,
            code: code.unwrap_or(linked),
        });
    }
    if host.contains("://") {
        let Some(code) = code else {
            bail!("give the code `weave pair` shows there, after the URL");
        };
        return Ok(Reach::Code {
            url: host.to_owned(),
            code,
        });
    }
    if code.is_some() {
        bail!(
            "a code goes with the URL `weave pair` shows there; over SSH, give the computer alone"
        );
    }
    Ok(Reach::Ssh(host.to_owned()))
}

/// What to call a Host SSH reaches at `destination`: its computer, without the user or port.
fn ssh_name(destination: &str) -> String {
    let host = destination
        .rsplit_once('@')
        .map_or(destination, |(_, host)| host);
    host.split(':').next().unwrap_or(host).to_owned()
}

/// Run `weave args…` on `destination` over SSH, without prompting: what it printed.
fn ssh(destination: &str, args: &[&str]) -> anyhow::Result<String> {
    let program = std::env::var(SSH_VARIABLE).unwrap_or_else(|_| "ssh".to_owned());
    let remote: Vec<String> = std::iter::once("weave")
        .chain(args.iter().copied())
        .map(shell_quote)
        .collect();
    let output = Command::new(&program)
        .args(["-o", "BatchMode=yes", destination])
        .arg(remote.join(" "))
        .stdin(Stdio::null())
        .output()
        .with_context(|| format!("running {program}"))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    let said = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    match output.status.code() {
        Some(127) => bail!(
            "a command over SSH on {destination} doesn't find weave: {said}. `weave daemon \
             install` there says how to have it"
        ),
        Some(255) => bail!("couldn't reach {destination} over SSH: {said}"),
        _ => bail!("`weave {}` failed on {destination}: {said}", args.join(" ")),
    }
}

/// `text` as one word for a POSIX shell.
fn shell_quote(text: &str) -> String {
    let plain = !text.is_empty()
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_./:=@%+,".contains(&byte));
    if plain {
        text.to_owned()
    } else {
        format!("'{}'", text.replace('\'', r"'\''"))
    }
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let hex = bytes
            .get(at + 1..at + 3)
            .and_then(|hex| std::str::from_utf8(hex).ok())
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        match (bytes[at], hex) {
            (b'%', Some(byte)) => {
                out.push(byte);
                at += 3;
            }
            (byte, _) => {
                out.push(byte);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn describe(peers: &[Peer], now_ms: u64) -> String {
    if peers.is_empty() {
        return "No other Hosts pair with this one; `weave hosts add <computer>` pairs with one \
                over SSH.\n"
            .to_owned();
    }
    let width = peers
        .iter()
        .map(|peer| peer.name.chars().count())
        .max()
        .unwrap_or(0);
    peers
        .iter()
        .map(|peer| {
            let error = peer.error.as_deref().unwrap_or("no reason given");
            let state = match peer.status {
                PeerStatus::Reachable => "reachable".to_owned(),
                PeerStatus::Unchecked => match peer.last_seen_at {
                    Some(seen) => format!("seen {} ago", ago(now_ms, seen)),
                    None => "not seen since pairing".to_owned(),
                },
                PeerStatus::Refused => format!("refused this Host: {error}"),
                PeerStatus::Down => format!("down: {error}"),
                PeerStatus::Unreachable => format!("can't be reached: {error}"),
                PeerStatus::OtherHost => format!("another Host answers: {error}"),
            };
            format!(
                "{}  {:width$}  {}  {state}\n",
                peer.host_id, peer.name, peer.url
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn a_host_is_reached_by_url_and_code_or_over_ssh() {
        let code = |url: &str, code: &str| Reach::Code {
            url: url.to_owned(),
            code: code.to_owned(),
        };
        assert_eq!(
            reach(
                "weave://pair?url=wss%3A%2F%2Fstudio.example.ts.net%3A7341&code=ABC",
                None
            )
            .expect("a link"),
            code("wss://studio.example.ts.net:7341", "ABC")
        );
        assert_eq!(
            reach("wss://studio.example.ts.net:7341", Some("ABC".to_owned())).expect("as given"),
            code("wss://studio.example.ts.net:7341", "ABC")
        );
        assert!(reach("wss://studio.example.ts.net:7341", None).is_err());
        assert_eq!(
            reach("me@studio", None).expect("SSH"),
            Reach::Ssh("me@studio".to_owned())
        );
        assert!(reach("studio", Some("ABC".to_owned())).is_err());
    }

    #[test]
    fn a_host_over_ssh_is_named_by_its_computer() {
        assert_eq!(ssh_name("studio"), "studio");
        assert_eq!(ssh_name("me@studio.local"), "studio.local");
        assert_eq!(ssh_name("me@studio:2222"), "studio");
    }

    #[test]
    fn words_for_the_remote_shell_are_quoted_when_they_need_it() {
        assert_eq!(shell_quote("ws://127.0.0.1:7341"), "ws://127.0.0.1:7341");
        assert_eq!(shell_quote("Jaco's Mac"), r"'Jaco'\''s Mac'");
        assert_eq!(shell_quote(""), "''");
    }

    #[test]
    fn hosts_are_listed_with_whether_they_can_be_reached() {
        let peer = |name: &str, status, error: Option<&str>| Peer {
            host_id: format!("h-{name}"),
            name: name.to_owned(),
            url: format!("wss://{name}.example.ts.net:7341"),
            paired_at: 0,
            last_seen_at: Some(0),
            status,
            error: error.map(str::to_owned),
        };
        assert_eq!(
            describe(
                &[
                    peer("studio", PeerStatus::Reachable, None),
                    peer("mini", PeerStatus::Unreachable, Some("it didn't answer")),
                    peer("box", PeerStatus::Down, Some("HTTP 502")),
                ],
                0
            ),
            "h-studio  studio  wss://studio.example.ts.net:7341  reachable\n\
             h-mini  mini    wss://mini.example.ts.net:7341  can't be reached: it didn't answer\n\
             h-box  box     wss://box.example.ts.net:7341  down: HTTP 502\n"
        );
        assert!(describe(&[], 0).starts_with("No other Hosts"));
    }
}
