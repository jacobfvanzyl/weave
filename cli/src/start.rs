//! Choosing and opening the first session through the Host, signing in when the agent
//! requires it; and connecting to an agent directly, for `weave login` and `logout`.

use std::collections::BTreeMap;
use std::io::BufRead;
use std::io::IsTerminal;
use std::io::Write;
use std::path::PathBuf;

use anyhow::Context;
use anyhow::bail;
use tokio::sync::mpsc::UnboundedReceiver;
use weave_acp_core::AgentConnection;
use weave_acp_core::AgentEvent;
use weave_acp_core::AgentSpec;
use weave_acp_core::ProtocolTrace;
use weave_acp_core::is_auth_required;
use weave_acp_core::schema::AuthMethod;
use weave_acp_core::schema::AuthMethodTerminal;
use weave_acp_core::schema::Error;
use weave_acp_core::schema::InitializeResponse;
use weave_acp_core::schema::SessionId;
use weave_host::RecordedChoice;
use weave_host_client::HostConnection;
use weave_host_client::HostEvent;
use weave_host_client::HostHandle;
use weave_host_client::OpenedSession;
use weave_host_protocol::agents::AuthenticateAgentRequest;
use weave_host_protocol::agents::GetAgentRequest;
use weave_host_protocol::agents::TerminalSignInRequest;
use weave_host_protocol::sessions::AttachSessionRequest;
use weave_host_protocol::sessions::CreateSessionRequest;
use weave_host_protocol::sessions::ListSessionsRequest;

use crate::args::AgentChoice;
use crate::args::HostLaunch;
use crate::args::Launch;
use crate::args::WorkspaceArgs;
use crate::daemon;
use crate::daemon::Host;
use crate::daemon::Target;
use crate::recent::Recent;

/// The agent and directory to open a session with.
pub struct Chosen {
    /// The agent; the config's `default_agent` without one.
    pub agent: Option<AgentChoice>,
    /// The directory; the workspace's without one.
    pub cwd: Option<PathBuf>,
    /// Why, when it isn't what the command line said.
    pub note: Option<String>,
}

/// The agent and directory for `mode`. `--resume <id>` reopens the session with the agent and
/// directory it was started with, whatever `--agent` and `--cwd` say, when the Host's journal
/// records them. `--continue` without an agent uses the one last used in the directory.
/// Otherwise it's what the command line says.
pub fn choose(
    mode: &StartMode,
    explicit: Option<AgentChoice>,
    workspace: &WorkspaceArgs,
    target: &Target,
    recent: Option<&Recent>,
) -> anyhow::Result<Chosen> {
    let as_given = |agent| Chosen {
        agent,
        cwd: None,
        note: None,
    };
    match (mode, target) {
        (StartMode::Resume(session_id), Target::Shared(paths)) => {
            let Some(recorded) = weave_host::recorded_session(paths, session_id) else {
                return Ok(as_given(explicit));
            };
            let here = workspace.cwd().ok();
            let elsewhere = if here.as_ref() == Some(&recorded.cwd) {
                String::new()
            } else {
                format!(" in {}", recorded.cwd.display())
            };
            let recorded_agent = recorded.choice.as_ref().map(|choice| match choice {
                RecordedChoice::Named(id) => AgentChoice::Named(id.clone()),
                RecordedChoice::Command(words) => AgentChoice::Command(words.clone()),
            });
            let agent = recorded_agent.or(explicit.clone());
            let note = match (&agent, &explicit) {
                (Some(agent), Some(given)) if agent != given => Some(format!(
                    "Resuming {session_id} with {}, the agent it was started with (not {}){elsewhere}",
                    agent.describe(),
                    given.describe()
                )),
                (Some(agent), None) => Some(format!(
                    "Resuming {session_id} with {}{elsewhere}",
                    agent.describe()
                )),
                _ if !elsewhere.is_empty() => Some(format!("Resuming {session_id}{elsewhere}")),
                _ => None,
            };
            Ok(Chosen {
                agent,
                cwd: Some(recorded.cwd),
                note,
            })
        }
        (StartMode::Continue, _) if explicit.is_none() => {
            let remembered = match recent {
                Some(recent) => recent.last_in(&workspace.cwd()?),
                None => None,
            };
            let note = remembered.as_ref().map(|agent| {
                format!(
                    "Continuing with {}, the agent last used here",
                    agent.describe()
                )
            });
            Ok(Chosen {
                agent: remembered,
                cwd: None,
                note,
            })
        }
        _ => Ok(as_given(explicit)),
    }
}

/// Which session to start in.
pub enum StartMode {
    New,
    Resume(SessionId),
    /// The most recent session in this directory, or a new one.
    Continue,
    /// Choose in the TUI's session picker.
    Pick,
}

