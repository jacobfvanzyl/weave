//! `weave dotfiles`: the person's terminal dotfiles repository, which the Dispatcher pulls from
//! git and syncs incrementally to their Hosts (ADR 0037, WVE-243).

use std::fmt::Write as _;
use std::process::ExitCode;

use anyhow::bail;
use clap::Args;
use clap::Subcommand;
use clap::ValueEnum;
use weave_host_protocol::dispatcher::ClearDotfilesRequest;
use weave_host_protocol::dispatcher::DOTFILES_FEATURE;
use weave_host_protocol::dispatcher::DotfilesHostStatus;
use weave_host_protocol::dispatcher::DotfilesStatus;
use weave_host_protocol::dispatcher::DotfilesStatusRequest;
use weave_host_protocol::dispatcher::SetDotfilesHostRequest;
use weave_host_protocol::dispatcher::SetDotfilesRequest;
use weave_host_protocol::dispatcher::SyncDotfilesRequest;
use weave_host_protocol::dotfiles::DotfilesActiveMode;
use weave_host_protocol::dotfiles::DotfilesMode;

use crate::clock::ago;
use crate::clock::duration;
use crate::clock::now_ms;
use crate::dispatcher;
use crate::dispatcher::connect;
use crate::dispatcher::require;

pub const LOG: &str = "warn";

#[derive(Args)]
pub struct DotfilesArgs {
    #[command(subcommand)]
    command: Option<DotfilesCommand>,
}

#[derive(Subcommand)]
enum DotfilesCommand {
    /// The configured dotfiles repository and how each Host stands (the default).
    Status(OutputArgs),
    /// Configure the git repository the Dispatcher pulls dotfiles from, then fetch and sync
    /// connected Hosts.
    Set(SetArgs),
    /// Remove the dotfiles configuration and have synced Hosts unlink weave-managed symlinks.
    Clear(OutputArgs),
    /// Fetch from git now and sync all connected Hosts.
    Sync(OutputArgs),
    /// Override one Host's dotfiles mode (`auto`, `sync`, `local`, or `off`).
    Host(HostArgs),
}

