//! `weave bots`: the person's Bots, which the Dispatcher keeps (ADR 0028, WVE-118): named
//! assistants, each with an agent and a home of its own memory on one of the person's Hosts,
//! whose work goes on there in one thread at a time. Listing them, adding one, showing, changing
//! and removing one, sending one a prompt, and starting its new thread.
//!
//! `weave bots add` has the Dispatcher add a Bot, which has the Bot's Host make its home first
//! (WVE-178): the directory, a git repository of its own and its first memory files, on this
//! computer's Host or another's alike. It says what that did ([`home`]).

mod home;

use std::path::Path;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use anyhow::Context as _;
use anyhow::bail;
use clap::Args;
use clap::Subcommand;
use weave_dispatcher::client::DispatcherConnection;
use weave_host_protocol::Empty;
use weave_host_protocol::dispatcher::AddBotRequest;
use weave_host_protocol::dispatcher::BOTS_FEATURE;
use weave_host_protocol::dispatcher::BOTS_HOME_FEATURE;
use weave_host_protocol::dispatcher::Bot;
use weave_host_protocol::dispatcher::BotColor;
use weave_host_protocol::dispatcher::BotState;
use weave_host_protocol::dispatcher::GetBotRequest;
use weave_host_protocol::dispatcher::ListBotsRequest;
use weave_host_protocol::dispatcher::ListHostsRequest;
use weave_host_protocol::dispatcher::ListSchedulesRequest;
use weave_host_protocol::dispatcher::NewBotThreadRequest;
use weave_host_protocol::dispatcher::RemoveBotRequest;
use weave_host_protocol::dispatcher::Schedule;
use weave_host_protocol::dispatcher::SendToBotRequest;
use weave_host_protocol::dispatcher::UpdateBotRequest;
use weave_host_protocol::policy::PermissionPolicy;
use weave_host_protocol::policy::Unapproved;

use crate::args::approve_words;
use crate::args::directory_on;
use crate::args::prompt_text;
use crate::args::shell_words;
use crate::args::tool_kinds;
use crate::clock;
use crate::clock::ago;
use crate::clock::now_ms;
use crate::commands::schedules;
use crate::dispatcher;
use crate::host;
use crate::turn::parse_timeout;

pub const LOG: &str = "warn";

#[derive(Args)]
pub struct BotsArgs {
    #[command(subcommand)]
    command: Option<BotsCommand>,
}

#[derive(Subcommand)]
enum BotsCommand {
    /// The Bots, what each is doing, and its thread (the default).
    List(JsonArgs),
    /// Add a Bot on one of your Hosts, which makes its home first. It has no thread until the
    /// first prompt you send it.
    Add(Box<AddArgs>),
    /// A Bot: how it's set up, its threads and its schedules.
    Show(BotArgs),
    /// Change a Bot. A thread it has open keeps the approvals and mode it started with.
    Update(Box<UpdateArgs>),
    /// Forget a Bot and its schedules. Its threads and its home stay.
    Remove(BotArgs),
    /// Send a Bot a prompt: into its thread, or starting its first.
    Send(SendArgs),
    /// Start a Bot's new thread: its thread saves what it knows to its home first.
    NewThread(BotArgs),
}

#[derive(Args, Default)]
struct JsonArgs {
    /// Print them as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct BotArgs {
    /// The Bot's name or id.
    bot: String,
    /// Print what the Dispatcher answered as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct AddArgs {
    /// Its name, unique among your Bots ignoring case.
    name: String,

    /// The agent its threads run, by its id on the Bot's Host, as `weave agents` lists them
    /// there.
    #[arg(long)]
    agent: String,

    /// The Host its threads run on, by its id or name as `weave hosts` lists them; this
    /// computer's when omitted, which has to have joined the Dispatcher.
    #[arg(long, value_name = "HOST")]
    host: Option<String>,

    /// Its home on that Host: the git repository of its own its threads run in and its memory
    /// is kept in, whole or under ~ there; on this computer's Host, from this directory too.
    /// ~/bots/<name> when omitted. The Host makes it, with its first memory files, unless one
    /// of them is there.
    #[arg(long, value_name = "DIR")]
    home: Option<PathBuf>,

    /// What it's for, in your words, which its first AGENTS.md says.
    #[arg(long, value_name = "TEXT")]
    job: Option<String>,

