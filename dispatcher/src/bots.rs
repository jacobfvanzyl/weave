//! Bots (ADR 0028, WVE-118): named assistants the Dispatcher keeps, whose work goes on in
//! ordinary threads, one at a time, on the one Host each names, in its home there. The Host
//! learns nothing of them: a Bot's threads carry the labels `dispatcher` and `bot:<id>`, and the
//! rest is here.
//!
//! - A prompt for a Bot, from `bots/send` or a schedule naming it, is a delivery
//!   ([`Work::Bot`]) whose thread is settled when it's first sent ([`settle`]): its current
//!   thread, as a thread's prompt is, or `thread/run` in its home starting its first, whose
//!   answer makes that thread its own. Another prompt waits until that one is answered, so two
//!   never start two threads.
//! - A new thread ([`advance`]) is started by `bots/newThread`, or daily at its time, if the
//!   thread has had a turn since it started. From then its prompts wait; once its thread is
//!   idle, that thread is asked to save what's worth keeping to the home and note itself there;
//!   once that turn ends, a new thread starts in the home, the old one names it as its
//!   successor, and the prompts that waited go into it. Each step is written down with the
//!   delivery it sends, under a key made from the Bot and the new thread's number, so a restart
//!   takes it up where it was and starts nothing twice. While its Host is away, it waits.
//! - A Bot whose thread has waited on the person longer than its `pause_after` is paused, and
//!   its schedules' occurrences skipped, until the thread no longer waits ([`consider`]).
//!
//! - A Bot's home is made before the Bot is added ([`home`], WVE-178): its Host makes it with
//!   `repos/init`, a git repository of its own with the Bot's first memory files, and the Bot
//!   keeps the directory as the Host gives it. The Dispatcher never reads a Host's files itself.
//! - Those watching the Bots are told of each change to how one lists ([`watch`]).

mod home;
mod watch;

use std::path::Path;
use std::sync::Mutex;

use agent_client_protocol::Error;
use agent_client_protocol::schema::v1::ContentBlock;
use weave_host_client::HostHandle;
use weave_host_protocol::dispatcher::AddBotRequest;
use weave_host_protocol::dispatcher::AddBotResponse;
use weave_host_protocol::dispatcher::Bot;
use weave_host_protocol::dispatcher::BotState;
use weave_host_protocol::dispatcher::BotThread;
use weave_host_protocol::dispatcher::DEFAULT_PAUSE_AFTER;
use weave_host_protocol::dispatcher::SendToBotRequest;
use weave_host_protocol::dispatcher::SentToBot;
use weave_host_protocol::dispatcher::UpdateBotRequest;
use weave_host_protocol::errors;
use weave_host_protocol::threads::Activity;
use weave_host_protocol::threads::GetThreadRequest;
use weave_host_protocol::threads::RunRequest;
use weave_host_protocol::threads::ServiceOrigin;
use weave_host_protocol::threads::SetSuccessorRequest;
use weave_host_protocol::threads::ThreadId;
use weave_host_protocol::threads::TurnState;
use weave_host_protocol::turns::MAX_KEY;
use weave_host_protocol::worktrees::InitRepositoryResponse;
use weave_host_protocol::worktrees::REPOS_INIT_FEATURE;

use crate::Shared;
use crate::internal;
use crate::invalid;
use crate::link;
use crate::link::Seen;
use crate::lock;
use crate::scheduler;
use crate::scheduler::LABEL;
use crate::scheduler::LOOK_BACK;
use crate::scheduler::Plan;
use crate::store::BotChange;
use crate::store::BotError;
use crate::store::BotPrompt;
use crate::store::Delivery;
use crate::store::DeliveryState;
use crate::store::MOST_BOTS;
use crate::store::NewBot;
use crate::store::NewThread;
use crate::store::Step;
use crate::store::StoredBot;
use crate::store::StoredHost;
use crate::store::Work;
use crate::store::answered_thread;
use crate::store::too_many;

pub(crate) use self::watch::Watchers;

/// How many continuations of an interrupted save turn are followed, at most.
const MOST_CONTINUATIONS: usize = 64;

impl Shared {
    /// The Bots, by name, as they stand now.
    pub(crate) fn bots(&self) -> Result<Vec<Bot>, Error> {
        let hosts = self.store.hosts().map_err(internal)?;
        Ok(self
            .store
            .bots()
            .map_err(internal)?
            .into_iter()
            .map(|bot| self.listed_bot(bot, &hosts))
            .collect())
    }

