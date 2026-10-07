//! Connecting, signing in when the agent requires it, and opening the first session.

use std::io::BufRead;
use std::io::Write;

use anyhow::Context;
use anyhow::bail;
use tokio::sync::mpsc::UnboundedReceiver;
use weave_acp_core::AgentConnection;
use weave_acp_core::AgentEvent;
use weave_acp_core::AgentSpec;
use weave_acp_core::ProtocolTrace;
use weave_acp_core::SessionSetup;
use weave_acp_core::is_auth_required;
use weave_acp_core::schema::AuthMethod;
use weave_acp_core::schema::AuthMethodTerminal;
use weave_acp_core::schema::SessionId;
use weave_tui::OpenedSession;
use weave_tui::SessionTarget;
use weave_tui::open_session;

use crate::agent_args::Launch;

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

/// Launch and initialize the agent.
pub async fn connect(
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

/// Connect and open the session `mode` asks for, signing in first if the agent requires it.
pub async fn start(launch: &Launch, mode: &StartMode) -> anyhow::Result<Started> {
    let mut attempts = 0;
    loop {
        let (connection, events) = connect(launch).await?;
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
fn session_setup(launch: &Launch, connection: &AgentConnection) -> (SessionSetup, Vec<String>) {
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
            let listed = handle.list_sessions(Some(setup.cwd.clone()), None).await?;
            match listed.sessions.into_iter().next() {
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
