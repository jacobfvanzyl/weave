//! Running schedules (WVE-145): a task that wakes when the next occurrence of any schedule is
//! due, when schedules change, and at least every half minute by the wall clock, so a computer
//! waking from sleep finds what came due meanwhile. Each time it considers every schedule
//! that isn't paused from where it last did:
//!
//! - the latest occurrence due since then starts, late if more than a minute has passed, unless
//!   the schedule skips what it misses;
//! - the ones before it, within a week, are written down as one skipped occurrence that says
//!   how many were missed;
//! - an occurrence that comes while the schedule's previous one is still waiting or running is
//!   skipped, unless the schedule allows that ([`crate::store`]).
//!
//! The cron expressions are croner's five fields, in the schedule's IANA time zone: a time in
//! an hour a clock change skips runs at the first valid moment after it, and one in an hour it
//! repeats runs once.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1::ContentBlock;
use croner::Cron;
use croner::parser::CronParser;
use croner::parser::Seconds;
use croner::parser::Year;
use jiff::Timestamp;
use jiff::tz::TimeZone;
use weave_host_protocol::dispatcher::Missed;
use weave_host_protocol::sessions::RunRequest;
use weave_host_protocol::sessions::ServiceOrigin;

use crate::Shared;
use crate::now_ms;
use crate::store::Fired;
use crate::store::StoredSchedule;
use crate::store::Work;

/// How far back missed occurrences are caught up.
pub(crate) const LOOK_BACK: u64 = 7 * 24 * 60 * 60 * 1000;

/// How long after it's due an occurrence still starts on time.
pub(crate) const GRACE: u64 = 60 * 1000;

/// The most occurrences counted between two considerations, so a schedule that runs every
/// minute and missed a week counts them quickly.
const MOST_COUNTED: usize = 20_000;

/// The wall clock, as schedules read it. Tests move one of their own.
pub trait Clock: Send + Sync {
    /// Milliseconds since the Unix epoch.
    fn now(&self) -> u64;
    /// Wait until `at`, or less: the scheduler looks at the clock again after.
    fn wait_until(&self, at: u64) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
}

/// The system's clock. Waits are at most half a minute, since a sleeping computer's monotonic
/// clock may stop while the wall clock goes on.
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> u64 {
        now_ms()
    }

    fn wait_until(&self, at: u64) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        let wait = Duration::from_millis(at.saturating_sub(now_ms())).min(Duration::from_secs(30));
        Box::pin(tokio::time::sleep(wait))
    }
}

/// A schedule's times: its cron expression in its time zone.
pub(crate) struct Plan {
    cron: Cron,
    zone: TimeZone,
}

impl Plan {
    pub(crate) fn new(cron: &str, zone: &str) -> Result<Self, String> {
        let cron = CronParser::builder()
            .seconds(Seconds::Disallowed)
            .year(Year::Disallowed)
            .build()
            .parse(cron)
            .map_err(|error| format!("the cron expression {cron:?}: {error}"))?;
        let zone =
            TimeZone::get(zone).map_err(|error| format!("the time zone {zone:?}: {error}"))?;
        Ok(Self { cron, zone })
    }

    /// The first time after `after`.
    pub(crate) fn next_after(&self, after: u64) -> Option<u64> {
        let after = self.zoned(after)?;
        let next = self.cron.find_next_occurrence(&after, false).ok()?;
        u64::try_from(next.timestamp().as_millisecond()).ok()
    }

    /// The times after `after`, up to and including `until`, the latest at most
    /// [`MOST_COUNTED`] of them.
    fn between(&self, after: u64, until: u64) -> Vec<u64> {
        let mut times = Vec::new();
        let mut from = after;
        while let Some(next) = self.next_after(from).filter(|next| *next <= until) {
            if times.len() == MOST_COUNTED {
                times.remove(0);
            }
            times.push(next);
            from = next;
        }
        times
    }

    /// `at` in the schedule's time zone, as people read it: "Wed 4 Nov 09:00 SAST".
    pub(crate) fn describe(&self, at: u64) -> String {
        self.zoned(at)
            .map(|zoned| zoned.strftime("%a %-d %b %H:%M %Z").to_string())
            .unwrap_or_default()
    }

    fn zoned(&self, at: u64) -> Option<jiff::Zoned> {
        let at = Timestamp::from_millisecond(i64::try_from(at).ok()?).ok()?;
        Some(at.to_zoned(self.zone.clone()))
    }
}

/// The time zone schedules are in unless they name one: this computer's.
pub(crate) fn local_zone() -> String {
    TimeZone::system().iana_name().unwrap_or("UTC").to_owned()
}

/// Consider every schedule until the Dispatcher stops.
pub(crate) async fn run(shared: Arc<Shared>) {
    loop {
        let now = shared.config.clock.now();
        let next = consider_all(&shared, now);
        let wake = next.unwrap_or(now + 60 * 1000);
        tokio::select! {
            () = shared.config.clock.wait_until(wake) => {}
            () = shared.schedules_changed.notified() => {}
            () = shared.stop.cancelled() => return,
        }
    }
}

/// Consider each schedule that isn't paused at `now`: the time the first of them is next due.
fn consider_all(shared: &Shared, now: u64) -> Option<u64> {
    let schedules = match shared.store.schedules() {
        Ok(schedules) => schedules,
        Err(why) => {
            tracing::warn!(%why, "reading the schedules failed");
            return None;
        }
    };
    schedules
        .iter()
        .filter(|schedule| schedule.paused.is_none())
        .filter_map(|schedule| match consider(shared, schedule, now) {
            Ok(next) => next,
            Err(why) => {
                tracing::warn!(schedule = %schedule.name, %why, "considering a schedule failed");
                None
            }
        })
        .min()
}

