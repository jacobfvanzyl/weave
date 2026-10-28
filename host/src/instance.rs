//! Agent processes: one per open session, started in the session's directory with the
//! Host's agent environment under the agent's own settings.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::Error;
use futures::future::BoxFuture;
use tokio::sync::mpsc::UnboundedReceiver;
use weave_acp_core::AgentConnection;
use weave_acp_core::AgentEvent;
use weave_acp_core::AgentSpec;
use weave_acp_core::ClientOptions;
use weave_acp_core::InitializeError;
use weave_acp_core::Traces;
use weave_acp_core::schema::InitializeResponse;

/// The variable naming an agent process in its environment, so a `weave` it runs can tell
/// the Host which turn is its own, as `weave daemon restart` does to leave that turn out of
/// the wait (`host/drain`'s `except`).
pub const AGENT_PROCESS_VARIABLE: &str = "WEAVE_AGENT_PROCESS";

/// An agent to start: how, and where.
#[derive(Clone, Debug)]
pub struct Launch {
    /// The agent's id, as clients name it.
    pub agent_id: String,
    pub spec: AgentSpec,
    /// Where the agent process starts, and the session's directory.
    pub cwd: PathBuf,
    /// The environment the agent inherits, under its own settings. Never written to disk.
    pub environment: BTreeMap<String, String>,
    /// This agent process's name, given to it as [`AGENT_PROCESS_VARIABLE`].
    pub process: String,
}

impl Launch {
    /// A new name for an agent process.
    pub(crate) fn new_process() -> String {
        format!("a-{}", crate::devices::random_id(8))
    }

    /// What the agent starts with over the Host's own environment: the Host's agent
    /// environment, `PWD`, the agent's own settings, and its process's name. Its Host-run
    /// terminals start with it too.
    pub fn agent_environment(&self) -> BTreeMap<String, String> {
        let mut env = self.environment.clone();
        env.insert("PWD".to_owned(), self.cwd.display().to_string());
        env.extend(
            self.spec
                .env
                .iter()
                .map(|(name, value)| (name.clone(), value.clone())),
        );
        env.insert(AGENT_PROCESS_VARIABLE.to_owned(), self.process.clone());
        env
    }
}

/// Starts an agent and connects to it, uninitialized, tracing its protocol into whatever
/// the traces hold: as a process, or in tests in-process.
pub type Launcher = Arc<
    dyn Fn(
            &Launch,
            ClientOptions,
            Arc<Traces>,
        )
            -> BoxFuture<'static, Result<(AgentConnection, UnboundedReceiver<AgentEvent>), Error>>
        + Send
        + Sync,
>;

/// Agents as processes, each in its own process group, killed with its session.
pub fn process_launcher() -> Launcher {
    Arc::new(
        |launch: &Launch, options: ClientOptions, traces: Arc<Traces>| {
            let spec = in_directory(launch);
            Box::pin(async move {
                AgentConnection::spawn_exactly(&spec, traces, options)
                    .await
                    .map_err(|error| Error::internal_error().data(error.to_string()))
            })
        },
    )
}

/// What identifies an agent the daemon can reuse: for `initialize` answers, and to list and
/// delete sessions without starting another process.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct LaunchKey {
    spec: AgentSpec,
    cwd: PathBuf,
    options: ClientOptions,
}

impl LaunchKey {
    pub(crate) fn spec(&self) -> &AgentSpec {
        &self.spec
    }

    pub(crate) fn options(&self) -> ClientOptions {
        self.options
    }

    pub(crate) fn new(launch: &Launch, options: ClientOptions) -> Self {
        Self {
            spec: launch.spec.clone(),
            cwd: launch.cwd.clone(),
            options,
        }
    }
}

/// An initialized agent.
pub(crate) struct Instance {
    pub(crate) agent_id: String,
    pub(crate) connection: AgentConnection,
    pub(crate) events: UnboundedReceiver<AgentEvent>,
    pub(crate) key: LaunchKey,
    /// Where its protocol is traced, for the clients that asked.
    pub(crate) traces: Arc<Traces>,
    /// Its name, as [`Launch::process`].
    pub(crate) process: String,
}

