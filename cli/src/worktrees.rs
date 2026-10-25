//! `weave worktrees`: what worktrunk asks the weave Host before it removes a worktree, and
//! adding that question to worktrunk's hooks (ADR 0019). A worktrunk `pre-remove` hook that
//! fails stops the removal, so `wt remove`, `wt merge` and `wt step prune` leave a worktree be
//! while one of its sessions runs a turn or waits on a person, as the Host's own
//! `worktrees/remove` does.

use std::path::Path;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use anyhow::Context;
use anyhow::bail;
use clap::Args;
use clap::Subcommand;
use weave_host_protocol::errors;
use weave_host_protocol::worktrees::FEATURE;
use weave_host_protocol::worktrees::ReleaseWorktreeRequest;

use crate::daemon::control;
use crate::daemon::paths;

/// The hook's name among worktrunk's `pre-remove` hooks.
const HOOK_NAME: &str = "weave";
/// What the hook runs, in the worktree being removed.
const HOOK_COMMAND: &str = "weave worktrees pre-remove";
/// How long the Host may take to close a worktree's sessions.
const RELEASE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Args)]
pub struct WorktreesArgs {
    #[command(subcommand)]
    command: WorktreesCommand,
}

#[derive(Subcommand)]
enum WorktreesCommand {
    /// Before a worktree is removed: fail while a thread in it runs a turn or waits on you,
    /// otherwise close its threads. worktrunk runs it as a pre-remove hook in the worktree it
    /// removes (`weave worktrees install-hook`).
    PreRemove {
        /// The worktree; the current directory when absent.
        path: Option<PathBuf>,
    },
    /// Have worktrunk ask the weave Host before it removes a worktree: adds
    /// `weave worktrees pre-remove` to the pre-remove hooks in worktrunk's user config.
    InstallHook {
        /// worktrunk's user config. Defaults to $XDG_CONFIG_HOME/worktrunk/config.toml, else
        /// ~/.config/worktrunk/config.toml.
        #[arg(long)]
        config: Option<PathBuf>,
    },
}

pub async fn command(args: WorktreesArgs) -> anyhow::Result<ExitCode> {
    match args.command {
        WorktreesCommand::PreRemove { path } => {
            let path = match path {
                Some(path) => path,
                None => std::env::current_dir().context("the current directory")?,
            };
            pre_remove(&path).await
        }
        WorktreesCommand::InstallHook { config } => {
            let config = match config {
                Some(config) => config,
                None => worktrunk_config()?,
            };
            install_hook(&config).map(|()| ExitCode::SUCCESS)
        }
    }
}

/// Ask a running Host to let the worktree at `path` go. With no Host running, no session is
/// open, so nothing stands in the way.
async fn pre_remove(path: &Path) -> anyhow::Result<ExitCode> {
    let paths = paths()?;
    let Some(connection) = control(&paths).await? else {
        return Ok(ExitCode::SUCCESS);
    };
    if !connection
        .hello()
        .features
        .iter()
        .any(|feature| feature == FEATURE)
    {
        eprintln!(
            "weave: this weave Host can't say whether threads use {}; `weave daemon restart` \
             runs one that can",
            path.display()
        );
        connection.shutdown().await;
        return Ok(ExitCode::SUCCESS);
    }
    let released = tokio::time::timeout(
        RELEASE_TIMEOUT,
        connection.send(ReleaseWorktreeRequest {
            path: path.to_path_buf(),
        }),
    )
    .await;
    connection.shutdown().await;
    match released {
        Ok(Ok(released)) => {
            match released.closed.len() {
                0 => {}
                1 => eprintln!("weave: closed the thread in {}", path.display()),
                count => eprintln!("weave: closed the {count} threads in {}", path.display()),
            }
            Ok(ExitCode::SUCCESS)
        }
        Ok(Err(error)) if errors::is(&error, errors::WORKTREE_BUSY) => {
            eprintln!(
                "weave: {}. Let it finish or stop it (`weave threads cancel <id>`) first.",
                error.message
            );
            Ok(ExitCode::FAILURE)
        }
        Ok(Err(error)) => Err(error).context("asking the weave Host about the worktree"),
        Err(_) => bail!("the weave Host took too long to close the worktree's threads"),
    }
}

/// Where worktrunk keeps its user config.
fn worktrunk_config() -> anyhow::Result<PathBuf> {
    let base = match std::env::var_os("XDG_CONFIG_HOME").filter(|dir| !dir.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => std::env::var_os("HOME")
            .filter(|home| !home.is_empty())
            .map(PathBuf::from)
            .context("no home directory for worktrunk's config; pass --config")?
            .join(".config"),
    };
    Ok(base.join("worktrunk/config.toml"))
}

