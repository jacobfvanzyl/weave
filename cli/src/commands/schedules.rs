//! `weave schedules`: the Dispatcher's schedules (WVE-145), which start a headless turn on one of
//! the person's Hosts at the times a cron expression gives, or once, at a time (a one-off), or
//! prompt one of their Bots then (WVE-118); and what each time did.

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::Context as _;
use anyhow::bail;
use clap::ArgGroup;
use clap::Args;
use clap::Subcommand;
use clap::ValueEnum;
use weave_dispatcher::client::DispatcherConnection;
use weave_host_protocol::dispatcher::AddScheduleRequest;
use weave_host_protocol::dispatcher::BOTS_FEATURE;
use weave_host_protocol::dispatcher::ListOccurrencesRequest;
use weave_host_protocol::dispatcher::ListSchedulesRequest;
use weave_host_protocol::dispatcher::Missed;
use weave_host_protocol::dispatcher::Occurrence;
use weave_host_protocol::dispatcher::OccurrenceState;
use weave_host_protocol::dispatcher::Overlap;
use weave_host_protocol::dispatcher::PauseScheduleRequest;
use weave_host_protocol::dispatcher::RemoveScheduleRequest;
use weave_host_protocol::dispatcher::ResumeScheduleRequest;
use weave_host_protocol::dispatcher::RunScheduleRequest;
use weave_host_protocol::dispatcher::Schedule;
use weave_host_protocol::policy::PermissionPolicy;
use weave_host_protocol::threads::TurnState;

use crate::args::ApproveArgs;
use crate::args::prompt_text;
use crate::clock;
use crate::clock::ago;
use crate::clock::now_ms;
use crate::dispatcher;
use crate::dispatcher::connect;
use crate::projects;
use crate::projects::On;

pub const LOG: &str = "warn";

#[derive(Args)]
pub struct SchedulesArgs {
    #[command(subcommand)]
    command: Option<SchedulesCommand>,
}

#[derive(Subcommand)]
enum SchedulesCommand {
    /// The schedules, when each runs next and how it last went (the default).
    List(JsonArgs),
    /// Add a schedule: at the times `--cron` gives, or once `--at` a time, start a headless turn
    /// on a Host, or prompt a Bot.
    Add(Box<AddArgs>),
    /// Forget a schedule and what it did. A turn it started runs on.
    Remove(NameArgs),
    /// Run nothing on schedule until resumed.
    Pause(NameArgs),
    /// Run on schedule again from now, catching up nothing missed while paused.
    Resume(NameArgs),
    /// Run it now, paused or not, as an occurrence of its own.
    Run(NameArgs),
    /// What schedules did each time they came due, newest first.
    Occurrences(OccurrencesArgs),
}

#[derive(Args, Default)]
struct JsonArgs {
    /// Print them as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct NameArgs {
    /// The schedule's name or id.
    schedule: String,
}

#[derive(Args)]
#[command(group(ArgGroup::new("when").required(true).args(["cron", "at"])))]
struct AddArgs {
    /// Its name, unique among the Dispatcher's schedules.
    name: String,

    /// When it runs: five fields, minute hour day-of-month month day-of-week, such as
    /// "0 9 * * 1-5" for 09:00 on weekdays; or @hourly, @daily, @weekly, @monthly.
    #[arg(long)]
    cron: Option<String>,

    /// Run once, at this time, in place of --cron: 2026-11-12 09:00, in --zone, or
    /// 2026-11-12T09:00:00+02:00.
    #[arg(long, value_name = "TIME")]
    at: Option<String>,

    /// The IANA time zone its times are in, such as Africa/Johannesburg; the Dispatcher's
    /// computer's when omitted, or with --at, this computer's.
    #[arg(long)]
    zone: Option<String>,

