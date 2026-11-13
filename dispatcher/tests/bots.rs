//! Bots (ADR 0028, WVE-118) against an in-process Host with the fake agent, on a clock the tests
//! move: a Bot's life through the Dispatcher's socket and through a paired device; its first
//! prompt starting its thread in its home, and the rest following it there; its state; a new
//! thread, asked for and daily, across the Dispatcher's restarts at each step and the Host's;
//! pausing while its thread waits on the person; a one-off schedule prompting it once; and its
//! own wake-ups, which its agent asks for, lists and cancels with the Dispatcher's tools. Its home,
//! which its Host makes as it's added; a Bot another made; watching the Bots; listing one's
//! schedules; and a Bot's own tools making another Bot and managing its schedules, refused to any
//! other thread and held to their limits (WVE-178).

#![allow(clippy::expect_used)]

mod common;

use std::future::Future;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use pretty_assertions::assert_eq;
use serde_json::json;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::PermissionOptionId;
use weave_acp_core::schema::RequestPermissionOutcome;
use weave_acp_core::schema::RequestPermissionResponse;
use weave_acp_core::schema::SelectedPermissionOutcome;
use weave_acp_core::schema::ToolKind;
use weave_dispatcher::Clock;
use weave_dispatcher::Delivery;
use weave_dispatcher::DeliveryState;
use weave_dispatcher::Dispatcher;
use weave_dispatcher::Work;
use weave_dispatcher::client::BotChange;
use weave_dispatcher::client::DispatcherConnection;
use weave_dispatcher::socket;
use weave_host_client::Credentials;
use weave_host_client::HostConnection;
use weave_host_client::HostEvent;
use weave_host_client::remote::DeviceKey;
use weave_host_client::remote::Opened;
use weave_host_client::remote::connect_websocket_as;
use weave_host_client::remote::open_dispatcher;
use weave_host_protocol::devices::OfferDeviceRequest;
use weave_host_protocol::dispatcher::AddBotRequest;
use weave_host_protocol::dispatcher::AddScheduleRequest;
use weave_host_protocol::dispatcher::BOTS_FEATURE;
use weave_host_protocol::dispatcher::BOTS_HOME_FEATURE;
use weave_host_protocol::dispatcher::BOTS_WATCH_FEATURE;
use weave_host_protocol::dispatcher::Bot;
use weave_host_protocol::dispatcher::BotColor;
use weave_host_protocol::dispatcher::BotState;
use weave_host_protocol::dispatcher::DEFAULT_PAUSE_AFTER;
use weave_host_protocol::dispatcher::DISPATCHER_HOST_SUBPROTOCOL;
use weave_host_protocol::dispatcher::DISPATCHER_SUBPROTOCOL;
use weave_host_protocol::dispatcher::DispatcherAddress;
use weave_host_protocol::dispatcher::DispatcherChallengeRequest;
use weave_host_protocol::dispatcher::GetBotRequest;
use weave_host_protocol::dispatcher::ListBotsRequest;
use weave_host_protocol::dispatcher::ListSchedulesRequest;
use weave_host_protocol::dispatcher::Missed;
use weave_host_protocol::dispatcher::NewBotThreadRequest;
use weave_host_protocol::dispatcher::Occurrence;
use weave_host_protocol::dispatcher::OccurrenceState;
use weave_host_protocol::dispatcher::Overlap;
use weave_host_protocol::dispatcher::RemoveBotRequest;
use weave_host_protocol::dispatcher::RemoveHostRequest;
use weave_host_protocol::dispatcher::SendToBotRequest;
use weave_host_protocol::dispatcher::SentToBot;
use weave_host_protocol::dispatcher::UnwatchBotsRequest;
use weave_host_protocol::dispatcher::UpdateBotRequest;
use weave_host_protocol::dispatcher::WatchBotsRequest;
use weave_host_protocol::errors;
use weave_host_protocol::events::ThreadEvent;
use weave_host_protocol::hello::ClientCapabilities;
use weave_host_protocol::pending::AnswerPendingRequest;
use weave_host_protocol::policy::PermissionPolicy;
use weave_host_protocol::policy::Unapproved;
use weave_host_protocol::queue::AddQueuedRequest;
use weave_host_protocol::threads::AttachThreadRequest;
use weave_host_protocol::threads::GetThreadRequest;
use weave_host_protocol::threads::LatestTurn;
use weave_host_protocol::threads::RunRequest;
use weave_host_protocol::threads::ThreadId;
use weave_host_protocol::threads::ThreadListing;
use weave_host_protocol::threads::TurnOrigin;
use weave_host_protocol::worktrees::FilesMade;
use weave_host_protocol::worktrees::InitRepositoryResponse;
use weave_remote::access::RemoteSettings;
use weave_remote::access::Serve;
use weave_remote::preamble;

use crate::common::WAIT;
use crate::common::World;
use crate::common::ask;
use crate::common::dispatcher_config;
use crate::common::host_until;
use crate::common::info;
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

/// A Tailscale Serve that hands out `ws://` URLs to the listener itself.
struct FakeServe;

impl Serve for FakeServe {
    fn ensure(&self, listen: SocketAddr) -> BoxFuture<'_, Result<String, String>> {
        Box::pin(async move { Ok(format!("ws://{listen}")) })
    }

    fn remove(&self, _listen: SocketAddr) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}

/// A Dispatcher from its own directory on a clock the test moves, with studio's Host joined and
/// connected, and a directory `odin` in studio's home for a Bot.
struct Setup {
    dir: tempfile::TempDir,
    clock: Arc<TestClock>,
    dispatcher: Dispatcher,
    serving: JoinHandle<()>,
    studio: World,
    host_id: String,
}

impl Setup {
    async fn new(time: &str) -> Self {
        Self::with(World::new().await, time).await
    }