    /// Tool kinds its threads approve without asking you, comma-separated: read, edit, delete,
    /// move, search, execute, think, fetch, switch_mode, other; or all. It asks you about the
    /// rest.
    #[arg(long, value_delimiter = ',', value_name = "KINDS")]
    approve: Vec<String>,

    /// The mode its threads start in; the agent's configured one when omitted.
    #[arg(long)]
    mode: Option<String>,

    /// Start a new thread every day at this time, in --zone, once its thread has had a turn.
    #[arg(long, value_name = "HH:MM")]
    new_thread_at: Option<String>,

    /// The IANA time zone its times are in, such as Africa/Johannesburg; the Dispatcher's
    /// computer's when omitted.
    #[arg(long)]
    zone: Option<String>,

    /// How long a request in its thread may wait for you before its schedules pause, until
    /// it's answered: 90s, 30m, 12h. 12h when omitted.
    #[arg(long, value_name = "DURATION", value_parser = parse_timeout)]
    pause_after: Option<Duration>,

    /// Its avatar's emoji.
    #[arg(long)]
    emoji: Option<String>,

    /// The colour its avatar is drawn on: white, brown, red, orange, yellow, green, teal, blue,
    /// purple, pink or gray.
    #[arg(long, value_parser = parse_color)]
    color: Option<BotColor>,

    /// Print the Bot as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct UpdateArgs {
    /// The Bot's name or id.
    bot: String,

    /// Its new name.
    #[arg(long)]
    name: Option<String>,

    /// Tool kinds its threads approve without asking you, in place of those they do now,
    /// comma-separated: read, edit, delete, move, search, execute, think, fetch, switch_mode,
    /// other; or all. It asks you about the rest.
    #[arg(long, value_delimiter = ',', value_name = "KINDS")]
    approve: Option<Vec<String>>,

    /// Approve nothing: ask you about every tool.
    #[arg(long, conflicts_with = "approve")]
    no_approve: bool,

    /// The mode its threads start in.
    #[arg(long)]
    mode: Option<String>,

    /// Start its threads in the agent's configured mode.
    #[arg(long, conflicts_with = "mode")]
    no_mode: bool,

    /// Start a new thread every day at this time, in its zone, once its thread has had a turn.
    #[arg(long, value_name = "HH:MM")]
    new_thread_at: Option<String>,

    /// Start a new thread only when asked.
    #[arg(long, conflicts_with = "new_thread_at")]
    no_new_thread_at: bool,

    /// The IANA time zone its times are in, such as Africa/Johannesburg.
    #[arg(long)]
    zone: Option<String>,

    /// How long a request in its thread may wait for you before its schedules pause: 90s, 30m,
    /// 12h.
    #[arg(long, value_name = "DURATION", value_parser = parse_timeout)]
    pause_after: Option<Duration>,

    /// Its avatar's emoji.
    #[arg(long)]
    emoji: Option<String>,

    /// The colour its avatar is drawn on: white, brown, red, orange, yellow, green, teal, blue,
    /// purple, pink or gray.
    #[arg(long, value_parser = parse_color)]
    color: Option<BotColor>,

    /// Give it no avatar of its own: neither emoji nor colour.
    #[arg(long, conflicts_with_all = ["emoji", "color"])]
    no_avatar: bool,

    /// Print the Bot as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct SendArgs {
    /// The Bot's name or id.
    bot: String,

    /// The prompt; read from stdin when omitted or `-`.
    prompt: Vec<String>,

    /// A name of your choosing, such as a UUID: sending again with it, after a dropped
    /// connection, sends nothing twice.
    #[arg(long)]
    key: Option<String>,

    /// Print what the Dispatcher answered as JSON.
    #[arg(long)]
    json: bool,
}