/// Start or skip what came due for `schedule` since it was last considered: when it's next
/// due.
fn consider(shared: &Shared, schedule: &StoredSchedule, now: u64) -> Result<Option<u64>, String> {
    let plan = Plan::new(&schedule.cron, &schedule.zone)?;
    let from = schedule.considered_until.max(now.saturating_sub(LOOK_BACK));
    let due = plan.between(from, now);
    if let Some((latest, earlier)) = due.split_last() {
        if let (Some(first), Some(last)) = (earlier.first(), earlier.last()) {
            let times = match earlier.len() {
                1 => "once".to_owned(),
                count => format!("{count} times"),
            };
            let span = if first == last {
                format!("at {}", plan.describe(*first))
            } else {
                format!("from {} to {}", plan.describe(*first), plan.describe(*last))
            };
            let why = format!("missed {times}, {span}, while the Dispatcher couldn't run it");
            shared.store.skip(&schedule.id, *first, &why, now)?;
        }
        let late = now.saturating_sub(*latest) > GRACE;
        if late && schedule.missed == Missed::Skip {
            let why = format!(
                "missed at {}, while the Dispatcher couldn't run it, and the schedule skips \
                 what it misses",
                plan.describe(*latest)
            );
            shared.store.skip(&schedule.id, *latest, &why, now)?;
        } else {
            fire(shared, schedule, &plan, *latest, late, false, now)?;
        }
    }
    shared.store.considered(&schedule.id, now)?;
    Ok(plan.next_after(now))
}

/// Write down `schedule`'s occurrence due `at`, with the delivery that starts it, and send it
/// to its Host.
pub(crate) fn fire(
    shared: &Shared,
    schedule: &StoredSchedule,
    plan: &Plan,
    at: u64,
    late: bool,
    manual: bool,
    now: u64,
) -> Result<Fired, String> {
    let key = if manual {
        format!("schedule/{}/run/{at}", schedule.id)
    } else {
        format!("schedule/{}/{at}", schedule.id)
    };
    let work = |occurrence: &str| {
        let run = &schedule.run;
        let mut prompt = run.prompt.clone();
        if late {
            prompt.insert(
                0,
                ContentBlock::from(format!(
                    "This turn is the schedule {}'s, due at {} and started late, at {}, because \
                     the Dispatcher couldn't start it on time.",
                    schedule.name,
                    plan.describe(at),
                    plan.describe(now)
                )),
            );
        }
        let request = RunRequest {
            agent_id: run.agent_id.clone(),
            cwd: run.cwd.clone(),
            remote: None,
            session_id: run.thread.clone(),
            additional_directories: Vec::new(),
            mode: run.mode.clone(),
            prompt,
            policy: run.policy.clone(),
            attach: false,
            trace: false,
            key: Some(key),
            caller: None,
            origin: Some(ServiceOrigin {
                label: format!("schedule {}", schedule.name),
                id: occurrence.to_owned(),
            }),
        };
        match run.thread {
            Some(_) => Work::Prompt(request),
            None => Work::Run(request),
        }
    };
    let fired = shared.store.fire(schedule, at, late, manual, now, work)?;
    match &fired {
        Fired::Started(occurrence, delivery) => {
            tracing::info!(schedule = %schedule.name, occurrence = %occurrence.id, delivery = %delivery.id, late, "a schedule came due");
            shared.wake(&schedule.host_id);
        }
        Fired::Skipped(occurrence) => {
            tracing::info!(schedule = %schedule.name, occurrence = %occurrence.id, "skipped a schedule's occurrence: its previous one is still waiting or running");
        }
        Fired::Already => {}
    }
    Ok(fired)
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn at(text: &str) -> u64 {
        let at: Timestamp = text.parse().expect("a time");
        u64::try_from(at.as_millisecond()).expect("after 1970")
    }

    #[test]
    fn times_follow_the_zone_across_its_clock_changes() {
        // New York's clocks skip 02:00 to 03:00 on 8 March 2026, and repeat 01:00 to 02:00 on
        // 1 November.
        let skipped = Plan::new("30 2 * * *", "America/New_York").expect("a plan");
        assert_eq!(
            skipped.next_after(at("2026-03-08T05:00:00Z")),
            Some(at("2026-03-08T07:00:00Z")),
            "02:30, which doesn't happen, runs at the first valid moment after it, 03:00 EDT"
        );
        let repeated = Plan::new("30 1 * * *", "America/New_York").expect("a plan");
        let times = repeated.between(at("2026-11-01T04:00:00Z"), at("2026-11-02T04:00:00Z"));
        assert_eq!(
            times,
            vec![at("2026-11-01T05:30:00Z")],
            "01:30, which happens twice, runs once"
        );
        assert_eq!(repeated.describe(times[0]), "Sun 1 Nov 01:30 EDT");
    }

    #[test]
    fn only_five_fields_and_real_zones_make_a_plan() {
        assert!(Plan::new("0 9 * * 1-5", "Africa/Johannesburg").is_ok());
        assert!(Plan::new("@daily", "UTC").is_ok());
        let seconds = Plan::new("0 0 9 * * *", "UTC")
            .err()
            .expect("seconds refused");
        assert!(seconds.contains("the cron expression"), "{seconds}");
        let zone = Plan::new("0 9 * * *", "Mars/Olympus")
            .err()
            .expect("no such zone");
        assert!(zone.contains("the time zone"), "{zone}");
    }
}