impl Instance {
    /// Start an agent for `launch` and initialize it, offering it `options`.
    pub(crate) async fn start(
        launcher: &Launcher,
        launch: &Launch,
        options: ClientOptions,
    ) -> Result<Self, Error> {
        Self::start_traced(launcher, launch, options, Arc::new(Traces::default())).await
    }

    /// [`Self::start`], tracing into `traces`: a reopened session's, for the clients that
    /// asked.
    pub(crate) async fn start_traced(
        launcher: &Launcher,
        launch: &Launch,
        options: ClientOptions,
        traces: Arc<Traces>,
    ) -> Result<Self, Error> {
        let (connection, events) = launcher(launch, options, Arc::clone(&traces)).await?;
        if let Err(error) = connection.initialize().await {
            connection.shutdown().await;
            return Err(match error {
                InitializeError::Protocol(error) => error,
                other => Error::internal_error().data(other.to_string()),
            });
        }
        Ok(Self {
            agent_id: launch.agent_id.clone(),
            connection,
            events,
            key: LaunchKey::new(launch, options),
            traces,
            process: launch.process.clone(),
        })
    }

    pub(crate) fn init(&self) -> Option<&InitializeResponse> {
        self.connection.agent()
    }

    /// Drop events the agent sent so far: a recovered session's replay, which its journal
    /// already has.
    pub(crate) fn discard_queued_events(&mut self) {
        while self.events.try_recv().is_ok() {}
    }
}

/// `launch`'s command, started in its directory with the Host's agent environment under the
/// command's own. The SDK can't set a child's directory, so `sh` changes to it and then
/// becomes the agent.
fn in_directory(launch: &Launch) -> AgentSpec {
    let env = launch.agent_environment();
    if cfg!(not(unix)) {
        return AgentSpec {
            env,
            ..launch.spec.clone()
        };
    }
    let mut args = vec![
        "-c".to_owned(),
        "cd -- \"$1\" && shift && exec \"$@\"".to_owned(),
        "weave-agent".to_owned(),
        launch.cwd.display().to_string(),
        launch.spec.command.clone(),
    ];
    args.extend(launch.spec.args.iter().cloned());
    AgentSpec {
        command: "/bin/sh".to_owned(),
        args,
        env,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use pretty_assertions::assert_eq;

    use super::*;

    #[cfg(unix)]
    #[test]
    fn agents_start_in_their_directory_with_the_hosts_environment() {
        let mut spec = AgentSpec::new("agent", ["--acp"]);
        spec.env.insert("MODE".into(), "acp".into());
        let launch = Launch {
            agent_id: "agent".into(),
            spec,
            cwd: "/repo dir".into(),
            environment: BTreeMap::from([
                ("PATH".to_owned(), "/client/bin".to_owned()),
                ("MODE".to_owned(), "shell".to_owned()),
            ]),
            process: "a-1".to_owned(),
        };
        let spec = in_directory(&launch);
        assert_eq!(spec.command, "/bin/sh");
        assert_eq!(&spec.args[3..], ["/repo dir", "agent", "--acp"]);
        assert_eq!(
            spec.env.get("PATH").map(String::as_str),
            Some("/client/bin")
        );
        // The agent's own settings win over the Host's environment.
        assert_eq!(spec.env.get("MODE").map(String::as_str), Some("acp"));
        assert_eq!(spec.env.get("PWD").map(String::as_str), Some("/repo dir"));
        // And it knows its name, whatever its settings say.
        assert_eq!(
            spec.env.get(AGENT_PROCESS_VARIABLE).map(String::as_str),
            Some("a-1")
        );

        // And the wrapper really runs it there.
        let output = std::process::Command::new(&spec.command)
            .args(&spec.args[..3])
            .arg("/")
            .arg("pwd")
            .output()
            .expect("sh runs");
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "/");
    }
}