    async fn with(studio: World, time: &str) -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let clock = TestClock::at(time);
        let (dispatcher, serving) = start_with(dir.path(), clock.clone());
        studio.join(&dispatcher, dir.path(), "studio").await;
        let host_id = studio.host_id().await;
        host_until(&dispatcher, &host_id, |host| host.connected).await;
        std::fs::create_dir_all(studio.home().join("odin")).expect("odin's home");
        Self {
            dir,
            clock,
            dispatcher,
            serving,
            studio,
            host_id,
        }
    }

    /// Stop the Dispatcher, as a crash or the person would, and start it again from its
    /// directory, waiting for studio to connect again.
    async fn restart(&mut self) {
        self.stop().await;
        self.start().await;
    }

    async fn stop(&mut self) {
        self.dispatcher.stop().await;
        self.serving.abort();
        let _ = (&mut self.serving).await;
    }

    async fn start(&mut self) {
        let (dispatcher, serving) = start_with(self.dir.path(), self.clock.clone());
        self.dispatcher = dispatcher;
        self.serving = serving;
        host_until(&self.dispatcher, &self.host_id, |host| host.connected).await;
    }

    fn database(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(dispatcher_config(self.dir.path()).paths.database())
            .expect("the database")
    }

    /// The Bot odin, in `~/odin` on studio, asking the person what its policy doesn't approve.
    async fn odin(&self) -> Bot {
        self.dispatcher.add_bot(odin()).await.expect("bots/add").bot
    }

    /// Where studio made `name`'s home, as the Dispatcher keeps it: whole, symlinks resolved.
    fn home(&self, name: &str) -> PathBuf {
        home_on(&self.studio, name)
    }

    async fn send(&self, text: &str) -> SentToBot {
        self.dispatcher
            .send_to_bot(SendToBotRequest {
                bot: "odin".to_owned(),
                prompt: prompt(text),
                key: None,
            })
            .expect("bots/send")
    }

    /// Wait until odin is as `wanted` says.
    async fn odin_until(&self, wanted: impl Fn(&Bot) -> bool) -> Bot {
        let found = tokio::time::timeout(WAIT, async {
            loop {
                let bot = self.dispatcher.bot("odin").expect("bots/get");
                if wanted(&bot) {
                    return bot;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        found.unwrap_or_else(|_| panic!("odin in time: {:#?}", self.dispatcher.bot("odin")))
    }

    /// Wait until the delivery `id` isn't pending, and give it, taken.
    async fn taken(&self, id: &str) -> Delivery {
        let delivery = tokio::time::timeout(WAIT, async {
            loop {
                let delivery = self.dispatcher.delivery(id).expect("read").expect("there");
                if delivery.state != DeliveryState::Pending {
                    return delivery;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("delivery {id} in time: {:?}", self.dispatcher.delivery(id)));
        assert_eq!(delivery.state, DeliveryState::Delivered, "{delivery:?}");
        delivery
    }

    /// Have the Bot `bot`'s agent call the Dispatcher's `tool` with `arguments`, in the Bot's
    /// thread: what the tool answered, as JSON, or why it failed.
    async fn calls(
        &self,
        bot: &str,
        tool: &str,
        arguments: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let sent = self
            .dispatcher
            .send_to_bot(SendToBotRequest {
                bot: bot.to_owned(),
                prompt: prompt(&format!("tool {} {arguments}", dispatcher_tool(tool))),
                key: None,
            })
            .expect("bots/send");
        let delivery = self.taken(&sent.delivery_id).await;
        let said = said(&self.studio, &thread_of(&delivery), &turn_of(&delivery)).await;
        answered(&said, tool)
    }

    /// Send odin `text` and wait for its turn to end: the thread it went into.
    async fn turn(&self, text: &str) -> ThreadId {
        let sent = self.send(text).await;
        let delivery = self.taken(&sent.delivery_id).await;
        let thread = thread_of(&delivery);
        ended(&self.studio, &thread, &turn_of(&delivery)).await;
        thread
    }

    /// Wait until `name` has occurrences as `wanted` says, newest first.
    async fn occurrences_until(
        &self,
        name: &str,
        wanted: impl Fn(&[Occurrence]) -> bool,
    ) -> Vec<Occurrence> {
        let found = tokio::time::timeout(WAIT, async {
            loop {
                let occurrences = self
                    .dispatcher
                    .occurrences(Some(name), None)
                    .expect("occurrences");
                if wanted(&occurrences) {
                    return occurrences;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        found.unwrap_or_else(|_| {
            panic!(
                "{name}'s occurrences in time: {:?}",
                self.dispatcher.occurrences(Some(name), None)
            )
        })
    }
}

fn odin() -> AddBotRequest {
    add("odin", "~/odin")
}

fn add(name: &str, home: &str) -> AddBotRequest {
    AddBotRequest {
        name: name.to_owned(),
        host: "studio".to_owned(),
        agent_id: "fake".to_owned(),
        home: Some(home.into()),
        job: None,
        policy: None,
        mode: None,
        new_thread_at: None,
        zone: Some("UTC".to_owned()),
        pause_after: None,
        emoji: None,
        color: None,
    }
}

/// `name` under `world`'s home, whole, symlinks resolved, as its Host gives a home it made.
fn home_on(world: &World, name: &str) -> PathBuf {
    world
        .home()
        .join(name)
        .canonicalize()
        .expect("the home is there")
}

fn prompt(text: &str) -> Vec<ContentBlock> {
    vec![ContentBlock::from(text.to_owned())]
}

/// A schedule prompting the Bot `bot`.
fn schedule(
    name: &str,
    bot: &str,
    cron: Option<&str>,
    at: Option<u64>,
    text: &str,
) -> AddScheduleRequest {
    AddScheduleRequest {
        name: name.to_owned(),
        cron: cron.map(str::to_owned),
        at,
        zone: Some("UTC".to_owned()),
        host: None,
        bot: Some(bot.to_owned()),
        agent_id: None,
        cwd: None,
        prompt: prompt(text),
        policy: None,
        mode: None,
        thread: None,
        missed: Missed::Latest,
        overlap: Overlap::Skip,
    }
}

/// The thread a delivery the Host took went into.
fn thread_of(delivery: &Delivery) -> ThreadId {
    match &delivery.work {
        Work::Queue(request) => request.thread_id.clone(),
        _ => ThreadId::new(
            delivery
                .answer
                .as_ref()
                .and_then(|answer| answer.get("threadId")?.as_str())
                .expect("a thread")
                .to_owned(),
        ),
    }
}

/// The turn a delivery the Host took started, or queued.
fn turn_of(delivery: &Delivery) -> String {
    let answer = delivery.answer.as_ref().expect("an answer");
    ["turnId", "queuedId"]
        .into_iter()
        .find_map(|name| answer.get(name)?.as_str())
        .expect("a turn")
        .to_owned()
}

async fn local(world: &World) -> (HostConnection, UnboundedReceiver<HostEvent>) {
    HostConnection::connect(
        world.daemon.connect_in_process(),
        info("weave"),
        ClientCapabilities::default(),
    )
    .await
    .expect("a local client")
}

/// Wait until the turn `turn` in `thread` on `world`'s Host is over.
async fn ended(world: &World, thread: &ThreadId, turn: &str) -> LatestTurn {
    let local = world.local().await;
    let over = tokio::time::timeout(WAIT, async {
        loop {
            let got = local
                .send(GetThreadRequest {
                    thread_id: thread.clone(),
                    turn_id: Some(turn.to_owned()),
                })
                .await
                .expect("threads/get");
            if let Some(latest) = got.latest_turn
                && latest.state.is_over()
            {
                return latest;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the turn over in time");
    local.shutdown().await;
    over
}

/// `thread` on `world`'s Host, as it lists.
async fn listing(world: &World, thread: &ThreadId) -> ThreadListing {
    threads(world)
        .await
        .into_iter()
        .find(|listing| listing.info.session_id == *thread)
        .expect("the thread")
}

fn text_of(prompt: &[ContentBlock]) -> String {
    prompt
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text(text) => Some(text.text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The turns `thread` on `world`'s Host has started, oldest first: each one's origin and
/// prompt, read from its journal as an observer.
async fn turns(world: &World, thread: &ThreadId) -> Vec<(TurnOrigin, String)> {
    let (observer, mut events) = local(world).await;
    let attach = |observe| AttachThreadRequest {
        thread_id: thread.clone(),
        after: None,
        agent_id: None,
        cwd: None,
        trace: false,
        observe,
    };
    // One that closed since is opened again to read it.
    let attached = match observer.send(attach(true)).await {
        Ok(attached) => attached,
        Err(error) if errors::is(&error, errors::THREAD_NOT_OPEN) => {
            observer.send(attach(false)).await.expect("thread/attach")
        }
        Err(error) => panic!("thread/attach: {error:?}"),
    };
    let head = attached.state.journal.head;
    let mut turns = Vec::new();
    tokio::time::timeout(WAIT, async {
        loop {
            let Some(HostEvent::Event(notification)) = events.recv().await else {
                continue;
            };
            if let ThreadEvent::TurnStarted {
                thread_id,
                prompt,
                origin,
                ..
            } = notification.event
                && thread_id == *thread
            {
                turns.push((origin, text_of(&prompt)));
            }
            if notification.seq >= head {
                return;
            }
        }
    })
    .await
    .expect("the journal in time");
    observer.shutdown().await;
    turns
}

/// Allow what the turn in `thread` on `world`'s Host waits for.
async fn allow(world: &World, thread: &ThreadId) {
    let local = world.local().await;
    let attached = local
        .send(AttachThreadRequest {
            thread_id: thread.clone(),
            after: None,
            agent_id: None,
            cwd: None,
            trace: false,
            observe: false,
        })
        .await
        .expect("thread/attach");
    let pending = attached.state.pending.first().expect("a pending request");
    local
        .send(AnswerPendingRequest {
            thread_id: thread.clone(),
            pending_id: pending.id.clone(),
            permission: Some(RequestPermissionResponse::new(
                RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                    PermissionOptionId::new("allow"),
                )),
            )),
            elicitation: None,
            client_tool: None,
        })
        .await
        .expect("pending/answer");
    local.shutdown().await;
}

fn service(label: &str, id: &str) -> TurnOrigin {
    TurnOrigin::Service {
        name: "Dispatcher".to_owned(),
        label: label.to_owned(),
        id: id.to_owned(),
    }
}

/// Add a Bot through `cli`, list, get, change and remove it, checking what's refused on the way.
async fn a_bot_goes_through_its_life(cli: &DispatcherConnection, studio: &World, host_id: &str) {
    assert!(cli.hello().offers(BOTS_FEATURE), "{:?}", cli.hello());
    let added = cli
        .send(AddBotRequest {
            name: " Odin ".to_owned(),
            new_thread_at: Some("9:30".to_owned()),
            ..odin()
        })
        .await
        .expect("bots/add")
        .bot;
    assert!(added.id.starts_with("b-"), "{}", added.id);
    assert_eq!(
        (
            added.name.as_str(),
            added.host_id.as_str(),
            added.host_name.as_str(),
            added.agent_id.as_str(),
            added.home.clone(),
        ),
        ("Odin", host_id, "studio", "fake", home_on(studio, "odin"))
    );
    // It approves nothing, so what isn't approved waits for the person.
    assert_eq!(
        added.policy,
        PermissionPolicy {
            approve: Vec::new(),
            otherwise: Unapproved::Ask,
        }
    );
    assert_eq!(added.new_thread_at.as_deref(), Some("09:30"));
    assert_eq!(
        (added.zone.as_str(), added.pause_after),
        ("UTC", DEFAULT_PAUSE_AFTER)
    );
    assert_eq!(
        (
            added.thread.clone(),
            added.threads.len(),
            added.state,
            added.starting_thread,
            added.paused.clone(),
            added.connected,
        ),
        (None, 0, BotState::Idle, false, None, true)
    );

    // What's refused.
    let refused =
        async |request: AddBotRequest| cli.send(request).await.expect_err("refused").message;
    assert_eq!(
        refused(add("ODIN", "~/other")).await,
        "there's a Bot called Odin already"
    );
    assert!(
        refused(AddBotRequest {
            host: "nowhere".to_owned(),
            ..add("loki", "~/loki")
        })
        .await
        .contains("no Host called nowhere")
    );
    assert!(
        refused(add("loki", "loki"))
            .await
            .contains("isn't a whole path")
    );
    assert!(
        refused(AddBotRequest {
            new_thread_at: Some("25:00".to_owned()),
            ..add("loki", "~/loki")
        })
        .await
        .contains("HH:MM")
    );
    assert!(
        refused(AddBotRequest {
            zone: Some("Mars/Olympus".to_owned()),
            ..add("loki", "~/loki")
        })
        .await
        .contains("the time zone")
    );
    assert!(
        refused(add("two\nlines", "~/loki"))
            .await
            .contains("one line")
    );

    let got = cli
        .send(GetBotRequest {
            bot: "odin".to_owned(),
        })
        .await
        .expect("bots/get")
        .bot;
    assert_eq!(got, added);
    let listed = cli.send(ListBotsRequest {}).await.expect("bots/list").bots;
    assert_eq!(listed, vec![added.clone()]);

    // Changing it.
    let thor = cli.send(add("thor", "~/thor")).await.expect("bots/add").bot;
    let clash = cli
        .send(UpdateBotRequest {
            bot: thor.id.clone(),
            name: Some("odin".to_owned()),
            ..UpdateBotRequest::default()
        })
        .await
        .expect_err("a name taken");
    assert_eq!(clash.message, "there's a Bot called Odin already");
    let policy = PermissionPolicy {
        approve: vec![ToolKind::Read],
        otherwise: Unapproved::Ask,
    };
    let changed = cli
        .send(UpdateBotRequest {
            bot: "ODIN".to_owned(),
            name: Some("odin-bot".to_owned()),
            policy: Some(policy.clone()),
            mode: Some(Some("plan".to_owned())),
            new_thread_at: Some(None),
            zone: None,
            pause_after: Some(60_000),
            emoji: None,
            color: None,
        })
        .await
        .expect("bots/update")
        .bot;
    assert_eq!(
        (
            changed.id.as_str(),
            changed.name.as_str(),
            &changed.policy,
            changed.mode.as_deref(),
            changed.new_thread_at.as_deref(),
            changed.pause_after,
        ),
        (
            added.id.as_str(),
            "odin-bot",
            &policy,
            Some("plan"),
            None,
            60_000
        )
    );
    assert!(changed.updated_at >= added.updated_at);
    let cleared = cli
        .send(UpdateBotRequest {
            bot: "odin-bot".to_owned(),
            mode: Some(None),
            ..UpdateBotRequest::default()
        })
        .await
        .expect("bots/update")
        .bot;
    assert_eq!((cleared.mode, cleared.policy), (None, policy));

    // A Bot with no thread has none to hand over from, and a prompt needs something in it.
    let early = cli
        .send(NewBotThreadRequest {
            bot: "odin-bot".to_owned(),
        })
        .await
        .expect_err("no thread yet");
    assert!(early.message.contains("has no thread yet"), "{early}");
    let empty = cli
        .send(SendToBotRequest {
            bot: "odin-bot".to_owned(),
            prompt: Vec::new(),
            key: None,
        })
        .await
        .expect_err("an empty prompt");
    assert!(empty.message.contains("needs something"), "{empty}");

    // Removing it.
    cli.send(RemoveBotRequest {
        bot: "odin-bot".to_owned(),
    })
    .await
    .expect("bots/remove");
    let left: Vec<String> = cli
        .send(ListBotsRequest {})
        .await
        .expect("bots/list")
        .bots
        .into_iter()
        .map(|bot| bot.name)
        .collect();
    assert_eq!(left, ["thor"]);
    let gone = cli
        .send(GetBotRequest {
            bot: "odin-bot".to_owned(),
        })
        .await
        .expect_err("gone");
    assert_eq!(gone.message, "there's no Bot odin-bot");
    cli.send(RemoveBotRequest { bot: thor.id })
        .await
        .expect("bots/remove");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bots_life_through_the_socket() {
    let setup = Setup::new("2026-11-04T08:00:00Z").await;
    let cli = ask(setup.dir.path()).await;
    a_bot_goes_through_its_life(&cli, &setup.studio, &setup.host_id).await;
    cli.shutdown().await;
    setup.dispatcher.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bots_life_through_a_paired_device() {
    let studio = World::new().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let config = weave_dispatcher::DispatcherConfig {
        remote: Some(RemoteSettings::new(
            "127.0.0.1:0".parse().expect("an address"),
            Arc::new(FakeServe),
        )),
        ..dispatcher_config(dir.path())
    };
    let listening = socket::listen(&config.paths).expect("its socket");
    let dispatcher = Dispatcher::open(config).expect("opened");
    let serving = dispatcher.clone();
    tokio::spawn(async move { serving.serve(listening.listener).await });
    studio.join(&dispatcher, dir.path(), "studio").await;
    let host_id = studio.host_id().await;
    host_until(&dispatcher, &host_id, |host| host.connected).await;

    let cli = ask(dir.path()).await;
    let offer = cli
        .send(OfferDeviceRequest {
            name: Some("iPad".to_owned()),
        })
        .await
        .expect("devices/offer");
    cli.shutdown().await;
    let url = offer.url.expect("a URL");
    let key = DeviceKey::generate();
    let connect = async |credentials| {
        let (transport, _closed) = connect_websocket_as(&url, DISPATCHER_SUBPROTOCOL)
            .await
            .expect("the WebSocket");
        DispatcherConnection::connect_with(transport, info("weave-cli"), credentials)
            .await
            .expect("hello")
    };
    let paired = connect(Credentials::Pair {
        code: offer.code,
        name: "iPad".to_owned(),
        key: key.clone(),
        service: false,
    })
    .await;
    let device = paired.hello().device.clone().expect("its device");
    paired.shutdown().await;
    let device = connect(Credentials::Device {
        device_id: device.id,
        key,
        host_id: None,
    })
    .await;
    assert!(device.hello().device.is_some(), "a paired device");
    a_bot_goes_through_its_life(&device, &studio, &host_id).await;
    device.shutdown().await;
    dispatcher.stop().await;
}

/// A Host's own connection to the Dispatcher says who it is first, and asks nothing of the
/// Dispatcher's API: it doesn't reach `bots/*`.
#[tokio::test(flavor = "multi_thread")]
async fn a_hosts_own_connection_doesnt_reach_bots() {
    let setup = Setup::new("2026-11-04T08:00:00Z").await;
    setup.odin().await;
    let address =
        DispatcherAddress::Socket(dispatcher_config(setup.dir.path()).paths.hosts_socket());
    let Opened::Unix(mut socket) = open_dispatcher(&address, DISPATCHER_HOST_SUBPROTOCOL)
        .await
        .expect("the Hosts' socket")
    else {
        panic!("a Unix socket");
    };
    let refused = preamble::ask(socket.as_mut(), 1, &ListBotsRequest {})
        .await
        .expect_err("refused");
    assert!(
        errors::is(&refused, errors::UNAUTHENTICATED)
            && refused.message.contains("dispatcher/challenge"),
        "{refused:?}"
    );
    let Opened::Unix(mut socket) = open_dispatcher(&address, DISPATCHER_HOST_SUBPROTOCOL)
        .await
        .expect("the Hosts' socket")
    else {
        panic!("a Unix socket");
    };
    preamble::ask(socket.as_mut(), 1, &DispatcherChallengeRequest {})
        .await
        .expect("its challenge");
    let refused = preamble::ask(
        socket.as_mut(),
        2,
        &SendToBotRequest {
            bot: "odin".to_owned(),
            prompt: prompt("hello"),
            key: None,
        },
    )
    .await
    .expect_err("refused");
    assert!(
        errors::is(&refused, errors::UNAUTHENTICATED) && refused.message.contains("hosts/connect"),
        "{refused:?}"
    );
    assert_eq!(setup.dispatcher.bot("odin").expect("odin").thread, None);
    setup.dispatcher.stop().await;
}

/// Removing a Host removes its Bots and their schedules, as it removes its schedules.
#[tokio::test(flavor = "multi_thread")]
async fn removing_a_host_removes_its_bots_and_their_schedules() {
    let setup = Setup::new("2026-11-04T08:00:00Z").await;
    setup.odin().await;
    setup
        .dispatcher
        .add_schedule(schedule("tick", "odin", Some("0 9 * * *"), None, "tick"))
        .expect("schedules/add");
    let cli = ask(setup.dir.path()).await;
    cli.send(RemoveHostRequest {
        host: "studio".to_owned(),
    })
    .await
    .expect("hosts/remove");
    assert_eq!(
        cli.send(ListBotsRequest {}).await.expect("bots/list").bots,
        Vec::new()
    );
    assert_eq!(
        cli.send(ListSchedulesRequest::default())
            .await
            .expect("schedules/list")
            .schedules,
        Vec::new()
    );
    cli.shutdown().await;
    setup.dispatcher.stop().await;
}

/// The first prompt starts the Bot's thread in its home, with its labels and policy; two sent
/// before it's answered start one thread; and later ones, and its schedule's occurrences, go
/// into that thread, in order.
#[tokio::test(flavor = "multi_thread")]
async fn the_first_prompt_starts_the_bots_thread_and_the_rest_follow_it() {
    let setup = Setup::new("2026-11-04T08:00:00Z").await;
    let policy = PermissionPolicy {
        approve: vec![ToolKind::Read],
        otherwise: Unapproved::Ask,
    };
    let odin = setup
        .dispatcher
        .add_bot(AddBotRequest {
            policy: Some(policy.clone()),
            ..odin()
        })
        .await
        .expect("bots/add")
        .bot;

    // Two prompts while its Host is away, and the first again under its key.
    setup.studio.relay.cut();
    host_until(&setup.dispatcher, &setup.host_id, |host| !host.connected).await;
    let send = |text: &str, key: Option<&str>| {
        setup.dispatcher.send_to_bot(SendToBotRequest {
            bot: "odin".to_owned(),
            prompt: prompt(text),
            key: key.map(str::to_owned),
        })
    };
    let first = send("first", Some("mine")).expect("bots/send");
    assert_eq!(
        send("first", Some("mine")).expect("bots/send").delivery_id,
        first.delivery_id,
        "the same key names the same delivery"
    );
    let second = send("second", None).expect("bots/send");
    assert_eq!(
        (first.bot.thread.clone(), first.bot.connected),
        (None, false)
    );
    setup.studio.relay.resume();

    let first = setup.taken(&first.delivery_id).await;
    let second = setup.taken(&second.delivery_id).await;
    let thread = thread_of(&first);
    assert_eq!(thread_of(&second), thread, "one thread");
    let Work::Run(started) = &first.work else {
        panic!("thread/run: {:?}", first.work);
    };
    assert_eq!(
        (started.thread_id.clone(), started.key.clone()),
        (None, Some(format!("bot/{}/send/mine", odin.id)))
    );
    assert!(matches!(second.work, Work::Queue(_)), "{:?}", second.work);
    let ran: weave_host_protocol::threads::RunResponse =
        serde_json::from_value(first.answer.clone().expect("an answer")).expect("a run's answer");
    assert_eq!(ran.policy, Some(policy));
    let listed = listing(&setup.studio, &thread).await;
    assert_eq!(
        listed.labels,
        ["dispatcher".to_owned(), format!("bot:{}", odin.id)]
    );
    assert_eq!(listed.info.cwd, setup.home("odin"));

    // A schedule naming it prompts the same thread.
    setup
        .dispatcher
        .add_schedule(schedule("tick", "odin", Some("0 9 * * *"), None, "tick"))
        .expect("schedules/add");
    ended(&setup.studio, &thread, &turn_of(&second)).await;
    setup.clock.set("2026-11-04T09:00:00Z");
    let occurrence = setup
        .occurrences_until("tick", |all| {
            all.first()
                .is_some_and(|first| first.state == OccurrenceState::Finished)
        })
        .await
        .remove(0);
    assert_eq!(occurrence.thread_id.as_ref(), Some(&thread));
    let third = setup.turn("third").await;
    assert_eq!(third, thread);

    let all = turns(&setup.studio, &thread).await;
    assert_eq!(
        all.iter()
            .map(|(_, text)| text.as_str())
            .collect::<Vec<_>>(),
        ["first", "second", "tick", "third"]
    );
    assert_eq!(
        all[..3]
            .iter()
            .map(|(origin, _)| origin.clone())
            .collect::<Vec<_>>(),
        vec![
            service("bot odin", &first.id),
            service("bot odin", &second.id),
            service("schedule tick", &occurrence.id),
        ]
    );
    assert_eq!(threads(&setup.studio).await.len(), 1);
    let odin = setup.odin_until(|bot| bot.state == BotState::Idle).await;
    assert_eq!(odin.thread.as_ref(), Some(&thread));
    assert_eq!(
        odin.threads
            .iter()
            .map(|listed| (listed.thread_id.clone(), listed.ended_at))
            .collect::<Vec<_>>(),
        vec![(thread.clone(), None)]
    );
    let listed = setup.dispatcher.schedules().expect("schedules").remove(0);
    assert_eq!(
        (
            listed.bot_id.as_deref(),
            listed.bot_name.as_deref(),
            listed.host_name.as_str(),
            listed.run.cwd.clone(),
            listed.run.thread.as_ref(),
        ),
        (
            Some(odin.id.as_str()),
            Some("odin"),
            "studio",
            setup.home("odin"),
            Some(&thread)
        )
    );
    setup.dispatcher.stop().await;
}

/// A Bot is working while its thread runs a turn, needs the person while a request there waits
/// for them, and is idle otherwise.
#[tokio::test(flavor = "multi_thread")]
async fn a_bots_state_follows_its_thread() {
    let setup = Setup::new("2026-11-04T08:00:00Z").await;
    setup.odin().await;
    setup.send("slow 10").await;
    setup.odin_until(|bot| bot.state == BotState::Working).await;
    setup.odin_until(|bot| bot.state == BotState::Idle).await;

    let target = setup.studio.home().join("odin").join("out.txt");
    setup
        .send(&format!("write {} hello", target.display()))
        .await;
    let waiting = setup
        .odin_until(|bot| bot.state == BotState::NeedsYou && bot.waiting_since.is_some())
        .await;
    assert_eq!(waiting.waiting_since, Some(ms("2026-11-04T08:00:00Z")));
    allow(&setup.studio, waiting.thread.as_ref().expect("its thread")).await;
    let done = setup
        .odin_until(|bot| bot.state == BotState::Idle && bot.waiting_since.is_none())
        .await;
    assert_eq!(done.paused, None);
    assert_eq!(
        std::fs::read_to_string(&target)
            .expect("written")
            .trim_end(),
        "hello"
    );
    setup.dispatcher.stop().await;
}

/// A new thread, asked for while the Bot's thread waits on the person: prompts and an
/// occurrence that come meanwhile wait, across a Dispatcher restart; once the thread is idle
/// it saves itself, the new thread starts in the home and takes over, the old one naming it as
/// its successor, and what waited goes into it.
#[tokio::test(flavor = "multi_thread")]
async fn a_new_thread_saves_the_old_one_and_takes_over() {
    let mut setup = Setup::new("2026-11-04T08:00:00Z").await;
    let odin = setup.odin().await;
    setup
        .dispatcher
        .add_schedule(schedule("tick", "odin", Some("0 9 * * *"), None, "tick"))
        .expect("schedules/add");
    let old = setup.turn("hello").await;
    let target = setup.studio.home().join("odin").join("out.txt");
    setup
        .send(&format!("write {} hello", target.display()))
        .await;
    setup
        .odin_until(|bot| bot.state == BotState::NeedsYou)
        .await;

    let starting = setup
        .dispatcher
        .new_bot_thread("odin")
        .expect("bots/newThread");
    assert!(starting.starting_thread);
    let again = setup
        .dispatcher
        .new_bot_thread("odin")
        .expect_err("one at a time");
    assert!(
        again.message.contains("starting a new thread already"),
        "{again}"
    );
    let during = setup.send("during").await;
    setup.clock.set("2026-11-04T09:00:00Z");
    let occurrence = setup
        .occurrences_until("tick", |all| {
            all.first()
                .is_some_and(|first| first.state == OccurrenceState::Waiting)
        })
        .await
        .remove(0);

    // The Dispatcher restarts while the thread still waits, and the prompts with it.
    setup.restart().await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let held = setup
        .dispatcher
        .delivery(&during.delivery_id)
        .expect("read")
        .expect("there");
    assert_eq!(held.state, DeliveryState::Pending);
    let odin_now = setup.dispatcher.bot("odin").expect("odin");
    assert_eq!(
        (odin_now.thread.as_ref(), odin_now.starting_thread),
        (Some(&old), true)
    );

    allow(&setup.studio, &old).await;
    let taken_over = setup
        .odin_until(|bot| bot.thread.as_ref() != Some(&old) && !bot.starting_thread)
        .await;
    let new = taken_over.thread.clone().expect("its new thread");
    let during = setup.taken(&during.delivery_id).await;
    assert_eq!(thread_of(&during), new);
    let occurrence = setup
        .occurrences_until("tick", |all| {
            all.first().is_some_and(|first| {
                first.id == occurrence.id && first.state == OccurrenceState::Finished
            })
        })
        .await
        .remove(0);
    assert_eq!(occurrence.thread_id.as_ref(), Some(&new));

    // The old thread saved itself, once, and names the new one as its successor.
    let note = format!("threads/2026-11-04-{}.md", &old.0[..8]);
    let saved: Vec<String> = turns(&setup.studio, &old)
        .await
        .into_iter()
        .map(|(_, text)| text)
        .collect();
    assert_eq!(saved.len(), 3, "{saved:#?}");
    assert_eq!(
        saved[2],
        format!(
            "This turn is the Bot odin's, before it starts a new thread. Save what's worth keeping \
         from this thread to your memory files in {}, write a note about this thread at \
         {note} there, and commit.",
            setup.home("odin").display()
        )
    );
    assert_eq!(
        listing(&setup.studio, &old).await.continued_in.as_ref(),
        Some(&new)
    );

    // The new one started in the home, with the Bot's labels, opening on where the note is, and
    // what waited went into it after.
    let listed = listing(&setup.studio, &new).await;
    assert_eq!(
        listed.labels,
        ["dispatcher".to_owned(), format!("bot:{}", odin.id)]
    );
    assert_eq!(listed.info.cwd, setup.home("odin"));
    let opened: Vec<String> = turns(&setup.studio, &new)
        .await
        .into_iter()
        .map(|(_, text)| text)
        .collect();
    assert_eq!(
        opened,
        vec![
            format!(
                "This is the Bot odin's new thread, which takes over from the thread {old}. \
                 That thread's note is at {note} in {}. Read your memory files there before \
                 you go on.",
                setup.home("odin").display()
            ),
            "during".to_owned(),
            "tick".to_owned(),
        ]
    );
    assert_eq!(
        taken_over
            .threads
            .iter()
            .map(|thread| (thread.thread_id.clone(), thread.ended_at.is_some()))
            .collect::<Vec<_>>(),
        vec![(old, true), (new, false)]
    );
    assert_eq!(threads(&setup.studio).await.len(), 2);
    setup.dispatcher.stop().await;
}

/// The id of the delivery for odin under `key`.
fn delivery_under(database: &rusqlite::Connection, key: &str) -> String {
    database
        .query_row(
            "SELECT id FROM deliveries WHERE coalesce(json_extract(work, '$.run.key'), \
             json_extract(work, '$.queue.key')) = ?1",
            [key],
            |row| row.get(0),
        )
        .expect("the delivery")
}

/// A new thread goes on across a Dispatcher restart at each step, the Host taking each step's
/// delivery but its answer lost, and across a Host restart, starting nothing twice.
#[tokio::test(flavor = "multi_thread")]
async fn a_new_thread_survives_restarts_repeating_nothing() {
    let mut setup = Setup::with(World::with_journals().await, "2026-11-04T08:00:00Z").await;
    let odin = setup.odin().await;
    let first = setup.turn("hello").await;
    setup.odin_until(|bot| bot.state == BotState::Idle).await;

    // The Host takes the save prompt, but its answer is lost, and the Dispatcher restarts.
    setup.studio.relay.deafen();
    setup
        .dispatcher
        .new_bot_thread("odin")
        .expect("bots/newThread");
    let local = setup.studio.local().await;
    tokio::time::timeout(WAIT, async {
        loop {
            let got = local
                .send(GetThreadRequest {
                    thread_id: first.clone(),
                    turn_id: None,
                })
                .await
                .expect("threads/get");
            if got.latest_turn.is_some_and(|turn| {
                turn.state.is_over()
                    && text_of(&turn.prompt).contains("before it starts a new thread")
            }) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the save turn in time");
    local.shutdown().await;
    setup.studio.relay.cut();
    setup.stop().await;
    let unanswered: String = setup
        .database()
        .query_row(
            "SELECT state FROM deliveries WHERE json_extract(work, '$.queue.key') = ?1",
            [format!("bot/{}/new-thread/1/save", odin.id)],
            |row| row.get(0),
        )
        .expect("the save prompt");
    assert_eq!(unanswered, "pending", "its answer was lost");
    setup.studio.relay.resume();
    setup.start().await;
    let second = setup
        .odin_until(|bot| bot.thread.as_ref() != Some(&first) && !bot.starting_thread)
        .await
        .thread
        .expect("its new thread");
    let saves = |turns: Vec<(TurnOrigin, String)>| {
        turns
            .into_iter()
            .filter(|(_, text)| text.contains("before it starts a new thread"))
            .count()
    };
    assert_eq!(saves(turns(&setup.studio, &first).await), 1);
    assert_eq!(threads(&setup.studio).await.len(), 2);

    // As though the Dispatcher stopped between the Host taking the new thread and writing that
    // down, and then between that and the old thread naming it: each time it goes on to the
    // same end, starting no other thread.
    let save = delivery_under(
        &setup.database(),
        &format!("bot/{}/new-thread/1/save", odin.id),
    );
    let start = delivery_under(
        &setup.database(),
        &format!("bot/{}/new-thread/1/start", odin.id),
    );
    for step in ["starting", "naming"] {
        setup.stop().await;
        let database = setup.database();
        database
            .execute(
                "INSERT INTO bot_new_threads (bot_id, number, step, from_thread, save_delivery, \
                 start_delivery, thread_id, began_at) VALUES (?1, 1, ?2, ?3, ?4, ?5, \
                 CASE WHEN ?2 = 'naming' THEN ?6 END, 0)",
                rusqlite::params![
                    odin.id,
                    step,
                    first.0.as_ref(),
                    save,
                    start,
                    second.0.as_ref()
                ],
            )
            .expect("the step back");
        if step == "starting" {
            database
                .execute(
                    "UPDATE deliveries SET state = 'pending', answer = NULL WHERE id = ?1",
                    [&start],
                )
                .expect("as though never answered");
        }
        database
            .execute(
                "UPDATE bots SET thread_id = ?2 WHERE id = ?1",
                rusqlite::params![odin.id, first.0.as_ref()],
            )
            .expect("the old thread current");
        database
            .execute(
                "DELETE FROM bot_threads WHERE thread_id = ?1",
                [second.0.as_ref()],
            )
            .expect("the new thread not yet");
        database
            .execute("UPDATE bot_threads SET ended_at = NULL", [])
            .expect("the old thread not ended");
        drop(database);
        setup.start().await;
        let done = setup
            .odin_until(|bot| bot.thread.as_ref() == Some(&second) && !bot.starting_thread)
            .await;
        assert_eq!(
            done.threads
                .iter()
                .map(|thread| (thread.thread_id.clone(), thread.ended_at.is_some()))
                .collect::<Vec<_>>(),
            vec![(first.clone(), true), (second.clone(), false)],
            "after {step}"
        );
        assert_eq!(threads(&setup.studio).await.len(), 2, "after {step}");
        assert_eq!(
            listing(&setup.studio, &first).await.continued_in.as_ref(),
            Some(&second)
        );
    }
    assert_eq!(saves(turns(&setup.studio, &first).await), 1);

    // The Host restarts while the thread waits on the person and a new thread is asked for:
    // its turn cut off, the thread is taken up again to save itself, and the new one takes
    // over.
    let target = setup.studio.home().join("odin").join("out.txt");
    setup
        .send(&format!("write {} hello", target.display()))
        .await;
    setup
        .odin_until(|bot| bot.state == BotState::NeedsYou)
        .await;
    setup
        .dispatcher
        .new_bot_thread("odin")
        .expect("bots/newThread");
    setup.studio.restart().await;
    let third = setup
        .odin_until(|bot| bot.thread.as_ref() != Some(&second) && !bot.starting_thread)
        .await;
    assert_eq!(third.threads.len(), 3);
    let third = third.thread.expect("its newest thread");
    assert_eq!(saves(turns(&setup.studio, &second).await), 1);
    assert_eq!(
        listing(&setup.studio, &second).await.continued_in.as_ref(),
        Some(&third)
    );
    assert_eq!(threads(&setup.studio).await.len(), 3);
    assert_eq!(
        setup.dispatcher.bot("odin").expect("odin").waiting_since,
        None
    );
    setup.dispatcher.stop().await;
}

/// A Bot's daily new thread comes at its time by the Dispatcher's clock, once its thread has had
/// a turn since it started, and a missed day starts one, once.
#[tokio::test(flavor = "multi_thread")]
async fn a_daily_new_thread_comes_at_its_time() {
    let mut setup = Setup::new("2026-11-04T08:00:00Z").await;
    setup
        .dispatcher
        .add_bot(AddBotRequest {
            new_thread_at: Some("09:00".to_owned()),
            ..odin()
        })
        .await
        .expect("bots/add");
    let first = setup.turn("hello").await;

    // Its thread has had no turn since the one it started with: no new thread.
    setup.clock.set("2026-11-04T09:00:00Z");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let odin = setup.dispatcher.bot("odin").expect("odin");
    assert_eq!(
        (odin.thread.as_ref(), odin.starting_thread),
        (Some(&first), false)
    );

    assert_eq!(setup.turn("again").await, first);
    setup.clock.set("2026-11-05T09:00:00Z");
    let second = setup
        .odin_until(|bot| bot.thread.as_ref() != Some(&first) && !bot.starting_thread)
        .await
        .thread
        .expect("its new thread");
    assert_eq!(setup.turn("more").await, second);

    // Three days pass while the Dispatcher is stopped: one new thread when it starts again.
    setup.stop().await;
    setup.clock.set("2026-11-08T10:00:00Z");
    setup.start().await;
    let third = setup
        .odin_until(|bot| bot.thread.as_ref() != Some(&second) && !bot.starting_thread)
        .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        setup.dispatcher.bot("odin").expect("odin").thread,
        third.thread
    );
    assert_eq!(third.threads.len(), 3);
    assert_eq!(threads(&setup.studio).await.len(), 3);
    setup.dispatcher.stop().await;
}

/// A Bot whose thread waits on the person longer than it allows is paused, its schedules'
/// occurrences skipped meanwhile though `bots/send` still delivers, and resumes once the
/// thread no longer waits.
#[tokio::test(flavor = "multi_thread")]
async fn a_bot_pauses_while_its_thread_waits_on_the_person() {
    let setup = Setup::new("2026-11-04T08:30:00Z").await;
    setup
        .dispatcher
        .add_bot(AddBotRequest {
            pause_after: Some(60 * 60 * 1000),
            ..odin()
        })
        .await
        .expect("bots/add");
    setup
        .dispatcher
        .add_schedule(schedule("tick", "odin", Some("0 10 * * *"), None, "tick"))
        .expect("schedules/add");
    let target = setup.studio.home().join("odin").join("out.txt");
    setup
        .send(&format!("write {} hello", target.display()))
        .await;
    let waiting = setup.odin_until(|bot| bot.waiting_since.is_some()).await;
    assert_eq!(waiting.waiting_since, Some(ms("2026-11-04T08:30:00Z")));
    let thread = waiting.thread.expect("its thread");

    setup.clock.set("2026-11-04T09:31:00Z");
    let why = "its thread has waited on the person since Wed 4 Nov 08:30 UTC";
    let paused = setup.odin_until(|bot| bot.paused.is_some()).await;
    assert_eq!(paused.paused.as_deref(), Some(why));
    setup.clock.set("2026-11-04T10:00:00Z");
    let skipped = setup
        .occurrences_until("tick", |all| !all.is_empty())
        .await
        .remove(0);
    assert_eq!(skipped.state, OccurrenceState::Skipped);
    assert_eq!(skipped.why, Some(format!("the Bot odin is paused: {why}")));
    let still = setup.send("still").await;
    let still = setup.taken(&still.delivery_id).await;
    assert_eq!(thread_of(&still), thread);

    // Answered, the thread goes on, and so does the Bot.
    allow(&setup.studio, &thread).await;
    ended(&setup.studio, &thread, &turn_of(&still)).await;
    let resumed = setup
        .odin_until(|bot| bot.paused.is_none() && bot.waiting_since.is_none())
        .await;
    assert_eq!(resumed.state, BotState::Idle);
    setup.clock.set("2026-11-05T10:00:00Z");
    let ran = setup
        .occurrences_until("tick", |all| {
            all.len() == 2 && all[0].state == OccurrenceState::Finished
        })
        .await
        .remove(0);
    assert_eq!(ran.thread_id.as_ref(), Some(&thread));
    setup.dispatcher.stop().await;
}

/// A one-off schedule naming a Bot prompts it once, its time caught up after a Dispatcher
/// restart, and not again after another; one that comes while it runs, once too.
#[tokio::test(flavor = "multi_thread")]
async fn a_one_off_prompts_a_bot_once_across_restarts() {
    let mut setup = Setup::new("2026-11-04T08:00:00Z").await;
    let odin = setup.odin().await;
    let refused = |request: AddScheduleRequest| {
        setup
            .dispatcher
            .add_schedule(request)
            .expect_err("refused")
            .message
    };
    let at = Some(ms("2026-11-04T09:00:00Z"));
    assert!(refused(schedule("x", "odin", Some("0 9 * * *"), at, "x")).contains("not both"));
    assert!(refused(schedule("x", "odin", None, None, "x")).contains("needs a cron expression"));
    assert!(
        refused(schedule(
            "x",
            "odin",
            None,
            Some(ms("2026-11-04T07:00:00Z")),
            "x"
        ))
        .contains("has passed")
    );
    assert!(
        refused(AddScheduleRequest {
            host: Some("studio".to_owned()),
            ..schedule("x", "odin", None, at, "x")
        })
        .contains("in place of host")
    );
    assert!(
        refused(AddScheduleRequest {
            overlap: Overlap::Allow,
            ..schedule("x", "odin", None, at, "x")
        })
        .contains("can't overlap")
    );
    assert!(refused(schedule("x", "loki", None, at, "x")).contains("there's no Bot loki"));

    let added = setup
        .dispatcher
        .add_schedule(schedule("wake", "odin", None, at, "wake up"))
        .expect("schedules/add");
    assert_eq!(
        (
            added.cron.as_str(),
            added.at,
            added.next_at,
            added.bot_name.as_deref(),
            added.run.thread.as_ref(),
        ),
        ("", at, at, Some("odin"), None)
    );

    // The Dispatcher is stopped at its time: it catches up once when it starts again.
    setup.stop().await;
    setup.clock.set("2026-11-04T09:30:00Z");
    setup.start().await;
    let caught_up = setup
        .occurrences_until("wake", |all| {
            all.first()
                .is_some_and(|first| first.state == OccurrenceState::Finished)
        })
        .await
        .remove(0);
    assert!(caught_up.late);
    let thread = caught_up.thread_id.clone().expect("its thread");
    let listed = listing(&setup.studio, &thread).await;
    assert_eq!(
        listed.labels,
        ["dispatcher".to_owned(), format!("bot:{}", odin.id)]
    );
    let woke = turns(&setup.studio, &thread).await;
    assert_eq!(woke.len(), 1);
    assert_eq!(woke[0].0, service("schedule wake", &caught_up.id));
    assert!(woke[0].1.ends_with("wake up"), "{}", woke[0].1);
    assert_eq!(
        setup.dispatcher.bot("odin").expect("odin").thread.as_ref(),
        Some(&thread)
    );
    let done = setup.dispatcher.schedules().expect("schedules").remove(0);
    assert_eq!(
        (done.next_at, done.run.thread.as_ref()),
        (None, Some(&thread))
    );

    // Another restart prompts it no more.
    setup.restart().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        setup
            .dispatcher
            .occurrences(Some("wake"), None)
            .expect("occurrences")
            .len(),
        1
    );

    // One that comes while the Dispatcher runs: once, into the Bot's thread, and once only
    // after a restart.
    setup
        .dispatcher
        .add_schedule(schedule(
            "nudge",
            "odin",
            None,
            Some(ms("2026-11-04T10:00:00Z")),
            "nudge",
        ))
        .expect("schedules/add");
    setup.clock.set("2026-11-04T10:00:00Z");
    let nudged = setup
        .occurrences_until("nudge", |all| {
            all.first()
                .is_some_and(|first| first.state == OccurrenceState::Finished)
        })
        .await
        .remove(0);
    assert!(!nudged.late);
    assert_eq!(nudged.thread_id.as_ref(), Some(&thread));
    setup.restart().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    for name in ["wake", "nudge"] {
        assert_eq!(
            setup
                .dispatcher
                .occurrences(Some(name), None)
                .expect("occurrences")
                .len(),
            1,
            "{name}"
        );
    }
    assert_eq!(turns(&setup.studio, &thread).await.len(), 2);
    assert_eq!(threads(&setup.studio).await.len(), 1);
    setup.dispatcher.stop().await;
}

/// The Dispatcher's tool `tool` as agents see it: the name the Host knows the Dispatcher by,
/// before it.
fn dispatcher_tool(tool: &str) -> String {
    format!("dispatcher__{tool}")
}

/// What the agent said last in the turn `turn` in `thread` on `world`'s Host, once it's over.
async fn said(world: &World, thread: &ThreadId, turn: &str) -> String {
    ended(world, thread, turn).await.message.unwrap_or_default()
}

/// What the Dispatcher's `tool` answered, as the fake agent says it: its JSON, or why it failed.
fn answered(said: &str, tool: &str) -> Result<serde_json::Value, String> {
    let tool = dispatcher_tool(tool);
    if let Some((_, answer)) = said.split_once(&format!("{tool} answered: ")) {
        return Ok(serde_json::from_str(answer)
            .unwrap_or_else(|error| panic!("JSON from {tool}: {error}: {said:?}")));
    }
    match said.split_once(&format!("{tool} failed: ")) {
        Some((_, why)) => Err(why.to_owned()),
        None => panic!("{tool} answered nothing: {said:?}"),
    }
}

/// The wake-up turns `thread` on `world`'s Host has had, oldest first: each one's origin and
/// prompt.
async fn wake_up_turns(world: &World, thread: &ThreadId) -> Vec<(TurnOrigin, String)> {
    turns(world, thread)
        .await
        .into_iter()
        .filter(|(origin, _)| {
            matches!(origin, TurnOrigin::Service { label, .. } if label.starts_with("wake-up"))
        })
        .collect()
}

/// A Bot's thread asks to be woken with `wake_me`: the wake-up is listed as the Bot's own among
/// the schedules, and prompts the Bot's thread once at its time, labelled as its wake-up, late
/// and once only across Dispatcher restarts around its time; then it's no longer to come, and
/// is forgotten a week after.
#[tokio::test(flavor = "multi_thread")]
async fn a_bots_thread_is_woken_once_at_the_time_it_asked_for() {
    let mut setup = Setup::new("2026-11-04T08:00:00Z").await;
    let odin = setup.odin().await;
    let thread = setup.turn("hello").await;

    let woken = setup
        .calls(
            "odin",
            "wake_me",
            json!({"prompt": "See whether the deploy finished.", "in": 3600}),
        )
        .await
        .expect("wake_me");
    let id = woken["id"].as_str().expect("its id").to_owned();
    assert!(id.starts_with("sch-"), "{id}");
    assert_eq!(
        woken,
        json!({
            "id": id,
            "at": "2026-11-04T09:00:00+00:00",
            "when": "Wed 4 Nov 09:00 UTC",
            "prompt": "See whether the deploy finished.",
        })
    );
    let coming = setup
        .calls("odin", "list_wakeups", json!({}))
        .await
        .expect("list_wakeups");
    assert_eq!(coming, json!({"wakeups": [woken]}));

    // It's among the schedules, as the Bot's own.
    let cli = ask(setup.dir.path()).await;
    let listed = cli
        .send(ListSchedulesRequest::default())
        .await
        .expect("schedules/list")
        .schedules;
    cli.shutdown().await;
    assert_eq!(listed.len(), 1);
    let listed = &listed[0];
    assert_eq!(
        (
            listed.id.as_str(),
            listed.wake_up,
            listed.bot_id.as_deref(),
            listed.bot_name.as_deref(),
            listed.cron.as_str(),
            listed.at,
            listed.next.as_deref(),
            listed.run.thread.as_ref(),
        ),
        (
            id.as_str(),
            true,
            Some(odin.id.as_str()),
            Some("odin"),
            "",
            Some(ms("2026-11-04T09:00:00Z")),
            Some("Wed 4 Nov 09:00 UTC"),
            Some(&thread),
        )
    );
    assert!(listed.name.starts_with("wake-up-"), "{}", listed.name);

    // The Dispatcher is stopped over its time: it's woken once, late, when it starts again.
    setup.stop().await;
    setup.clock.set("2026-11-04T09:30:00Z");
    setup.start().await;
    let woke = setup
        .occurrences_until(&id, |all| {
            all.first()
                .is_some_and(|first| first.state == OccurrenceState::Finished)
        })
        .await
        .remove(0);
    assert!(woke.late);
    assert_eq!(woke.thread_id.as_ref(), Some(&thread));
    assert_eq!(
        wake_up_turns(&setup.studio, &thread).await,
        vec![(
            service("wake-up odin", &woke.id),
            "This turn is the wake-up you asked for, due at Wed 4 Nov 09:00 UTC and started \
             late, at Wed 4 Nov 09:30 UTC, because the Dispatcher couldn't start it on time.\n\
             See whether the deploy finished."
                .to_owned()
        )]
    );
    assert_eq!(
        setup
            .calls("odin", "list_wakeups", json!({}))
            .await
            .expect("list_wakeups"),
        json!({"wakeups": []}),
        "it's no longer to come"
    );

    // Another restart wakes it no more.
    setup.restart().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        setup
            .dispatcher
            .occurrences(Some(&id), None)
            .expect("occurrences")
            .len(),
        1
    );

    // One that comes while the Dispatcher runs: on time, once.
    let on_time = setup
        .calls(
            "odin",
            "wake_me",
            json!({"prompt": "On time.", "at": "2026-11-04T12:00:00+02:00"}),
        )
        .await
        .expect("wake_me");
    assert_eq!(on_time["at"], "2026-11-04T10:00:00+00:00");
    let on_time = on_time["id"].as_str().expect("its id").to_owned();
    setup.clock.set("2026-11-04T10:00:00Z");
    let woke_on_time = setup
        .occurrences_until(&on_time, |all| {
            all.first()
                .is_some_and(|first| first.state == OccurrenceState::Finished)
        })
        .await
        .remove(0);
    assert!(!woke_on_time.late);
    let woken = wake_up_turns(&setup.studio, &thread).await;
    assert_eq!(
        woken[1..].to_vec(),
        vec![(
            service("wake-up odin", &woke_on_time.id),
            "On time.".to_owned()
        )]
    );
    assert_eq!(threads(&setup.studio).await.len(), 1);

    // A week after their times they're forgotten.
    setup.clock.set("2026-11-11T10:00:01Z");
    tokio::time::timeout(WAIT, async {
        while !setup.dispatcher.schedules().expect("schedules").is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("forgotten in time");
    setup.dispatcher.stop().await;
}

/// Only a Bot's own thread may ask to be woken; a wake-up is at least a minute away, and a Bot
/// has at most 20 to come; it lists them, cancels its own, and no other Bot's.
#[tokio::test(flavor = "multi_thread")]
async fn wake_ups_are_a_bots_own_and_within_limits() {
    let setup = Setup::new("2026-11-04T08:00:00Z").await;
    setup.odin().await;
    std::fs::create_dir_all(setup.studio.home().join("thor")).expect("thor's home");
    setup
        .dispatcher
        .add_bot(add("thor", "~/thor"))
        .await
        .expect("bots/add");
    setup.turn("hello").await;

    // A thread of the Host's that no Bot has is refused, whatever it asks.
    let local = setup.studio.local().await;
    let ask_tool = |tool: &str, arguments: serde_json::Value| {
        prompt(&format!("tool {} {arguments}", dispatcher_tool(tool)))
    };
    let ran = local
        .send(RunRequest {
            agent_id: "fake".to_owned(),
            cwd: setup.studio.home(),
            remote: None,
            thread_id: None,
            additional_directories: Vec::new(),
            mode: None,
            prompt: ask_tool("wake_me", json!({"prompt": "Me too.", "in": 3600})),
            policy: PermissionPolicy::ask(),
            attach: false,
            trace: false,
            key: None,
            caller: None,
            origin: None,
            labels: Vec::new(),
        })
        .await
        .expect("thread/run");
    let stranger = ran.thread_id;
    let refusal = "Only a Bot's own thread can ask to be woken";
    let why = answered(
        &said(&setup.studio, &stranger, &ran.turn_id.expect("its turn")).await,
        "wake_me",
    )
    .expect_err("refused");
    assert!(why.starts_with(refusal), "{why}");
    for (tool, arguments) in [
        ("list_wakeups", json!({})),
        ("cancel_wakeup", json!({"id": "sch-1"})),
    ] {
        let queued = local
            .send(AddQueuedRequest {
                thread_id: stranger.clone(),
                prompt: ask_tool(tool, arguments),
                key: None,
                caller: None,
                origin: None,
            })
            .await
            .expect("queue/add")
            .queued_id;
        let why =
            answered(&said(&setup.studio, &stranger, &queued).await, tool).expect_err("refused");
        assert!(why.starts_with(refusal), "{tool}: {why}");
    }
    local.shutdown().await;

    // When, and what, are checked.
    for (arguments, said) in [
        (
            json!({"prompt": "Soon.", "in": 30}),
            "A wake-up has to be at least a minute from now, and Wed 4 Nov 08:00 UTC is only 30 \
             seconds away.",
        ),
        (
            json!({"prompt": "Late.", "at": "2026-11-04T07:00:00Z"}),
            "A wake-up has to be at least a minute from now, and Wed 4 Nov 07:00 UTC has passed.",
        ),
        (
            json!({"prompt": "Both.", "at": "2026-11-04T09:00:00Z", "in": 3600}),
            "Give at or in, not both.",
        ),
        (
            json!({"prompt": "Neither."}),
            "Give when to be woken: at, a time, or in, a number of seconds from now.",
        ),
        (
            json!({"prompt": " ", "in": 3600}),
            "A wake-up needs a prompt",
        ),
        (
            json!({"prompt": "Odd.", "when": "later"}),
            "unknown field `when`",
        ),
        (
            json!({"prompt": "Odd.", "at": "tomorrow"}),
            "isn't an RFC 3339 time",
        ),
    ] {
        let why = setup
            .calls("odin", "wake_me", arguments.clone())
            .await
            .expect_err("refused");
        assert!(why.contains(said), "{arguments}: {why}");
    }

    // Twenty to come at most.
    let mut ids = Vec::new();
    for n in 0..20 {
        let woken = setup
            .calls(
                "odin",
                "wake_me",
                json!({"prompt": format!("Number {n}."), "in": 7200 - n * 60}),
            )
            .await
            .expect("wake_me");
        ids.push(woken["id"].as_str().expect("its id").to_owned());
    }
    let full = setup
        .calls(
            "odin",
            "wake_me",
            json!({"prompt": "One more.", "in": 3600}),
        )
        .await
        .expect_err("as many as it may have");
    assert_eq!(
        full,
        "odin has 20 wake-ups still to come, the most a Bot may have: cancel one with \
         cancel_wakeup, or wait for one to come, before asking for another."
    );
    let listed = setup
        .calls("odin", "list_wakeups", json!({}))
        .await
        .expect("list_wakeups");
    let listed: Vec<&str> = listed["wakeups"]
        .as_array()
        .expect("its wake-ups")
        .iter()
        .map(|woken| woken["id"].as_str().expect("an id"))
        .collect();
    let soonest_first: Vec<&str> = ids.iter().rev().map(String::as_str).collect();
    assert_eq!(listed, soonest_first);

    // Another Bot can't cancel odin's, nor sees them.
    let thors = setup
        .calls("thor", "cancel_wakeup", json!({"id": ids[0]}))
        .await
        .expect_err("not thor's");
    assert_eq!(
        thors,
        format!(
            "thor has no wake-up {} still to come: list_wakeups lists those it has.",
            ids[0]
        )
    );
    assert_eq!(
        setup
            .calls("thor", "list_wakeups", json!({}))
            .await
            .expect("list_wakeups"),
        json!({"wakeups": []})
    );

    // Cancelled, it's gone, and makes room.
    let cancelled = setup
        .calls("odin", "cancel_wakeup", json!({"id": ids[0]}))
        .await
        .expect("cancel_wakeup");
    assert_eq!(
        (
            &cancelled["cancelled"]["id"],
            &cancelled["cancelled"]["prompt"]
        ),
        (&json!(ids[0]), &json!("Number 0."))
    );
    let again = setup
        .calls("odin", "cancel_wakeup", json!({"id": ids[0]}))
        .await
        .expect_err("cancelled already");
    assert!(again.starts_with("odin has no wake-up"), "{again}");
    assert!(
        setup
            .dispatcher
            .schedules()
            .expect("schedules")
            .iter()
            .all(|schedule| schedule.id != ids[0] && schedule.wake_up)
    );
    setup
        .calls(
            "odin",
            "wake_me",
            json!({"prompt": "One more.", "in": 3600}),
        )
        .await
        .expect("room for one more");
    setup.dispatcher.stop().await;
}

/// A wake-up due while its Bot is paused is skipped, saying why, as any of the Bot's schedules'
/// occurrences is: it doesn't come again.
#[tokio::test(flavor = "multi_thread")]
async fn a_wake_up_due_while_its_bot_is_paused_is_skipped() {
    let setup = Setup::new("2026-11-04T08:00:00Z").await;
    setup
        .dispatcher
        .add_bot(AddBotRequest {
            pause_after: Some(60 * 60 * 1000),
            ..odin()
        })
        .await
        .expect("bots/add");
    setup.turn("hello").await;
    let woken = setup
        .calls(
            "odin",
            "wake_me",
            json!({"prompt": "Nudge.", "at": "2026-11-04T10:00:00Z"}),
        )
        .await
        .expect("wake_me");
    let id = woken["id"].as_str().expect("its id").to_owned();
    let target = setup.studio.home().join("odin").join("out.txt");
    setup
        .send(&format!("write {} hello", target.display()))
        .await;
    setup.odin_until(|bot| bot.waiting_since.is_some()).await;
    setup.clock.set("2026-11-04T09:01:00Z");
    setup.odin_until(|bot| bot.paused.is_some()).await;
    setup.clock.set("2026-11-04T10:00:00Z");
    let skipped = setup
        .occurrences_until(&id, |all| !all.is_empty())
        .await
        .remove(0);
    assert_eq!(skipped.state, OccurrenceState::Skipped);
    assert_eq!(
        skipped.why.as_deref(),
        Some(
            "the Bot odin is paused: its thread has waited on the person since Wed 4 Nov 08:00 UTC"
        )
    );
    setup.dispatcher.stop().await;
}

/// `git args…` in `dir`, away from the configuration of whoever runs the tests: what it printed.
fn git(dir: &std::path::Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .envs(crate::common::ISOLATED_GIT.iter().copied())
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

/// `bots/add` has the Bot's Host make its home (WVE-178): `~/bots/<name>` by default, a
/// repository of its own with its first memory files committed, saying its job; what's there is
/// kept. What the Dispatcher refuses makes nothing, and no Bot is added when the Host is away or
/// refuses.
#[tokio::test(flavor = "multi_thread")]
async fn bots_add_has_its_host_make_its_home() {
    let setup = Setup::new("2026-11-04T08:00:00Z").await;
    let cli = ask(setup.dir.path()).await;
    assert!(
        cli.hello().offers(BOTS_HOME_FEATURE) && cli.hello().offers(BOTS_WATCH_FEATURE),
        "{:?}",
        cli.hello()
    );

    // By default in ~/bots, saying what it's for.
    let added = cli
        .send(AddBotRequest {
            home: None,
            job: Some("Watch the night builds.".to_owned()),
            ..add("Night Owl", "unused")
        })
        .await
        .expect("bots/add");
    let home = setup.home("bots/night-owl");
    assert_eq!(added.bot.home, home);
    assert_eq!(
        added.home,
        Some(InitRepositoryResponse {
            path: home.clone(),
            created: true,
            initialized: true,
            files: Some(FilesMade::Committed),
        })
    );
    let agents = std::fs::read_to_string(home.join("AGENTS.md")).expect("its AGENTS.md");
    assert!(
        agents.starts_with("# Night Owl\n\nThis directory is the home of the Bot named Night Owl")
            && agents.contains("\n## Your job\n\nWatch the night builds.\n\nSo keep"),
        "{agents}"
    );
    assert_eq!(
        std::fs::read_to_string(home.join("CLAUDE.md")).expect("its CLAUDE.md"),
        "@AGENTS.md\n"
    );
    assert_eq!(
        git(&home, &["log", "--format=%s", "--name-only"]),
        "Start Night Owl's home\n\nAGENTS.md\nCLAUDE.md"
    );

    // odin's directory is there, with a memory file of its own: kept, and nothing committed.
    std::fs::write(setup.studio.home().join("odin/AGENTS.md"), "mine\n").expect("a file");
    let odin = cli.send(odin()).await.expect("bots/add");
    assert_eq!(
        odin.home,
        Some(InitRepositoryResponse {
            path: setup.home("odin"),
            created: false,
            initialized: true,
            files: Some(FilesMade::Kept {
                file: "AGENTS.md".into()
            }),
        })
    );
    assert!(!setup.studio.home().join("odin/CLAUDE.md").exists());

    // What the Dispatcher refuses makes nothing.
    let taken = cli
        .send(add("night owl", "~/elsewhere"))
        .await
        .expect_err("a name taken");
    assert_eq!(taken.message, "there's a Bot called Night Owl already");
    assert!(!setup.studio.home().join("elsewhere").exists());
    let nameless = cli
        .send(AddBotRequest {
            home: None,
            ..add("..", "unused")
        })
        .await
        .expect_err("no directory name");
    assert!(
        nameless.message.contains("give one with home"),
        "{nameless:?}"
    );

    // The Host refuses a home inside another repository, and says why; no Bot is added.
    let code = setup.studio.home().join("code");
    std::fs::create_dir_all(&code).expect("a directory");
    git(&code, &["init", "-q"]);
    let inside = cli
        .send(add("loki", "~/code/loki"))
        .await
        .expect_err("refused by the Host");
    assert!(
        inside
            .message
            .starts_with("studio couldn't make loki's home at ~/code/loki: ")
            && inside.message.contains("a repository of its own"),
        "{inside:?}"
    );
    assert!(!code.join("loki").exists());

    // Its Host away: nothing to make the home, and no Bot.
    setup.studio.relay.cut();
    host_until(&setup.dispatcher, &setup.host_id, |host| !host.connected).await;
    let away = cli
        .send(add("thor", "~/thor"))
        .await
        .expect_err("its Host away");
    assert!(
        errors::is(&away, errors::HOST_UNAVAILABLE) && away.message.contains("isn't connected"),
        "{away:?}"
    );
    setup.studio.relay.resume();
    host_until(&setup.dispatcher, &setup.host_id, |host| host.connected).await;
    let names: Vec<String> = cli
        .send(ListBotsRequest {})
        .await
        .expect("bots/list")
        .bots
        .into_iter()
        .map(|bot| bot.name)
        .collect();
    assert_eq!(names, ["Night Owl", "odin"]);
    assert!(!setup.studio.home().join("thor").exists());
    cli.shutdown().await;
    setup.dispatcher.stop().await;
}

/// A Bot another made names it, by name while it's there; the API never sets that itself.
#[tokio::test(flavor = "multi_thread")]
async fn a_bot_made_by_another_names_it() {
    let setup = Setup::new("2026-11-04T08:00:00Z").await;
    let odin = setup.odin().await;
    assert_eq!(
        (odin.created_by.clone(), odin.created_by_name.clone()),
        (None, None)
    );
    let scribe = setup
        .dispatcher
        .add_bot_made_by(add("scribe", "~/scribe"), "odin")
        .await
        .expect("bots/add")
        .bot;
    assert_eq!(
        (
            scribe.created_by.as_deref(),
            scribe.created_by_name.as_deref()
        ),
        (Some(odin.id.as_str()), Some("odin"))
    );
    let nobody = setup
        .dispatcher
        .add_bot_made_by(add("loki", "~/loki"), "nobody")
        .await
        .expect_err("no such maker");
    assert_eq!(nobody.message, "there's no Bot nobody");
    assert!(!setup.studio.home().join("loki").exists());
    setup.dispatcher.remove_bot("odin").expect("bots/remove");
    let scribe = setup.dispatcher.bot("scribe").expect("bots/get");
    assert_eq!(
        (scribe.created_by.as_deref(), scribe.created_by_name),
        (Some(odin.id.as_str()), None)
    );
    setup.dispatcher.stop().await;
}

/// A Bot's avatar (WVE-223) is an emoji and a colour, each given, changed or cleared alone by
/// the person, and by the Bot for itself with `set_avatar`; an emoji that's a word is refused.
#[tokio::test(flavor = "multi_thread")]
async fn a_bot_has_an_avatar_the_person_or_the_bot_sets() {
    let setup = Setup::new("2026-11-04T08:00:00Z").await;
    let odin = setup.odin().await;
    assert_eq!((odin.emoji, odin.color), (None, None));
    let scribe = setup
        .dispatcher
        .add_bot(AddBotRequest {
            emoji: Some(" 📝 ".to_owned()),
            color: Some(BotColor::Teal),
            ..add("scribe", "~/scribe")
        })
        .await
        .expect("bots/add")
        .bot;
    assert_eq!(
        (scribe.emoji.as_deref(), scribe.color),
        (Some("📝"), Some(BotColor::Teal))
    );

    let update = |emoji: Option<Option<&str>>, color: Option<Option<BotColor>>| {
        setup.dispatcher.update_bot(UpdateBotRequest {
            bot: "odin".to_owned(),
            emoji: emoji.map(|emoji| emoji.map(str::to_owned)),
            color,
            ..UpdateBotRequest::default()
        })
    };
    let changed = update(Some(Some("🦉")), None).expect("an emoji");
    assert_eq!(
        (changed.emoji.as_deref(), changed.color),
        (Some("🦉"), None)
    );
    assert!(changed.updated_at >= odin.updated_at);
    let changed = update(None, Some(Some(BotColor::Red))).expect("a colour");
    assert_eq!(
        (changed.emoji.as_deref(), changed.color),
        (Some("🦉"), Some(BotColor::Red))
    );
    // One joined of several is one emoji.
    let family = "👩‍👩‍👧‍👦";
    let changed = update(Some(Some(family)), None).expect("a joined emoji");
    assert_eq!(changed.emoji.as_deref(), Some(family));
    for (word, why) in [
        (
            "",
            "a Bot's emoji can't be empty: leave it out, or clear it with null".to_owned(),
        ),
        ("owl", "a Bot's emoji is one emoji, not \"owl\"".to_owned()),
        (
            "🦉 🦉",
            "a Bot's emoji is one emoji, not \"🦉 🦉\"".to_owned(),
        ),
        (
            &"🦉".repeat(17),
            "a Bot's emoji is one emoji, of 64 bytes at most".to_owned(),
        ),
    ] {
        let refused = update(Some(Some(word)), Some(None)).expect_err("no emoji");
        assert_eq!(refused.message, why, "{word:?}");
    }
    // All or none: the colour a refused change would have cleared is kept.
    let kept = setup.dispatcher.bot("odin").expect("bots/get");
    assert_eq!(
        (kept.emoji.as_deref(), kept.color),
        (Some(family), Some(BotColor::Red))
    );
    let cleared = update(Some(None), Some(None)).expect("cleared");
    assert_eq!((cleared.emoji, cleared.color), (None, None));

    // The Bot changes its own, and no other's.
    let mut cli = ask(setup.dir.path()).await;
    cli.send(WatchBotsRequest {}).await.expect("bots/watch");
    let mut set = setup
        .calls(
            "odin",
            "set_avatar",
            json!({"emoji": "🐙", "color": "purple"}),
        )
        .await
        .expect("set_avatar");
    set.as_object_mut().expect("odin").remove("state");
    assert_eq!(
        set,
        json!({
            "name": "odin",
            "agent": "fake",
            "host": "studio",
            "home": setup.home("odin").display().to_string(),
            "emoji": "🐙",
            "color": "purple",
            "you": true,
        })
    );
    changes_until(
        &mut cli,
        |change| matches!(change, BotChange::Updated(bot) if bot.emoji.as_deref() == Some("🐙")),
    )
    .await;
    cli.shutdown().await;
    let set = setup
        .calls("odin", "set_avatar", json!({"color": null}))
        .await
        .expect("set_avatar");
    assert_eq!((&set["emoji"], set.get("color")), (&json!("🐙"), None));
    for (arguments, why) in [
        (
            json!({}),
            "Give an emoji, a color or both: null clears one.",
        ),
        (
            json!({"emoji": "octopus"}),
            "Couldn't change your avatar: a Bot's emoji is one emoji, not \"octopus\".",
        ),
    ] {
        let refused = setup.calls("odin", "set_avatar", arguments).await;
        assert_eq!(refused, Err(why.to_owned()));
    }
    let wrong = setup
        .calls("odin", "set_avatar", json!({"color": "mauve"}))
        .await
        .expect_err("no such colour");
    assert!(
        wrong.starts_with("The arguments don't fit set_avatar's input: "),
        "{wrong}"
    );
    let scribe = setup.dispatcher.bot("scribe").expect("bots/get");
    assert_eq!(
        (scribe.emoji.as_deref(), scribe.color),
        (Some("📝"), Some(BotColor::Teal))
    );
    setup.dispatcher.stop().await;
}

/// The next change to the Bots `cli` hears of, in time.
async fn change(cli: &mut DispatcherConnection) -> BotChange {
    tokio::time::timeout(WAIT, cli.bot_change())
        .await
        .expect("a change in time")
        .expect("the connection open")
}

/// The changes `cli` hears of until one is as `wanted` says, which is the last.
async fn changes_until(
    cli: &mut DispatcherConnection,
    wanted: impl Fn(&BotChange) -> bool,
) -> Vec<BotChange> {
    let mut changes = Vec::new();
    loop {
        let next = change(cli).await;
        let done = wanted(&next);
        changes.push(next);
        if done {
            return changes;
        }
    }
}

/// Whether `cli` hears of no change for a moment.
async fn quiet(cli: &mut DispatcherConnection) -> bool {
    tokio::time::timeout(Duration::from_millis(300), cli.bot_change())
        .await
        .is_err()
}

/// `bots/watch` (WVE-178): the Bots, then each change to how one lists, once, until unwatched.
#[tokio::test(flavor = "multi_thread")]
async fn watching_the_bots_hears_each_change() {
    let setup = Setup::new("2026-11-04T08:00:00Z").await;
    let mut cli = ask(setup.dir.path()).await;
    let watched = cli.send(WatchBotsRequest {}).await.expect("bots/watch");
    assert_eq!(watched.bots, Vec::new());

    // Added.
    let odin = setup.odin().await;
    assert_eq!(
        change(&mut cli).await,
        BotChange::Updated(Box::new(odin.clone()))
    );
    assert!(quiet(&mut cli).await, "nothing more");

    // A change that changes nothing says nothing; one that does, says it.
    setup
        .dispatcher
        .update_bot(UpdateBotRequest {
            bot: "odin".to_owned(),
            zone: Some("UTC".to_owned()),
            ..UpdateBotRequest::default()
        })
        .expect("bots/update");
    assert!(quiet(&mut cli).await, "nothing changed");
    let changed = setup
        .dispatcher
        .update_bot(UpdateBotRequest {
            bot: "odin".to_owned(),
            mode: Some(Some("plan".to_owned())),
            ..UpdateBotRequest::default()
        })
        .expect("bots/update");
    assert_eq!(
        change(&mut cli).await,
        BotChange::Updated(Box::new(changed))
    );

    // Its first thread, working and then idle.
    setup.send("slow 10").await;
    let heard = changes_until(&mut cli, |change| {
        matches!(change, BotChange::Updated(bot) if bot.thread.is_some() && bot.state == BotState::Idle)
    })
    .await;
    assert!(
        heard.iter().any(
            |change| matches!(change, BotChange::Updated(bot) if bot.state == BotState::Working)
        ),
        "{heard:#?}"
    );
    for pair in heard.windows(2) {
        assert_ne!(pair[0], pair[1], "each change once");
    }
    assert!(quiet(&mut cli).await, "nothing more");

    // Its Host going and coming back.
    setup.studio.relay.cut();
    changes_until(
        &mut cli,
        |change| matches!(change, BotChange::Updated(bot) if !bot.connected),
    )
    .await;
    setup.studio.relay.resume();
    changes_until(
        &mut cli,
        |change| matches!(change, BotChange::Updated(bot) if bot.connected),
    )
    .await;

    // Removed.
    setup.dispatcher.remove_bot("odin").expect("bots/remove");
    changes_until(&mut cli, |change| {
        *change == BotChange::Removed(odin.id.clone())
    })
    .await;

    // Unwatched, it hears nothing more.
    cli.send(UnwatchBotsRequest {}).await.expect("bots/unwatch");
    setup
        .dispatcher
        .add_bot(add("thor", "~/thor"))
        .await
        .expect("bots/add");
    assert!(quiet(&mut cli).await, "unwatched");
    cli.shutdown().await;
    setup.dispatcher.stop().await;
}

/// `schedules/list` with a Bot lists only the schedules that prompt it, its wake-ups too.
#[tokio::test(flavor = "multi_thread")]
async fn a_bots_schedules_are_listed_alone() {
    let setup = Setup::new("2026-11-04T08:00:00Z").await;
    setup.odin().await;
    setup
        .dispatcher
        .add_bot(add("thor", "~/thor"))
        .await
        .expect("bots/add");
    for (name, bot) in [("tick", "odin"), ("tock", "thor")] {
        setup
            .dispatcher
            .add_schedule(schedule(name, bot, Some("0 9 * * *"), None, name))
            .expect("schedules/add");
    }
    setup.turn("hello").await;
    setup
        .calls("odin", "wake_me", json!({"prompt": "Nudge.", "in": 3600}))
        .await
        .expect("wake_me");
    let cli = ask(setup.dir.path()).await;
    let listed = |bot: Option<&str>| {
        cli.send(ListSchedulesRequest {
            bot: bot.map(str::to_owned),
        })
    };
    let odins: Vec<(String, bool)> = listed(Some("ODIN"))
        .await
        .expect("schedules/list")
        .schedules
        .into_iter()
        .map(|schedule| (schedule.name, schedule.wake_up))
        .collect();
    assert_eq!(odins.len(), 2, "{odins:?}");
    assert!(odins.contains(&("tick".to_owned(), false)), "{odins:?}");
    assert!(odins.iter().any(|(_, wake_up)| *wake_up), "{odins:?}");
    assert_eq!(
        listed(None).await.expect("schedules/list").schedules.len(),
        3
    );
    let nobody = listed(Some("nobody")).await.expect_err("no such Bot");
    assert_eq!(nobody.message, "there's no Bot nobody");
    cli.shutdown().await;
    setup.dispatcher.stop().await;
}

/// Have a thread on studio that no Bot has call each of the Dispatcher's `tools` in turn: why
/// each was refused.
async fn a_strangers_calls(setup: &Setup, tools: &[(&str, serde_json::Value)]) -> Vec<String> {
    let local = setup.studio.local().await;
    let ask_tool = |tool: &str, arguments: &serde_json::Value| {
        prompt(&format!("tool {} {arguments}", dispatcher_tool(tool)))
    };
    let mut refused = Vec::new();
    let mut stranger: Option<ThreadId> = None;
    for (tool, arguments) in tools {
        let (thread, turn) = match &stranger {
            None => {
                let ran = local
                    .send(RunRequest {
                        agent_id: "fake".to_owned(),
                        cwd: setup.studio.home(),
                        remote: None,
                        thread_id: None,
                        additional_directories: Vec::new(),
                        mode: None,
                        prompt: ask_tool(tool, arguments),
                        policy: PermissionPolicy::ask(),
                        attach: false,
                        trace: false,
                        key: None,
                        caller: None,
                        origin: None,
                        labels: Vec::new(),
                    })
                    .await
                    .expect("thread/run");
                (ran.thread_id, ran.turn_id.expect("its turn"))
            }
            Some(thread) => {
                let queued = local
                    .send(AddQueuedRequest {
                        thread_id: thread.clone(),
                        prompt: ask_tool(tool, arguments),
                        key: None,
                        caller: None,
                        origin: None,
                    })
                    .await
                    .expect("queue/add")
                    .queued_id;
                (thread.clone(), queued)
            }
        };
        let why = answered(&said(&setup.studio, &thread, &turn).await, tool)
            .expect_err("a stranger refused");
        refused.push(why);
        stranger = Some(thread);
    }
    local.shutdown().await;
    refused
}

/// A Bot's thread makes another Bot with `create_bot` (WVE-178): recorded with its maker, a home
/// its Host made saying its job, the maker's agent and zone, and nothing else until the person
/// prompts it; those watching the Bots hear of it, and `list_bots` lists both. What `bots/add`
/// refuses comes back as the tool's error.
#[tokio::test(flavor = "multi_thread")]
async fn a_bot_makes_another_that_waits_for_the_person() {
    let setup = Setup::new("2026-11-04T08:00:00Z").await;
    let odin = setup.odin().await;
    setup.turn("hello").await;
    let mut cli = ask(setup.dir.path()).await;
    cli.send(WatchBotsRequest {}).await.expect("bots/watch");

    let made = setup
        .calls(
            "odin",
            "create_bot",
            json!({"name": " Scribe ", "job": "Keep the meeting notes in order."}),
        )
        .await
        .expect("create_bot");
    let home = setup.home("bots/scribe");
    assert_eq!(
        made,
        json!({
            "made": {
                "name": "Scribe",
                "agent": "fake",
                "host": "studio",
                "home": home.display().to_string(),
                "state": "idle",
                "madeBy": "odin",
            },
            "home": {
                "path": home.display().to_string(),
                "created": true,
                "initialized": true,
                "files": {"state": "committed"},
            },
            "next": format!(
                "Scribe is made, with its home at {} on studio. It does nothing until the person \
                 prompts it: it has no thread and no schedules yet, and no Bot can prompt or \
                 schedule it. Tell the person it's there, and what it's for.",
                home.display()
            ),
        })
    );

    // Recorded with its maker, the maker's agent, Host and zone, and nothing to do.
    let scribe = setup.dispatcher.bot("scribe").expect("bots/get");
    assert_eq!(
        (
            scribe.created_by.as_deref(),
            scribe.created_by_name.as_deref(),
            scribe.agent_id.as_str(),
            scribe.host_id.as_str(),
            scribe.zone.as_str(),
            scribe.home.clone(),
            scribe.thread.clone(),
            scribe.policy.clone(),
        ),
        (
            Some(odin.id.as_str()),
            Some("odin"),
            "fake",
            setup.host_id.as_str(),
            "UTC",
            home.clone(),
            None,
            PermissionPolicy::default(),
        )
    );
    let agents = std::fs::read_to_string(home.join("AGENTS.md")).expect("its AGENTS.md");
    assert!(
        agents.contains("\n## Your job\n\nKeep the meeting notes in order.\n"),
        "{agents}"
    );
    assert!(setup.dispatcher.schedules().expect("schedules").is_empty());
    assert_eq!(threads(&setup.studio).await.len(), 1, "odin's alone");

    // Those watching hear of it.
    let heard = changes_until(
        &mut cli,
        |change| matches!(change, BotChange::Updated(bot) if bot.name == "Scribe"),
    )
    .await;
    assert_eq!(
        heard.last(),
        Some(&BotChange::Updated(Box::new(scribe.clone())))
    );
    cli.shutdown().await;

    // Both listed, by name, saying which is the caller and which made which.
    let mut listed = setup
        .calls("odin", "list_bots", json!({}))
        .await
        .expect("list_bots");
    // odin's own state is its turn calling the tool, as the watch has seen it by then.
    let state = listed["bots"][0]
        .as_object_mut()
        .expect("odin")
        .remove("state");
    assert!(
        matches!(
            state.as_ref().and_then(|state| state.as_str()),
            Some("working" | "idle")
        ),
        "{state:?}"
    );
    assert_eq!(
        listed,
        json!({"bots": [
            {
                "name": "odin",
                "agent": "fake",
                "host": "studio",
                "home": setup.home("odin").display().to_string(),
                "you": true,
            },
            {
                "name": "Scribe",
                "agent": "fake",
                "host": "studio",
                "home": home.display().to_string(),
                "state": "idle",
                "madeBy": "odin",
            },
        ]})
    );

    // What bots/add refuses, and what the tool does, come back as its error; nothing is made.
    for (arguments, said) in [
        (
            json!({"name": "scribe", "job": "Again."}),
            "Couldn't make scribe: there's a Bot called Scribe already.",
        ),
        (
            json!({"name": "Loki", "job": "Mischief.", "host": "nowhere"}),
            "Couldn't make Loki: no Host called nowhere has joined the Dispatcher.",
        ),
        (
            json!({"name": "Loki", "job": " "}),
            "A new Bot needs a job: what it's for, as the person put it, which its home's \
             AGENTS.md starts with.",
        ),
        (
            json!({"name": " ", "job": "Nothing."}),
            "A new Bot needs a name.",
        ),
        (
            json!({"name": "Loki", "job": "Mischief.", "policy": "allow"}),
            "unknown field `policy`",
        ),
    ] {
        let why = setup
            .calls("odin", "create_bot", arguments.clone())
            .await
            .expect_err("refused");
        assert!(why.contains(said), "{arguments}: {why}");
    }
    let names: Vec<String> = setup
        .dispatcher
        .bots()
        .expect("bots")
        .into_iter()
        .map(|bot| bot.name)
        .collect();
    assert_eq!(names, ["odin", "Scribe"]);
    assert!(!setup.studio.home().join("bots/loki").exists());

    // Another agent, named.
    let other = setup
        .calls(
            "odin",
            "create_bot",
            json!({"name": "Heimdall", "job": "Watch.", "agent": "other", "host": "STUDIO"}),
        )
        .await
        .expect("create_bot");
    assert_eq!(other["made"]["agent"], "other");
    setup.dispatcher.stop().await;
}

/// A thread of the Host's that isn't a Bot's is refused by every one of WVE-178's tools, saying
/// why.
#[tokio::test(flavor = "multi_thread")]
async fn a_thread_that_isnt_a_bots_cant_manage_schedules_or_make_bots() {
    let setup = Setup::new("2026-11-04T08:00:00Z").await;
    setup.odin().await;
    setup
        .dispatcher
        .add_schedule(schedule("tick", "odin", Some("0 9 * * *"), None, "tick"))
        .expect("schedules/add");
    let tools = [
        (
            "add_schedule",
            json!({"name": "mine", "cron": "0 9 * * *", "prompt": "Mine."}),
        ),
        ("list_schedules", json!({})),
        ("pause_schedule", json!({"id": "tick"})),
        ("resume_schedule", json!({"id": "tick"})),
        ("remove_schedule", json!({"id": "tick"})),
        ("create_bot", json!({"name": "Loki", "job": "Mischief."})),
        ("list_bots", json!({})),
        ("set_avatar", json!({"emoji": "🦉"})),
    ];
    let refused = a_strangers_calls(&setup, &tools).await;
    for ((tool, _), why) in tools.iter().zip(&refused) {
        let can = match *tool {
            "create_bot" | "list_bots" | "set_avatar" => {
                "make another Bot, list the person's Bots or change its own avatar"
            }
            _ => "add, list, pause, resume or remove its schedules",
        };
        assert_eq!(
            why,
            &format!(
                "Only a Bot's own thread can {can}, and this thread isn't one of a Bot's: a Bot \
                 is a named assistant the person's Dispatcher keeps, and its threads are those \
                 the Dispatcher started for it."
            ),
            "{tool}"
        );
    }
    // Nothing changed.
    let schedules = setup.dispatcher.schedules().expect("schedules");
    assert_eq!(
        schedules
            .iter()
            .map(|schedule| (schedule.name.as_str(), schedule.paused.is_some()))
            .collect::<Vec<_>>(),
        [("tick", false)]
    );
    assert_eq!(setup.dispatcher.bots().expect("bots").len(), 1);
    setup.dispatcher.stop().await;
}

/// A Bot makes another only while there are fewer than 20 Bots; the person adds one regardless.
#[tokio::test(flavor = "multi_thread")]
async fn a_bot_makes_another_only_while_there_are_fewer_than_twenty() {
    let setup = Setup::new("2026-11-04T08:00:00Z").await;
    setup.odin().await;
    for n in 1..19 {
        setup
            .dispatcher
            .add_bot(AddBotRequest {
                home: None,
                ..add(&format!("bot {n}"), "unused")
            })
            .await
            .expect("bots/add");
    }
    setup
        .calls(
            "odin",
            "create_bot",
            json!({"name": "Twentieth", "job": "Count."}),
        )
        .await
        .expect("the twentieth");
    let full = "there are 20 Bots, the most there may be when a Bot makes one; the person can \
                still add one themselves, or remove one";
    let why = setup
        .calls(
            "odin",
            "create_bot",
            json!({"name": "Loki", "job": "Mischief."}),
        )
        .await
        .expect_err("as many as there may be");
    assert_eq!(why, format!("Couldn't make Loki: {full}."));
    assert!(!setup.studio.home().join("bots/loki").exists());
    let made_by = setup
        .dispatcher
        .add_bot_made_by(
            AddBotRequest {
                home: None,
                ..add("Loki", "unused")
            },
            "odin",
        )
        .await
        .expect_err("as many as there may be");
    assert_eq!(made_by.message, full);
    setup
        .dispatcher
        .add_bot(AddBotRequest {
            home: None,
            ..add("Loki", "unused")
        })
        .await
        .expect("the person isn't held to it");
    assert_eq!(setup.dispatcher.bots().expect("bots").len(), 21);
    setup.dispatcher.stop().await;
}

/// The occurrences of the schedule `name` once its latest is finished, newest first.
async fn finished(setup: &Setup, name: &str) -> Vec<Occurrence> {
    setup
        .occurrences_until(name, |all| {
            all.first()
                .is_some_and(|first| first.state == OccurrenceState::Finished)
        })
        .await
}

/// A Bot adds a schedule of its own, lists it with the person's for it but not its wake-ups or
/// another Bot's, and it comes into the Bot's thread at its time, saying the Bot made it; it
/// pauses, resumes and removes its own and the person's for it, by id or name, but no other
/// Bot's, nor its wake-ups.
#[tokio::test(flavor = "multi_thread")]
async fn a_bot_manages_its_own_schedules() {
    let setup = Setup::new("2026-11-04T08:00:00Z").await;
    setup.odin().await;
    std::fs::create_dir_all(setup.studio.home().join("thor")).expect("thor's home");
    setup
        .dispatcher
        .add_bot(add("thor", "~/thor"))
        .await
        .expect("bots/add");
    for (name, bot) in [("tick", "odin"), ("tock", "thor")] {
        setup
            .dispatcher
            .add_schedule(schedule(name, bot, Some("30 9 * * *"), None, name))
            .expect("schedules/add");
    }
    let thread = setup.turn("hello").await;
    let woken = setup
        .calls("odin", "wake_me", json!({"prompt": "Nudge.", "in": 7200}))
        .await
        .expect("wake_me");
    let wake_up = woken["id"].as_str().expect("its id").to_owned();

    let added = setup
        .calls(
            "odin",
            "add_schedule",
            json!({"name": "brief", "cron": "0 9 * * 1-5", "prompt": "Write the morning brief."}),
        )
        .await
        .expect("add_schedule");
    let id = added["id"].as_str().expect("its id").to_owned();
    assert!(id.starts_with("sch-"), "{id}");
    assert_eq!(
        added,
        json!({
            "id": id,
            "name": "brief",
            "cron": "0 9 * * 1-5",
            "zone": "UTC",
            "prompt": "Write the morning brief.",
            "next": {"at": "2026-11-04T09:00:00+00:00", "when": "Wed 4 Nov 09:00 UTC"},
            "addedByYou": true,
        })
    );
    // As schedules/add would have it: the Bot's, skipping overlaps, not a wake-up.
    let stored = setup
        .dispatcher
        .schedules()
        .expect("schedules")
        .into_iter()
        .find(|schedule| schedule.id == id)
        .expect("listed");
    assert_eq!(
        (
            stored.bot_name.as_deref(),
            stored.wake_up,
            stored.overlap,
            stored.missed,
            stored.run.cwd.clone()
        ),
        (
            Some("odin"),
            false,
            Overlap::Skip,
            Missed::Latest,
            setup.home("odin")
        )
    );

    // Its own and the person's for it, by name; not its wake-up, nor thor's.
    let names = |listed: &serde_json::Value| -> Vec<String> {
        listed["schedules"]
            .as_array()
            .expect("schedules")
            .iter()
            .map(|schedule| schedule["name"].as_str().expect("a name").to_owned())
            .collect()
    };
    let listed = setup
        .calls("odin", "list_schedules", json!({}))
        .await
        .expect("list_schedules");
    assert_eq!(names(&listed), ["brief", "tick"]);
    assert_eq!(listed["schedules"][0], added);
    assert_eq!(
        listed["schedules"][1]["addedByYou"],
        serde_json::Value::Null
    );
    assert_eq!(
        names(
            &setup
                .calls("thor", "list_schedules", json!({}))
                .await
                .expect("list_schedules")
        ),
        ["tock"]
    );

    // At its time it comes into odin's thread, saying odin made it.
    setup.clock.set("2026-11-04T09:00:00Z");
    let came = finished(&setup, &id).await.remove(0);
    assert_eq!(came.thread_id.as_ref(), Some(&thread));
    let turns = turns(&setup.studio, &thread).await;
    assert_eq!(
        turns.last(),
        Some(&(
            service("schedule brief by odin", &came.id),
            "Write the morning brief.".to_owned()
        ))
    );
    let listed = setup
        .calls("odin", "list_schedules", json!({}))
        .await
        .expect("list_schedules");
    assert_eq!(
        (
            &listed["schedules"][0]["last"],
            &listed["schedules"][0]["next"]["when"]
        ),
        (
            &json!({
                "at": "2026-11-04T09:00:00+00:00",
                "when": "Wed 4 Nov 09:00 UTC",
                "state": "finished",
                "outcome": "ended",
            }),
            &json!("Thu 5 Nov 09:00 UTC")
        )
    );

    // Paused by name, resumed by id.
    let paused = setup
        .calls("odin", "pause_schedule", json!({"id": "brief"}))
        .await
        .expect("pause_schedule");
    assert_eq!(
        (&paused["paused"], &paused["next"]),
        (&json!("odin paused it"), &serde_json::Value::Null)
    );
    setup.clock.set("2026-11-05T09:00:00Z");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        setup
            .dispatcher
            .occurrences(Some(&id), None)
            .expect("occurrences")
            .len(),
        1,
        "not while paused"
    );
    let resumed = setup
        .calls("odin", "resume_schedule", json!({"id": id}))
        .await
        .expect("resume_schedule");
    assert_eq!(
        (&resumed["paused"], &resumed["next"]["when"]),
        (&serde_json::Value::Null, &json!("Fri 6 Nov 09:00 UTC")),
        "what it missed while paused isn't caught up"
    );

    // The person's for it too.
    let paused = setup
        .calls("odin", "pause_schedule", json!({"id": "tick"}))
        .await
        .expect("pause_schedule");
    assert_eq!(paused["paused"], "odin paused it");
    let removed = setup
        .calls("odin", "remove_schedule", json!({"id": "tick"}))
        .await
        .expect("remove_schedule");
    assert_eq!(removed["removed"]["name"], "tick");
    assert!(
        setup.dispatcher.occurrences(Some("tick"), None).is_err(),
        "gone"
    );

    // Not thor's, nor its wake-ups, nor one there isn't.
    for tool in ["pause_schedule", "resume_schedule", "remove_schedule"] {
        for (by, said) in [
            (
                "tock".to_owned(),
                "The schedule tock isn't odin's: a Bot manages only the schedules that prompt \
                 it, which list_schedules lists."
                    .to_owned(),
            ),
            (
                wake_up.clone(),
                format!(
                    "{wake_up} is one of odin's wake-ups, which these tools leave alone: \
                     cancel_wakeup cancels it."
                ),
            ),
            (
                "nope".to_owned(),
                "There's no schedule nope: list_schedules lists odin's.".to_owned(),
            ),
        ] {
            let why = setup
                .calls("odin", tool, json!({"id": by}))
                .await
                .expect_err("refused");
            assert_eq!(why, said, "{tool} {by}");
        }
    }
    let schedules = setup.dispatcher.schedules().expect("schedules");
    let tock = schedules
        .iter()
        .find(|schedule| schedule.name == "tock")
        .expect("thor's untouched");
    assert_eq!(tock.paused, None);
    assert!(schedules.iter().any(|schedule| schedule.id == wake_up));

    // Its own, removed by id.
    setup
        .calls("odin", "remove_schedule", json!({"id": id}))
        .await
        .expect("remove_schedule");
    assert_eq!(
        names(
            &setup
                .calls("odin", "list_schedules", json!({}))
                .await
                .expect("list_schedules")
        ),
        [] as [String; 0]
    );
    setup.dispatcher.stop().await;
}

/// What a Bot's `add_schedule` refuses: what `schedules/add` would, one that comes more often
/// than every five minutes, and one past 20 schedules, the person's counted but not its
/// wake-ups.
#[tokio::test(flavor = "multi_thread")]
async fn a_bots_own_schedules_are_within_limits() {
    let setup = Setup::new("2026-11-04T08:00:00Z").await;
    setup.odin().await;
    setup
        .dispatcher
        .add_schedule(schedule("tick", "odin", Some("30 9 * * *"), None, "tick"))
        .expect("schedules/add");
    setup.turn("hello").await;
    setup
        .calls("odin", "wake_me", json!({"prompt": "Nudge.", "in": 7200}))
        .await
        .expect("wake_me");
    let add = |name: &str, cron: &str| json!({"name": name, "cron": cron, "prompt": "Go."});
    for (arguments, said) in [
        (
            add("busy", "*/2 * * * *"),
            "*/2 * * * * would come at Wed 4 Nov 08:02 UTC and again at Wed 4 Nov 08:04 UTC: a \
             Bot's own schedule may come every 5 minutes at most.",
        ),
        (
            add("twice", "0,3 9 * * *"),
            "0,3 9 * * * would come at Wed 4 Nov 09:00 UTC and again at Wed 4 Nov 09:03 UTC",
        ),
        (
            add("tick", "0 9 * * *"),
            "There's a schedule called tick already.",
        ),
        (add("odd", "0 9 * *"), "The cron expression \"0 9 * *\""),
        (
            json!({"name": "far", "cron": "0 9 * * *", "prompt": "Go.", "zone": "Mars/Olympus"}),
            "The time zone \"Mars/Olympus\"",
        ),
        (
            json!({"name": "empty", "cron": "0 9 * * *", "prompt": " "}),
            "A schedule needs a prompt: what to tell yourself each time.",
        ),
        (
            json!({"name": "at", "cron": "0 9 * * *", "prompt": "Go.", "at": 1}),
            "unknown field `at`",
        ),
    ] {
        let why = setup
            .calls("odin", "add_schedule", arguments.clone())
            .await
            .expect_err("refused");
        assert!(why.contains(said), "{arguments}: {why}");
    }

    // Every five minutes is all right, and in a zone of its own.
    let zoned = setup
        .calls(
            "odin",
            "add_schedule",
            json!({"name": "s-0", "cron": "*/5 * * * *", "prompt": "Go.", "zone": "Africa/Johannesburg"}),
        )
        .await
        .expect("add_schedule");
    assert_eq!(
        (&zoned["zone"], &zoned["next"]["at"]),
        (
            &json!("Africa/Johannesburg"),
            &json!("2026-11-04T10:05:00+02:00")
        )
    );

    // Twenty with the person's, but not counting its wake-up.
    for n in 1..19 {
        setup
            .calls("odin", "add_schedule", add(&format!("s-{n}"), "0 9 * * *"))
            .await
            .expect("add_schedule");
    }
    let full = setup
        .calls("odin", "add_schedule", add("s-19", "0 9 * * *"))
        .await
        .expect_err("as many as it may have");
    assert_eq!(
        full,
        "odin has 20 schedules, wake-ups aside, the most a Bot may have when it adds one: \
         remove one with remove_schedule, if the person agrees, before adding another."
    );
    setup
        .calls("odin", "remove_schedule", json!({"id": "s-0"}))
        .await
        .expect("remove_schedule");
    setup
        .calls("odin", "add_schedule", add("s-19", "0 9 * * *"))
        .await
        .expect("room for one more");
    // The person isn't held to it.
    setup
        .dispatcher
        .add_schedule(schedule("tock", "odin", Some("0 10 * * *"), None, "tock"))
        .expect("schedules/add");
    setup.dispatcher.stop().await;
}