    /// The Bot `by` names, by id or name, ignoring case.
    pub(crate) fn bot(&self, by: &str) -> Result<Bot, Error> {
        let bot = self.find_bot(by)?;
        let hosts = self.store.hosts().map_err(internal)?;
        Ok(self.listed_bot(bot, &hosts))
    }

    pub(crate) fn find_bot(&self, by: &str) -> Result<StoredBot, Error> {
        self.store
            .find_bot(by)
            .map_err(internal)?
            .ok_or_else(|| invalid(format!("there's no Bot {by}")))
    }

    /// Add the Bot `request` asks for, made by the Bot `created_by` names, by id, if one made it:
    /// checked first, then its home made by its Host, then written down with the home as the
    /// Host gave it. No Bot is added when its home can't be made, nor one a Bot makes once there
    /// are [`MOST_BOTS`]. The API never names a maker; a Bot's own tools do.
    pub(crate) async fn add_bot(
        &self,
        request: AddBotRequest,
        created_by: Option<&str>,
    ) -> Result<AddBotResponse, Error> {
        let name = self.store.free_bot_name(&request.name).map_err(refused)?;
        let host = self.resolve_host(&request.host)?;
        let agent_id = request.agent_id.trim();
        if agent_id.is_empty() {
            return Err(invalid("a Bot needs an agent"));
        }
        let home = match request.home {
            Some(home) => home,
            None => home::default_home(&name).map_err(invalid)?,
        };
        whole(&home)?;
        let zone = request.zone.unwrap_or_else(scheduler::local_zone);
        scheduler::zone_named(&zone).map_err(invalid)?;
        let new_thread_at = request
            .new_thread_at
            .as_deref()
            .map(daily)
            .transpose()
            .map_err(invalid)?;
        let created_by = match created_by {
            Some(by) => Some(self.find_bot(by)?.id),
            None => None,
        };
        if created_by.is_some() {
            let had = self.store.bots().map_err(internal)?.len();
            if had >= usize::try_from(MOST_BOTS).unwrap_or(usize::MAX) {
                return Err(invalid(too_many(u32::try_from(had).unwrap_or(u32::MAX))));
            }
        }
        let made = self
            .make_home(&host, &home, &name, request.job.as_deref())
            .await?;
        let new = NewBot {
            name,
            host_id: host.host_id,
            agent_id: agent_id.to_owned(),
            home: made.path.clone(),
            policy: request.policy.unwrap_or_default(),
            mode: request.mode,
            new_thread_at,
            zone,
            pause_after: request.pause_after.unwrap_or(DEFAULT_PAUSE_AFTER),
            created_by,
        };
        let bot = self
            .store
            .add_bot(&new, self.config.clock.now())
            .map_err(refused)?;
        tracing::info!(bot = %bot.name, host = %bot.host_id, home = %bot.home.display(), "added a Bot");
        self.schedules_changed.notify_one();
        self.bots_changed();
        Ok(AddBotResponse {
            bot: self.bot(&bot.id)?,
            home: Some(made),
        })
    }

    /// Have `host` make the home of the Bot called `name` at `home`, as its Host gives it back.
    async fn make_home(
        &self,
        host: &StoredHost,
        home: &Path,
        name: &str,
        job: Option<&str>,
    ) -> Result<InitRepositoryResponse, Error> {
        let Some(handle) = self.handle(&host.host_id) else {
            return Err(errors::host_unavailable(format!(
                "{} isn't connected to the Dispatcher now, so it can't make {name}'s home; add \
                 the Bot once it's back",
                host.name
            )));
        };
        if !handle
            .hello()
            .features
            .iter()
            .any(|feature| feature == REPOS_INIT_FEATURE)
        {
            return Err(invalid(format!(
                "{}'s weave is too old to make {name}'s home: update weave there, and add the Bot \
                 again",
                host.name
            )));
        }
        match handle.send(home::request(home, name, job)).await {
            Ok(made) => Ok(made),
            Err(error) if link::again(&error) => Err(errors::host_unavailable(format!(
                "{} couldn't be asked to make {name}'s home now: {}",
                host.name,
                said(&error)
            ))),
            Err(error) => Err(invalid(format!(
                "{} couldn't make {name}'s home at {}: {}",
                host.name,
                home.display(),
                said(&error)
            ))),
        }
    }

