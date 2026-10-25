//! `weave update`: move the presets' adapters to their newest releases and refresh the ACP
//! registry's catalog for the registry agents in use, after checking that each new version
//! starts. Newer preset versions go in `agents.lock` beside the config, which every launch
//! reads, so the next session uses them (WVE-92). The work is `weave_agents::update`'s, which
//! the Host's `agents/update` shares; this is its command line and report.
//!
//! It's made for update scripts: it never prompts, `--dry-run` writes nothing, `--json` prints
//! the report as JSON, and the exit status is 1 when a lookup or a check failed.

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::Context;
use clap::Args;
use weave_agents::Config;
use weave_agents::registry::Cache;
use weave_agents::update::Network;
use weave_agents::update::Outcome;
use weave_agents::update::Report;
use weave_agents::update::Request;
use weave_agents::update::Starts;

#[derive(Args)]
pub struct UpdateArgs {
    /// Only these agents. By default, every preset and the registry agents the config names.
    agents: Vec<String>,

    /// Say what would change, and change nothing.
    #[arg(long)]
    dry_run: bool,

    /// Go back to weave's built-in preset versions.
    #[arg(long)]
    reset: bool,

    /// Print the report as JSON.
    #[arg(long)]
    json: bool,

    /// Config file. Defaults to ~/.config/weave/config.toml; the lock is beside it.
    #[arg(long)]
    config: Option<PathBuf>,
}

pub async fn command(args: UpdateArgs) -> anyhow::Result<ExitCode> {
    let loaded = Config::load(args.config.as_deref())?;
    let lock_path = loaded
        .lock_path
        .context("no config directory to keep agents.lock in: set HOME or XDG_CONFIG_HOME")?;
    let cache = Cache::default_location()?;
    let request = Request {
        agents: args.agents.clone(),
        dry_run: args.dry_run,
        reset: args.reset,
    };
    let report = weave_agents::update::update(
        &request,
        &loaded.config,
        &lock_path,
        &cache,
        &Network,
        &Starts,
    )
    .await?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        print!("{}", describe(&report));
    }
    Ok(if report.failed() {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    })
}

/// The report as `weave update` prints it.
fn describe(report: &Report) -> String {
    let id_width = report
        .agents
        .iter()
        .map(|entry| entry.agent.len())
        .max()
        .unwrap_or(0);
    let package_width = report
        .agents
        .iter()
        .map(|entry| entry.package.as_deref().unwrap_or("ACP registry").len())
        .max()
        .unwrap_or(0);
    let mut out = String::new();
    for entry in &report.agents {
        let versions = match (&entry.from, &entry.to) {
            (Some(from), Some(to)) => format!("{from} → {to}"),
            (Some(from), None) => from.clone(),
            (None, Some(to)) => format!("→ {to}"),
            (None, None) => String::new(),
        };
        let outcome = match entry.outcome {
            Outcome::Current => "up to date",
            Outcome::WouldUpdate => "would update",
            Outcome::Updated => "updated",
            Outcome::WouldReset => "would go back",
            Outcome::Reset => "back to built-in",
            Outcome::Skipped => "skipped",
            Outcome::Failed => "failed",
        };
        let mut line = format!(
            "{:id_width$}  {:package_width$}  {versions:16}  {outcome}",
            entry.agent,
            entry.package.as_deref().unwrap_or("ACP registry"),
        );
        if let Some(cli) = &entry.cli {
            line.push_str(&match cli.as_str() {
                "bundled" => " · runs its bundled CLI".to_owned(),
                path => format!(" · runs {path}"),
            });
        }
        if let Some(note) = &entry.note {
            line.push_str(&format!(": {note}"));
        }
        out.push_str(line.trim_end());
        out.push('\n');
    }
    if let Some(catalog) = &report.catalog {
        let outcome = match catalog.outcome {
            Outcome::WouldUpdate => "would refresh",
            Outcome::Updated => "refreshed",
            _ => "couldn't refresh",
        };
        out.push_str(&format!("ACP registry catalog: {outcome}"));
        if let Some(note) = &catalog.note {
            out.push_str(&format!(": {note}"));
        }
        out.push('\n');
    }
    let changed = report
        .agents
        .iter()
        .any(|entry| matches!(entry.outcome, Outcome::Updated | Outcome::Reset));
    if report.dry_run {
        out.push_str("Dry run: nothing changed.\n");
    } else if changed {
        out.push_str("New threads use these. Open threads keep theirs until they close, or /update moves them.\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use weave_agents::update::CatalogEntry;
    use weave_agents::update::Entry;
    use weave_agents::update::Source;

    use super::*;

    fn entry(agent: &str, from: &str, to: Option<&str>, outcome: Outcome) -> Entry {
        Entry {
            agent: agent.to_owned(),
            source: Source::Preset,
            package: Some(format!("@acp/{agent}-acp")),
            from: Some(from.to_owned()),
            to: to.map(str::to_owned),
            outcome,
            note: None,
            cli: None,
        }
    }

    #[test]
    fn the_report_lines_up_and_says_what_changed() {
        let mut codex = entry("codex", "2.1.1", Some("2.2.2"), Outcome::Failed);
        codex.cli = Some("/opt/codex".to_owned());
        codex.note = Some("2.2.2 doesn't start, so 2.1.1 stays: it exited".to_owned());
        let mut claude = entry("claude", "0.86.0", Some("0.93.0"), Outcome::Updated);
        claude.cli = Some("bundled".to_owned());
        let report = Report {
            agents: vec![
                claude,
                codex,
                entry("gemini", "0.63.0", None, Outcome::Current),
            ],
            catalog: Some(CatalogEntry {
                outcome: Outcome::Updated,
                note: None,
            }),
            dry_run: false,
        };
        assert_eq!(
            describe(&report),
            "claude  @acp/claude-acp  0.86.0 → 0.93.0   updated · runs its bundled CLI\n\
             codex   @acp/codex-acp   2.1.1 → 2.2.2     failed · runs /opt/codex: 2.2.2 doesn't start, so 2.1.1 stays: it exited\n\
             gemini  @acp/gemini-acp  0.63.0            up to date\n\
             ACP registry catalog: refreshed\n\
             New threads use these. Open threads keep theirs until they close, or /update moves them.\n"
        );
        let dry = Report {
            agents: vec![entry(
                "claude",
                "0.86.0",
                Some("0.93.0"),
                Outcome::WouldUpdate,
            )],
            catalog: None,
            dry_run: true,
        };
        assert!(describe(&dry).ends_with("would update\nDry run: nothing changed.\n"));
    }
}