pub struct Started {
    pub connection: HostConnection,
    pub events: UnboundedReceiver<HostEvent>,
    /// What the agent said about itself.
    pub agent: InitializeResponse,
    pub opened: Option<OpenedSession>,
    pub notices: Vec<String>,
}

/// How many sign-in attempts to make before giving up.
const SIGN_IN_ATTEMPTS: usize = 3;

/// Launch the agent here, outside the Host, and initialize it: for signing in and out.
pub async fn connect_direct(
    launch: &Launch,
) -> anyhow::Result<(AgentConnection, UnboundedReceiver<AgentEvent>)> {
    let trace = launch
        .trace
        .as_deref()
        .map(|path| {
            ProtocolTrace::create(path)
                .with_context(|| format!("creating trace {}", path.display()))
        })
        .transpose()?;
    let (connection, events) = AgentConnection::spawn(&launch.spec, trace, launch.options).await?;
    if let Err(error) = connection.initialize().await {
        connection.shutdown().await;
        return Err(error.into());
    }
    Ok((connection, events))
}

/// Connect to the Host and open the session `mode` asks for, signing in first if the agent
/// requires it.
pub async fn start(launch: &HostLaunch, host: &Host, mode: &StartMode) -> anyhow::Result<Started> {
    let (connection, events) = host.connect(daemon::TUI).await?;
    let handle = connection.handle();
    let mut attempts = 0;
    let (opened, notices) = loop {
        match establish(&handle, launch, mode).await {
            Ok(opened) => break opened,
            Err(error) if is_auth_required(&error) && attempts < SIGN_IN_ATTEMPTS => {
                attempts += 1;
                if let Err(error) = sign_in_through(&handle, launch.agent_id(), None).await {
                    connection.shutdown().await;
                    return Err(error);
                }
            }
            Err(error) => {
                connection.shutdown().await;
                return Err(error.into());
            }
        }
    };
    let agent = match &opened {
        Some(opened) => opened.state.agent.initialize.clone(),
        None => {
            let request = GetAgentRequest {
                agent_id: launch.agent_id().to_owned(),
            };
            match handle.send(request).await {
                Ok(got) => got.initialize,
                Err(error) => {
                    connection.shutdown().await;
                    return Err(error.into());
                }
            }
        }
    };
    let mut notices = notices;
    notices.extend(launch.config.notice.clone());
    Ok(Started {
        connection,
        events,
        agent,
        opened,
        notices,
    })
}

/// Open the session `mode` asks for, and anything worth telling the user about it.
async fn establish(
    handle: &HostHandle,
    launch: &HostLaunch,
    mode: &StartMode,
) -> Result<(Option<OpenedSession>, Vec<String>), Error> {
    let create = || CreateSessionRequest {
        agent_id: launch.agent_id().to_owned(),
        cwd: launch.cwd.clone(),
        additional_directories: launch.additional_directories.clone(),
        mode: None,
        policy: None,
        trace: launch.trace,
    };
    let attach = |session_id: SessionId| AttachSessionRequest {
        session_id,
        after: None,
        agent_id: Some(launch.agent_id().to_owned()),
        cwd: Some(launch.cwd.clone()),
        trace: launch.trace,
        observe: false,
    };
    let created = async |handle: &HostHandle| {
        handle.send(create()).await.map(|state| OpenedSession {
            state,
            replay: None,
        })
    };
    let attached = async |handle: &HostHandle, session_id| {
        handle
            .send(attach(session_id))
            .await
            .map(|attached| OpenedSession {
                state: attached.state,
                replay: Some(attached.replay),
            })
    };
    match mode {
        StartMode::New => Ok((Some(created(handle).await?), Vec::new())),
        StartMode::Resume(session_id) => Ok((
            Some(attached(handle, session_id.clone()).await?),
            Vec::new(),
        )),
        StartMode::Continue => {
            // The Host lists the sessions it has here first; headless runs aren't for
            // continuing interactively, so `weave sessions` and `--resume <id>` reach those.
            let listed = handle
                .send(ListSessionsRequest {
                    agent_id: Some(launch.agent_id().to_owned()),
                    cwd: Some(launch.cwd.clone()),
                    repo: None,
                    activity: None,
                    cursor: None,
                })
                .await?;
            match listed
                .sessions
                .into_iter()
                .find(|listing| !listing.headless)
            {
                Some(latest) => Ok((
                    Some(attached(handle, latest.info.session_id).await?),
                    Vec::new(),
                )),
                None => Ok((
                    Some(created(handle).await?),
                    vec!["No earlier thread here; started a new one".to_owned()],
                )),
            }
        }
        StartMode::Pick => {
            // Listing here surfaces sign-in requirements before the TUI starts.
            handle
                .send(ListSessionsRequest {
                    agent_id: Some(launch.agent_id().to_owned()),
                    cwd: Some(launch.cwd.clone()),
                    repo: None,
                    activity: None,
                    cursor: None,
                })
                .await?;
            Ok((None, Vec::new()))
        }
    }
}