    /// Prompt this Bot, by its name or id, in place of --host, --agent, --cwd and the rest: each
    /// time goes into its thread, or starts its first, as the Bot is set up then.
    #[arg(
        long,
        value_name = "BOT",
        conflicts_with_all = [
            "host", "agent", "cwd", "project", "thread", "mode", "approve", "allow_overlap"
        ]
    )]
    bot: Option<String>,

    /// The Host it runs on, by name or id: one `weave hosts` lists.
    #[arg(long, required_unless_present = "bot")]
    host: Option<String>,

    /// The agent on that Host, as `weave agents` lists them there.
    #[arg(long, required_unless_present = "bot")]
    agent: Option<String>,

    /// The directory on that Host it runs in; `~/` starts at the home there. This directory
    /// when omitted.
    #[arg(long)]
    cwd: Option<PathBuf>,

    /// Run in a Project, by its name or id as `weave projects` lists them: in its location on
    /// that Host, a repository's primary worktree. A Project with no location there is refused.
    #[arg(long, value_name = "PROJECT", conflicts_with = "cwd")]
    project: Option<String>,

    /// Prompt this thread each time, by its id, instead of starting a new one.
    #[arg(long)]
    thread: Option<String>,

    /// The mode a new thread starts in; the agent's configured one when omitted.
    #[arg(long, conflicts_with = "thread")]
    mode: Option<String>,

    #[command(flatten)]
    approve: ApproveArgs,

    /// What to do about a time it missed, as while the Dispatcher's computer slept: run the
    /// latest once, late, within a week (the default), or skip it.
    #[arg(long, value_enum, default_value_t = MissedArg::Latest)]
    missed: MissedArg,

    /// Start an occurrence while its previous one is still waiting or running, in a thread of
    /// its own; by default it's skipped.
    #[arg(long, conflicts_with = "thread")]
    allow_overlap: bool,

    /// The prompt; read from stdin when omitted or `-`.
    #[arg(last = true)]
    prompt: Vec<String>,
}

#[derive(Clone, Copy, ValueEnum)]
enum MissedArg {
    Latest,
    Skip,
}

#[derive(Args)]
struct OccurrencesArgs {
    /// Only this schedule's, by name or id.
    schedule: Option<String>,

    /// How many, newest first.
    #[arg(long, default_value_t = 20)]
    limit: u32,

    /// Print them as JSON.
    #[arg(long)]
    json: bool,
}

pub async fn command(args: SchedulesArgs) -> anyhow::Result<ExitCode> {
    let dispatcher = connect(&dispatcher::paths()?).await?;
    let result = async {
        match args
            .command
            .unwrap_or(SchedulesCommand::List(JsonArgs::default()))
        {
            SchedulesCommand::List(args) => {
                let schedules = dispatcher
                    .send(ListSchedulesRequest::default())
                    .await?
                    .schedules;
                if args.json {
                    println!("{}", serde_json::to_string_pretty(&schedules)?);
                } else {
                    print!("{}", describe(&schedules, now_ms()));
                }
            }
            SchedulesCommand::Add(add) => {
                let request = add_request(&dispatcher, *add).await?;
                let schedule = dispatcher.send(request).await?.schedule;
                println!("Added {}.", summary(&schedule, now_ms()));
            }
            SchedulesCommand::Remove(args) => {
                dispatcher
                    .send(RemoveScheduleRequest {
                        schedule: args.schedule.clone(),
                    })
                    .await?;
                println!("Removed the schedule {}.", args.schedule);
            }
            SchedulesCommand::Pause(args) => {
                let schedule = dispatcher
                    .send(PauseScheduleRequest {
                        schedule: args.schedule,
                    })
                    .await?
                    .schedule;
                println!(
                    "Paused {}; `weave schedules resume` resumes it.",
                    schedule.name
                );
            }
            SchedulesCommand::Resume(args) => {
                let schedule = dispatcher
                    .send(ResumeScheduleRequest {
                        schedule: args.schedule,
                    })
                    .await?
                    .schedule;
                println!("Resumed {}.", summary(&schedule, now_ms()));
            }
            SchedulesCommand::Run(args) => {
                let occurrence = dispatcher
                    .send(RunScheduleRequest {
                        schedule: args.schedule.clone(),
                    })
                    .await?
                    .occurrence;
                match occurrence.state {
                    OccurrenceState::Skipped => println!(
                        "Skipped running {} now: {}.",
                        args.schedule,
                        occurrence.why.as_deref().unwrap_or("no reason given")
                    ),
                    _ => println!(
                        "Running {} now ({}); `weave schedules occurrences {}` says how it goes.",
                        args.schedule, occurrence.id, args.schedule
                    ),
                }
            }
            SchedulesCommand::Occurrences(args) => occurrences(&dispatcher, args).await?,
        }
        anyhow::Ok(())
    }
    .await;
    dispatcher.shutdown().await;
    result.map(|()| ExitCode::SUCCESS)
}

