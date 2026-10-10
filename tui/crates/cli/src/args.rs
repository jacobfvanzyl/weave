//! The argument groups commands share: which agent, the workspace it works in, which
//! session, and what a headless turn may do without asking.

use std::path::PathBuf;

use anyhow::Context;
use anyhow::bail;
use clap::Args;
use weave_acp_core::AgentSpec;
use weave_acp_core::ClientOptions;
pub use weave_acp_core::daemon_protocol::AgentChoice;
use weave_acp_core::schema::ToolKind;

use crate::config::Config;
use crate::registry;
use crate::start::StartMode;

/// Which agent, for every command that talks to one.
#[derive(Args)]
pub struct AgentArgs {
    /// Agent to launch: a preset (claude, codex, gemini), one defined in the config file, or
    /// an ACP registry agent's id (`weave agents` lists them).
    #[arg(long, conflicts_with = "command")]
    agent: Option<String>,

    /// A custom agent command and its arguments, given after `--`.
    #[arg(last = true)]
    command: Vec<String>,

    /// Append a protocol trace of the agent to this file, viewable with
    /// agent-client-protocol-trace-viewer. In the daemon, from when this weave attaches.
    #[arg(long)]
    trace: Option<PathBuf>,

    /// Config file. Defaults to ~/.config/weave/tui.toml.
    #[arg(long)]
    config: Option<PathBuf>,
}

/// Where a session works, and what the agent may use there.
#[derive(Args, Default)]
pub struct WorkspaceArgs {
    /// Session working directory. Defaults to the current directory.
    #[arg(long)]
    cwd: Option<PathBuf>,

    /// An extra workspace root for the session; repeatable. Needs agent support.
    #[arg(long = "add-dir", value_name = "DIR")]
    add_dirs: Vec<PathBuf>,

    /// Don't offer the agent fs/read_text_file and fs/write_text_file.
    #[arg(long)]
    no_fs: bool,

    /// Don't offer the agent terminals for running commands.
    #[arg(long)]
    no_terminal: bool,
}

/// Which session to open.
#[derive(Args)]
pub struct SessionArgs {
    /// Reopen a session: by id, or (in the TUI) choose one from a list when no id is given.
    #[arg(long, value_name = "SESSION_ID", num_args = 0..=1, conflicts_with = "continue_last")]
    resume: Option<Option<String>>,

    /// Reopen the session last used in this directory (one open in the daemon first), with
    /// the agent last used here unless --agent or `--` names one.
    #[arg(long = "continue")]
    continue_last: bool,
}

impl SessionArgs {
    pub fn mode(&self) -> StartMode {
        match (&self.resume, self.continue_last) {
            (Some(Some(id)), _) => StartMode::Resume(id.clone().into()),
            (Some(None), _) => StartMode::Pick,
            (None, true) => StartMode::Continue,
            (None, false) => StartMode::New,
        }
    }
}

/// What a headless turn may do without asking: nobody is there to.
#[derive(Args)]
pub struct ApproveArgs {
    /// Tool kinds to allow, comma-separated: read, edit, delete, move, search, execute,
    /// think, fetch, switch_mode, other; or all. Everything else is rejected.
    #[arg(long, value_delimiter = ',', value_name = "KINDS")]
    approve: Vec<String>,
}

