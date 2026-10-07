//! Agent selection and session options shared by the TUI and `smoke`.

use std::path::PathBuf;

use anyhow::Context;
use anyhow::bail;
use clap::Args;
use weave_acp_core::AgentSpec;
use weave_acp_core::ClientOptions;
use weave_acp_core::ProtocolTrace;
use weave_acp_core::preset_ids;

#[derive(Args)]
pub struct AgentArgs {
    /// Built-in agent to launch: claude, codex or gemini.
    #[arg(long, conflicts_with = "command")]
    agent: Option<String>,

    /// A custom agent command and its arguments, given after `--`.
    #[arg(last = true)]
    command: Vec<String>,

    /// Session working directory. Defaults to the current directory.
    #[arg(long)]
    cwd: Option<PathBuf>,

    /// Append every line exchanged with the agent to this JSONL file.
    #[arg(long)]
    trace: Option<PathBuf>,

    /// Don't offer the agent fs/read_text_file and fs/write_text_file.
    #[arg(long)]
    no_fs: bool,

    /// Don't offer the agent terminals for running commands.
    #[arg(long)]
    no_terminal: bool,
}

impl AgentArgs {
    pub fn spec(&self) -> anyhow::Result<AgentSpec> {
        match (&self.agent, self.command.split_first()) {
            (Some(id), _) => AgentSpec::preset(id).with_context(|| {
                let known = preset_ids().collect::<Vec<_>>().join(", ");
                format!("unknown agent {id:?}; expected one of {known}, or a command after `--`")
            }),
            (None, Some((command, rest))) => Ok(AgentSpec::new(command, rest)),
            (None, None) => {
                let known = preset_ids().collect::<Vec<_>>().join(", ");
                bail!("choose an agent with --agent ({known}) or give a command after `--`")
            }
        }
    }

    /// The absolute session directory ACP requires.
    pub fn cwd(&self) -> anyhow::Result<PathBuf> {
        let cwd = match &self.cwd {
            Some(cwd) => cwd.clone(),
            None => std::env::current_dir()?,
        };
        cwd.canonicalize()
            .with_context(|| format!("session directory {}", cwd.display()))
    }

    /// The client services to advertise.
    pub fn client_options(&self) -> ClientOptions {
        ClientOptions {
            read_files: !self.no_fs,
            write_files: !self.no_fs,
            terminals: !self.no_terminal,
        }
    }

    pub fn trace(&self) -> anyhow::Result<Option<ProtocolTrace>> {
        self.trace
            .as_deref()
            .map(|path| {
                ProtocolTrace::create(path)
                    .with_context(|| format!("creating trace {}", path.display()))
            })
            .transpose()
    }
}