    pub(crate) fn update_bot(&self, request: UpdateBotRequest) -> Result<Bot, Error> {
        if let Some(zone) = &request.zone {
            scheduler::zone_named(zone).map_err(invalid)?;
        }
        let new_thread_at = match request.new_thread_at {
            Some(Some(at)) => Some(Some(daily(&at).map_err(invalid)?)),
            other => other,
        };
        let change = BotChange {
            name: request.name,
            policy: request.policy,
            mode: request.mode,
            new_thread_at,
            zone: request.zone,
            pause_after: request.pause_after,
        };
        let bot = self
            .store
            .update_bot(&request.bot, &change, self.config.clock.now())
            .map_err(refused)?;
        tracing::info!(bot = %bot.name, "changed a Bot");
        self.schedules_changed.notify_one();
        self.bots_changed();
        self.bot(&bot.id)
    }

    /// Forget the Bot `by` names, its schedules and the prompts waiting for it.
    pub(crate) fn remove_bot(&self, by: &str) -> Result<(), Error> {
        let bot = self.store.remove_bot(by).map_err(refused)?;
        tracing::info!(bot = %bot.name, "removed a Bot");
        self.schedules_changed.notify_one();
        self.bots_changed();
        Ok(())
    }

    /// Write `request`'s prompt down for its Bot, and send it as soon as the Bot's Host can
    /// take it.
    pub(crate) fn send_to_bot(&self, request: SendToBotRequest) -> Result<SentToBot, Error> {
        if request.prompt.is_empty() {
            return Err(invalid("a prompt for a Bot needs something in it"));
        }
        let bot = self.find_bot(&request.bot)?;
        let key = request.key.as_deref().map(|key| send_key(&bot.id, key));
        let label = format!("bot {}", bot.name);
        let prompt = request.prompt;
        let delivery = self
            .store
            .add_bot_prompt(&bot, key.as_deref(), |id| {
                Work::Bot(BotPrompt {
                    bot_id: bot.id.clone(),
                    prompt,
                    key: key.clone(),
                    origin: ServiceOrigin {
                        label,
                        id: id.to_owned(),
                    },
                })
            })
            .map_err(internal)?;
        tracing::info!(bot = %bot.name, delivery = %delivery.id, "a prompt for a Bot");
        self.wake(&bot.host_id);
        Ok(SentToBot {
            delivery_id: delivery.id,
            bot: self.bot(&bot.id)?,
        })
    }

    /// Begin the Bot `by` names' new thread.
    pub(crate) fn new_bot_thread(&self, by: &str) -> Result<Bot, Error> {
        let bot = self.find_bot(by)?;
        let bot = self
            .store
            .begin_new_thread(&bot.id, self.config.clock.now())
            .map_err(refused)?;
        tracing::info!(bot = %bot.name, "a Bot begins a new thread, as asked");
        self.wake(&bot.host_id);
        self.bots_changed();
        self.bot(&bot.id)
    }

    /// `bot` as the API gives it: its Host's name and connection, and its thread's state, now.
    fn listed_bot(&self, bot: StoredBot, hosts: &[StoredHost]) -> Bot {
        let listing = bot
            .thread
            .as_ref()
            .and_then(|thread| self.thread(&bot.host_id, &ThreadId::new(thread.clone())));
        let state = match listing.and_then(|listing| listing.activity) {
            Some(Activity::Running) => BotState::Working,
            Some(Activity::Waiting) => BotState::NeedsYou,
            _ => BotState::Idle,
        };
        Bot {
            host_name: hosts
                .iter()
                .find(|host| host.host_id == bot.host_id)
                .map(|host| host.name.clone())
                .unwrap_or_default(),
            connected: self.connected(&bot.host_id),
            thread: bot.thread.map(ThreadId::new),
            threads: bot
                .threads
                .into_iter()
                .map(|thread| BotThread {
                    thread_id: ThreadId::new(thread.thread_id),
                    started_at: thread.started_at,
                    ended_at: thread.ended_at,
                })
                .collect(),
            state,
            waiting_since: bot.waiting_since,
            paused: bot.paused,
            starting_thread: bot.new_thread.is_some(),
            id: bot.id,
            name: bot.name,
            agent_id: bot.agent_id,
            host_id: bot.host_id,
            home: bot.home,
            policy: bot.policy,
            mode: bot.mode,
            new_thread_at: bot.new_thread_at,
            zone: bot.zone,
            pause_after: bot.pause_after,
            created_at: bot.created_at,
            updated_at: bot.updated_at,
            created_by: bot.created_by,
            created_by_name: bot.created_by_name,
        }
    }
}