impl ApproveArgs {
    pub fn kinds(&self) -> anyhow::Result<Vec<ToolKind>> {
        let mut kinds = Vec::new();
        for name in &self.approve {
            match name.trim() {
                "all" => kinds.extend(ALL_KINDS.iter().map(|(_, kind)| *kind)),
                name => match ALL_KINDS.iter().find(|(known, _)| *known == name) {
                    Some((_, kind)) => kinds.push(*kind),
                    None => bail!(
                        "unknown tool kind {name:?}; expected some of {}, or all",
                        ALL_KINDS
                            .iter()
                            .map(|(name, _)| *name)
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                },
            }
        }
        kinds.dedup();
        Ok(kinds)
    }
}

/// ACP's tool kinds by their protocol names.
const ALL_KINDS: [(&str, ToolKind); 10] = [
    ("read", ToolKind::Read),
    ("edit", ToolKind::Edit),
    ("delete", ToolKind::Delete),
    ("move", ToolKind::Move),
    ("search", ToolKind::Search),
    ("execute", ToolKind::Execute),
    ("think", ToolKind::Think),
    ("fetch", ToolKind::Fetch),
    ("switch_mode", ToolKind::SwitchMode),
    ("other", ToolKind::Other),
];

/// The command that reopens `session_id` with `agent`.
pub fn reopen_command(agent: &AgentChoice, session_id: &str) -> String {
    let words: Vec<String> = match agent {
        AgentChoice::Named(id) => ["weave", "--agent", id, "--resume", session_id]
            .map(str::to_owned)
            .to_vec(),
        AgentChoice::Command(command) => ["weave", "--resume", session_id, "--"]
            .map(str::to_owned)
            .into_iter()
            .chain(command.iter().cloned())
            .collect(),
    };
    shell_words(&words)
}

/// `words` as a shell command line.
pub fn shell_words(words: &[String]) -> String {
    words
        .iter()
        .map(|word| shell_quote(word))
        .collect::<Vec<_>>()
        .join(" ")
}

fn shell_quote(word: &str) -> String {
    let plain = !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:=@%+,".contains(c));
    if plain {
        word.to_owned()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

/// Everything needed to launch the agent and set up its sessions.
pub struct Launch {
    pub config: Config,
    /// How the agent was chosen: on the command line, as last used here, or by default.
    pub agent: AgentChoice,
    pub spec: AgentSpec,
    pub options: ClientOptions,
    pub cwd: PathBuf,
    pub additional_directories: Vec<PathBuf>,
    pub trace: Option<PathBuf>,
}

impl Launch {
    /// The mode new sessions start in, from the chosen agent's config.
    pub fn default_mode(&self) -> Option<&str> {
        match &self.agent {
            AgentChoice::Named(id) => self.config.mode(id),
            AgentChoice::Command(_) => None,
        }
    }
}

impl AgentArgs {
    /// The agent chosen on the command line, if one was.
    pub fn choice(&self) -> Option<AgentChoice> {
        match (&self.agent, self.command.is_empty()) {
            (Some(id), _) => Some(AgentChoice::Named(id.clone())),
            (None, false) => Some(AgentChoice::Command(self.command.clone())),
            (None, true) => None,
        }
    }

    /// The config file this command reads.
    pub fn load_config(&self) -> anyhow::Result<Config> {
        Config::load(self.config.as_deref())
    }

    /// Resolve the agent chosen on the command line (else the config's `default_agent`), to
    /// launch in `workspace`.
    pub async fn launch_here(&self, workspace: &WorkspaceArgs) -> anyhow::Result<Launch> {
        self.launch(workspace, self.choice(), None).await
    }

    /// Resolve `agent` (else the config's `default_agent`), to launch in `cwd` or else the
    /// workspace's directory, with the rest of the workspace's settings.
    pub async fn launch(
        &self,
        workspace: &WorkspaceArgs,
        agent: Option<AgentChoice>,
        cwd: Option<PathBuf>,
    ) -> anyhow::Result<Launch> {
        let config = Config::load(self.config.as_deref())?;
        let agent = match agent {
            Some(agent) => agent,
            None => match &config.default_agent {
                Some(id) => AgentChoice::Named(id.clone()),
                None => {
                    let known = weave_acp_core::preset_ids().collect::<Vec<_>>().join(", ");
                    bail!(
                        "choose an agent with --agent ({known}), give a command after `--`, \
                         or set default_agent in the config file"
                    )
                }
            },
        };
        let (spec, mut options) = match &agent {
            AgentChoice::Named(id) => resolve(&config, id).await?,
            AgentChoice::Command(words) => match words.split_first() {
                Some((command, rest)) => (AgentSpec::new(command, rest), ClientOptions::default()),
                None => bail!("an empty agent command"),
            },
        };
        if workspace.no_fs {
            options.read_files = false;
            options.write_files = false;
        }
        if workspace.no_terminal {
            options.terminals = false;
        }
        let additional_directories = workspace
            .add_dirs
            .iter()
            .map(|dir| {
                dir.canonicalize()
                    .with_context(|| format!("directory {}", dir.display()))
            })
            .collect::<anyhow::Result<_>>()?;
        Ok(Launch {
            config,
            agent,
            spec,
            options,
            cwd: match cwd {
                Some(cwd) => cwd,
                None => workspace.cwd()?,
            },
            additional_directories,
            // The daemon opens it, from its own directory.
            trace: self.trace.as_deref().map(std::path::absolute).transpose()?,
        })
    }
}

impl WorkspaceArgs {
    /// The absolute session directory ACP requires.
    pub fn cwd(&self) -> anyhow::Result<PathBuf> {
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

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn approve(kinds: &[&str]) -> ApproveArgs {
        ApproveArgs {
            approve: kinds.iter().map(|kind| (*kind).to_owned()).collect(),
        }
    }

    #[test]
    fn a_reopen_command_names_the_agent_as_it_was_chosen() {
        assert_eq!(
            reopen_command(&AgentChoice::Named("claude".into()), "s1"),
            "weave --agent claude --resume s1"
        );
        assert_eq!(
            reopen_command(
                &AgentChoice::Command(vec!["my agent".into(), "--acp".into()]),
                "s1"
            ),
            "weave --resume s1 -- 'my agent' --acp"
        );
    }

    #[test]
    fn tool_kinds_parse_by_their_protocol_names_or_all() {
        assert_eq!(
            approve(&["read", " switch_mode"]).kinds().ok(),
            Some(vec![ToolKind::Read, ToolKind::SwitchMode])
        );
        assert_eq!(
            approve(&["all"]).kinds().map(|kinds| kinds.len()).ok(),
            Some(10)
        );
        assert!(approve(&["write"]).kinds().is_err());
        assert_eq!(approve(&[]).kinds().ok(), Some(Vec::new()));
    }
}