pub async fn command(args: BotsArgs) -> anyhow::Result<ExitCode> {
    let command = args
        .command
        .unwrap_or_else(|| BotsCommand::List(JsonArgs::default()));
    // A prompt is read first, so a missing one is said before the Dispatcher is asked.
    let prompt = match &command {
        BotsCommand::Send(send) => Some(prompt_text(&send.prompt)?),
        _ => None,
    };
    let dispatcher = dispatcher::connect(&dispatcher::paths()?).await?;
    let done = async {
        dispatcher::require(&dispatcher, BOTS_FEATURE, "Bots")?;
        match command {
            BotsCommand::List(JsonArgs { json }) => list(&dispatcher, json).await,
            BotsCommand::Add(args) => add(&dispatcher, *args).await,
            BotsCommand::Show(args) => show(&dispatcher, args).await,
            BotsCommand::Update(args) => update(&dispatcher, *args).await,
            BotsCommand::Remove(args) => remove(&dispatcher, args).await,
            BotsCommand::Send(args) => send(&dispatcher, args, prompt.unwrap_or_default()).await,
            BotsCommand::NewThread(args) => new_thread(&dispatcher, args).await,
        }
    }
    .await;
    dispatcher.shutdown().await;
    done.map(|()| ExitCode::SUCCESS)
}

async fn list(dispatcher: &DispatcherConnection, json: bool) -> anyhow::Result<()> {
    let bots = dispatcher.send(ListBotsRequest {}).await?.bots;
    if json {
        println!("{}", serde_json::to_string_pretty(&bots)?);
    } else {
        print!("{}", describe(&bots));
    }
    Ok(())
}

async fn show(dispatcher: &DispatcherConnection, args: BotArgs) -> anyhow::Result<()> {
    let bot = dispatcher.send(GetBotRequest { bot: args.bot }).await?.bot;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&bot)?);
        return Ok(());
    }
    // A Dispatcher without `bots_home` lists them all, so they're filtered here too.
    let schedules: Vec<Schedule> = dispatcher
        .send(ListSchedulesRequest {
            bot: Some(bot.id.clone()),
        })
        .await?
        .schedules
        .into_iter()
        .filter(|schedule| schedule.bot_id.as_deref() == Some(bot.id.as_str()))
        .collect();
    print!("{}", describe_one(&bot, &schedules, now_ms()));
    Ok(())
}

async fn add(dispatcher: &DispatcherConnection, args: AddArgs) -> anyhow::Result<()> {
    dispatcher::require(dispatcher, BOTS_HOME_FEATURE, "making Bots' homes")?;
    let name = args.name.trim().to_owned();
    if name.is_empty() || name.chars().any(char::is_control) {
        bail!("a Bot's name is one line of text");
    }
    let policy = PermissionPolicy {
        approve: tool_kinds(&args.approve)?,
        otherwise: Unapproved::Ask,
    };
    if let Some(zone) = &args.zone {
        clock::zone(zone)?;
    }
    let hosts = dispatcher.send(ListHostsRequest {}).await?.hosts;
    let own = weave_host::own_id(&host::paths()?);
    let host = match &args.host {
        Some(by) => hosts
            .iter()
            .find(|host| host.host_id == *by)
            .or_else(|| hosts.iter().find(|host| host.name.eq_ignore_ascii_case(by)))
            .with_context(|| {
                format!(
                    "no Host called {by} has joined the Dispatcher; `weave hosts` lists those \
                     that have"
                )
            })?,
        None => own
            .as_deref()
            .and_then(|own| hosts.iter().find(|host| host.host_id == own))
            .context(
                "this computer's Host hasn't joined the Dispatcher, so name the Bot's Host with \
                 --host, one `weave hosts` lists; or have this computer's join with `weave hosts \
                 add`",
            )?,
    };
    let here = own.as_deref() == Some(host.host_id.as_str());
    let home = match &args.home {
        None => None,
        Some(dir) if here => Some(home_here(dir)?),
        Some(dir) => Some(directory_on(Some(dir), &host.name, "--home")?),
    };
    let added = dispatcher
        .send(AddBotRequest {
            name,
            host: host.host_id.clone(),
            agent_id: args.agent,
            home,
            job: args.job,
            policy: Some(policy),
            mode: args.mode,
            new_thread_at: args.new_thread_at,
            zone: args.zone,
            pause_after: args.pause_after.map(millis),
            emoji: args.emoji,
            color: args.color,
        })
        .await?;
    let bot = added.bot;
    // What making the home did comes first; with --json, beside the Bot, on stderr.
    if let Some(made) = &added.home {
        let made = home::said(made, &bot.name);
        match args.json {
            true => eprintln!("{made}"),
            false => println!("{made}"),
        }
    }
    if args.json {
        println!("{}", serde_json::to_string_pretty(&bot)?);
    } else {
        println!(
            "Added the Bot {}, with {} on {}, at home in {}. The first prompt you send it starts \
             its first thread: `weave bots send {} <prompt>`.",
            bot.name,
            bot.agent_id,
            host_name(&bot),
            bot.home.display(),
            shell_words(std::slice::from_ref(&bot.name))
        );
    }
    Ok(())
}

