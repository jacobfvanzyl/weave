//! `weave smoke`: verifies an agent end to end without the TUI.
//!
//! Initializes, opens a session in the working directory, sends one prompt,
//! and prints each event until the turn ends. Ctrl-C cancels the turn the way
//! the protocol requires; a second Ctrl-C abandons it.

use std::io::Write;

use anyhow::Context;
use anyhow::bail;
use clap::Args;
use clap::ValueEnum;
use serde::Serialize;
use weave_acp_core::AgentConnection;
use weave_acp_core::AgentEvent;
use weave_acp_core::PermissionRequest;
use weave_acp_core::ProtocolTrace;
use weave_acp_core::SessionSetup;
use weave_acp_core::schema::AuthMethod;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::ErrorCode;
use weave_acp_core::schema::InitializeResponse;
use weave_acp_core::schema::PermissionOptionKind;
use weave_acp_core::schema::SessionUpdate;
use weave_acp_core::schema::TextContent;

use crate::agent_args::AgentArgs;
use crate::agent_args::Launch;

#[derive(Args)]
pub struct SmokeArgs {
    #[command(flatten)]
    agent: AgentArgs,

    /// The prompt to send.
    #[arg(
        long,
        short,
        default_value = "Reply with one short sentence confirming you can read this."
    )]
    prompt: String,

    /// How to answer the agent's permission requests.
    #[arg(long, value_enum, default_value_t = PermissionPolicy::Reject)]
    permissions: PermissionPolicy,
}

#[derive(Clone, Copy, ValueEnum)]
enum PermissionPolicy {
    /// Choose the agent's one-time allow option.
    Allow,
    /// Choose the agent's one-time reject option.
    Reject,
}

pub async fn run(args: SmokeArgs) -> anyhow::Result<()> {
    let launch = args.agent.launch().await?;
    let trace = launch
        .trace
        .as_deref()
        .map(|path| {
            ProtocolTrace::create(path)
                .with_context(|| format!("creating trace {}", path.display()))
        })
        .transpose()?;

    let mut out = Printer::default();
    out.event(format_args!("launching {}", launch.spec.display_command()));
    let (connection, mut events) =
        AgentConnection::spawn(&launch.spec, trace, launch.options).await?;
    let result = run_turn(
        &connection,
        &mut events,
        &mut out,
        &launch,
        args.prompt,
        args.permissions,
    )
    .await;
    connection.shutdown().await;
    result
}

