//! `weave dispatcher`: the Dispatcher (ADR 0027, WVE-175), which keeps triggers and starts
//! work on the person's Hosts as a client of each, over the connection each Host that joined it
//! keeps open (ADR 0030). `run` runs it in
//! the foreground; `start`, `stop` and `restart` in the background, or through its service once
//! `install` has launchd or systemd keep it running; `status`, the default, asks it. Its Hosts
//! are [`crate::commands::hosts`]'s, its schedules [`crate::commands::schedules`]'.
//!
//! The person's devices and other computers pair with it (WVE-176): `weave pair` shows a code on
//! its computer and `weave devices` lists and revokes them there ([`crate::commands::devices`]),
//! and `connect` on another computer pairs that one, over SSH or with the code, so `weave hosts`
//! and `weave schedules` reach it from there ([`crate::paired`]); `disconnect` forgets it.
//! `connect` offers to have that computer's Host join the Dispatcher too, so it starts work
//! there.

use std::io::BufRead as _;
use std::io::IsTerminal as _;
use std::io::Write as _;
use std::net::SocketAddr;
use std::process::ExitCode;
use std::sync::Arc;

use anyhow::Context as _;
use anyhow::bail;
use clap::Args;
use clap::Subcommand;
use weave_dispatcher::DEFAULT_LISTEN;
use weave_dispatcher::Dispatcher;
use weave_dispatcher::DispatcherConfig;
use weave_dispatcher::DispatcherPaths;
use weave_dispatcher::client::DispatcherConnection;
use weave_dispatcher::computer_name;
use weave_dispatcher::socket;
use weave_host_client::Credentials;
use weave_host_protocol::dispatcher::DispatcherHello;
use weave_host_protocol::dispatcher::DispatcherStatusRequest;
use weave_host_protocol::dispatcher::ListHostsRequest;
use weave_host_protocol::dispatcher::Reachability;
use weave_remote::access::RemoteSettings;
use weave_remote::tailscale::TailscaleServe;

use crate::background;
use crate::clock::ago;
use crate::clock::now_ms;
use crate::commands::devices::Offered;
use crate::commands::hosts;
use crate::commands::stop_signal;
use crate::dispatcher;
use crate::dispatcher::connect_here;
use crate::dispatcher::remote_pairing;
use crate::host;
use crate::paired;
use crate::paired::Paired;
use crate::service;
use crate::ssh::DISPATCHER;
use crate::ssh::Reach;
use crate::ssh::reach_for;
use crate::ssh::ssh;
use crate::ssh::ssh_name;

/// `run`'s stderr is its log, as the Host's is.
pub const LOG: &str = "info";

#[derive(Args)]
pub struct DispatcherArgs {
    #[command(subcommand)]
    command: Option<DispatcherCommand>,
}

#[derive(Subcommand)]
enum DispatcherCommand {
    /// Run the Dispatcher in the foreground until stopped (for launchd or systemd, or to watch
    /// its log).
    Run(RunArgs),
    /// Start the Dispatcher in the background, if it isn't running.
    Start,
    /// Stop the Dispatcher. Nothing runs on schedule until it starts again; then each schedule
    /// catches up as its `--missed` says.
    Stop,
    /// Stop the Dispatcher if it's running, then start it again: after rebuilding weave.
    Restart,
    /// Whether the Dispatcher runs, and how it reaches its Hosts (the default).
    Status(JsonArgs),
    /// Have launchd or systemd run the Dispatcher, from login or boot, and restart it if it
    /// stops.
    Install,
    /// Stop the Dispatcher's service and remove it.
    Uninstall,
    /// Pair this computer with the Dispatcher on another, over SSH (`weave dispatcher connect
    /// homelab`) or with the URL and code `weave pair` shows there, and offer to have this
    /// computer's Host join the Dispatcher.
    Connect(ConnectArgs),
    /// Forget the Dispatcher this computer is paired with.
    Disconnect,
}

#[derive(Args, Default)]
struct RunArgs {
    /// The loopback address its WebSocket listens on for your devices and Hosts, once one pairs
    /// or joins (default 127.0.0.1:7342).
    #[arg(long)]
    listen: Option<String>,
    /// What devices and Hosts connect to. With it, the Dispatcher makes and removes no Tailscale
    /// Serve entry: you route them to it yourself, as a development Dispatcher does.
    #[arg(long)]
    url: Option<String>,
}