async fn occurrences(
    dispatcher: &DispatcherConnection,
    args: OccurrencesArgs,
) -> anyhow::Result<()> {
    let occurrences = dispatcher
        .send(ListOccurrencesRequest {
            schedule: args.schedule.clone(),
            limit: Some(args.limit),
        })
        .await?
        .occurrences;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&occurrences)?);
        return Ok(());
    }
    let schedules = dispatcher
        .send(ListSchedulesRequest::default())
        .await?
        .schedules;
    print!(
        "{}",
        describe_occurrences(&occurrences, &schedules, now_ms())
    );
    Ok(())
}

async fn add_request(
    dispatcher: &DispatcherConnection,
    add: AddArgs,
) -> anyhow::Result<AddScheduleRequest> {
    let prompt = prompt_text(&add.prompt)?;
    if add.at.is_some() {
        dispatcher::require(dispatcher, BOTS_FEATURE, "one-off schedules")?;
    }
    if add.bot.is_some() {
        dispatcher::require(dispatcher, BOTS_FEATURE, "Bots")?;
    }
    let (cron, at, zone) = match &add.at {
        Some(text) => {
            let at = clock::parse_time(text, add.zone.as_deref())?;
            if at <= now_ms() {
                bail!("--at {text} has passed: a one-off's time has to come after now");
            }
            (None, Some(at), add.zone.or_else(clock::local_zone))
        }
        None => (add.cron, None, add.zone),
    };
    let missed = match add.missed {
        MissedArg::Latest => Missed::Latest,
        MissedArg::Skip => Missed::Skip,
    };
    if let Some(bot) = add.bot {
        return Ok(AddScheduleRequest {
            name: add.name,
            cron,
            at,
            zone,
            host: None,
            bot: Some(bot),
            agent_id: None,
            cwd: None,
            prompt: vec![prompt.into()],
            policy: None,
            mode: None,
            thread: None,
            missed,
            overlap: Overlap::Skip,
        });
    }
    let (Some(host), Some(agent)) = (add.host, add.agent) else {
        bail!("a schedule names a Bot with --bot, or a Host and agent with --host and --agent");
    };
    let cwd = match (add.cwd, &add.project) {
        (Some(cwd), _) => cwd,
        (None, Some(project)) => projects::directory(project, On::Host(&host)).await?,
        (None, None) => std::env::current_dir().context("reading this directory")?,
    };
    Ok(AddScheduleRequest {
        name: add.name,
        cron,
        at,
        zone,
        host: Some(host),
        bot: None,
        agent_id: Some(agent),
        cwd: Some(cwd),
        prompt: vec![prompt.into()],
        policy: Some(PermissionPolicy::headless(add.approve.kinds()?)),
        mode: add.mode,
        thread: add.thread.map(Into::into),
        missed,
        overlap: if add.allow_overlap {
            Overlap::Allow
        } else {
            Overlap::Skip
        },
    })
}