/// The colour `--color` names.
fn parse_color(name: &str) -> Result<BotColor, String> {
    BotColor::named(&name.to_lowercase()).ok_or_else(|| {
        let names: Vec<&str> = BotColor::ALL.into_iter().map(BotColor::name).collect();
        format!("no colour {name}: one of {}", names.join(", "))
    })
}

/// `home`, as given for a Bot on this computer's Host: `~/…` as it is, for the Host to put under
/// its home, and a relative one from this directory.
fn home_here(home: &Path) -> anyhow::Result<PathBuf> {
    if home.starts_with("~") || home.is_absolute() {
        return Ok(home.to_path_buf());
    }
    std::path::absolute(home).with_context(|| format!("the directory {}", home.display()))
}

async fn update(dispatcher: &DispatcherConnection, args: UpdateArgs) -> anyhow::Result<()> {
    let policy = match (&args.approve, args.no_approve) {
        (Some(kinds), _) => Some(PermissionPolicy {
            approve: tool_kinds(kinds)?,
            otherwise: Unapproved::Ask,
        }),
        (None, true) => Some(PermissionPolicy::ask()),
        (None, false) => None,
    };
    let mode = match (args.mode, args.no_mode) {
        (Some(mode), _) => Some(Some(mode)),
        (None, true) => Some(None),
        (None, false) => None,
    };
    let new_thread_at = match (args.new_thread_at, args.no_new_thread_at) {
        (Some(at), _) => Some(Some(at)),
        (None, true) => Some(None),
        (None, false) => None,
    };
    if let Some(zone) = &args.zone {
        clock::zone(zone)?;
    }
    let starts_otherwise = policy.is_some() || mode.is_some();
    let request = UpdateBotRequest {
        bot: args.bot.clone(),
        name: args.name,
        policy,
        mode,
        new_thread_at,
        zone: args.zone,
        pause_after: args.pause_after.map(millis),
        emoji: match args.no_avatar {
            true => Some(None),
            false => args.emoji.map(Some),
        },
        color: match args.no_avatar {
            true => Some(None),
            false => args.color.map(Some),
        },
    };
    if request
        == (UpdateBotRequest {
            bot: args.bot.clone(),
            ..UpdateBotRequest::default()
        })
    {
        bail!(
            "nothing to change: give --name, --approve, --mode, --new-thread-at, --zone or \
             --pause-after, or --no-approve, --no-mode or --no-new-thread-at"
        );
    }
    let renamed = request.name.is_some();
    let bot = dispatcher.send(request).await?.bot;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&bot)?);
        return Ok(());
    }
    let mut said = match renamed {
        true => format!("Changed {}, now called {}.", args.bot, bot.name),
        false => format!("Changed {}.", bot.name),
    };
    if starts_otherwise && bot.thread.is_some() {
        said.push_str(
            " Its thread keeps the approvals and mode it started with; its next thread takes \
             these.",
        );
    }
    println!("{said}");
    Ok(())
}

async fn remove(dispatcher: &DispatcherConnection, args: BotArgs) -> anyhow::Result<()> {
    let bot = dispatcher.send(GetBotRequest { bot: args.bot }).await?.bot;
    let removed: Empty = dispatcher
        .send(RemoveBotRequest {
            bot: bot.id.clone(),
        })
        .await?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&removed)?);
        return Ok(());
    }
    let host = host_name(&bot);
    let home = bot.home.display();
    let stays = match bot.threads.is_empty() {
        true => format!("Its home, {home}, stays on {host} as it was."),
        false => format!("Its threads and its home, {home}, stay on {host} as they were."),
    };
    println!("Removed the Bot {} and its schedules. {stays}", bot.name);
    Ok(())
}

async fn send(
    dispatcher: &DispatcherConnection,
    args: SendArgs,
    prompt: String,
) -> anyhow::Result<()> {
    let sent = dispatcher
        .send(SendToBotRequest {
            bot: args.bot,
            prompt: vec![prompt.into()],
            key: args.key,
        })
        .await?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&sent)?);
    } else {
        println!("{}", sent_to(&sent.bot));
    }
    Ok(())
}