#[derive(Args)]
struct ConnectArgs {
    /// The computer SSH reaches the Dispatcher on, or the URL `weave pair` shows there.
    dispatcher: String,
    /// The code `weave pair` shows there, after its URL.
    code: Option<String>,
    /// What the Dispatcher calls this computer, and its Host; its name by default.
    #[arg(long)]
    name: Option<String>,
    /// Have this computer's Host join the Dispatcher too, so it starts work here, without
    /// asking.
    #[arg(long, conflicts_with = "no_host")]
    host: bool,
    /// Leave this computer's Host alone, without asking.
    #[arg(long)]
    no_host: bool,
}

#[derive(Args, Default)]
struct JsonArgs {
    /// Print it as JSON.
    #[arg(long)]
    json: bool,
}

pub async fn command(args: DispatcherArgs) -> anyhow::Result<ExitCode> {
    let paths = dispatcher::paths()?;
    let command = args
        .command
        .unwrap_or_else(|| DispatcherCommand::Status(JsonArgs::default()));
    let elsewhere = match &command {
        DispatcherCommand::Run(_) => Some("run"),
        DispatcherCommand::Start => Some("start"),
        DispatcherCommand::Restart => Some("restart"),
        DispatcherCommand::Install => Some("install"),
        _ => None,
    };
    if let (Some(what), Some(paired)) = (elsewhere, remote_pairing()?) {
        bail!(
            "this computer is paired with the Dispatcher on {}, so `weave dispatcher {what}` is \
             for that computer. To run one here instead, `weave dispatcher disconnect` first",
            paired.place()
        );
    }
    let done = match command {
        DispatcherCommand::Run(args) => run(paths, args).await,
        DispatcherCommand::Start => start(&paths).await,
        DispatcherCommand::Stop => {
            if !stop(&paths).await? {
                eprintln!("The Dispatcher isn't running.");
            }
            Ok(())
        }
        DispatcherCommand::Restart => restart(&paths).await,
        DispatcherCommand::Status(args) => status(&paths, args.json).await,
        DispatcherCommand::Install => install(&paths).await,
        DispatcherCommand::Uninstall => {
            service::uninstall_dispatcher(&paths)?;
            eprintln!("Removed the Dispatcher's service; it no longer runs.");
            Ok(())
        }
        DispatcherCommand::Connect(args) => connect(&paths, args).await,
        DispatcherCommand::Disconnect => disconnect(),
    };
    done.map(|()| ExitCode::SUCCESS)
}

/// `weave dispatcher run`: hold the directory's lock, answer on its socket, and keep the
/// Hosts connected until SIGTERM or SIGINT. Its work is kept as it goes, so stopping it drains
/// nothing.
async fn run(paths: DispatcherPaths, args: RunArgs) -> anyhow::Result<()> {
    let remote = remote_settings(&args)?;
    let listening = socket::listen(&paths)
        .with_context(|| format!("listening on {}", paths.socket().display()))?;
    let mut config = DispatcherConfig::new(paths.clone());
    config.remote = Some(remote);
    let dispatcher = Dispatcher::open(config)
        .map_err(anyhow::Error::msg)
        .context("opening the Dispatcher's state")?;
    tracing::info!(dir = %paths.dir.display(), "the Dispatcher is running");
    tokio::select! {
        () = dispatcher.serve(listening.listener) => {}
        () = stop_signal() => {}
    }
    dispatcher.stop().await;
    tracing::info!("the Dispatcher stopped");
    Ok(())
}

/// Where the WebSocket listens, and whether Tailscale Serve brings devices to it: loopback port
/// 7342 and its own Serve entry, unless `--listen` and `--url` say otherwise. A URL leaves Serve
/// alone.
fn remote_settings(args: &RunArgs) -> anyhow::Result<RemoteSettings> {
    let text = args.listen.as_deref().unwrap_or(DEFAULT_LISTEN);
    let listen: SocketAddr = text
        .parse()
        .with_context(|| format!("--listen {text:?} isn't an address and port"))?;
    if !listen.ip().is_loopback() {
        bail!(
            "--listen {text:?} isn't a loopback address; the Dispatcher listens on loopback \
             only, and Tailscale Serve or whatever --url names forwards to it"
        );
    }
    Ok(RemoteSettings {
        url: args.url.clone(),
        ..RemoteSettings::new(listen, Arc::new(TailscaleServe::DISPATCHER))
    })
}