/// "daily-review, 0 9 * * 1-5 in Africa/Johannesburg, next Wed 4 Nov 09:00 SAST (in 3h)", or for
/// a one-off "standup, once at Thu 12 Nov 2026 09:00 SAST (in 2d)".
pub(crate) fn summary(schedule: &Schedule, now: u64) -> String {
    let when = match (schedule.at, &schedule.paused) {
        (Some(at), paused) => {
            let at = format!("once at {}", clock::describe(at, &schedule.zone));
            match (paused, schedule.next_at) {
                (Some(why), _) => format!("{at}, paused: {why}"),
                (None, Some(next)) => format!("{at} (in {})", ago(next, now)),
                (None, None) => format!("{at}, which has passed"),
            }
        }
        (None, paused) => {
            let when = match (paused, &schedule.next, schedule.next_at) {
                (Some(why), _, _) => format!("paused: {why}"),
                (None, Some(next), Some(at)) => format!("next {next} (in {})", ago(at, now)),
                _ => "never runs again".to_owned(),
            };
            format!("{} in {}, {when}", schedule.cron, schedule.zone)
        }
    };
    format!("{}, {when}", schedule.name)
}

fn describe(schedules: &[Schedule], now: u64) -> String {
    if schedules.is_empty() {
        return "The Dispatcher has no schedules; `weave schedules add` adds one.\n".to_owned();
    }
    schedules
        .iter()
        .map(|schedule| {
            let last = match &schedule.last {
                Some(last) => format!("; last {}", outcome(last, now)),
                None => String::new(),
            };
            let what = match (&schedule.bot_name, &schedule.bot_id) {
                (Some(bot), _) | (None, Some(bot)) if schedule.wake_up => {
                    format!("bot {bot}, a wake-up it asked for")
                }
                (Some(bot), _) | (None, Some(bot)) => format!("bot {bot}"),
                (None, None) => {
                    let target = match &schedule.run.thread {
                        Some(thread) => format!("prompts thread {thread}"),
                        None => "starts a thread".to_owned(),
                    };
                    format!(
                        "{} on {} in {}, {target}",
                        schedule.run.agent_id,
                        schedule.host_name,
                        schedule.run.cwd.display(),
                    )
                }
            };
            format!("{}\n  {what}{last}\n", summary(schedule, now))
        })
        .collect()
}

/// How `occurrence` went: "finished 2h ago: ended", "skipped: its previous run was still
/// going".
fn outcome(occurrence: &Occurrence, now: u64) -> String {
    let why = occurrence
        .why
        .as_deref()
        .map(|why| format!(": {why}"))
        .unwrap_or_default();
    let when = |at: u64| format!(" {} ago", ago(now, at));
    match occurrence.state {
        OccurrenceState::Skipped => format!("skipped{why}"),
        OccurrenceState::Waiting => format!(
            "waiting for its Host, written down{}",
            when(occurrence.recorded_at)
        ),
        OccurrenceState::Started => format!("running, started{}", when(occurrence.recorded_at)),
        OccurrenceState::Failed => format!("refused by its Host{why}"),
        OccurrenceState::Finished => {
            let ended = occurrence.ended_at.map(when).unwrap_or_default();
            let how = match occurrence.outcome {
                Some(TurnState::Ended) => "ended",
                Some(TurnState::Stopped) => "stopped short",
                Some(TurnState::Cancelled) => "cancelled",
                Some(TurnState::Interrupted) => "interrupted",
                Some(TurnState::Failed) => "failed",
                Some(TurnState::Queued | TurnState::Running | TurnState::Waiting) | None => {
                    "finished"
                }
            };
            format!("finished{ended}: {how}{why}")
        }
    }
}

