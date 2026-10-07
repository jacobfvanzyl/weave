//! Serves the scripted fake agent over stdio, for driving the real client by hand.

#[tokio::main]
async fn main() -> Result<(), agent_client_protocol::Error> {
    weave_fake_agent::serve(agent_client_protocol::Stdio::new()).await
}