fn refused(error: BotError) -> Error {
    match error {
        BotError::Refused(why) => invalid(why),
        BotError::Failed(why) => internal(why),
    }
}

/// What a Host's `error` said: its message, and its data when that's words too.
pub(crate) fn said(error: &Error) -> String {
    match error.data.as_ref().and_then(serde_json::Value::as_str) {
        Some(data) if !error.message.contains(data) => format!("{}: {data}", error.message),
        _ => error.message.clone(),
    }
}

/// Refused unless `home` is whole, or under the Host's home as `~/…`.
fn whole(home: &Path) -> Result<(), Error> {
    match home.is_absolute() || home.starts_with("~") {
        true => Ok(()),
        false => Err(invalid(format!(
            "{} isn't a whole path, or one under ~, on the Bot's Host",
            home.display()
        ))),
    }
}

/// `at` as a time of day, `HH:MM`, or why it isn't one.
pub(crate) fn daily(at: &str) -> Result<String, String> {
    hour_minute(at).map(|(hour, minute)| format!("{hour:02}:{minute:02}"))
}

fn hour_minute(at: &str) -> Result<(u8, u8), String> {
    let refused = || format!("{at:?} isn't a time of day as HH:MM");
    let (hour, minute) = at.trim().split_once(':').ok_or_else(refused)?;
    let (Ok(hour), Ok(minute)) = (hour.parse::<u8>(), minute.parse::<u8>()) else {
        return Err(refused());
    };
    if hour > 23 || minute > 59 {
        return Err(refused());
    }
    Ok((hour, minute))
}

/// The plan of a Bot's daily new thread at `at`, `HH:MM`, in `zone`.
fn daily_plan(at: &str, zone: &str) -> Result<Plan, String> {
    let (hour, minute) = hour_minute(at)?;
    Plan::new(&format!("{minute} {hour} * * *"), zone)
}

/// The request key a prompt sent with `key` goes under: the Bot's own, so two Bots' keys never
/// meet, hashed when it would be too long.
fn send_key(bot_id: &str, key: &str) -> String {
    let plain = format!("bot/{bot_id}/send/{key}");
    if plain.chars().count() <= MAX_KEY {
        return plain;
    }
    use base64::Engine as _;
    use sha2::Digest as _;
    let digest = sha2::Sha256::digest(key.as_bytes());
    format!(
        "bot/{bot_id}/send/{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
    )
}

/// The labels a Bot's threads carry.
pub(crate) fn labels(bot_id: &str) -> Vec<String> {
    vec![LABEL.to_owned(), format!("bot:{bot_id}")]
}

/// `thread/run` for `bot`, in its home, with its agent, policy, mode and labels: into `thread`,
/// or starting a new thread.
fn run_request(
    bot: &StoredBot,
    thread: Option<ThreadId>,
    prompt: Vec<ContentBlock>,
    key: Option<String>,
    origin: ServiceOrigin,
) -> RunRequest {
    RunRequest {
        agent_id: bot.agent_id.clone(),
        cwd: bot.home.clone(),
        remote: None,
        thread_id: thread,
        additional_directories: Vec::new(),
        mode: bot.mode.clone(),
        prompt,
        policy: bot.policy.clone(),
        attach: false,
        trace: false,
        key,
        caller: None,
        origin: Some(origin),
        labels: labels(&bot.id),
    }
}

/// How a Bot's prompt, `delivery`, reaches it, settled before its first send: into its current
/// thread, as a thread's prompt is ([`link::into_thread`]), or `thread/run` starting its first.
/// None while it waits: for the Bot's new thread, or for another of its prompts starting its
/// first.
pub(crate) fn settle(
    shared: &Shared,
    delivery: &Delivery,
    prompt: &BotPrompt,
    seen: &Mutex<Seen>,
) -> Option<Work> {
    let bot = match shared.store.find_bot(&prompt.bot_id) {
        Ok(Some(bot)) if bot.id == prompt.bot_id => bot,
        Ok(_) => return None,
        Err(why) => {
            tracing::warn!(delivery = %delivery.id, %why, "reading a prompt's Bot failed");
            return None;
        }
    };
    if bot.new_thread.is_some() {
        return None;
    }
    let request = run_request(
        &bot,
        bot.thread.clone().map(ThreadId::new),
        prompt.prompt.clone(),
        prompt.key.clone(),
        prompt.origin.clone(),
    );
    if bot.thread.is_some() {
        return Some(link::into_thread(&request, seen));
    }
    match shared.store.bot_starting(&bot.id, &delivery.id) {
        Ok(false) => Some(Work::Run(request)),
        Ok(true) => None,
        Err(why) => {
            tracing::warn!(delivery = %delivery.id, %why, "reading a Bot's prompts failed");
            None
        }
    }
}