/// Sign in to `agent_id` through the Host, with `method` or one the user picks: in this
/// terminal for a terminal method, otherwise through the agent.
pub async fn sign_in_through(
    handle: &HostHandle,
    agent_id: &str,
    method: Option<&str>,
) -> anyhow::Result<()> {
    let got = handle
        .send(GetAgentRequest {
            agent_id: agent_id.to_owned(),
        })
        .await?;
    let name = got.agent.name.clone();
    let methods = &got.initialize.auth_methods;
    let chosen = pick_method(&name, methods, method, in_terminal())?;
    match chosen {
        AuthMethod::Terminal(terminal) => {
            let login = handle
                .send(TerminalSignInRequest {
                    agent_id: agent_id.to_owned(),
                    method_id: terminal.id.clone(),
                })
                .await?;
            run_command(&login.command, &login.args, &login.env)
        }
        other => {
            eprintln!("Signing in with {}…", other.name());
            handle
                .send(AuthenticateAgentRequest {
                    agent_id: agent_id.to_owned(),
                    method_id: other.id().clone(),
                })
                .await?;
            Ok(())
        }
    }
}

pub enum SignedIn {
    /// Signed in on this connection; retry.
    Ready,
    /// Signed in through a separate process; the protocol requires reconnecting.
    Reconnect,
}

/// Offer the agent's sign-in methods (or use `method`) and run the chosen one, talking to
/// the agent directly.
pub async fn sign_in(
    connection: &AgentConnection,
    spec: &AgentSpec,
    method: Option<&str>,
) -> anyhow::Result<SignedIn> {
    let agent = connection
        .agent()
        .context("the connection is not initialized")?;
    let name = agent.agent_info.as_ref().map_or_else(
        || spec.command.clone(),
        |info| info.title.clone().unwrap_or_else(|| info.name.clone()),
    );
    match pick_method(&name, &agent.auth_methods, method, in_terminal())? {
        AuthMethod::Terminal(terminal) => {
            run_terminal_sign_in(spec, terminal)?;
            Ok(SignedIn::Reconnect)
        }
        other => {
            eprintln!("Signing in with {}…", other.name());
            connection.authenticate(other.id().clone()).await?;
            Ok(SignedIn::Ready)
        }
    }
}

/// Whether there's a person at a terminal to ask, rather than a script or an SSH command run
/// without one.
fn in_terminal() -> bool {
    std::io::stdin().is_terminal()
}

/// `method`, or the one the user chooses from `methods`, when there's a `terminal` to ask in.
fn pick_method<'a>(
    name: &str,
    methods: &'a [AuthMethod],
    method: Option<&str>,
    terminal: bool,
) -> anyhow::Result<&'a AuthMethod> {
    if methods.is_empty() {
        bail!("{name} requires sign-in but offers no sign-in methods; sign in with its own CLI");
    }
    match method {
        Some(id) => methods
            .iter()
            .find(|candidate| candidate.id().to_string() == id)
            .with_context(|| format!("{name} has no sign-in method {id:?}")),
        None if terminal => choose_method(name, methods),
        None => {
            let ids = methods
                .iter()
                .map(|method| format!("{} ({})", method.id(), method.name()))
                .collect::<Vec<_>>()
                .join(", ");
            bail!(
                "{name} needs you to sign in, and with no terminal to choose how in, name the \
                 method: --method <id>, one of {ids}"
            )
        }
    }
}

fn choose_method<'a>(agent: &str, methods: &'a [AuthMethod]) -> anyhow::Result<&'a AuthMethod> {
    let mut stderr = std::io::stderr();
    writeln!(stderr, "{agent} needs you to sign in.")?;
    for (index, method) in methods.iter().enumerate() {
        let kind = if matches!(method, AuthMethod::Terminal(_)) {
            " (in this terminal)"
        } else {
            ""
        };
        let description = method
            .description()
            .map(|text| format!(" — {text}"))
            .unwrap_or_default();
        writeln!(
            stderr,
            "  {}. {}{kind}{description}",
            index + 1,
            method.name()
        )?;
    }
    loop {
        write!(
            stderr,
            "Choose a method [1-{}], or q to quit: ",
            methods.len()
        )?;
        stderr.flush()?;
        let mut answer = String::new();
        if std::io::stdin().lock().read_line(&mut answer)? == 0 {
            bail!("sign-in cancelled");
        }
        let answer = answer.trim();
        if answer.eq_ignore_ascii_case("q") {
            bail!("sign-in cancelled");
        }
        if let Some(method) = answer
            .parse::<usize>()
            .ok()
            .and_then(|choice| methods.get(choice.wrapping_sub(1)))
        {
            return Ok(method);
        }
    }
}

