//! Connecting, signing in when the agent requires it, and opening the first session.

use std::io::BufRead;
use std::io::Write;
use std::path::PathBuf;

use anyhow::Context;
use anyhow::bail;
use tokio::sync::mpsc::UnboundedReceiver;
use weave_acp_core::AgentConnection;
use weave_acp_core::AgentEvent;
use weave_acp_core::AgentSpec;
use weave_acp_core::ClientOptions;
use weave_acp_core::ProtocolTrace;
use weave_acp_core::SessionSetup;
use weave_acp_core::daemon_protocol;
use weave_acp_core::daemon_protocol::ListedSession;
use weave_acp_core::is_auth_required;
use weave_acp_core::schema::AuthMethod;
use weave_acp_core::schema::AuthMethodTerminal;
use weave_acp_core::schema::SessionId;
use weave_tui::OpenedSession;
use weave_tui::SessionTarget;
use weave_tui::open_session;

use crate::args::AgentChoice;
use crate::args::Launch;
use crate::args::WorkspaceArgs;
use crate::daemon::Target;
use crate::daemon::daemon_launch;
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
/// directory it was started with, whatever `--agent` and `--cwd` say, when the daemon's
/// journal records them. `--continue` without an agent uses the one last used in the
/// directory. Otherwise it's what the command line says.
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
            let Some(recorded) = weave_daemon::recorded_session(paths, session_id) else {
                return Ok(as_given(explicit));
            };
            let here = workspace.cwd().ok();
            let elsewhere = if here.as_ref() == Some(&recorded.cwd) {
                String::new()
            } else {
                format!(" in {}", recorded.cwd.display())
            };
            let agent = recorded.choice.clone().or(explicit.clone());
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
    pub connection: AgentConnection,
    pub events: UnboundedReceiver<AgentEvent>,
    pub setup: SessionSetup,
    pub opened: Option<OpenedSession>,
    pub notices: Vec<String>,
}

/// How many sign-in attempts to make before giving up.
const SIGN_IN_ATTEMPTS: usize = 3;

/// Launch the agent here, outside the daemon, and initialize it: for signing in and out.
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

/// Connect through the daemon and open the session `mode` asks for, signing in first if the
/// agent requires it.
pub async fn start(launch: &Launch, target: &Target, mode: &StartMode) -> anyhow::Result<Started> {
    // This client can rerun the agent's command here for terminal sign-in.
    let options = ClientOptions {
        terminal_auth: true,
        ..launch.options
    };
    let mut attempts = 0;
    loop {
        let (connection, events) = target.connect(daemon_launch(launch), options).await?;
        let (setup, notices) = session_setup(launch, &connection);
        loop {
            match establish(&connection, &setup, mode).await {
                Ok((opened, mut extra)) => {
                    let mut notices = notices;
                    notices.append(&mut extra);
                    return Ok(Started {
                        connection,
                        events,
                        setup,
                        opened,
                        notices,
                    });
                }
                Err(error) if needs_sign_in(&error) && attempts < SIGN_IN_ATTEMPTS => {
                    attempts += 1;
                    match sign_in(&connection, &launch.spec, None).await {
                        Ok(SignedIn::Ready) => continue,
                        Ok(SignedIn::Reconnect) => {
                            connection.shutdown().await;
                            break;
                        }
                        Err(error) => {
                            connection.shutdown().await;
                            return Err(error);
                        }
                    }
                }
                Err(error) => {
                    connection.shutdown().await;
                    return Err(error);
                }
            }
        }
    }
}

fn needs_sign_in(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<weave_acp_core::schema::Error>()
        .is_some_and(is_auth_required)
}

/// The session setup this agent can accept, and notices about what it can't.
pub fn session_setup(launch: &Launch, connection: &AgentConnection) -> (SessionSetup, Vec<String>) {
    let capabilities = connection
        .agent()
        .map(|agent| agent.agent_capabilities.clone())
        .unwrap_or_default();
    let (mcp_servers, mut notices) = launch.config.mcp_servers(&capabilities.mcp_capabilities);
    let mut additional_directories = launch.additional_directories.clone();
    if !additional_directories.is_empty()
        && capabilities
            .session_capabilities
            .additional_directories
            .is_none()
    {
        notices.push(
            "The agent doesn't support extra workspace roots; --add-dir was ignored".to_owned(),
        );
        additional_directories.clear();
    }
    let setup = SessionSetup {
        cwd: launch.cwd.clone(),
        additional_directories,
        mcp_servers,
    };
    (setup, notices)
}

async fn establish(
    connection: &AgentConnection,
    setup: &SessionSetup,
    mode: &StartMode,
) -> anyhow::Result<(Option<OpenedSession>, Vec<String>)> {
    let handle = connection.handle();
    match mode {
        StartMode::New => Ok((
            Some(open_session(&handle, SessionTarget::New, setup).await?),
            Vec::new(),
        )),
        StartMode::Resume(session_id) => {
            let target = SessionTarget::Existing(session_id.clone());
            Ok((
                Some(open_session(&handle, target, setup).await?),
                Vec::new(),
            ))
        }
        StartMode::Continue => {
            // The daemon lists the sessions it has here first; headless runs aren't for
            // continuing interactively, so `weave sessions` and `--resume <id>` reach those.
            let listed = handle.list_sessions(Some(setup.cwd.clone()), None).await?;
            let interactive = listed.sessions.into_iter().find(|info| {
                !daemon_protocol::read_meta::<ListedSession>(info.meta.as_ref())
                    .is_some_and(|listed| listed.headless)
            });
            match interactive {
                Some(latest) => {
                    let target = SessionTarget::Existing(latest.session_id);
                    Ok((
                        Some(open_session(&handle, target, setup).await?),
                        Vec::new(),
                    ))
                }
                None => {
                    let opened = open_session(&handle, SessionTarget::New, setup).await?;
                    Ok((
                        Some(opened),
                        vec!["No earlier session here; started a new one".to_owned()],
                    ))
                }
            }
        }
        StartMode::Pick => {
            // Listing here surfaces sign-in requirements before the TUI starts.
            handle.list_sessions(Some(setup.cwd.clone()), None).await?;
            Ok((None, Vec::new()))
        }
    }
}

pub enum SignedIn {
    /// Signed in on this connection; retry.
    Ready,
    /// Signed in through a separate process; the protocol requires reconnecting.
    Reconnect,
}

/// Offer the agent's sign-in methods (or use `method`) and run the chosen one.
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
    let methods = &agent.auth_methods;
    if methods.is_empty() {
        bail!("{name} requires sign-in but offers no sign-in methods; sign in with its own CLI");
    }
    let chosen = match method {
        Some(id) => methods
            .iter()
            .find(|candidate| candidate.id().to_string() == id)
            .with_context(|| format!("{name} has no sign-in method {id:?}"))?,
        None => choose_method(&name, methods)?,
    };
    match chosen {
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
    eprintln!("Running {} to sign in…", login.display_command());
    let status = std::process::Command::new(&login.command)
        .args(&login.args)
        .envs(&login.env)
        .status()
        .with_context(|| format!("starting {}", login.command))?;
    if !status.success() {
        bail!("sign-in did not succeed ({status})");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use weave_daemon::DaemonPaths;

    use super::*;

    /// A journal header as the daemon writes one.
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