/// The Host took a Bot's `delivery`, answering `answer`: a thread a `thread/run` opened is read
/// now, so the Bot's next prompt finds it open and waits in its queue rather than running into
/// its turn, before the watch says so.
pub(crate) async fn delivered(
    handle: &HostHandle,
    seen: &Mutex<Seen>,
    delivery: &Delivery,
    answer: &serde_json::Value,
) {
    let Work::Run(_) = &delivery.work else {
        return;
    };
    let Some(thread) = answered_thread(answer) else {
        return;
    };
    let read = handle
        .send(GetThreadRequest {
            thread_id: ThreadId::new(thread.to_owned()),
            turn_id: None,
        })
        .await;
    match read {
        Ok(got) => {
            lock(seen)
                .threads
                .insert(got.thread.info.session_id.clone(), got.thread);
        }
        Err(error) => tracing::debug!(%thread, %error, "reading a Bot's thread failed"),
    }
}

/// Carry on with what the Bots on `host` are doing, those whose threads `only` names or all:
/// note when their threads start or stop waiting on the person, begin a daily new thread that
/// came due, and take each new thread's next step. Whether it wrote down work for the Host or
/// let a Bot's prompts go on, for the link to send.
pub(crate) async fn advance(
    shared: &Shared,
    host: &StoredHost,
    handle: &HostHandle,
    seen: &Mutex<Seen>,
    only: Option<&ThreadId>,
) -> bool {
    let bots = match shared.store.bots() {
        Ok(bots) => bots,
        Err(why) => {
            tracing::warn!(host = %host.host_id, %why, "reading the Bots failed");
            return false;
        }
    };
    let mut more = false;
    for bot in bots.iter().filter(|bot| bot.host_id == host.host_id) {
        if only.is_some_and(|only| !concerns(bot, only)) {
            continue;
        }
        note_waiting(shared, bot, seen);
        match &bot.new_thread {
            Some(new_thread) => more |= step(shared, bot, new_thread, handle, seen).await,
            None if bot.new_thread_due.is_some() && only.is_none() => {
                more |= daily_due(shared, bot, handle).await;
            }
            None => {}
        }
    }
    more
}

/// Whether `bot` has to do with `thread`: its current thread, or one its new thread's sequence
/// is in.
fn concerns(bot: &StoredBot, thread: &ThreadId) -> bool {
    let is = |id: &Option<String>| id.as_deref() == Some(&*thread.0);
    is(&bot.thread)
        || bot
            .new_thread
            .as_ref()
            .is_some_and(|new_thread| *new_thread.from == *thread.0 || is(&new_thread.thread))
}

fn activity(seen: &Mutex<Seen>, thread: &str) -> Option<Activity> {
    lock(seen)
        .threads
        .get(&ThreadId::new(thread.to_owned()))
        .and_then(|listing| listing.activity)
}

/// Whether `thread` runs a turn or waits on the person, as the watch last said.
fn busy(seen: &Mutex<Seen>, thread: &str) -> bool {
    matches!(
        activity(seen, thread),
        Some(Activity::Running | Activity::Waiting)
    )
}

/// Write down when `bot`'s current thread began waiting on the person, by the scheduler's
/// clock, or that it no longer does, which resumes it, and have the scheduler look again.
fn note_waiting(shared: &Shared, bot: &StoredBot, seen: &Mutex<Seen>) {
    let waiting = bot
        .thread
        .as_deref()
        .is_some_and(|thread| activity(seen, thread) == Some(Activity::Waiting));
    let since = match (waiting, bot.waiting_since) {
        (true, None) => Some(shared.config.clock.now()),
        (false, Some(_)) => None,
        _ => return,
    };
    if let Err(why) = shared.store.bot_waiting(&bot.id, since) {
        tracing::warn!(bot = %bot.name, %why, "recording a Bot's thread waiting failed");
        return;
    }
    if since.is_none() && bot.paused.is_some() {
        tracing::info!(bot = %bot.name, "a Bot's thread no longer waits on the person; its schedules go on");
    }
    shared.schedules_changed.notify_one();
}