fn install_hook(config: &Path) -> anyhow::Result<()> {
    let text = match std::fs::read_to_string(config) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(error).with_context(|| format!("reading {}", config.display()));
        }
    };
    match with_hook(&text).with_context(|| format!("adding the hook to {}", config.display()))? {
        None => println!(
            "worktrunk already asks the weave Host before it removes a worktree ({}).",
            config.display()
        ),
        Some(hooked) => {
            if let Some(dir) = config.parent() {
                std::fs::create_dir_all(dir)
                    .with_context(|| format!("creating {}", dir.display()))?;
            }
            std::fs::write(config, hooked)
                .with_context(|| format!("writing {}", config.display()))?;
            println!(
                "Added to {}:\n\n[pre-remove]\n{HOOK_NAME} = \"{HOOK_COMMAND}\"\n\n\
                 wt remove, wt merge and wt step prune now ask the weave Host first, and stop \
                 while a thread in the worktree runs a turn or waits on you; otherwise its \
                 threads close. The hook needs `weave` on the PATH worktrunk runs hooks with; \
                 --no-hooks skips it.",
                config.display()
            );
        }
    }
    Ok(())
}

/// `text`, a worktrunk user config, with the hook among its `pre-remove` hooks; none when it
/// has it already. Everything else is left as written.
fn with_hook(text: &str) -> anyhow::Result<Option<String>> {
    let parsed: toml::Table = toml::from_str(text).context("it isn't valid TOML")?;
    let line = format!("{HOOK_NAME} = \"{HOOK_COMMAND}\"");
    let hooked = match parsed.get("pre-remove") {
        None => {
            let mut hooked = text.to_owned();
            if !hooked.is_empty() {
                if !hooked.ends_with('\n') {
                    hooked.push('\n');
                }
                hooked.push('\n');
            }
            hooked.push_str(&format!("[pre-remove]\n{line}\n"));
            hooked
        }
        Some(toml::Value::Table(hooks)) => match hooks.get(HOOK_NAME) {
            Some(toml::Value::String(command)) if command == HOOK_COMMAND => return Ok(None),
            Some(_) => bail!(
                "its pre-remove hooks have a `{HOOK_NAME}` of their own; add `{HOOK_COMMAND}` \
                 under another name"
            ),
            None => {
                let Some(header) = text.lines().position(|line| line.trim() == "[pre-remove]")
                else {
                    bail!("its pre-remove hooks aren't a [pre-remove] table; add `{line}` to them");
                };
                let mut lines: Vec<&str> = text.lines().collect();
                lines.insert(header + 1, &line);
                let mut hooked = lines.join("\n");
                hooked.push('\n');
                hooked
            }
        },
        Some(_) => bail!("its pre-remove hook is a single command; make it a [pre-remove] table"),
    };
    let check: toml::Table = toml::from_str(&hooked).context("the hook wouldn't fit")?;
    let added = check
        .get("pre-remove")
        .and_then(|hooks| hooks.get(HOOK_NAME))
        .and_then(toml::Value::as_str);
    if added != Some(HOOK_COMMAND) {
        bail!("the hook wouldn't fit; add `{line}` under [pre-remove]");
    }
    Ok(Some(hooked))
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn the_hook_joins_worktrunks_pre_remove_hooks_and_leaves_the_rest_as_written() {
        let line = "weave = \"weave worktrees pre-remove\"";
        // A config without pre-remove hooks gets a table of them.
        assert_eq!(
            with_hook("").ok().flatten(),
            Some(format!("[pre-remove]\n{line}\n"))
        );
        let theirs = "# mine\n[post-remove]\ntmux = \"~/bin/cleanup {{ branch }}\"";
        assert_eq!(
            with_hook(theirs).ok().flatten(),
            Some(format!("{theirs}\n\n[pre-remove]\n{line}\n"))
        );
        // One with them gets one more, first.
        let hooks = "[pre-remove]\nbackup = \"cp -r . /tmp/x\"\n\n[post-start]\nnpm = \"npm ci\"\n";
        assert_eq!(
            with_hook(hooks).ok().flatten(),
            Some(format!(
                "[pre-remove]\n{line}\nbackup = \"cp -r . /tmp/x\"\n\n[post-start]\nnpm = \"npm ci\"\n"
            ))
        );
        // Again, it changes nothing.
        let hooked = with_hook(hooks).ok().flatten().expect("hooked");
        assert!(with_hook(&hooked).is_ok_and(|again| again.is_none()));
    }

    #[test]
    fn configs_the_hook_cant_join_are_left_alone() {
        for config in [
            "[pre-remove]\nweave = \"something else\"\n",
            "pre-remove = \"cp -r . /tmp/x\"\n",
            "pre-remove = { backup = \"cp -r . /tmp/x\" }\n",
            "not toml",
        ] {
            assert!(with_hook(config).is_err(), "{config}");
        }
    }
}