/// Where a prompt just sent to `bot` goes.
fn sent_to(bot: &Bot) -> String {
    let name = &bot.name;
    let mut said = match (&bot.thread, bot.starting_thread) {
        (_, true) => format!(
            "Sent to {name}, which is starting a new thread: it waits for that thread, and goes \
             into it."
        ),
        (Some(thread), false) => match bot.state {
            BotState::Working => {
                format!("Sent to {name}, into its thread {thread}, after the turn running there.")
            }
            BotState::NeedsYou => format!(
                "Sent to {name}, into its thread {thread}, after the turn there, which waits on \
                 you."
            ),
            BotState::Idle => format!("Sent to {name}, into its thread {thread}."),
        },
        (None, false) => format!(
            "Sent to {name}, which has no thread yet: it starts its first, in {}.",
            bot.home.display()
        ),
    };
    if !bot.connected {
        said.push_str(&format!(
            " Its Host, {}, isn't connected, so it waits for it.",
            host_name(bot)
        ));
    }
    said
}

async fn new_thread(dispatcher: &DispatcherConnection, args: BotArgs) -> anyhow::Result<()> {
    let bot = dispatcher
        .send(NewBotThreadRequest { bot: args.bot })
        .await?
        .bot;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&bot)?);
        return Ok(());
    }
    let thread = bot
        .thread
        .as_ref()
        .map(|thread| format!(" {thread}"))
        .unwrap_or_default();
    let mut said = format!(
        "{name} is starting a new thread. Once its thread{thread} is idle, it saves what it \
         knows to its home, {home}, and notes itself in threads/ there; then the new thread \
         starts. Prompts you send {name} meanwhile wait for the new thread.",
        name = bot.name,
        home = bot.home.display(),
    );
    if !bot.connected {
        said.push_str(&format!(
            " Its Host, {}, isn't connected, so this waits for it.",
            host_name(&bot)
        ));
    }
    println!("{said}");
    Ok(())
}

/// `duration` in milliseconds, as the Dispatcher takes it.
fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

/// What the Dispatcher calls `bot`'s Host, or its id.
fn host_name(bot: &Bot) -> &str {
    match bot.host_name.is_empty() {
        true => &bot.host_id,
        false => &bot.host_name,
    }
}

/// How `bot` is: "working", "needs you", "idle", and whether it's starting a new thread or its
/// schedules are paused.
fn state(bot: &Bot) -> String {
    let mut words = vec![
        match bot.state {
            BotState::Working => "working",
            BotState::NeedsYou => "needs you",
            BotState::Idle => "idle",
        }
        .to_owned(),
    ];
    if bot.starting_thread {
        words.push("starting a new thread".to_owned());
    }
    if let Some(why) = &bot.paused {
        words.push(format!("paused: {why}"));
    }
    words.join(", ")
}

/// `bot`'s Host, and whether the Dispatcher is connected to it.
fn host(bot: &Bot) -> String {
    match bot.connected {
        true => host_name(bot).to_owned(),
        false => format!("{} (not connected)", host_name(bot)),
    }
}

/// The Bot that made `bot`, if one did: by name, or by id once it's gone.
fn made_by(bot: &Bot) -> Option<String> {
    let id = bot.created_by.as_ref()?;
    Some(match &bot.created_by_name {
        Some(name) => name.clone(),
        None => format!("the Bot {id}, since removed"),
    })
}

/// A line for each Bot: "odin  working  claude on studio  thread 019a…", and "made by mimir"
/// for one another Bot made.
fn describe(bots: &[Bot]) -> String {
    if bots.is_empty() {
        return "You have no Bots; `weave bots add <name> --agent <id>` adds one.\n".to_owned();
    }
    let width = bots
        .iter()
        .map(|bot| bot.name.chars().count())
        .max()
        .unwrap_or(0);
    bots.iter()
        .map(|bot| {
            let thread = match &bot.thread {
                Some(thread) => format!("thread {thread}"),
                None => "no thread yet".to_owned(),
            };
            let maker = match made_by(bot) {
                Some(maker) => format!("  made by {maker}"),
                None => String::new(),
            };
            format!(
                "{:width$}  {}  {} on {}  {thread}{maker}\n",
                bot.name,
                state(bot),
                bot.agent_id,
                host(bot)
            )
        })
        .collect()
}