/// `bot`'s daily new thread came due: begin it if its thread has had a turn since it started,
/// as its Host says. Whether it began.
async fn daily_due(shared: &Shared, bot: &StoredBot, handle: &HostHandle) -> bool {
    let not_due = |why: &str| {
        tracing::info!(bot = %bot.name, why, "skipped a Bot's daily new thread");
        if let Err(why) = shared.store.new_thread_not_due(&bot.id) {
            tracing::warn!(bot = %bot.name, %why, "recording a Bot's daily new thread failed");
        }
        false
    };
    let Some(thread) = &bot.thread else {
        return not_due("it has no thread");
    };
    let first = bot
        .threads
        .iter()
        .rev()
        .find(|stored| stored.thread_id == *thread)
        .and_then(|stored| stored.first_turn.clone());
    let read = handle
        .send(GetThreadRequest {
            thread_id: ThreadId::new(thread.clone()),
            turn_id: None,
        })
        .await;
    let used = match read {
        Ok(got) => match (got.latest_turn, first) {
            (Some(latest), Some(first)) => {
                latest.turn_id.as_deref() != Some(&*first)
                    && latest.continues.as_deref() != Some(&*first)
            }
            (Some(_), None) => true,
            (None, _) => false,
        },
        Err(error) if errors::is(&error, errors::UNKNOWN_THREAD) => true,
        Err(error) => {
            tracing::debug!(bot = %bot.name, %error, "reading a Bot's thread failed; its daily new thread waits");
            return false;
        }
    };
    if !used {
        return not_due("its thread has had no turn since it started");
    }
    match shared
        .store
        .begin_new_thread(&bot.id, shared.config.clock.now())
    {
        Ok(_) => {
            tracing::info!(bot = %bot.name, "a Bot begins its daily new thread");
            true
        }
        Err(BotError::Refused(why)) => not_due(&why),
        Err(BotError::Failed(why)) => {
            tracing::warn!(bot = %bot.name, %why, "beginning a Bot's new thread failed");
            false
        }
    }
}

/// How the save turn of a Bot's new thread went.
enum Saved {
    Ended,
    /// It didn't finish, as this says.
    Not(String),
}

/// Take `bot`'s new thread's next step, if it can be taken now. Whether it wrote down work for
/// the Host or let the Bot's prompts go on.
async fn step(
    shared: &Shared,
    bot: &StoredBot,
    new_thread: &NewThread,
    handle: &HostHandle,
    seen: &Mutex<Seen>,
) -> bool {
    let number = new_thread.number;
    let from = &new_thread.from;
    match new_thread.step {
        Step::Waiting => {
            if busy(seen, from) {
                return false;
            }
            let note = note(bot, from, shared.config.clock.now());
            let text = format!(
                "This turn is the Bot {}'s, before it starts a new thread. Save what's worth \
                 keeping from this thread to your memory files in {}, write a note about this \
                 thread at {note} there, and commit.",
                bot.name,
                bot.home.display()
            );
            let saved = shared.store.save_new_thread(bot, number, &note, |id| {
                Work::Prompt(run_request(
                    bot,
                    Some(ThreadId::new(from.clone())),
                    vec![ContentBlock::from(text)],
                    Some(format!("bot/{}/new-thread/{number}/save", bot.id)),
                    origin(bot, id),
                ))
            });
            written(bot, saved, "the prompt saving its thread")
        }
        Step::Saving => {
            let Some(save) = new_thread
                .save
                .as_deref()
                .and_then(|id| shared.store.delivery(id).ok().flatten())
            else {
                return false;
            };
            let saved = match save.state {
                DeliveryState::Pending => return false,
                DeliveryState::Failed => Saved::Not(format!(
                    "its Host refused the prompt: {}",
                    save.error.unwrap_or_default()
                )),
                DeliveryState::Delivered => {
                    let started = save
                        .answer
                        .as_ref()
                        .and_then(|answer| save.work.started(answer));
                    match started {
                        Some((thread, _)) if busy(seen, &thread) => return false,
                        Some((thread, turn)) => match ended(handle, &thread, turn).await {
                            Some(saved) => saved,
                            None => return false,
                        },
                        None => Saved::Not("its Host didn't say which turn it was".to_owned()),
                    }
                }
            };
            let note = new_thread.note.as_deref().unwrap_or_default();
            let mut text = format!(
                "This is the Bot {}'s new thread, which takes over from the thread {from}. That \
                 thread's note is at {note} in {}. Read your memory files there before you go \
                 on.",
                bot.name,
                bot.home.display()
            );
            if let Saved::Not(why) = &saved {
                text.push_str(&format!(
                    " Saving that thread didn't finish ({why}), so the note and your memory \
                     files may be missing what it learned."
                ));
            }
            let started = shared.store.start_new_thread(bot, number, |id| {
                Work::Run(run_request(
                    bot,
                    None,
                    vec![ContentBlock::from(text)],
                    Some(format!("bot/{}/new-thread/{number}/start", bot.id)),
                    origin(bot, id),
                ))
            });
            written(bot, started, "its new thread")
        }
        Step::Starting => false,
        Step::Naming => {
            let Some(thread) = &new_thread.thread else {
                return false;
            };
            let named = handle
                .send(SetSuccessorRequest {
                    thread_id: ThreadId::new(from.clone()),
                    successor: ThreadId::new(thread.clone()),
                })
                .await;
            match named {
                Ok(_) => {}
                Err(error) if errors::is(&error, errors::THREAD_NOT_OPEN) => {
                    tracing::info!(bot = %bot.name, %from, "a Bot's old thread wasn't open to name its new one as its successor");
                }
                Err(error) if link::again(&error) => return false,
                Err(error) => {
                    tracing::warn!(bot = %bot.name, %from, %error, "naming a Bot's new thread its old one's successor failed");
                }
            }
            match shared.store.finish_new_thread(&bot.id, number) {
                Ok(finished) => {
                    if finished {
                        tracing::info!(bot = %bot.name, %from, %thread, "a Bot's new thread took over");
                    }
                    finished
                }
                Err(why) => {
                    tracing::warn!(bot = %bot.name, %why, "recording a Bot's new thread failed");
                    false
                }
            }
        }
    }
}

