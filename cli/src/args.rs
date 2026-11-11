//! The argument groups commands share: which agent, the workspace it works in, which
//! thread, and what a headless turn may do without asking; and the prompt they're given.

use std::io::IsTerminal;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;

use anyhow::Context;
use anyhow::bail;
use clap::Args;
use serde::Deserialize;
use serde::Serialize;
use weave_acp_core::AgentSpec;
use weave_acp_core::ClientOptions;
use weave_acp_core::schema::ToolKind;
use weave_host::Withheld;

use crate::config::Config;
use crate::start::StartMode;

/// The id an in-process Host knows a custom command (`-- <command>`) by.
pub const COMMAND_AGENT: &str = "command";

/// An agent as the user chose it, by name or as a command, so it can be chosen again: what
/// `--resume <id>` reopens a thread with, and `--continue` remembers per directory.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentChoice {
    /// A preset, a config agent or a registry agent: `--agent <id>`.
    Named(String),
    /// A custom command: `-- <command>…`, which only a Host in this process runs.
    Command(Vec<String>),
}

impl AgentChoice {
    /// How it's named in messages.
    pub fn describe(&self) -> String {
        match self {
            Self::Named(id) => id.clone(),
            Self::Command(words) => words.join(" "),
        }
    }

    /// The id the Host knows it by.
    pub fn agent_id(&self) -> &str {
        match self {
            Self::Named(id) => id,
            Self::Command(_) => COMMAND_AGENT,
        }
    }
}

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
    /// agent-client-protocol-trace-viewer. Through the weave Host, which writes the trace in
    /// its own directory and says where, give it without a file.
    #[arg(long, num_args = 0..=1, default_missing_value = "")]
    trace: Option<PathBuf>,

    /// Config file. Defaults to ~/.config/weave/config.toml.
    #[arg(long)]
    config: Option<PathBuf>,
}

/// Where a thread works, and what the agent may use there.
#[derive(Args, Default)]
pub struct WorkspaceArgs {
    /// Thread working directory. Defaults to the current directory.
    #[arg(long)]
    cwd: Option<PathBuf>,

    /// An extra workspace root for the thread; repeatable. Needs agent support.
    #[arg(long = "add-dir", value_name = "DIR")]
    add_dirs: Vec<PathBuf>,

    /// Don't offer the agent fs/read_text_file and fs/write_text_file.
    #[arg(long)]
    no_fs: bool,

    /// Don't offer the agent terminals for running commands.
    #[arg(long)]
    no_terminal: bool,

    /// The directory `--project` named, on the Host the thread is on, in place of `--cwd`.
    #[arg(skip)]
    in_project: Option<PathBuf>,
}

/// Which thread to open.
#[derive(Args)]
pub struct ThreadArgs {
    /// Reopen a thread: by id, or (in the TUI) choose one from a list when no id is given.
    #[arg(long, value_name = "THREAD_ID", num_args = 0..=1, conflicts_with = "continue_last")]
    resume: Option<Option<String>>,

    /// Reopen the thread last used in this directory (one open in the daemon first), with
    /// the agent last used here unless --agent or `--` names one.
    #[arg(long = "continue")]
    continue_last: bool,
}

impl ThreadArgs {
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
        tool_kinds(&self.approve)
    }
}