#[derive(Args, Default)]
struct OutputArgs {
    /// Print the response as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct SetArgs {
    /// Git repository URL to pull dotfiles from (such as `https://github.com/owner/.dotfiles.git`).
    repo: String,
    /// Branch to track (`main` by default).
    #[arg(long)]
    branch: Option<String>,
    /// Name of a `token` credential in `weave credentials` for fetching a private repository.
    #[arg(long, conflicts_with = "clear_git_credential")]
    git_credential: Option<String>,
    /// Detach the git credential so the repository is fetched anonymously.
    #[arg(long)]
    clear_git_credential: bool,
    /// How often the Dispatcher checks `git ls-remote` (such as `60s`, `5m`, or `0` to disable).
    #[arg(long)]
    poll: Option<String>,
    /// Print the response as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Clone, Copy, ValueEnum)]
enum ModeArg {
    /// Local authoring checkout if one matching the repo exists under `$HOME`, otherwise sync.
    Auto,
    /// Always sync managed files into `$HOME` via file-level symlinks.
    Sync,
    /// Authoring Host: leave its local checkout untouched and report its state.
    Local,
    /// Do not sync; unlink any symlinks weave previously placed on this Host.
    Off,
}

impl From<ModeArg> for DotfilesMode {
    fn from(mode: ModeArg) -> Self {
        match mode {
            ModeArg::Auto => Self::Auto,
            ModeArg::Sync => Self::Sync,
            ModeArg::Local => Self::Local,
            ModeArg::Off => Self::Off,
        }
    }
}

#[derive(Args)]
struct HostArgs {
    /// The Host to configure, by id or name.
    host: String,
    #[arg(long, value_enum)]
    mode: ModeArg,
    /// Print the response as JSON.
    #[arg(long)]
    json: bool,
}

pub async fn command(args: DotfilesArgs) -> anyhow::Result<ExitCode> {
    let dispatcher = connect(&dispatcher::paths()?).await?;
    let done = async {
        require(&dispatcher, DOTFILES_FEATURE, "dotfiles")?;
        let (status, json) = match args
            .command
            .unwrap_or_else(|| DotfilesCommand::Status(OutputArgs::default()))
        {
            DotfilesCommand::Status(OutputArgs { json }) => {
                let status = dispatcher
                    .send(DotfilesStatusRequest {})
                    .await
                    .map_err(said)?;
                (status, json)
            }
            DotfilesCommand::Set(args) => {
                let poll_interval_secs = match args.poll.as_deref() {
                    Some(text) => Some(parse_poll_secs(text)?),
                    None => None,
                };
                let git_credential = if args.clear_git_credential {
                    Some(None)
                } else {
                    args.git_credential.map(Some)
                };
                let status = dispatcher
                    .send(SetDotfilesRequest {
                        repo: args.repo,
                        branch: args.branch,
                        git_credential,
                        poll_interval_secs,
                    })
                    .await
                    .map_err(said)?;
                (status, args.json)
            }
            DotfilesCommand::Clear(OutputArgs { json }) => {
                let status = dispatcher
                    .send(ClearDotfilesRequest {})
                    .await
                    .map_err(said)?;
                (status, json)
            }
            DotfilesCommand::Sync(OutputArgs { json }) => {
                let status = dispatcher
                    .send(SyncDotfilesRequest {})
                    .await
                    .map_err(said)?;
                (status, json)
            }
            DotfilesCommand::Host(args) => {
                let status = dispatcher
                    .send(SetDotfilesHostRequest {
                        host: args.host,
                        mode: args.mode.into(),
                    })
                    .await
                    .map_err(said)?;
                (status, args.json)
            }
        };
        if json {
            println!("{}", serde_json::to_string_pretty(&status)?);
        } else {
            print!("{}", describe(&status, now_ms()));
        }
        Ok::<(), anyhow::Error>(())
    }
    .await;
    dispatcher.shutdown().await;
    done?;
    Ok(ExitCode::SUCCESS)
}

fn said(error: agent_client_protocol::Error) -> anyhow::Error {
    if let Some(detail) = error.data.as_ref().and_then(serde_json::Value::as_str) {
        anyhow::anyhow!("{detail}")
    } else {
        anyhow::anyhow!("{}", error.message)
    }
}

/// Parse a poll interval like `60s`, `2m`, `1h`, `0`, or plain seconds `60`.
fn parse_poll_secs(text: &str) -> anyhow::Result<u64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        bail!("poll interval can't be empty");
    }
    let (digits, mult) = if let Some(n) = trimmed.strip_suffix('s') {
        (n, 1u64)
    } else if let Some(n) = trimmed.strip_suffix('m') {
        (n, 60u64)
    } else if let Some(n) = trimmed.strip_suffix('h') {
        (n, 3600u64)
    } else {
        (trimmed, 1u64)
    };
    let count: u64 = digits
        .parse()
        .map_err(|_| anyhow::anyhow!("{text:?} isn't a duration (try 60s, 5m, 1h, or 0)"))?;
    count
        .checked_mul(mult)
        .ok_or_else(|| anyhow::anyhow!("poll interval {text:?} is too large"))
}

fn short_sha(sha: &str) -> &str {
    &sha[..sha.len().min(8)]
}