async fn run_turn(
    connection: &AgentConnection,
    events: &mut tokio::sync::mpsc::UnboundedReceiver<AgentEvent>,
    out: &mut Printer,
    launch: &Launch,
    prompt: String,
    policy: PermissionPolicy,
) -> anyhow::Result<()> {
    let init = connection.initialize().await?;
    describe_agent(out, &init);

    let (mcp_servers, notices) = launch
        .config
        .mcp_servers(&init.agent_capabilities.mcp_capabilities);
    for notice in notices {
        out.event(format_args!("{notice}"));
    }
    let additional_directories = if init
        .agent_capabilities
        .session_capabilities
        .additional_directories
        .is_some()
    {
        launch.additional_directories.clone()
    } else {
        Vec::new()
    };
    let setup = SessionSetup {
        cwd: launch.cwd.clone(),
        additional_directories,
        mcp_servers,
    };
    let session = match connection.new_session(&setup).await {
        Ok(session) => session,
        Err(error) if error.code == ErrorCode::AuthRequired => {
            bail!(
                "agent requires authentication ({error}); sign in with the agent's own CLI first. \
                 Interactive ACP authentication arrives with session management."
            );
        }
        Err(error) => return Err(error).context("session/new"),
    };
    let session_id = session.session_id;
    out.event(format_args!("session {session_id}"));
    if let Some(modes) = &session.modes {
        let ids = modes
            .available_modes
            .iter()
            .map(|mode| mode.id.to_string())
            .collect::<Vec<_>>();
        out.event(format_args!(
            "modes {} (current {})",
            ids.join(", "),
            modes.current_mode_id
        ));
    }
    if let Some(options) = &session.config_options {
        let names = options
            .iter()
            .map(|option| option.name.as_str())
            .collect::<Vec<_>>();
        out.event(format_args!("config options {}", names.join(", ")));
    }

    out.event(format_args!("prompt {prompt:?}"));
    connection.prompt(
        session_id.clone(),
        vec![ContentBlock::Text(TextContent::new(prompt))],
    )?;

    let mut cancelling = false;
    loop {
        let event = tokio::select! {
            event = events.recv() => event,
            _ = tokio::signal::ctrl_c() => {
                if cancelling {
                    bail!("turn abandoned before the agent acknowledged cancellation");
                }
                cancelling = true;
                out.event(format_args!("cancelling (Ctrl-C again to abandon)"));
                connection.cancel(session_id.clone())?;
                continue;
            }
        };
        match event {
            Some(AgentEvent::SessionUpdate(notification)) => out.update(&notification.update),
            Some(AgentEvent::PermissionRequested(request)) if cancelling => {
                out.event(format_args!("permission request answered cancelled"));
                request.cancel()?;
            }
            Some(AgentEvent::PermissionRequested(request)) => {
                answer_permission(out, request, policy)?
            }
            Some(AgentEvent::ElicitationRequested(request)) => {
                out.event(format_args!(
                    "elicitation {:?} dismissed: smoke cannot answer it",
                    request.request.message
                ));
                request.cancel()?;
            }
            Some(AgentEvent::ElicitationCompleted(id)) => {
                out.event(format_args!("elicitation {id} completed"))
            }
            Some(AgentEvent::RequestWithdrawn(_)) => {
                out.event(format_args!("the agent withdrew a request"))
            }
            Some(AgentEvent::TerminalOutput { terminal_id, text }) => {
                for line in text.lines() {
                    out.event(format_args!("{terminal_id} │ {line}"));
                }
            }
            Some(AgentEvent::TerminalExited {
                terminal_id,
                status,
            }) => out.event(format_args!("{terminal_id} exited {}", wire(&status))),
            Some(AgentEvent::TurnEnded { result, .. }) => {
                let response = result.context("session/prompt")?;
                out.event(format_args!("turn ended: {}", wire(&response.stop_reason)));
                return Ok(());
            }
            Some(AgentEvent::Disconnected(Some(error))) => {
                bail!("connection closed mid-turn: {error}");
            }
            Some(AgentEvent::Disconnected(None)) | None => bail!("agent exited mid-turn"),
        }
    }
}

fn describe_agent(out: &mut Printer, init: &InitializeResponse) {
    match &init.agent_info {
        Some(info) => out.event(format_args!("agent {} {}", info.name, info.version)),
        None => out.event(format_args!("agent (no agentInfo)")),
    }
    let caps = &init.agent_capabilities;
    out.event(format_args!(
        "capabilities loadSession={} image={} audio={} embeddedContext={} mcp.http={} mcp.sse={}",
        caps.load_session,
        caps.prompt_capabilities.image,
        caps.prompt_capabilities.audio,
        caps.prompt_capabilities.embedded_context,
        caps.mcp_capabilities.http,
        caps.mcp_capabilities.sse,
    ));
    if !init.auth_methods.is_empty() {
        let methods = init
            .auth_methods
            .iter()
            .map(AuthMethod::name)
            .collect::<Vec<_>>();
        out.event(format_args!("auth methods {}", methods.join(", ")));
    }
}

fn answer_permission(
    out: &mut Printer,
    request: PermissionRequest,
    policy: PermissionPolicy,
) -> anyhow::Result<()> {
    let wanted = match policy {
        PermissionPolicy::Allow => PermissionOptionKind::AllowOnce,
        PermissionPolicy::Reject => PermissionOptionKind::RejectOnce,
    };
    let title = request
        .request
        .tool_call
        .fields
        .title
        .clone()
        .unwrap_or_default();
    let choice = request
        .request
        .options
        .iter()
        .find(|option| option.kind == wanted)
        .map(|option| (option.option_id.clone(), option.name.clone()));
    match choice {
        Some((id, name)) => {
            out.event(format_args!("permission {title:?} -> {name}"));
            request.select(id)?;
        }
        None => {
            out.event(format_args!(
                "permission {title:?} offered no {} option; cancelled",
                wire(&wanted)
            ));
            request.cancel()?;
        }
    }
    Ok(())
}