async fn install(paths: &DispatcherPaths) -> anyhow::Result<()> {
    if !service::dispatcher_installed(paths) && socket::connect(&paths.socket()).await.is_ok() {
        bail!(
            "a Dispatcher already runs from {}, not as a service: `weave dispatcher stop` stops it, \
             and the service takes over",
            paths.dir.display()
        );
    }
    let (executable, lingering) = service::install_dispatcher(paths)?;
    if !dispatcher::answers(paths).await {
        bail!(
            "installed the Dispatcher's service, but it didn't answer within {} seconds; its log \
             is {}",
            dispatcher::STARTUP_WAIT.as_secs(),
            paths.log().display()
        );
    }
    let lingering = lingering.map(|note| format!(" {note}")).unwrap_or_default();
    eprintln!(
        "Installed the Dispatcher as a {} service. It runs {} and restarts it if it stops; \
         `weave dispatcher uninstall` removes it.{lingering} Have a Host join it with `weave hosts \
         add <computer>`, pair your devices with `weave pair`, and your other computers with \
         `weave dispatcher connect` there.",
        service::manager_name(),
        executable.display()
    );
    Ok(())
}

/// Start the Dispatcher in the background, or have its service's manager start it, and wait for
/// it to answer.
async fn start(paths: &DispatcherPaths) -> anyhow::Result<()> {
    if socket::connect(&paths.socket()).await.is_ok() {
        eprintln!(
            "The Dispatcher is already running from {}.",
            paths.dir.display()
        );
        return Ok(());
    }
    if service::dispatcher_installed(paths) {
        service::start_dispatcher(paths)?;
    } else {
        paths
            .prepare()
            .with_context(|| format!("creating {}", paths.dir.display()))?;
        background::spawn(&["dispatcher", "run"], &paths.log(), "the Dispatcher")?;
    }
    if !dispatcher::answers(paths).await {
        bail!(
            "the Dispatcher didn't answer within {} seconds; its log is {}",
            dispatcher::STARTUP_WAIT.as_secs(),
            paths.log().display()
        );
    }
    eprintln!(
        "Started the Dispatcher from {}; it logs to {}.",
        paths.dir.display(),
        paths.log().display()
    );
    Ok(())
}

/// Stop the Dispatcher, through its service's manager when it's installed, which would start it
/// again otherwise, and wait for it to go. Returns whether it was running.
async fn stop(paths: &DispatcherPaths) -> anyhow::Result<bool> {
    let running = socket::connect(&paths.socket()).await.is_ok();
    if service::dispatcher_installed(paths) {
        service::stop_dispatcher(paths)?;
    } else if running {
        weave_host::socket::terminate_listener(&paths.socket())
            .await
            .with_context(|| format!("stopping the Dispatcher on {}", paths.socket().display()))?;
    }
    if !running {
        return Ok(false);
    }
    dispatcher::wait_until_stopped(paths).await?;
    eprintln!("Stopped the Dispatcher.");
    Ok(true)
}

/// Stop the Dispatcher if it's running, and start it again, through its service's manager when
/// it's installed.
async fn restart(paths: &DispatcherPaths) -> anyhow::Result<()> {
    if !service::dispatcher_installed(paths) {
        stop(paths).await?;
        return start(paths).await;
    }
    service::restart_dispatcher(paths).await?;
    if !dispatcher::answers(paths).await {
        bail!(
            "restarted the Dispatcher's service, but it didn't answer within {} seconds; its log \
             is {}",
            dispatcher::STARTUP_WAIT.as_secs(),
            paths.log().display()
        );
    }
    eprintln!(
        "Restarted the Dispatcher from {}; it logs to {}.",
        paths.dir.display(),
        paths.log().display()
    );
    Ok(())
}