/// Everything about `bot`, with its schedules, by the flags that set it.
fn describe_one(bot: &Bot, schedules: &[Schedule], now: u64) -> String {
    let mut head = state(bot);
    if let (BotState::NeedsYou, Some(since)) = (bot.state, bot.waiting_since) {
        head.push_str(&format!(" (for {})", ago(now, since)));
    }
    let approve = match (approve_words(&bot.policy.approve), bot.policy.otherwise) {
        (words, _) if words == "all" => words,
        (words, Unapproved::Ask) if words.is_empty() => {
            "nothing: it asks you about every tool".to_owned()
        }
        (words, Unapproved::Reject) if words.is_empty() => {
            "nothing: it refuses every tool".to_owned()
        }
        (words, Unapproved::Ask) => format!("{words}; it asks you about the rest"),
        (words, Unapproved::Reject) => format!("{words}; it refuses the rest"),
    };
    let threads: Vec<String> = match bot.threads.is_empty() {
        true => vec!["none yet: the first prompt you send it starts one".to_owned()],
        false => bot
            .threads
            .iter()
            .map(|thread| {
                let from = clock::stamp(thread.started_at, &bot.zone);
                match thread.ended_at {
                    Some(ended) => format!(
                        "{}  {from} to {}",
                        thread.thread_id,
                        clock::stamp(ended, &bot.zone)
                    ),
                    None => format!("{}  {from} on, its thread now", thread.thread_id),
                }
            })
            .collect(),
    };
    let schedules: Vec<String> = match schedules.is_empty() {
        true => vec![format!(
            "none: `weave schedules add --bot {}` adds one",
            shell_words(std::slice::from_ref(&bot.name))
        )],
        false => schedules
            .iter()
            .map(|schedule| match schedule.wake_up {
                true => format!(
                    "{}; a wake-up it asked for",
                    schedules::summary(schedule, now)
                ),
                false => schedules::summary(schedule, now),
            })
            .collect(),
    };
    let mut fields: Vec<(&str, Vec<String>)> = vec![
        ("agent", vec![bot.agent_id.clone()]),
        ("host", vec![host(bot)]),
        ("home", vec![bot.home.display().to_string()]),
        ("approve", vec![approve]),
        (
            "mode",
            vec![
                bot.mode
                    .clone()
                    .unwrap_or_else(|| "the agent's configured one".to_owned()),
            ],
        ),
        (
            "new thread at",
            vec![match &bot.new_thread_at {
                Some(at) => format!("{at} every day"),
                None => "only when asked".to_owned(),
            }],
        ),
        ("zone", vec![bot.zone.clone()]),
        ("pause after", vec![clock::duration(bot.pause_after)]),
        ("threads", threads),
        ("schedules", schedules),
        ("id", vec![bot.id.clone()]),
    ];
    if bot.emoji.is_some() || bot.color.is_some() {
        let avatar = [bot.emoji.as_deref(), bot.color.map(BotColor::name)];
        fields.push((
            "avatar",
            vec![
                avatar
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" on "),
            ],
        ));
    }
    if let Some(maker) = made_by(bot) {
        fields.push(("made by", vec![maker]));
    }
    let width = fields
        .iter()
        .map(|(label, _)| label.len())
        .max()
        .unwrap_or(0);
    let mut text = format!("{}  {head}\n", bot.name);
    for (label, lines) in fields {
        for (index, line) in lines.iter().enumerate() {
            let label = if index == 0 { label } else { "" };
            text.push_str(&format!("  {label:width$}  {line}\n"));
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use weave_acp_core::schema::ToolKind;
    use weave_host_protocol::dispatcher::BotThread;
    use weave_host_protocol::threads::ThreadId;

    use super::*;

    fn odin() -> Bot {
        Bot {
            id: "b-1".to_owned(),
            name: "odin".to_owned(),
            emoji: None,
            color: None,
            agent_id: "claude".into(),
            host_id: "h-1".to_owned(),
            host_name: "studio".to_owned(),
            connected: true,
            home: "~/bots/odin".into(),
            policy: PermissionPolicy::ask(),
            mode: None,
            new_thread_at: None,
            zone: "UTC".to_owned(),
            pause_after: 12 * 3_600_000,
            thread: None,
            threads: Vec::new(),
            state: BotState::Idle,
            waiting_since: None,
            paused: None,
            starting_thread: false,
            created_at: 0,
            updated_at: 0,
            created_by: None,
            created_by_name: None,
        }
    }

    #[test]
    fn bots_are_listed_a_line_each() {
        let mimir = Bot {
            name: "mimir".to_owned(),
            connected: false,
            thread: Some(ThreadId::new("t-1".to_owned())),
            state: BotState::NeedsYou,
            starting_thread: true,
            paused: Some("its thread has waited on the person since Wed 4 Nov 09:00 UTC".into()),
            ..odin()
        };
        assert_eq!(
            describe(&[odin(), mimir]),
            "odin   idle  claude on studio  no thread yet\n\
             mimir  needs you, starting a new thread, paused: its thread has waited on the person \
             since Wed 4 Nov 09:00 UTC  claude on studio (not connected)  thread t-1\n"
        );
        assert!(describe(&[]).starts_with("You have no Bots"));
    }

    #[test]
    fn a_bot_is_shown_by_the_flags_that_set_it() {
        let hour = 3_600_000;
        let bot = Bot {
            policy: PermissionPolicy {
                approve: vec![ToolKind::Read, ToolKind::Edit],
                otherwise: Unapproved::Ask,
            },
            new_thread_at: Some("04:00".to_owned()),
            pause_after: 6 * hour,
            thread: Some(ThreadId::new("t-2".to_owned())),
            threads: vec![
                BotThread {
                    thread_id: ThreadId::new("t-1".to_owned()),
                    started_at: 0,
                    ended_at: Some(28 * hour),
                },
                BotThread {
                    thread_id: ThreadId::new("t-2".to_owned()),
                    started_at: 28 * hour,
                    ended_at: None,
                },
            ],
            state: BotState::NeedsYou,
            waiting_since: Some(29 * hour),
            ..odin()
        };
        assert_eq!(
            describe_one(&bot, &[], 31 * hour),
            "odin  needs you (for 2h)\n  \
             agent          claude\n  \
             host           studio\n  \
             home           ~/bots/odin\n  \
             approve        read,edit; it asks you about the rest\n  \
             mode           the agent's configured one\n  \
             new thread at  04:00 every day\n  \
             zone           UTC\n  \
             pause after    6h\n  \
             threads        t-1  1970-01-01 00:00 to 1970-01-02 04:00\n                 \
             t-2  1970-01-02 04:00 on, its thread now\n  \
             schedules      none: `weave schedules add --bot odin` adds one\n  \
             id             b-1\n"
        );
    }

    #[test]
    fn a_bot_another_made_says_which() {
        let scribe = Bot {
            name: "scribe".to_owned(),
            created_by: Some("b-1".to_owned()),
            created_by_name: Some("odin".to_owned()),
            ..odin()
        };
        assert_eq!(
            describe(std::slice::from_ref(&scribe)),
            "scribe  idle  claude on studio  no thread yet  made by odin\n"
        );
        assert!(
            describe_one(&scribe, &[], 0)
                .ends_with("  id             b-1\n  made by        odin\n"),
            "{}",
            describe_one(&scribe, &[], 0)
        );
        let orphan = Bot {
            created_by_name: None,
            ..scribe
        };
        assert_eq!(
            made_by(&orphan).as_deref(),
            Some("the Bot b-1, since removed")
        );
        assert_eq!(made_by(&odin()), None);
    }

    #[test]
    fn sending_says_where_the_prompt_goes() {
        assert_eq!(
            sent_to(&odin()),
            "Sent to odin, which has no thread yet: it starts its first, in ~/bots/odin."
        );
        let working = Bot {
            thread: Some(ThreadId::new("t-1".to_owned())),
            state: BotState::Working,
            connected: false,
            ..odin()
        };
        assert_eq!(
            sent_to(&working),
            "Sent to odin, into its thread t-1, after the turn running there. Its Host, studio, \
             isn't connected, so it waits for it."
        );
        let starting = Bot {
            starting_thread: true,
            ..working
        };
        assert!(sent_to(&starting).contains("which is starting a new thread"));
    }
}
