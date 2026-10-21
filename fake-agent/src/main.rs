//! Serves the scripted fake agent over stdio, for driving the real client by hand.
//!
//! With `--login` it instead runs the interactive sign-in its `terminal` auth method asks
//! the client to launch, exiting 0 on success.

use weave_fake_agent::FakeAgentConfig;

#[tokio::main]
async fn main() -> Result<(), agent_client_protocol::Error> {
    if std::env::args().any(|arg| arg == "--login") {
        let config = FakeAgentConfig::from_env();
        let signed_in = weave_fake_agent::interactive_login(config.state_path.as_deref())
            .map_err(agent_client_protocol::Error::into_internal_error)?;
        std::process::exit(if signed_in { 0 } else { 1 });
    }
    weave_fake_agent::serve(agent_client_protocol::Stdio::new()).await
}
