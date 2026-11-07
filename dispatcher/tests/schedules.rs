//! Schedules (WVE-145) against in-process Hosts with the fake agent, on a clock the tests move:
//! an occurrence starts its turn at its time, once, through restarts and a Host that's down;
//! what was missed catches up once; an occurrence while the last still runs is skipped; and
//! failures in a row pause a schedule.

#![allow(clippy::expect_used)]

mod common;

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use pretty_assertions::assert_eq;
use tokio::sync::watch;
use weave_acp_core::schema::ContentBlock;
use weave_dispatcher::Clock;
use weave_dispatcher::Dispatcher;
use weave_host_protocol::dispatcher::AddScheduleRequest;
use weave_host_protocol::dispatcher::ListSchedulesRequest;
use weave_host_protocol::dispatcher::Missed;
use weave_host_protocol::dispatcher::Occurrence;
use weave_host_protocol::dispatcher::OccurrenceState;
use weave_host_protocol::dispatcher::Overlap;
use weave_host_protocol::dispatcher::RunScheduleRequest;
use weave_host_protocol::dispatcher::ScheduledRun;
use weave_host_protocol::policy::PermissionPolicy;
use weave_host_protocol::sessions::GetSessionRequest;
use weave_host_protocol::sessions::LatestTurn;
use weave_host_protocol::sessions::TurnOrigin;
use weave_host_protocol::sessions::TurnState;

use crate::common::WAIT;
use crate::common::World;
use crate::common::ask;
use crate::common::host_until;
use crate::common::start_with;
use crate::common::threads;

/// A clock that moves only when a test moves it.
struct TestClock {
    time: watch::Sender<u64>,
}

impl TestClock {
    fn at(time: &str) -> Arc<Self> {
        Arc::new(Self {
            time: watch::Sender::new(ms(time)),
        })
    }

    fn set(&self, time: &str) {
        self.time.send_replace(ms(time));
    }
}

impl Clock for TestClock {
    fn now(&self) -> u64 {
        *self.time.borrow()
    }

    fn wait_until(&self, at: u64) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        let mut time = self.time.subscribe();
        Box::pin(async move {
            let _ = time.wait_for(|now| *now >= at).await;
        })
    }
}

fn ms(time: &str) -> u64 {
    let at: jiff::Timestamp = time.parse().expect("a time");
    u64::try_from(at.as_millisecond()).expect("after 1970")
}

/// Have `world`'s Host join the Dispatcher from `dir` as studio, and wait until it's connected:
/// the Host's id.
async fn pair(dispatcher: &Dispatcher, dir: &std::path::Path, world: &World) -> String {
    world.join(dispatcher, dir, "studio").await;
    let host_id = world.host_id().await;
    host_until(dispatcher, &host_id, |host| host.connected).await;
    host_id
}

fn schedule(world: &World, name: &str, cron: &str, prompt: &str) -> AddScheduleRequest {
    AddScheduleRequest {
        name: name.to_owned(),
        cron: cron.to_owned(),
        zone: Some("UTC".to_owned()),
        host: "studio".to_owned(),
        run: ScheduledRun {
            agent_id: "fake".to_owned(),
            cwd: world.dir.path().to_path_buf(),
            prompt: vec![ContentBlock::from(prompt.to_owned())],
            policy: PermissionPolicy::ask(),
            mode: None,
            thread: None,
        },
        missed: Missed::Latest,
        overlap: Overlap::Skip,
    }
}