/// Whether a step wrote `what` down, saying so.
fn written(bot: &StoredBot, written: Result<Option<Delivery>, String>, what: &str) -> bool {
    match written {
        Ok(Some(delivery)) => {
            tracing::info!(bot = %bot.name, delivery = %delivery.id, what, "a Bot's new thread goes on");
            true
        }
        Ok(None) => false,
        Err(why) => {
            tracing::warn!(bot = %bot.name, %why, what, "writing a Bot's new thread down failed");
            false
        }
    }
}

/// What started the turns of `bot`'s own deliveries, the one `id`.
fn origin(bot: &StoredBot, id: &str) -> ServiceOrigin {
    ServiceOrigin {
        label: format!("bot {}", bot.name),
        id: id.to_owned(),
    }
}

/// Where in `bot`'s home the thread `thread` notes itself as it hands over at `now`:
/// `threads/<date in its zone>-<the thread id's first 8 characters>.md`.
fn note(bot: &StoredBot, thread: &str, now: u64) -> String {
    let date = Plan::once(now, &bot.zone)
        .map(|plan| plan.date(now))
        .unwrap_or_default();
    let short: String = thread.chars().take(8).collect();
    format!("threads/{date}-{short}.md")
}

/// How the turn `turn` in `thread` went, once it's over, following one its Host stopped under
/// into its continuation: none while it runs, or while a headless thread is still to continue
/// it, or the Host can't be read now.
async fn ended(handle: &HostHandle, thread: &str, turn: String) -> Option<Saved> {
    let thread_id = ThreadId::new(thread.to_owned());
    let mut turn = turn;
    for _ in 0..MOST_CONTINUATIONS {
        let read = handle
            .send(GetThreadRequest {
                thread_id: thread_id.clone(),
                turn_id: Some(turn.clone()),
            })
            .await;
        let got = match read {
            Ok(got) => got,
            Err(error)
                if errors::is(&error, errors::UNKNOWN_THREAD)
                    || errors::is(&error, errors::UNKNOWN_TURN) =>
            {
                return Some(Saved::Not(error.message));
            }
            Err(error) => {
                tracing::debug!(%thread, %error, "reading a Bot's save turn failed");
                return None;
            }
        };
        let Some(latest) = got.latest_turn else {
            return Some(Saved::Not("its Host has no record of the turn".to_owned()));
        };
        if !latest.state.is_over() {
            return None;
        }
        match latest.continued_in {
            Some(next) => turn = next,
            None if latest.state == TurnState::Interrupted && got.thread.headless => return None,
            None => {
                return Some(match latest.state {
                    TurnState::Ended => Saved::Ended,
                    state => {
                        let said = latest
                            .error
                            .map(|error| format!(": {}", error.message))
                            .unwrap_or_default();
                        Saved::Not(format!("its turn {}{said}", ended_as(state)))
                    }
                });
            }
        }
    }
    Some(Saved::Not(
        "its turn was interrupted too many times".to_owned(),
    ))
}

