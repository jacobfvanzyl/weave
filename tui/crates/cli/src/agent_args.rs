//! Agent selection and session options shared by every subcommand.

use std::path::PathBuf;

use anyhow::Context;
use anyhow::bail;
use clap::Args;
use weave_acp_core::AgentSpec;
use weave_acp_core::ClientOptions;

use crate::config::Config;
use crate::registry;

#[derive(Args)]
pub struct AgentArgs {
    /// Agent to launch: a preset (claude, codex, gemini), one defined in the config file, or
    /// an ACP registry agent's id (`weave agents` lists them).
    #[arg(long, conflicts_with = "command")]
    agent: Option<String>,

    /// A custom agent command and its arguments, given after `--`.
    #[arg(last = true)]
    command: Vec<String>,

    /// Session working directory. Defaults to the current directory.
    #[arg(long)]
    cwd: Option<PathBuf>,

    /// An extra workspace root for the session; repeatable. Needs agent support.
    #[arg(long = "add-dir", value_name = "DIR")]
    add_dirs: Vec<PathBuf>,

    /// Append a protocol trace to this file, viewable with agent-client-protocol-trace-viewer.
    #[arg(long)]
    trace: Option<PathBuf>,

    /// Config file. Defaults to ~/.config/weave/tui.toml.
    #[arg(long)]
    config: Option<PathBuf>,

    /// Don't offer the agent fs/read_text_file and fs/write_text_file.
    #[arg(long)]
    no_fs: bool,

    /// Don't offer the agent terminals for running commands.
    #[arg(long)]
    no_terminal: bool,
}

/// Everything needed to launch the agent and set up its sessions.
pub struct Launch {
    pub config: Config,
    pub spec: AgentSpec,
    pub options: ClientOptions,
    pub cwd: PathBuf,
    pub additional_directories: Vec<PathBuf>,
    pub trace: Option<PathBuf>,
}

impl AgentArgs {
    pub async fn launch(&self) -> anyhow::Result<Launch> {
        let config = Config::load(self.config.as_deref())?;
        let (spec, mut options) = match (&self.agent, self.command.split_first()) {
            (Some(id), _) => resolve(&config, id).await?,
            (None, Some((command, rest))) => {
                (AgentSpec::new(command, rest), ClientOptions::default())
            }
            (None, None) => match &config.default_agent {
                Some(id) => resolve(&config, id).await?,
                None => {
                    let known = weave_acp_core::preset_ids().collect::<Vec<_>>().join(", ");
                    bail!(
                        "choose an agent with --agent ({known}), give a command after `--`, \
                         or set default_agent in the config file"
                    )
                }
            },
        };
        if self.no_fs {
            options.read_files = false;
            options.write_files = false;
        }
        if self.no_terminal {
            options.terminals = false;
        }
        let additional_directories = self
            .add_dirs
            .iter()
            .map(|dir| {
                dir.canonicalize()
                    .with_context(|| format!("directory {}", dir.display()))
            })
            .collect::<anyhow::Result<_>>()?;
        Ok(Launch {
            config,
            spec,
            options,
            cwd: self.cwd()?,
            additional_directories,
            trace: self.trace.clone(),
        })
    }

    /// The absolute session directory ACP requires.
    fn cwd(&self) -> anyhow::Result<PathBuf> {
        let cwd = match &self.cwd {
            Some(cwd) => cwd.clone(),
            None => std::env::current_dir()?,
        };
        cwd.canonicalize()
            .with_context(|| format!("session directory {}", cwd.display()))
    }
}

/// The agent `id` names: one the config defines, a preset, or else an ACP registry agent,
/// with the config's settings for that name applied.
async fn resolve(config: &Config, id: &str) -> anyhow::Result<(AgentSpec, ClientOptions)> {
    if let Some(spec) = config.local_agent(id) {
        return Ok(config.configure(id, spec));
    }
    let cache = registry::Cache::default_location()?;
    let loaded = registry::load(&cache, false).await?;
    if let Some(warning) = &loaded.warning {
        eprintln!("weave: {warning}");
    }
    let Some(agent) = loaded.registry.find(id) else {
        bail!(
            "unknown agent {id:?}: not one of {} or in the ACP registry (`weave agents` lists \
             them); or give a command after `--`",
            config.known_agents().join(", ")
        );
    };
    let spec = registry::agent_spec(&cache, agent).await?;
    Ok(config.configure(id, spec))
}