/// Wait until `name` has occurrences as `wanted` says, newest first.
async fn occurrences_until(
    dispatcher: &Dispatcher,
    name: &str,
    wanted: impl Fn(&[Occurrence]) -> bool,
) -> Vec<Occurrence> {
    tokio::time::timeout(WAIT, async {
        loop {
            let occurrences = dispatcher
                .occurrences(Some(name), None)
                .expect("occurrences");
            if wanted(&occurrences) {
                return occurrences;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "{name}'s occurrences in time: {:?}",
            dispatcher.occurrences(Some(name), None)
        )
    })
}

fn finished(occurrence: &Occurrence) -> bool {
    occurrence.state == OccurrenceState::Finished
}

/// The turn `occurrence` started, as its Host has it.
async fn turn(world: &World, occurrence: &Occurrence) -> LatestTurn {
    let local = world.local().await;
    let got = local
        .send(GetSessionRequest {
            session_id: occurrence.session_id.clone().expect("a thread"),
            turn_id: occurrence.turn_id.clone(),
        })
        .await
        .expect("sessions/get");
    local.shutdown().await;
    got.latest_turn.expect("its turn")
}

fn text(turn: &LatestTurn) -> Vec<String> {
    turn.prompt
        .iter()
        .map(|block| match block {
            ContentBlock::Text(text) => text.text.clone(),
            _ => String::new(),
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_schedule_starts_a_turn_at_its_time_naming_itself() {
    let studio = World::new().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let clock = TestClock::at("2026-11-04T08:59:00Z");
    let (dispatcher, serving) = start_with(dir.path(), clock.clone());
    pair(&dispatcher, dir.path(), &studio).await;

    // Added through its socket, it says when it next runs.
    let cli = ask(dir.path()).await;
    let added = cli
        .send(schedule(&studio, "daily-review", "0 9 * * *", "hello"))
        .await
        .expect("schedules/add")
        .schedule;
    assert_eq!(added.next_at, Some(ms("2026-11-04T09:00:00Z")));
    assert_eq!(added.next.as_deref(), Some("Wed 4 Nov 09:00 UTC"));
    assert!(
        dispatcher
            .occurrences(Some("daily-review"), None)
            .expect("none")
            .is_empty()
    );

    clock.set("2026-11-04T09:00:00Z");
    let occurrences = occurrences_until(&dispatcher, "daily-review", |all| {
        all.first().is_some_and(finished)
    })
    .await;
    let due = &occurrences[0];
    assert_eq!(due.scheduled_at, ms("2026-11-04T09:00:00Z"));
    assert!(!due.late);
    assert_eq!(due.outcome, Some(TurnState::Ended));
    // Its thread says whose it is.
    let thread = threads(&studio)
        .await
        .into_iter()
        .find(|thread| Some(&thread.info.session_id) == due.session_id.as_ref())
        .expect("its thread");
    assert_eq!(
        thread.labels,
        ["dispatcher".to_owned(), format!("schedule:{}", added.id)]
    );
    let started = turn(&studio, due).await;
    assert_eq!(
        started.origin,
        TurnOrigin::Service {
            name: "Dispatcher".to_owned(),
            label: "schedule daily-review".to_owned(),
            id: due.id.clone(),
        }
    );
    let listed = cli
        .send(ListSchedulesRequest {})
        .await
        .expect("schedules/list");
    assert_eq!(
        listed.schedules[0].next.as_deref(),
        Some("Thu 5 Nov 09:00 UTC")
    );
    assert_eq!(
        listed.schedules[0].last.as_ref().map(|last| &last.id),
        Some(&due.id)
    );

    // Run by hand, it starts another, in a thread of its own.
    let by_hand = cli
        .send(RunScheduleRequest {
            schedule: "daily-review".to_owned(),
        })
        .await
        .expect("schedules/run")
        .occurrence;
    assert!(by_hand.manual);
    occurrences_until(&dispatcher, "daily-review", |all| {
        all.len() == 2 && all.iter().all(finished)
    })
    .await;
    assert_eq!(threads(&studio).await.len(), 2);

    cli.shutdown().await;
    dispatcher.stop().await;
    serving.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_occurrence_written_down_starts_once_after_a_restart_and_a_host_that_was_down() {
    let studio = World::new().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let clock = TestClock::at("2026-11-04T08:59:00Z");
    let (dispatcher, serving) = start_with(dir.path(), clock.clone());
    pair(&dispatcher, dir.path(), &studio).await;
    dispatcher
        .add_schedule(schedule(&studio, "daily-review", "0 9 * * *", "hello"))
        .expect("added");

    // The Host is down when it comes due: it waits, written down.
    studio.relay.cut();
    clock.set("2026-11-04T09:00:00Z");
    occurrences_until(&dispatcher, "daily-review", |all| {
        all.first()
            .is_some_and(|first| first.state == OccurrenceState::Waiting)
    })
    .await;

    // The Dispatcher restarts before the Host is back, and then it is.
    dispatcher.stop().await;
    serving.abort();
    let _ = serving.await;
    let (dispatcher, serving) = start_with(dir.path(), clock.clone());
    studio.relay.resume();
    let occurrences = occurrences_until(&dispatcher, "daily-review", |all| {
        all.first().is_some_and(finished)
    })
    .await;
    assert_eq!(occurrences.len(), 1);
    assert_eq!(threads(&studio).await.len(), 1);

    dispatcher.stop().await;
    serving.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn what_was_missed_catches_up_once_late_unless_the_schedule_skips_it() {
    let studio = World::new().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let clock = TestClock::at("2026-11-04T08:00:00Z");
    let (dispatcher, serving) = start_with(dir.path(), clock.clone());
    pair(&dispatcher, dir.path(), &studio).await;
    dispatcher
        .add_schedule(schedule(&studio, "daily-review", "0 9 * * *", "Review"))
        .expect("added");
    dispatcher
        .add_schedule(AddScheduleRequest {
            missed: Missed::Skip,
            ..schedule(&studio, "standup", "0 9 * * *", "Standup")
        })
        .expect("added");

    // The Dispatcher doesn't run for four of their times.
    dispatcher.stop().await;
    serving.abort();
    let _ = serving.await;
    clock.set("2026-11-07T10:00:00Z");
    let (dispatcher, serving) = start_with(dir.path(), clock.clone());

    let review = occurrences_until(&dispatcher, "daily-review", |all| {
        all.first().is_some_and(finished)
    })
    .await;
    assert_eq!(review.len(), 2, "{review:?}");
    let (caught_up, skipped) = (&review[0], &review[1]);
    assert_eq!(caught_up.scheduled_at, ms("2026-11-07T09:00:00Z"));
    assert!(caught_up.late);
    assert_eq!(skipped.state, OccurrenceState::Skipped);
    assert_eq!(
        skipped.why.as_deref(),
        Some(
            "missed 3 times, from Wed 4 Nov 09:00 UTC to Fri 6 Nov 09:00 UTC, while the \
             Dispatcher couldn't run it"
        )
    );
    let prompt = text(&turn(&studio, caught_up).await);
    assert_eq!(
        prompt,
        vec![
            "This turn is the schedule daily-review's, due at Sat 7 Nov 09:00 UTC and started \
             late, at Sat 7 Nov 10:00 UTC, because the Dispatcher couldn't start it on time."
                .to_owned(),
            "Review".to_owned(),
        ]
    );

    let standup = dispatcher
        .occurrences(Some("standup"), None)
        .expect("occurrences");
    assert_eq!(
        standup
            .iter()
            .map(|occurrence| occurrence.state)
            .collect::<Vec<_>>(),
        vec![OccurrenceState::Skipped, OccurrenceState::Skipped]
    );
    assert!(
        standup[0]
            .why
            .as_deref()
            .is_some_and(|why| why.contains("the schedule skips what it misses")),
        "{standup:?}"
    );
    assert_eq!(threads(&studio).await.len(), 1);

    dispatcher.stop().await;
    serving.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_occurrence_while_the_last_still_runs_is_skipped() {
    let studio = World::new().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let clock = TestClock::at("2026-11-04T08:59:30Z");
    let (dispatcher, serving) = start_with(dir.path(), clock.clone());
    pair(&dispatcher, dir.path(), &studio).await;
    dispatcher
        .add_schedule(schedule(&studio, "watch", "* * * * *", "/slow 10"))
        .expect("added");

    clock.set("2026-11-04T09:00:00Z");
    occurrences_until(&dispatcher, "watch", |all| {
        all.first()
            .is_some_and(|first| first.state == OccurrenceState::Started)
    })
    .await;
    clock.set("2026-11-04T09:01:00Z");
    let occurrences = occurrences_until(&dispatcher, "watch", |all| all.len() == 2).await;
    assert_eq!(occurrences[0].state, OccurrenceState::Skipped);
    assert_eq!(
        occurrences[0].why.as_deref(),
        Some("its previous occurrence was still waiting or running")
    );

    // Once it's over, the next one runs.
    occurrences_until(&dispatcher, "watch", |all| all.get(1).is_some_and(finished)).await;
    clock.set("2026-11-04T09:02:00Z");
    occurrences_until(&dispatcher, "watch", |all| {
        all.len() == 3 && all[0].state != OccurrenceState::Skipped
    })
    .await;

    dispatcher.stop().await;
    serving.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_schedule_that_prompts_one_thread_queues_its_prompt_there() {
    let studio = World::new().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let clock = TestClock::at("2026-11-04T08:59:00Z");
    let (dispatcher, serving) = start_with(dir.path(), clock.clone());
    pair(&dispatcher, dir.path(), &studio).await;
    dispatcher
        .add_schedule(schedule(&studio, "first", "0 9 * * *", "hello"))
        .expect("added");
    clock.set("2026-11-04T09:00:00Z");
    let first = occurrences_until(&dispatcher, "first", |all| {
        all.first().is_some_and(finished)
    })
    .await
    .remove(0);
    let thread = first.session_id.clone().expect("its thread");

    let mut again = schedule(&studio, "again", "30 9 * * *", "and again");
    again.run.thread = Some(thread.clone());
    dispatcher.add_schedule(again).expect("added");
    clock.set("2026-11-04T09:30:00Z");
    let queued = occurrences_until(&dispatcher, "again", |all| {
        all.first().is_some_and(finished)
    })
    .await
    .remove(0);
    assert_eq!(queued.session_id, Some(thread));
    assert_eq!(
        text(&turn(&studio, &queued).await),
        vec!["and again".to_owned()]
    );
    assert_eq!(threads(&studio).await.len(), 1);

    dispatcher.stop().await;
    serving.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_occurrence_its_host_stops_under_ends_as_the_continuation_does() {
    let mut studio = World::with_journals().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let clock = TestClock::at("2026-11-04T08:59:00Z");
    let (dispatcher, serving) = start_with(dir.path(), clock.clone());
    pair(&dispatcher, dir.path(), &studio).await;
    let mut headless = schedule(&studio, "long-job", "0 9 * * *", "slow 20");
    headless.run.policy = PermissionPolicy::headless(Vec::new());
    dispatcher.add_schedule(headless).expect("added");
    clock.set("2026-11-04T09:00:00Z");
    let started = occurrences_until(&dispatcher, "long-job", |all| {
        all.first()
            .is_some_and(|first| first.state == OccurrenceState::Started)
    })
    .await;
    let cut = started[0].turn_id.clone().expect("its turn");

    // The Host stops under the turn; the thread continues it, and the occurrence ends as
    // the continuation does.
    studio.restart().await;
    let occurrences = occurrences_until(&dispatcher, "long-job", |all| {
        all.first().is_some_and(finished)
    })
    .await;
    let ended = &occurrences[0];
    assert_eq!(ended.outcome, Some(TurnState::Ended), "{ended:?}");
    assert_ne!(ended.turn_id.as_ref(), Some(&cut));
    let continuation = turn(&studio, ended).await;
    assert_eq!(continuation.continues.as_ref(), Some(&cut));

    dispatcher.stop().await;
    serving.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn three_failures_in_a_row_pause_a_schedule() {
    let studio = World::new().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let clock = TestClock::at("2026-11-04T08:59:30Z");
    let (dispatcher, serving) = start_with(dir.path(), clock.clone());
    pair(&dispatcher, dir.path(), &studio).await;
    let mut broken = schedule(&studio, "broken", "* * * * *", "hello");
    broken.run.agent_id = "nobody".to_owned();
    dispatcher.add_schedule(broken).expect("added");

    for (count, minute) in [(1, "09:00"), (2, "09:01"), (3, "09:02")] {
        clock.set(&format!("2026-11-04T{minute}:00Z"));
        occurrences_until(&dispatcher, "broken", |all| {
            all.len() == count && all[0].state == OccurrenceState::Failed
        })
        .await;
    }
    let paused = dispatcher.schedules().expect("schedules").remove(0);
    assert_eq!(paused.failures, 3);
    assert!(
        paused
            .paused
            .as_deref()
            .is_some_and(|why| why.starts_with("it failed 3 times in a row; the last said:")),
        "{paused:?}"
    );
    assert_eq!(paused.next_at, None);

    // Paused, it runs no more; resumed, it runs from then on.
    clock.set("2026-11-04T09:03:00Z");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        dispatcher
            .occurrences(Some("broken"), None)
            .expect("listed")
            .len(),
        3
    );
    let resumed = dispatcher.resume_schedule("broken").expect("resumed");
    assert_eq!((resumed.paused, resumed.failures), (None, 0));
    assert_eq!(resumed.next_at, Some(ms("2026-11-04T09:04:00Z")));

    dispatcher.stop().await;
    serving.abort();
}