/// The tool kinds `names` gives, as `--approve` takes them: by their protocol names, or all.
pub fn tool_kinds(names: &[String]) -> anyhow::Result<Vec<ToolKind>> {
    let mut kinds = Vec::new();
    for name in names {
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

/// `kinds` as `--approve` takes them: "read,edit", or "all" for every kind.
pub fn approve_words(kinds: &[ToolKind]) -> String {
    if ALL_KINDS.iter().all(|(_, kind)| kinds.contains(kind)) {
        return "all".to_owned();
    }
    kinds
        .iter()
        .map(|kind| {
            ALL_KINDS
                .iter()
                .find(|(_, known)| known == kind)
                .map_or_else(
                    || format!("{kind:?}").to_lowercase(),
                    |(name, _)| (*name).to_owned(),
                )
        })
        .collect::<Vec<_>>()
        .join(",")
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

/// The command that reopens `thread_id` with `agent`, on another computer's Host, `host`, when
/// it's there.
pub fn reopen_command(agent: &AgentChoice, thread_id: &str, host: Option<&str>) -> String {
    let on: Vec<String> = host
        .map(|host| vec!["--host".to_owned(), host.to_owned()])
        .unwrap_or_default();
    let words: Vec<String> = match agent {
        AgentChoice::Named(id) => std::iter::once("weave".to_owned())
            .chain(on)
            .chain(["--agent", id, "--resume", thread_id].map(str::to_owned))
            .collect(),
        AgentChoice::Command(command) => std::iter::once("weave".to_owned())
            .chain(on)
            .chain(["--resume", thread_id, "--"].map(str::to_owned))
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

/// What a thread through the Host is opened with.
pub struct HostLaunch {
    pub config: Config,
    /// How the agent was chosen: on the command line, as last used here, or by default.
    pub agent: AgentChoice,
    pub cwd: PathBuf,
    pub additional_directories: Vec<PathBuf>,
    /// Have the Host trace the agent's protocol.
    pub trace: bool,
}

impl HostLaunch {
    /// The id the Host knows the agent by.
    pub fn agent_id(&self) -> &str {
        self.agent.agent_id()
    }
}

/// Everything needed to launch the agent directly, outside the Host, and set up its threads:
/// for `weave agents smoke`, `login` and `logout`.
pub struct Launch {
    pub config: Config,
    pub spec: AgentSpec,
    pub options: ClientOptions,
    pub cwd: PathBuf,
    pub additional_directories: Vec<PathBuf>,
    pub trace: Option<PathBuf>,
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

    /// The config file given on the command line, for a Host in this process to read.
    pub fn config_file(&self) -> Option<PathBuf> {
        self.config.clone()
    }

    /// `agent` (else the config's `default_agent`), for a thread through the Host in `cwd`
    /// or else the workspace's directory, with the rest of the workspace's settings. The Host
    /// resolves the agent. On another computer's Host, `elsewhere`, the workspace's directories
    /// are those there ([`WorkspaceArgs::cwd_on`]).
    pub fn host_launch(
        &self,
        workspace: &WorkspaceArgs,
        agent: Option<AgentChoice>,
        cwd: Option<PathBuf>,
        elsewhere: Option<&str>,
    ) -> anyhow::Result<HostLaunch> {
        let config = Config::load(self.config.as_deref())?;
        let agent = match agent {
            Some(agent) => agent,
            None => default_agent(&config)?,
        };
        let (cwd, additional_directories) = match elsewhere {
            Some(host) => (
                cwd.map_or_else(|| workspace.cwd_on(host), Ok)?,
                workspace.additional_directories_on(host)?,
            ),
            None => (
                cwd.map_or_else(|| workspace.cwd(), Ok)?,
                workspace.additional_directories()?,
            ),
        };
        Ok(HostLaunch {
            config,
            agent,
            cwd,
            additional_directories,
            trace: self.trace.is_some(),
        })
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
            None => default_agent(&config)?,
        };
        let (spec, mut options) = match &agent {
            AgentChoice::Named(id) => resolve(&config.agents, id).await?,
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
        let additional_directories = workspace.additional_directories()?;
        Ok(Launch {
            config,
            spec,
            options,
            cwd: match cwd {
                Some(cwd) => cwd,
                None => workspace.cwd()?,
            },
            additional_directories,
            trace: self
                .trace
                .as_deref()
                .filter(|path| !path.as_os_str().is_empty())
                .map(std::path::absolute)
                .transpose()?,
        })
    }
}

/// The config's `default_agent`, else a reason to give one.
fn default_agent(config: &Config) -> anyhow::Result<AgentChoice> {
    match &config.agents.default_agent {
        Some(id) => Ok(AgentChoice::Named(id.clone())),
        None => {
            let known = weave_acp_core::preset_ids().collect::<Vec<_>>().join(", ");
            bail!("choose an agent with --agent ({known}), or set default_agent in the config file")
        }
    }
}

impl WorkspaceArgs {
    /// The extra workspace roots, as absolute paths.
    pub fn additional_directories(&self) -> anyhow::Result<Vec<PathBuf>> {
        self.add_dirs
            .iter()
            .map(|dir| {
                dir.canonicalize()
                    .with_context(|| format!("directory {}", dir.display()))
            })
            .collect()
    }

    /// What `--no-fs` and `--no-terminal` withhold from agents.
    pub fn withheld(&self) -> Withheld {
        Withheld {
            fs: self.no_fs,
            terminals: self.no_terminal,
        }
    }

    /// Work in `dir`, a Project's location on the Host the thread is on, as `--project` names
    /// it (WVE-189), in place of `--cwd`, which it can't be given with.
    pub fn in_project(&mut self, dir: PathBuf) {
        self.in_project = Some(dir);
    }

    /// The thread's directory on another computer's Host, `host` (WVE-195): a Project's
    /// location there, `--cwd`, a directory there, or else this one's, the same path under the
    /// home there (`~/…`), as the thread tools name a directory on another Host. A `--cwd` under
    /// this computer's home, as a shell expands `~/…`, is the same path under the home there
    /// too. The Host says so if there's none.
    pub fn cwd_on(&self, host: &str) -> anyhow::Result<PathBuf> {
        if let Some(dir) = &self.in_project {
            return Ok(dir.clone());
        }
        directory_on(self.cwd.as_deref(), host, "--cwd")
    }

    /// The extra workspace roots on another computer's Host, `host`: each as given when it's
    /// a whole path or under `~`, a directory there, and otherwise this computer's, the same
    /// path under the home there, as [`Self::cwd_on`] names the thread's.
    pub fn additional_directories_on(&self, host: &str) -> anyhow::Result<Vec<PathBuf>> {
        self.add_dirs
            .iter()
            .map(|dir| {
                if dir.is_absolute() || dir.starts_with("~") {
                    return there(dir, "--add-dir");
                }
                let here = dir
                    .canonicalize()
                    .with_context(|| format!("directory {}", dir.display()))?;
                under_home(&here).with_context(|| {
                    format!(
                        "{} is outside your home, so it has no counterpart on {host}: give \
                         --add-dir a whole path there",
                        here.display()
                    )
                })
            })
            .collect()
    }

    /// The absolute session directory ACP requires: a Project's location here, `--cwd`, or this
    /// directory.
    pub fn cwd(&self) -> anyhow::Result<PathBuf> {
        let cwd = match (&self.in_project, &self.cwd) {
            (Some(dir), _) | (None, Some(dir)) => dir.clone(),
            (None, None) => std::env::current_dir()?,
        };
        cwd.canonicalize()
            .with_context(|| format!("thread directory {}", cwd.display()))
    }
}

/// A directory on another computer's Host, `host`: `dir`, given with `flag`, a directory there
/// whole or under `~` (one under this computer's home is the same path under the home there),
/// or else this one's counterpart under the home there, `~/…`, which there's none of outside
/// this computer's home.
pub fn directory_on(dir: Option<&Path>, host: &str, flag: &str) -> anyhow::Result<PathBuf> {
    if let Some(dir) = dir {
        return there(dir, flag);
    }
    let here = std::env::current_dir()?;
    let here = here
        .canonicalize()
        .with_context(|| format!("directory {}", here.display()))?;
    under_home(&here).with_context(|| {
        format!(
            "{} is outside your home, so it has no counterpart on {host}: give {flag}, a \
             directory there",
            here.display()
        )
    })
}

/// `path`, given with `flag` for another computer's Host, if it names a directory there whole:
/// from its root, or under the home there, as one under this computer's home does.
fn there(path: &Path, flag: &str) -> anyhow::Result<PathBuf> {
    if path.is_absolute() {
        return Ok(under_home(path).unwrap_or_else(|| path.to_path_buf()));
    }
    if path.starts_with("~") {
        return Ok(path.to_path_buf());
    }
    bail!(
        "with --host, {flag} names a directory on that computer: give it whole, or under ~, \
         not {}",
        path.display()
    )
}

/// `path`, a directory on this computer, as the same one under the home on another: `~/…`.
fn under_home(path: &Path) -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)?;
    let home = home.canonicalize().unwrap_or(home);
    let under = path.strip_prefix(&home).ok()?;
    Some(match under.as_os_str().is_empty() {
        true => PathBuf::from("~"),
        false => Path::new("~").join(under),
    })
}

/// The agent `id` names: one the config defines, a preset, or else an ACP registry agent,
/// with the config's settings for that name applied.
async fn resolve(
    config: &weave_agents::Config,
    id: &str,
) -> anyhow::Result<(AgentSpec, ClientOptions)> {
    let cache = weave_agents::registry::Cache::default_location()?;
    let Some(resolved) = weave_agents::resolve(config, id, &cache).await? else {
        bail!(
            "{}; or give a command after `--`",
            weave_agents::unknown(config, id)
        );
    };
    if let Some(warning) = &resolved.warning {
        eprintln!("weave: {warning}");
    }
    Ok((resolved.spec, resolved.options))
}

/// The prompt from the arguments, or stdin when there are none or just `-`.
pub(crate) fn prompt_text(words: &[String]) -> anyhow::Result<String> {
    let from_stdin = words.is_empty() || words == ["-"];
    let text = if from_stdin {
        if std::io::stdin().is_terminal() {
            bail!("give a prompt, or pipe one in");
        }
        let mut text = String::new();
        std::io::stdin()
            .read_to_string(&mut text)
            .context("reading the prompt from stdin")?;
        text
    } else {
        words.join(" ")
    };
    let text = text.trim().to_owned();
    if text.is_empty() {
        bail!("the prompt is empty");
    }
    Ok(text)
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
    fn a_directory_on_another_host_is_named_under_the_home_there() {
        let home = std::env::var_os("HOME").map(PathBuf::from).expect("a home");
        let home = home.canonicalize().unwrap_or(home);
        assert_eq!(under_home(&home), Some(PathBuf::from("~")));
        assert_eq!(
            under_home(&home.join("code/weave")),
            Some(PathBuf::from("~/code/weave"))
        );
        assert_eq!(under_home(Path::new("/srv/elsewhere")), None);
        // As given, but a shell's `~/…` is the home there too.
        assert_eq!(
            there(&home.join("code"), "--cwd").ok(),
            Some(PathBuf::from("~/code"))
        );
        assert_eq!(
            there(Path::new("~/code"), "--cwd").ok(),
            Some(PathBuf::from("~/code"))
        );
        assert_eq!(
            there(Path::new("/srv/code"), "--cwd").ok(),
            Some(PathBuf::from("/srv/code"))
        );
        assert!(there(Path::new("code"), "--cwd").is_err());
    }

    #[test]
    fn a_reopen_command_names_the_agent_as_it_was_chosen() {
        assert_eq!(
            reopen_command(&AgentChoice::Named("claude".into()), "s1", None),
            "weave --agent claude --resume s1"
        );
        assert_eq!(
            reopen_command(&AgentChoice::Named("claude".into()), "s1", Some("studio")),
            "weave --host studio --agent claude --resume s1"
        );
        assert_eq!(
            reopen_command(
                &AgentChoice::Command(vec!["my agent".into(), "--acp".into()]),
                "s1",
                None
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
        // And are said back in the same words.
        assert_eq!(
            approve_words(&[ToolKind::Read, ToolKind::SwitchMode]),
            "read,switch_mode"
        );
        let all = approve(&["all"]).kinds().unwrap_or_default();
        assert_eq!(approve_words(&all), "all");
        assert_eq!(approve_words(&[]), "");
    }
}