fn describe(status: &DotfilesStatus, now: u64) -> String {
    let mut out = String::new();
    let settings = &status.settings;
    match &settings.repo {
        Some(repo) => {
            let label = settings.remote.as_deref().unwrap_or(repo.as_str());
            let _ = writeln!(out, "repo:       {label} ({})", settings.branch);
            if settings.remote.is_some() && settings.remote.as_deref() != Some(repo.as_str()) {
                let _ = writeln!(out, "url:        {repo}");
            }
            if let Some(cred) = &settings.git_credential {
                let _ = writeln!(out, "credential: {cred}");
            }
            let poll = if settings.poll_interval_secs == 0 {
                "off".to_owned()
            } else {
                duration(settings.poll_interval_secs.saturating_mul(1000))
            };
            let _ = writeln!(out, "poll:       {poll}");
            match (&settings.commit, settings.fetched_at) {
                (Some(commit), Some(at)) => {
                    let _ = writeln!(
                        out,
                        "commit:     {} (fetched {} ago)",
                        short_sha(commit),
                        ago(now, at)
                    );
                }
                (Some(commit), None) => {
                    let _ = writeln!(out, "commit:     {}", short_sha(commit));
                }
                (None, _) => {
                    let _ = writeln!(out, "commit:     not fetched yet");
                }
            }
            if let Some(error) = &settings.fetch_error {
                let _ = writeln!(out, "error:      {error}");
            }
        }
        None => {
            let _ = writeln!(
                out,
                "No dotfiles repository configured. Run `weave dotfiles set <repo>` to set one."
            );
        }
    }

    if status.hosts.is_empty() {
        return out;
    }
    let _ = writeln!(out);
    let name_width = status
        .hosts
        .iter()
        .map(|host| host.host_name.len())
        .max()
        .unwrap_or(4)
        .max(4);
    for host in &status.hosts {
        format_host(&mut out, host, name_width, now);
    }
    out
}

fn format_host(out: &mut String, host: &DotfilesHostStatus, name_width: usize, now: u64) {
    let mode_label = match host.active_mode {
        Some(DotfilesActiveMode::Synced) => "synced",
        Some(DotfilesActiveMode::Local) => "local",
        Some(DotfilesActiveMode::Off) => "off",
        None if !host.connected => "offline",
        None => "pending",
    };
    let mut details = Vec::new();
    match host.active_mode {
        Some(DotfilesActiveMode::Local) => {
            if let Some(path) = &host.local_path {
                details.push(path.clone());
            }
            if let Some(commit) = &host.commit {
                details.push(format!("@ {}", short_sha(commit)));
            }
            let mut flags = Vec::new();
            if let Some(ahead) = host.ahead
                && ahead > 0
            {
                flags.push(format!("{ahead} ahead"));
            }
            if host.dirty {
                flags.push("dirty".to_owned());
            }
            if !flags.is_empty() {
                details.push(format!("({})", flags.join(", ")));
            }
        }
        Some(DotfilesActiveMode::Synced) => {
            if let Some(commit) = &host.commit {
                details.push(short_sha(commit).to_owned());
            }
            details.push(format!("{} linked", host.linked));
            if !host.conflicts.is_empty() {
                details.push(format!("{} conflict(s)", host.conflicts.len()));
            }
            if let Some(at) = host.synced_at {
                details.push(format!("{} ago", ago(now, at)));
            }
        }
        Some(DotfilesActiveMode::Off) if host.removed > 0 => {
            details.push(format!("{} unlinked", host.removed));
        }
        Some(DotfilesActiveMode::Off) | None => {}
    }
    if host.configured_mode != DotfilesMode::Auto {
        details.push(format!("[mode={}]", host.configured_mode.as_str()));
    }
    if !host.connected && host.active_mode.is_some() {
        details.push("[offline]".to_owned());
    }
    if let Some(error) = &host.error {
        details.push(format!("error: {error}"));
    }

    let _ = writeln!(
        out,
        "{:<name_width$}  {:<7}  {}",
        host.host_name,
        mode_label,
        details.join(" ")
    );
    for conflict in &host.conflicts {
        let _ = writeln!(out, "  conflict: {} — {}", conflict.path, conflict.reason);
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn parses_poll_intervals() {
        assert_eq!(parse_poll_secs("60").expect("plain"), 60);
        assert_eq!(parse_poll_secs("60s").expect("secs"), 60);
        assert_eq!(parse_poll_secs("5m").expect("mins"), 300);
        assert_eq!(parse_poll_secs("1h").expect("hours"), 3600);
        assert_eq!(parse_poll_secs("0").expect("zero"), 0);
        assert!(parse_poll_secs("bad").is_err());
    }
}