/// Run the agent's own command with the method's arguments, interactively, as the spec defines.
fn run_terminal_sign_in(spec: &AgentSpec, method: &AuthMethodTerminal) -> anyhow::Result<()> {
    let login = spec.for_terminal_sign_in(method);
    run_command(&login.command, &login.args, &login.env)
}

/// Run a sign-in command in this terminal.
fn run_command(
    command: &str,
    args: &[String],
    env: &BTreeMap<String, String>,
) -> anyhow::Result<()> {
    let line = std::iter::once(command)
        .chain(args.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    if !in_terminal() {
        bail!(
            "signing in runs {line}, which needs a terminal; over SSH, give it one with `ssh -t`"
        );
    }
    eprintln!("Running {line} to sign in…");
    let status = std::process::Command::new(command)
        .args(args)
        .envs(env)
        .status()
        .with_context(|| format!("starting {command}"))?;
    if !status.success() {
        bail!("sign-in did not succeed ({status})");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use weave_host::DaemonPaths;

    use super::*;

    #[test]
    fn without_a_terminal_signing_in_names_its_method_rather_than_asking() {
        use weave_acp_core::schema::AuthMethodAgent;

        let methods = [
            AuthMethod::Agent(AuthMethodAgent::new("token", "Token")),
            AuthMethod::Terminal(AuthMethodTerminal::new("login", "Log in")),
        ];
        let error = pick_method("Fake", &methods, None, false)
            .err()
            .map(|error| error.to_string())
            .unwrap_or_default();
        assert!(error.contains("--method"), "{error}");
        assert!(error.contains("token (Token), login (Log in)"), "{error}");
        let named = pick_method("Fake", &methods, Some("login"), false).map(AuthMethod::id);
        assert_eq!(
            named.ok().map(ToString::to_string),
            Some("login".to_owned())
        );
    }

    /// A journal header as the Host writes one.
    fn record(paths: &DaemonPaths, session_id: &str, choice: &str, cwd: &str) {
        let dir = paths.journals();
        std::fs::create_dir_all(&dir).expect("journals");
        let header = serde_json::json!({
            "type": "header",
            "version": 1,
            "sessionId": session_id,
            "agent": {"command": "npx", "args": [choice]},
            "choice": {"named": choice},
            "cwd": cwd,
            "policy": {},
            "createdMs": 0,
        });
        std::fs::write(
            dir.join(format!("{session_id}.jsonl")),
            format!("{header}\n"),
        )
        .expect("journal");
    }

    #[test]
    fn resuming_a_session_uses_the_agent_and_directory_it_started_with() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = DaemonPaths::in_dir(dir.path().to_path_buf());
        record(&paths, "s1", "codex", "/elsewhere/repo");
        let target = Target::Shared(paths);
        let resume = StartMode::Resume("s1".into());
        let claude = Some(AgentChoice::Named("claude".into()));
        let workspace = WorkspaceArgs::default();

        let chosen = choose(&resume, claude.clone(), &workspace, &target, None).expect("choose");
        assert_eq!(chosen.agent, Some(AgentChoice::Named("codex".into())));
        assert_eq!(chosen.cwd, Some(PathBuf::from("/elsewhere/repo")));
        assert_eq!(
            chosen.note.as_deref(),
            Some(
                "Resuming s1 with codex, the agent it was started with (not claude) in \
                 /elsewhere/repo"
            )
        );

        // A session weave has no record of opens as the command line says.
        let unknown = StartMode::Resume("s2".into());
        let chosen = choose(&unknown, claude.clone(), &workspace, &target, None).expect("choose");
        assert_eq!(
            (chosen.agent, chosen.cwd, chosen.note),
            (claude, None, None)
        );
    }

    #[test]
    fn continuing_uses_the_agent_last_used_here_unless_one_is_given() {
        let dir = tempfile::tempdir().expect("tempdir");
        let recent = Recent::at(dir.path().join("recent.json"));
        let workspace = WorkspaceArgs::default();
        let here = workspace.cwd().expect("cwd");
        recent.record(&here, &AgentChoice::Named("gemini".into()));
        let target = Target::Shared(DaemonPaths::in_dir(dir.path().to_path_buf()));

        let chosen = choose(
            &StartMode::Continue,
            None,
            &workspace,
            &target,
            Some(&recent),
        )
        .expect("choose");
        assert_eq!(chosen.agent, Some(AgentChoice::Named("gemini".into())));
        let given = Some(AgentChoice::Named("claude".into()));
        let chosen = choose(
            &StartMode::Continue,
            given.clone(),
            &workspace,
            &target,
            Some(&recent),
        )
        .expect("choose");
        assert_eq!(chosen.agent, given);
    }
}