fn ended_as(state: TurnState) -> &'static str {
    match state {
        TurnState::Cancelled => "was cancelled",
        TurnState::Stopped => "stopped short",
        TurnState::Interrupted => "was interrupted",
        _ => "failed",
    }
}

/// Consider every Bot at `now`, by the scheduler's clock: pause one whose thread has waited on
/// the person longer than it allows, and note a daily new thread that came due, a missed day
/// once, for its Host's link to begin. When it next has to look.
pub(crate) fn consider(shared: &Shared, now: u64) -> Option<u64> {
    let bots = match shared.store.bots() {
        Ok(bots) => bots,
        Err(why) => {
            tracing::warn!(%why, "reading the Bots failed");
            return None;
        }
    };
    let mut next: Option<u64> = None;
    let mut sooner = |at: Option<u64>| {
        next = match (next, at) {
            (Some(next), Some(at)) => Some(next.min(at)),
            (next, at) => next.or(at),
        };
    };
    for bot in &bots {
        if let (Some(since), None) = (bot.waiting_since, &bot.paused) {
            let deadline = since.saturating_add(bot.pause_after);
            if now >= deadline {
                let when = Plan::once(since, &bot.zone)
                    .map(|plan| plan.describe(since))
                    .unwrap_or_default();
                let why = format!("its thread has waited on the person since {when}");
                match shared.store.pause_bot(&bot.id, since, &why) {
                    Ok(true) => tracing::info!(bot = %bot.name, %why, "paused a Bot's schedules"),
                    Ok(false) => {}
                    Err(why) => tracing::warn!(bot = %bot.name, %why, "pausing a Bot failed"),
                }
            } else {
                sooner(Some(deadline));
            }
        }
        let Some(at) = &bot.new_thread_at else {
            continue;
        };
        let plan = match daily_plan(at, &bot.zone) {
            Ok(plan) => plan,
            Err(why) => {
                tracing::warn!(bot = %bot.name, %why, "a Bot's daily new thread has no plan");
                continue;
            }
        };
        let from = bot.new_thread_considered.max(now.saturating_sub(LOOK_BACK));
        if let Some(due) = plan.between(from, now).last().copied() {
            let due = match (&bot.thread, &bot.new_thread) {
                (Some(_), None) => Some(due),
                (None, _) => {
                    tracing::info!(bot = %bot.name, "skipped a Bot's daily new thread: it has no thread");
                    None
                }
                (Some(_), Some(_)) => {
                    tracing::info!(bot = %bot.name, "skipped a Bot's daily new thread: it's starting one");
                    None
                }
            };
            match shared.store.new_thread_considered(&bot.id, due, now) {
                Ok(()) if due.is_some() => shared.wake(&bot.host_id),
                Ok(()) => {}
                Err(why) => {
                    tracing::warn!(bot = %bot.name, %why, "recording a Bot's daily new thread failed")
                }
            }
        }
        sooner(plan.next_after(now));
    }
    next
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn a_time_of_day_is_hh_mm() {
        assert_eq!(daily("9:05"), Ok("09:05".to_owned()));
        assert_eq!(daily(" 23:59 "), Ok("23:59".to_owned()));
        for wrong in ["24:00", "12:60", "noon", "12", "-1:00"] {
            assert!(daily(wrong).is_err(), "{wrong}");
        }
        let plan = daily_plan("09:00", "UTC").expect("a plan");
        assert_eq!(
            plan.describe(plan.next_after(0).expect("a time")),
            "Thu 1 Jan 09:00 UTC"
        );
        let midnight = daily_plan("00:00", "UTC").expect("a plan");
        assert_eq!(
            midnight.describe(midnight.next_after(0).expect("a time")),
            "Fri 2 Jan 00:00 UTC"
        );
    }

    #[test]
    fn a_long_key_is_hashed_within_the_hosts_limit() {
        assert_eq!(send_key("b-1", "mine"), "bot/b-1/send/mine");
        let long = send_key("b-1", &"k".repeat(400));
        assert!(
            long.starts_with("bot/b-1/send/") && long.len() <= MAX_KEY,
            "{long}"
        );
        assert_eq!(long, send_key("b-1", &"k".repeat(400)));
    }
}