async fn status(paths: &DispatcherPaths, json: bool) -> anyhow::Result<()> {
    let reached = match dispatcher::reach(paths).await {
        Ok(reached) => reached,
        Err(error) if remote_pairing()?.is_some() => return Err(error),
        Err(_) => {
            let installed = if service::dispatcher_installed(paths) {
                format!(
                    "Its {} service is installed but it isn't answering; its log is {}.",
                    service::manager_name(),
                    paths.log().display()
                )
            } else {
                "`weave dispatcher install` runs it as a service, or `weave dispatcher start` \
                 here. If it runs on another computer, `weave dispatcher connect <computer>` \
                 pairs this one with it."
                    .to_owned()
            };
            bail!(
                "the Dispatcher isn't running from {}. {installed}",
                paths.dir.display()
            );
        }
    };
    let dispatcher = reached.connection;
    let status = dispatcher.send(DispatcherStatusRequest {}).await?;
    let hosts = dispatcher.send(ListHostsRequest {}).await?.hosts;
    dispatcher.shutdown().await;
    if json {
        let value = serde_json::json!({
            "status": status,
            "hosts": hosts,
            "paired": reached.paired,
        });
        println!("{}", serde_json::to_string_pretty(&value)?);
        return Ok(());
    }
    let now = now_ms();
    let place = match &reached.paired {
        Some(paired) => format!(
            "on {}, which this computer is paired with as {}, at {}",
            paired.place(),
            paired.device_id,
            paired.url
        ),
        None => {
            let service = if service::dispatcher_installed(paths) {
                format!("its {} service", service::manager_name())
            } else {
                "a process of its own".to_owned()
            };
            format!("as {service}, from {}", paths.dir.display())
        }
    };
    let devices = match (status.devices, &reached.paired) {
        (_, Some(_)) => String::new(),
        (0, None) => String::new(),
        (1, None) => " 1 device is paired with it.".to_owned(),
        (devices, None) => format!(" {devices} devices are paired with it."),
    };
    println!(
        "The Dispatcher {} (pid {}) has run for {} {place}. Hosts that join it know it as \"{}\", and it {} \
         waiting for a Host.{devices}",
        status.version,
        status.pid,
        ago(now, status.started_at),
        status.name,
        match status.pending {
            0 => "has no work".to_owned(),
            1 => "has 1 piece of work".to_owned(),
            pending => format!("has {pending} pieces of work"),
        }
    );
    print!("\n{}", hosts::describe(&hosts, now));
    Ok(())
}

/// `weave dispatcher connect`: pair this computer with the Dispatcher on another, with a code
/// from `weave pair` there, which this runs over SSH unless given one, and keep the
/// pairing. Then offer to have this computer's Host join the Dispatcher.
async fn connect(paths: &DispatcherPaths, args: ConnectArgs) -> anyhow::Result<()> {
    if std::env::var_os(weave_dispatcher::paths::DIR_VARIABLE).is_some_and(|dir| !dir.is_empty()) {
        bail!(
            "$WEAVE_DISPATCHER_DIR names a Dispatcher here, which commands reach instead; unset \
             it to pair with one on another computer"
        );
    }
    if let Ok(local) = connect_here(paths).await {
        local.shutdown().await;
        bail!(
            "a Dispatcher runs here, from {}, and commands reach it rather than another. Stop it \
             (`weave dispatcher uninstall`, or `weave dispatcher stop`) to use one elsewhere",
            paths.dir.display()
        );
    }
    let (url, code, computer) = match reach_for(&DISPATCHER, &args.dispatcher, args.code)? {
        Reach::Code { url, code } => (url, code, None),
        Reach::Ssh(destination) => {
            let offered: Offered = serde_json::from_str(
                &ssh(&destination, &["pair", "--json"]).context("asking it for a code")?,
            )
            .context("reading what `weave pair --json` said there")?;
            (offered.url, offered.code, Some(ssh_name(&destination)))
        }
    };
    let name = args.name.unwrap_or_else(computer_name);
    let credentials = Credentials::Pair {
        code,
        name: name.clone(),
        key: paired::new_key()?,
        service: false,
    };
    let dispatcher = paired::connect_with(&url, credentials)
        .await
        .context("pairing with the Dispatcher")?;
    let hello = dispatcher.hello().clone();
    let paired = keep_pairing(url, computer, hello);
    let host = match paired {
        Ok(()) => {
            let wanted = match (args.host, args.no_host) {
                (true, _) => Some(true),
                (_, true) => Some(false),
                _ => None,
            };
            pair_host_here(&dispatcher, name, wanted).await
        }
        Err(error) => Err(error),
    };
    dispatcher.shutdown().await;
    host
}

/// Keep the pairing `hello` says this computer has with the Dispatcher at `url`, and say so.
fn keep_pairing(
    url: String,
    computer: Option<String>,
    hello: DispatcherHello,
) -> anyhow::Result<()> {
    let device = hello
        .device
        .context("the Dispatcher didn't say which device this computer is")?;
    let before = paired::load()?;
    let pairing = Paired {
        url,
        dispatcher_id: hello.id,
        device_id: device.id.clone(),
        computer,
        paired_at: now_ms(),
    };
    paired::save(&pairing)?;
    if let Some(before) = before.filter(|before| before.dispatcher_id != pairing.dispatcher_id) {
        eprintln!(
            "This replaces the pairing with the Dispatcher on {}, which lists this computer as {} \
             until you revoke it there.",
            before.place(),
            before.device_id
        );
    }
    println!(
        "Paired this computer with the Dispatcher on {} as {} ({}). `weave hosts` and `weave \
         schedules` reach it from here now; `weave dispatcher disconnect` forgets it.",
        pairing.place(),
        device.name,
        device.id
    );
    Ok(())
}