fn describe_occurrences(occurrences: &[Occurrence], schedules: &[Schedule], now: u64) -> String {
    if occurrences.is_empty() {
        return "No schedule has run yet.\n".to_owned();
    }
    occurrences
        .iter()
        .map(|occurrence| {
            let name = schedules
                .iter()
                .find(|schedule| schedule.id == occurrence.schedule_id)
                .map_or(occurrence.schedule_id.as_str(), |schedule| {
                    schedule.name.as_str()
                });
            let kind = match (occurrence.manual, occurrence.late) {
                (true, _) => " (by hand)",
                (false, true) => " (late)",
                (false, false) => "",
            };
            let thread = occurrence
                .thread_id
                .as_ref()
                .map(|thread| format!(", thread {thread}"))
                .unwrap_or_default();
            format!(
                "{}  {name}{kind}  due {} ago, {}{thread}\n",
                occurrence.id,
                ago(now, occurrence.scheduled_at),
                outcome(occurrence, now)
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn occurrence(state: OccurrenceState) -> Occurrence {
        Occurrence {
            id: "occ-1".to_owned(),
            schedule_id: "sch-1".to_owned(),
            scheduled_at: 0,
            late: false,
            manual: false,
            state,
            outcome: None,
            why: None,
            thread_id: None,
            turn_id: None,
            recorded_at: 0,
            ended_at: None,
        }
    }

    fn schedule() -> Schedule {
        Schedule {
            id: "sch-1".to_owned(),
            name: "daily".to_owned(),
            cron: "0 9 * * *".to_owned(),
            at: None,
            zone: "UTC".to_owned(),
            host_id: "h-1".to_owned(),
            host_name: "studio".to_owned(),
            bot_id: None,
            bot_name: None,
            wake_up: false,
            run: weave_host_protocol::dispatcher::ScheduledRun {
                agent_id: "claude".to_owned(),
                cwd: "/srv/odin".into(),
                prompt: Vec::new(),
                policy: PermissionPolicy::headless(Vec::new()),
                mode: None,
                thread: None,
            },
            missed: Missed::Latest,
            overlap: Overlap::Skip,
            created_at: 0,
            paused: None,
            failures: 0,
            next_at: Some(9 * 3_600_000),
            next: Some("Thu 1 Jan 09:00 UTC".to_owned()),
            last: None,
        }
    }

    #[test]
    fn a_bots_schedules_and_one_offs_list_as_such() {
        let hour = 3_600_000;
        assert_eq!(
            describe(&[schedule()], 6 * hour),
            "daily, 0 9 * * * in UTC, next Thu 1 Jan 09:00 UTC (in 3h)\n  \
             claude on studio in /srv/odin, starts a thread\n"
        );
        let once = Schedule {
            name: "later".to_owned(),
            cron: String::new(),
            at: Some(9 * hour),
            bot_id: Some("b-1".to_owned()),
            bot_name: Some("odin".to_owned()),
            ..schedule()
        };
        assert_eq!(
            describe(std::slice::from_ref(&once), 6 * hour),
            "later, once at Thu 1 Jan 1970 09:00 UTC (in 3h)\n  bot odin\n"
        );
        let passed = Schedule {
            next_at: None,
            next: None,
            last: Some(Occurrence {
                outcome: Some(TurnState::Ended),
                ended_at: Some(10 * hour),
                ..occurrence(OccurrenceState::Finished)
            }),
            ..once
        };
        assert_eq!(
            describe(std::slice::from_ref(&passed), 12 * hour),
            "later, once at Thu 1 Jan 1970 09:00 UTC, which has passed\n  \
             bot odin; last finished 2h ago: ended\n"
        );
        let woken = Schedule {
            wake_up: true,
            last: None,
            ..passed
        };
        assert_eq!(
            describe(&[woken], 12 * hour),
            "later, once at Thu 1 Jan 1970 09:00 UTC, which has passed\n  \
             bot odin, a wake-up it asked for\n"
        );
    }

    #[test]
    fn occurrences_say_how_they_went() {
        let hour = 3_600_000;
        let ended = Occurrence {
            outcome: Some(TurnState::Ended),
            ended_at: Some(hour),
            thread_id: Some("s-1".into()),
            ..occurrence(OccurrenceState::Finished)
        };
        assert_eq!(outcome(&ended, 3 * hour), "finished 2h ago: ended");
        let skipped = Occurrence {
            why: Some("its previous occurrence was still waiting or running".to_owned()),
            ..occurrence(OccurrenceState::Skipped)
        };
        assert_eq!(
            outcome(&skipped, hour),
            "skipped: its previous occurrence was still waiting or running"
        );
        assert_eq!(
            describe_occurrences(&[ended], &[], 3 * hour),
            "occ-1  sch-1  due 3h ago, finished 2h ago: ended, thread s-1\n"
        );
    }
}