/// A value's ACP wire spelling, such as `end_turn` for `StopReason::EndTurn`.
fn wire(value: &impl Serialize) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(s)) => s,
        Ok(other) => other.to_string(),
        Err(_) => "?".to_owned(),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stream {
    Agent,
    Thought,
    User,
}

/// Prints streamed message chunks inline and every other event on its own `›` line.
#[derive(Default)]
struct Printer {
    open: Option<Stream>,
    mid_line: bool,
}

impl Printer {
    fn event(&mut self, line: std::fmt::Arguments<'_>) {
        self.end_stream();
        println!("› {line}");
    }

    fn update(&mut self, update: &SessionUpdate) {
        match update {
            SessionUpdate::AgentMessageChunk(chunk) => self.chunk(Stream::Agent, &chunk.content),
            SessionUpdate::AgentThoughtChunk(chunk) => self.chunk(Stream::Thought, &chunk.content),
            SessionUpdate::UserMessageChunk(chunk) => self.chunk(Stream::User, &chunk.content),
            SessionUpdate::ToolCall(call) => self.event(format_args!(
                "tool_call {} {:?} kind={} status={}",
                call.tool_call_id,
                call.title,
                wire(&call.kind),
                wire(&call.status),
            )),
            SessionUpdate::ToolCallUpdate(update) => {
                let fields = &update.fields;
                let mut changes = Vec::new();
                if let Some(status) = &fields.status {
                    changes.push(format!("status={}", wire(status)));
                }
                if let Some(title) = &fields.title {
                    changes.push(format!("title={title:?}"));
                }
                if let Some(content) = &fields.content {
                    changes.push(format!("content={} item(s)", content.len()));
                }
                self.event(format_args!(
                    "tool_call_update {} {}",
                    update.tool_call_id,
                    changes.join(" ")
                ));
            }
            SessionUpdate::Plan(plan) => {
                self.event(format_args!("plan ({} entries)", plan.entries.len()));
                for entry in &plan.entries {
                    println!("    [{}] {}", wire(&entry.status), entry.content);
                }
            }
            SessionUpdate::AvailableCommandsUpdate(update) => {
                let names = update
                    .available_commands
                    .iter()
                    .map(|command| format!("/{}", command.name))
                    .collect::<Vec<_>>();
                self.event(format_args!("commands {}", names.join(" ")));
            }
            SessionUpdate::CurrentModeUpdate(update) => {
                self.event(format_args!("mode {}", update.current_mode_id));
            }
            SessionUpdate::ConfigOptionUpdate(update) => {
                self.event(format_args!(
                    "config options updated ({})",
                    update.config_options.len()
                ));
            }
            SessionUpdate::SessionInfoUpdate(update) => {
                self.event(format_args!("session info {}", wire(update)));
            }
            SessionUpdate::UsageUpdate(update) => {
                self.event(format_args!(
                    "context {}/{} tokens",
                    update.used, update.size
                ));
            }
            other => self.event(format_args!("unrecognized update {}", wire(other))),
        }
    }

    fn chunk(&mut self, stream: Stream, content: &ContentBlock) {
        if self.open != Some(stream) {
            let label = match stream {
                Stream::Agent => "agent",
                Stream::Thought => "thought",
                Stream::User => "user",
            };
            self.event(format_args!("{label}"));
            self.open = Some(stream);
        }
        let text = match content {
            ContentBlock::Text(text) => text.text.clone(),
            ContentBlock::Image(_) => "[image]".to_owned(),
            ContentBlock::Audio(_) => "[audio]".to_owned(),
            ContentBlock::ResourceLink(link) => format!("[link {}]", link.uri),
            ContentBlock::Resource(_) => "[embedded resource]".to_owned(),
            _ => "[unsupported content]".to_owned(),
        };
        print!("{text}");
        self.mid_line = !text.ends_with('\n');
        let _ = std::io::stdout().flush();
    }

    fn end_stream(&mut self) {
        if self.mid_line {
            println!();
            self.mid_line = false;
        }
        self.open = None;
    }
}
