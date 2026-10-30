//! A weave Host inside the test, on a socket in a directory of its own, whose agent `fake` is
//! the fake agent served in this process; and `weave` run against it as a script would run it.
//! The Host has a runtime of its own, so the test can lose it as a client loses a Host whose
//! process ends.

#![allow(dead_code, clippy::expect_used)]

use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Output;
use std::sync::Arc;

use agent_client_protocol::Channel;
use agent_client_protocol::Error;
use tokio::runtime::Runtime;
use tokio::sync::mpsc::UnboundedReceiver;
use weave_acp_core::AgentConnection;
use weave_fake_agent::FakeAgentConfig;
use weave_host::Daemon;
use weave_host::DaemonConfig;
use weave_host::DaemonPaths;
use weave_host::Launcher;
use weave_host::socket;
use weave_host_client::HostConnection;
use weave_host_client::HostEvent;
use weave_host_protocol::hello::ClientCapabilities;
use weave_host_protocol::hello::ClientInfo;

pub struct TestHost {
    pub dir: tempfile::TempDir,
    pub paths: DaemonPaths,
    daemon: Daemon,
    runtime: Option<Runtime>,
}

impl TestHost {
    pub fn start() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let config_home = dir.path().join("config");
        std::fs::create_dir_all(config_home.join("weave")).expect("config dir");
        let config_file = config_home.join("weave/config.toml");
        std::fs::write(&config_file, "[agents.fake]\ncommand = \"fake-agent\"\n").expect("config");
        std::fs::create_dir_all(dir.path().join("work")).expect("work dir");
        let paths = DaemonPaths::in_dir(dir.path().join("host"));

        let state = dir.path().join("agent-state.json");
        let launcher: Launcher = Arc::new(move |_, options, _| {
            let config = FakeAgentConfig {
                state_path: Some(state.clone()),
                ..FakeAgentConfig::default()
            };
            Box::pin(async move {
                let (client, agent) = Channel::duplex();
                tokio::spawn(weave_fake_agent::serve_with(agent, config));
                AgentConnection::connect(client, options)
                    .await
                    .map_err(|error| Error::internal_error().data(error.to_string()))
            })
        });
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let _entered = runtime.enter();
        let listening = socket::listen(&paths).expect("listen");
        let mut config = DaemonConfig::in_process(Some(config_file));
        config.journals = Some(paths.journals());
        config.devices = Some(paths.devices());
        config.traces = dir.path().join("traces");
        config.launcher = launcher;
        let daemon = Daemon::new(config);
        let serving = daemon.clone();
        runtime.spawn(async move {
            let listener = listening.listener;
            serving.serve(listener, None).await;
        });
        drop(_entered);
        Self {
            dir,
            paths,
            daemon,
            runtime: Some(runtime),
        }
    }

    /// End the Host at once, its connections and agents with it.
    pub fn lose(&mut self) {
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }

    /// Run `future` on the Host's runtime, as a client of it beside `weave` does.
    pub fn block_on<F: Future>(&self, future: F) -> F::Output {
        self.runtime
            .as_ref()
            .expect("the Host is running")
            .block_on(future)
    }

    /// A protocol client of the Host, for what `weave` doesn't do.
    pub fn client(&self) -> (HostConnection, UnboundedReceiver<HostEvent>) {
        self.block_on(async {
            let transport = socket::connect(&self.paths.socket).await.expect("connect");
            HostConnection::connect(
                transport,
                ClientInfo {
                    name: "test".to_owned(),
                    version: "0".to_owned(),
                },
                ClientCapabilities {
                    terminal_sign_in: false,
                    client_tools: Vec::new(),
                },
            )
            .await
            .expect("hello")
        })
    }

    /// The directory sessions run in.
    pub fn work(&self) -> PathBuf {
        self.dir.path().join("work")
    }

    /// `weave args…` against this Host, run in [`Self::work`].
    pub fn command(&self, args: &[&str]) -> Command {
        weave_command(self.dir.path(), &self.paths.dir, &self.work(), args)
    }

    /// Run `weave args…` against this Host, without a terminal, as a script over SSH would.
    pub fn weave(&self, args: &[&str]) -> Output {
        self.command(args).output().expect("run weave")
    }
}

impl Drop for TestHost {
    fn drop(&mut self) {
        self.daemon.stop();
        self.lose();
    }
}

/// `weave args…` with its Host in `host_dir`, its config and state under `root`, run in `cwd`.
pub fn weave_command(root: &Path, host_dir: &Path, cwd: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_weave"));
    command
        .args(args)
        .current_dir(cwd)
        .env("WEAVE_DAEMON_DIR", host_dir)
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_STATE_HOME", root.join("state"))
        .env_remove("WEAVE_AGENT_PROCESS")
        .env_remove("RUST_LOG");
    command
}