/// What `connect` says when it leaves this computer's Host alone.
const ADD_HERE_LATER: &str =
    "`weave hosts add` has this computer's Host join the Dispatcher, so it starts work here.";

/// Have this computer's Host join the Dispatcher too, as `name`, unless it has already, or
/// `wanted` or the person says not to. With no terminal to ask in, it only says how.
async fn pair_host_here(
    dispatcher: &DispatcherConnection,
    name: String,
    wanted: Option<bool>,
) -> anyhow::Result<()> {
    let Some(here) = host::control(&host::paths()?).await? else {
        if wanted == Some(true) {
            bail!("no weave Host runs here to join the Dispatcher");
        }
        println!(
            "No weave Host runs here, so the Dispatcher has nothing to start work on here; once \
             one does, `weave hosts add` has it join."
        );
        return Ok(());
    };
    let result = async {
        let host_id = &here.hello().host.id;
        let hosts = dispatcher.send(ListHostsRequest {}).await?.hosts;
        let joined = hosts.iter().find(|known| {
            &known.host_id == host_id
                && known.joined_at.is_some()
                && known.status != Reachability::Refused
        });
        if let Some(known) = joined {
            println!(
                "This computer's Host already joined the Dispatcher, as {}.",
                known.name
            );
            return Ok(());
        }
        let wanted = match wanted {
            Some(wanted) => wanted,
            None if std::io::stdin().is_terminal() => ask(
                "Have this computer's Host join the Dispatcher too, so it starts work here? [Y/n] ",
            )?,
            None => false,
        };
        if !wanted {
            println!("{ADD_HERE_LATER}");
            return Ok(());
        }
        let joined = hosts::join_from(dispatcher, &here, name, false)
            .await
            .context("having this computer's Host join the Dispatcher")?;
        println!(
            "This computer's Host joined the {} as {}: it starts work here.",
            joined.name, joined.host_name
        );
        Ok(())
    }
    .await;
    here.shutdown().await;
    result
}

/// Ask `question` at the terminal: yes unless the answer is no.
fn ask(question: &str) -> anyhow::Result<bool> {
    let mut stderr = std::io::stderr();
    write!(stderr, "{question}")?;
    stderr.flush()?;
    let mut answer = String::new();
    if std::io::stdin().lock().read_line(&mut answer)? == 0 {
        return Ok(false);
    }
    let answer = answer.trim().to_ascii_lowercase();
    Ok(!matches!(answer.as_str(), "n" | "no"))
}

/// `weave dispatcher disconnect`: forget the pairing, and the key this computer proved itself
/// with. A device can't revoke itself, so the Dispatcher lists it until it's revoked there.
fn disconnect() -> anyhow::Result<()> {
    match paired::forget()? {
        Some(paired) => println!(
            "Forgot the Dispatcher on {}. It lists this computer as {} until you run `weave \
             devices revoke {}` there.",
            paired.place(),
            paired.device_id,
            paired.device_id
        ),
        None => println!("This computer isn't paired with a Dispatcher."),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::unwrap_used)]

    use super::*;

    #[test]
    fn a_url_leaves_tailscale_serve_alone_and_listen_must_be_loopback() {
        let default = remote_settings(&RunArgs::default()).unwrap();
        assert_eq!(default.listen.to_string(), DEFAULT_LISTEN);
        assert_eq!(default.url, None);

        let dev = remote_settings(&RunArgs {
            listen: Some("127.0.0.1:47342".to_owned()),
            url: Some("ws://127.0.0.1:47342".to_owned()),
        })
        .unwrap();
        assert_eq!(dev.listen.to_string(), "127.0.0.1:47342");
        assert_eq!(dev.url.as_deref(), Some("ws://127.0.0.1:47342"));

        let open = remote_settings(&RunArgs {
            listen: Some("0.0.0.0:7342".to_owned()),
            url: None,
        });
        assert!(
            open.err()
                .unwrap()
                .to_string()
                .contains("isn't a loopback address")
        );
        assert!(
            remote_settings(&RunArgs {
                listen: Some("nowhere".to_owned()),
                url: None,
            })
            .is_err()
        );
    }
}
