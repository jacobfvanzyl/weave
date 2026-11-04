//! `weave dispatcher schedules` and `weave dispatcher occurrences`: the Dispatcher's schedules
//! (WVE-145), which start a headless turn on one of the person's Hosts at the times a cron
//! expression gives, and what each time did.

use std::path::PathBuf;

use anyhow::Context as _;
use clap::Args;
use clap::Subcommand;
use clap::ValueEnum;
use weave_dispatcher::DispatcherPaths;
use weave_host_protocol::dispatcher::AddScheduleRequest;
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
use weave_host_protocol::dispatcher::ScheduledRun;
use weave_host_protocol::policy::PermissionPolicy;
use weave_host_protocol::sessions::TurnState;

use crate::args::ApproveArgs;
use crate::daemon::ago;
use crate::daemon::now_ms;
use crate::dispatcher::connect;
use crate::run::prompt_text;

#[derive(Args)]
pub struct SchedulesArgs {
    #[command(subcommand)]
    command: Option<SchedulesCommand>,
}

#[derive(Subcommand)]
enum SchedulesCommand {
    /// The schedules, when each runs next and how it last went (the default).
    List(JsonArgs),
    /// Add a schedule: at the times `--cron` gives, start a headless turn on a Host.
    Add(Box<AddArgs>),
    /// Forget a schedule and what it did. A turn it started runs on.
    Remove(NameArgs),
    /// Run nothing on schedule until resumed.
    Pause(NameArgs),
    /// Run on schedule again from now, catching up nothing missed while paused.
    Resume(NameArgs),
    /// Run it now, paused or not, as an occurrence of its own.
    Run(NameArgs),
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
struct AddArgs {
    /// Its name, unique among the Dispatcher's schedules.
    name: String,

    /// When it runs: five fields, minute hour day-of-month month day-of-week, such as
    /// "0 9 * * 1-5" for 09:00 on weekdays; or @hourly, @daily, @weekly, @monthly.
    #[arg(long)]
    cron: String,

    /// The IANA time zone its times are in, such as Africa/Johannesburg; the Dispatcher's
    /// computer's when omitted.
    #[arg(long)]
    zone: Option<String>,

    /// The Host it runs on, by name or id: one `weave dispatcher hosts` lists.
    #[arg(long)]
    host: String,

    /// The agent on that Host, as `weave agents` lists them there.
    #[arg(long)]
    agent: String,

    /// The directory on that Host it runs in; `~/` starts at the home there. This directory
    /// when omitted.
    #[arg(long)]
    cwd: Option<PathBuf>,

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
pub struct OccurrencesArgs {
    /// Only this schedule's, by name or id.
    schedule: Option<String>,

    /// How many, newest first.
    #[arg(long, default_value_t = 20)]
    limit: u32,

    /// Print them as JSON.
    #[arg(long)]
    json: bool,
}

pub async fn schedules(paths: &DispatcherPaths, args: SchedulesArgs) -> anyhow::Result<()> {
    let dispatcher = connect(paths).await?;
    let result = async {
        match args
            .command
            .unwrap_or(SchedulesCommand::List(JsonArgs::default()))
        {
            SchedulesCommand::List(args) => {
                let schedules = dispatcher.send(ListSchedulesRequest {}).await?.schedules;
                if args.json {
                    println!("{}", serde_json::to_string_pretty(&schedules)?);
                } else {
                    print!("{}", describe(&schedules, now_ms()));
                }
            }
            SchedulesCommand::Add(add) => {
                let request = add_request(*add)?;
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
                    "Paused {}; `weave dispatcher schedules resume` resumes it.",
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
                        "Running {} now ({}); `weave dispatcher occurrences {}` says how it goes.",
                        args.schedule, occurrence.id, args.schedule
                    ),
                }
            }
        }
        anyhow::Ok(())
    }
    .await;
    dispatcher.shutdown().await;
    result
}

pub async fn occurrences(paths: &DispatcherPaths, args: OccurrencesArgs) -> anyhow::Result<()> {
    let dispatcher = connect(paths).await?;
    let listed = dispatcher
        .send(ListOccurrencesRequest {
            schedule: args.schedule.clone(),
            limit: Some(args.limit),
        })
        .await;
    let names = dispatcher.send(ListSchedulesRequest {}).await;
    dispatcher.shutdown().await;
    let occurrences = listed?.occurrences;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&occurrences)?);
        return Ok(());
    }
    let schedules = names?.schedules;
    print!(
        "{}",
        describe_occurrences(&occurrences, &schedules, now_ms())
    );
    Ok(())
}

fn add_request(add: AddArgs) -> anyhow::Result<AddScheduleRequest> {
    let prompt = prompt_text(&add.prompt)?;
    let cwd = match add.cwd {
        Some(cwd) => cwd,
        None => std::env::current_dir().context("reading this directory")?,
    };
    Ok(AddScheduleRequest {
        name: add.name,
        cron: add.cron,
        zone: add.zone,
        host: add.host,
        run: ScheduledRun {
            agent_id: add.agent,
            cwd,
            prompt: vec![prompt.into()],
            policy: PermissionPolicy::headless(add.approve.kinds()?),
            mode: add.mode,
            thread: add.thread.map(Into::into),
        },
        missed: match add.missed {
            MissedArg::Latest => Missed::Latest,
            MissedArg::Skip => Missed::Skip,
        },
        overlap: if add.allow_overlap {
            Overlap::Allow
        } else {
            Overlap::Skip
        },
    })
}

/// "daily-review, 0 9 * * 1-5 in Africa/Johannesburg, next Wed 4 Nov 09:00 SAST (in 3h)".
fn summary(schedule: &Schedule, now: u64) -> String {
    let when = match (&schedule.paused, &schedule.next, schedule.next_at) {
        (Some(why), _, _) => format!("paused: {why}"),
        (None, Some(next), Some(at)) => format!("next {next} (in {})", ago(at, now)),
        _ => "never runs again".to_owned(),
    };
    format!(
        "{}, {} in {}, {when}",
        schedule.name, schedule.cron, schedule.zone
    )
}

fn describe(schedules: &[Schedule], now: u64) -> String {
    if schedules.is_empty() {
        return "The Dispatcher has no schedules; `weave dispatcher schedules add` adds one.\n"
            .to_owned();
    }
    schedules
        .iter()
        .map(|schedule| {
            let target = match &schedule.run.thread {
                Some(thread) => format!("prompts thread {thread}"),
                None => "starts a thread".to_owned(),
            };
            let last = match &schedule.last {
                Some(last) => format!("; last {}", outcome(last, now)),
                None => String::new(),
            };
            format!(
                "{}\n  {} on {} in {}, {target}{last}\n",
                summary(schedule, now),
                schedule.run.agent_id,
                schedule.host_name,
                schedule.run.cwd.display(),
            )
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
                .session_id
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
            session_id: None,
            turn_id: None,
            recorded_at: 0,
            ended_at: None,
        }
    }

    #[test]
    fn occurrences_say_how_they_went() {
        let hour = 3_600_000;
        let ended = Occurrence {
            outcome: Some(TurnState::Ended),
            ended_at: Some(hour),
            session_id: Some("s-1".into()),
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
