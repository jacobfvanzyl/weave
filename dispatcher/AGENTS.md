# The Dispatcher

`weave-dispatcher` is the Dispatcher (ADR 0027, WVE-175; spec
`docs/specs/wve-175-dispatcher.md`): the person's program, apart from their Hosts, that keeps
triggers and Bots and starts their work on the Hosts. The `weave dispatcher` subcommands in
`cli/src/commands/dispatcher.rs` run, start, stop and install it as a service, and `weave hosts`,
`weave schedules`, `weave projects` and `weave bots` ask it over its socket, or from another
computer paired with it over its WebSocket (`cli/src/dispatcher.rs`, `cli/src/paired.rs`;
WVE-176).

It is a client of each Host over the Host protocol, as a **service**, so a Host lets it do only
what starting and following threads needs (`FOR_SERVICES` in `host/src/client.rs`). Hosts join
it and keep a connection open to it (ADR 0030, WVE-194), over which it says `host/hello`; it
never dials a Host. It is never a Host: it runs no agents, and Hosts work on without it. Keep it
that way. It depends on
`weave-host-client`, `weave-host-protocol` and `weave-remote`, never on `weave-host`, so it can run
on a computer of its own; `weave-host` is only a dev-dependency, for the tests' in-process Hosts.

- `lib.rs`: `Dispatcher`, opened from its directory (`DispatcherPaths`: `$WEAVE_DISPATCHER_DIR`
  or `~/.local/state/weave/dispatcher`), and what the API does: codes Hosts join with
  (`offer_host`), listing and removing Hosts, and `deliver`. `serve` listens on `hosts.sock` too.
- `joins.rs` (WVE-194): a Host's own connection, on the WebSocket with `weave-dispatcher-host` or
  over `hosts.sock` on this computer (`serve_socket`): its `dispatcher/challenge` and
  `hosts/connect`, read before the SDK takes the connection (`weave_remote::preamble`), joining
  with a live code (`Joins`) or proving the key it joined with (`Shared::admit`), then handed to a
  new `Link` in place of any the Host had (`Shared::arrived`).
- `store.rs`: its state in SQLite (`rusqlite`, bundled): `hosts` and `deliveries`, and in
  `store/calls.rs` the `calls` from Hosts' agents and the turns they began (`follows`). Migrations are
  numbered SQL in `MIGRATIONS`, applied in order and recorded in `PRAGMA user_version`; never
  edit one once released, add the next. The eleventh (WVE-223) added a Bot's avatar, `emoji` and
  `color` on `bots`, the colour by its name on the wire, and one it doesn't know read as none. The tenth (WVE-178) added `made_call` to `schedules`,
  the Host's id for the `add_schedule` call that added a Bot's own schedule, unique per Bot; the
  ninth (WVE-178), `created_by` on `bots`, the Bot that made one, by id and with no foreign key so
  it outlives its maker. The eighth (WVE-118) added Bots: `bots`, `bot_threads`
  and `bot_new_threads`, `bot_id` on `schedules` and `deliveries`, cascading so removing a Bot or
  its Host takes its schedules and the prompts waiting for it, and a schedule's `at` and
  `wake_call`. The seventh (WVE-189) added Projects. The sixth (WVE-200) renamed the `session_id` columns to
  `thread_id` and moved stored work to the Host protocol's version 3; Hosts' answers stored
  before keep `sessionId`, which `answered_thread` reads too. Times are milliseconds, kept signed.
- `link.rs`: one task per Host connection, which says hello with the Dispatcher's key over it
  (`HostConnection::connect_with`), watches its threads (`threads/watch`) and sends it its
  pending deliveries,
  oldest first, settling a thread's prompt (`Work::Prompt`) into `queue/add` or `thread/run`
  before its first send (in the last of the thread's successors, WVE-168), and reads with
  `threads/get` how started occurrences' turns ended when their threads go idle, following an
  interrupted turn into its continuation (`continuedIn`). A Host that closes with
  `CLOSE_REVOKED`, having left, is recorded as refused in `hosts.refused` until it joins again;
  removing a Host closes its connection with `CLOSE_REVOKED` (`Link::revoke`), which it forgets
  the Dispatcher at. A Host with no key in `hosts` was paired before Hosts joined, and is listed
  `unjoined` until it joins. On each connection it declares the Dispatcher's own tools
  (`tools::tools`) beside `hosts`, and answers their calls (`HostEvent::ToolCall`,
  `tools::answer`). It settles a Bot's prompt (`Work::Bot`) with `bots::settle` before its
  first send, leaving one that has to wait unsent while the work after it goes on, reads at once
  a thread a Bot's `thread/run` opened (`bots::delivered`), so the next prompt queues there, and
  runs `bots::advance` when it connects, when it's woken, and when the watch says a Bot's thread
  changed. Whenever it connects, hears of a thread or goes, it asks `Shared::bots_changed`, so
  those watching the Bots hear of their state and Host.
- `scheduler.rs` (WVE-145): the task that considers every schedule when one is due, when they
  change, and every 30 seconds of wall clock at most (`Clock`; tests pass one they move), and
  `Plan`, a schedule's croner expression in its jiff time zone. Catch-ups, the one-week look-back
  and the minute's grace are here; overlap and pausing are in the store, inside the
  transaction that writes an occurrence down. A thread an occurrence starts is labelled
  `dispatcher` (`LABEL`) and `schedule:<id>` (WVE-173). A one-off (`at`, `Plan::once`; `Plan::of`
  picks) has one time, considered as a cron expression's are, and is skipped, saying so, when
  missed by more than the look-back; it's kept once done. A Bot's schedule fires a `Work::Bot`
  (`BotPrompt`) under the occurrence's key, a wake-up with the origin label `wake-up <name>` and
  a catch-up line of its own, and a schedule a Bot added itself (`made_call`) with `schedule
  <name> by <bot>`, by the Bot's name then. Each pass considers the Bots first (`bots::consider`), so an
  occurrence due as a Bot pauses is skipped, and then forgets wake-ups done a week ago
  (`Store::prune_wake_ups`).
- `projects.rs`, `store/projects.rs` (WVE-189, ADR 0031): the person's Projects, the seventh
  migration's `projects` and `project_locations`, behind the `projects` feature its hello names
  (`api::features`). A location's Host must have joined (a foreign key, so `remove_host` takes
  its locations, and touches their Projects' `updatedAt`); one per Project and Host, one Project
  per Host and path. Each change checks names (unique ignoring case, folded in Rust), kinds and
  remotes in the transaction that makes it (`ProjectError::Refused` is invalid params). The client
  says where a directory lies in git, from its Host; the Dispatcher never reads a Host's
  directories, and Hosts' own connections never reach `projects/*` (WVE-208).
- `bots.rs`, `store/bots.rs` (WVE-118, ADR 0028 as WVE-118 and WVE-178 settled it): the
  person's Bots, behind the `bots` feature. A Bot names one Host, a foreign key, so
  `remove_host` takes it, and a home there. `add_bot` (WVE-178, feature `bots_home`) checks the
  name (`Store::free_bot_name`) and the rest of the request first, then has the Host's link ask
  `repos/init` (`make_home`, with `bots/home.rs`: `default_home`, `~/bots/<name>`, and
  `request`, the first `AGENTS.md`, its job under "## Your job", and `CLAUDE.md`), refusing with
  `host_unavailable` while the link is away and invalid params for a Host without `repos_init`,
  and writes the Bot down only once that answers, with the home as the Host gave it; the
  Dispatcher never reads a Host's files itself. `created_by` names the Bot that made one, which
  only the tools pass (and `Dispatcher::add_bot_made_by`, for tests): such an add is refused at
  `MOST_BOTS` (20), checked before the home is made and again in the store's transaction. Names
  are checked in the transaction that changes them too (`BotError::Refused` is invalid
  params). A Bot's avatar (WVE-223, feature `bots_avatar`) is an `emoji`, checked by
  `emoji_given` to be no word and no longer than `MAX_BOT_EMOJI`, and a `BotColor`, each set and
  cleared alone by `bots/add` and `bots/update`. A prompt for a Bot is a `Work::Bot` delivery with `bot_id`, from `bots/send` (keyed
  `bot/<id>/send/<key>`, hashed past `MAX_KEY`) or a Bot's schedule, settled at its first send
  (`settle`): `link::into_thread` for its current thread, or `thread/run` in its home with its
  `labels` (`dispatcher`, `bot:<id>`), held while another prompt starts its first thread
  (`Store::bot_starting`) or the Bot starts a new one. The Host's answer to a Bot's `thread/run`
  with no thread makes that thread the Bot's, its first or its new one (`answered`, in
  `Store::delivered`'s transaction). `advance`, from the Host's link, notes when a Bot's thread
  starts and stops waiting on the person (`waiting_since`; stopping clears `paused`), begins a
  daily new thread `consider` marked due (`new_thread_due`) once `threads/get` shows a turn since
  the thread's first (`first_turn`), and takes a new thread's next `Step`: `Waiting` until the
  watch has the thread idle, `Saving` until the save turn is over (`ended`, into
  continuations), `Starting` until the Host answers, `Naming` (`thread/setSuccessor`). Each step
  is written with the delivery it sends in one transaction (`step_new_thread`), under
  `bot/<id>/new-thread/<n>/save` and `…/start`, so restarts repeat nothing; a refused start
  leaves the Bot its thread (`refused`). `consider`, from the scheduler, pauses a Bot whose
  thread has waited longer than `pause_after` and marks a daily new thread due, a missed day
  once, by the scheduler's clock. A Bot's state is the link's watch (`Seen`), never stored.
  `bots/watch.rs` (WVE-178, feature `bots_watch`): the API connections watching the Bots
  (`Watchers`). Whatever may change how a Bot lists (the API, a link, the scheduler) calls
  `Shared::bots_changed`, which lists the Bots again and tells each watcher `bots/updated` for
  those that differ from what was last told and `bots/removed` for those gone; one record of what
  was told serves every watcher, and a new watcher is answered under the same lock, so none misses
  a change or hears one twice. Take no lock of the links' before calling it, as it reads them.
- `tools.rs` (WVE-171): the Dispatcher's own service tools, a Bot's, declared on every link
  (`tools`, in the order agents see them) and answered (`answer`, `respond`) only for a Bot's own
  thread on its Host (`own_bot`: its current thread, one it had, or the new one starting), with a
  tool error in words for the agent otherwise; each tool's description begins with `ONLY`, and
  API errors reach the agent as sentences (`sentence`). Each module gives its `NAMES`, its
  `tools()` and what only a Bot's thread `CAN` do with them:
  - `tools/wakeups.rs` (WVE-118): `wake_me`, `list_wakeups` and `cancel_wakeup`. A wake-up is a
    one-off schedule naming the Bot, with `wake_call` the Host's id for the call, unique per Bot
    so a call sent again makes one; at least a minute away (`SOONEST`), and at most 20 to come
    (`MOST`, counted in `add_wake_up`'s transaction). One due while its Bot is paused is skipped
    like any of the Bot's occurrences, and lost.
  - `tools/schedules.rs` (WVE-178): `add_schedule`, `list_schedules`, `pause_schedule`,
    `resume_schedule` and `remove_schedule`, over the schedules naming the calling Bot, the
    person's too, wake-ups aside (`own_schedule` refuses those, and anything not the Bot's).
    `add` checks a schedule as `schedules/add` does (`Shared::new_schedule`), in the Bot's zone
    unless it names one, refuses one coming more often than every five minutes (`too_often` over
    `LOOKED_AT` next times, `OFTENEST`), and writes it with `made_call` in
    `Store::add_bot_schedule`'s transaction, which answers with the one the same call added before
    (`BotSchedule::Again`) and refuses at 20 schedules naming the Bot, wake-ups aside (`MOST`,
    `BotSchedule::Full`).
  - `tools/bots.rs` (WVE-178): `create_bot`, which adds a Bot through `Shared::add_bot` with the
    caller as its maker, `~/bots/<name>` and its job, and the caller's agent, Host and zone unless
    it names others, and answers with what it made, what making its home did and what to tell the
    person (`next`); `list_bots`; and `set_avatar` (WVE-223), the caller's own emoji and colour
    through `Shared::update_bot`, absent to keep and `null` to clear. Nothing here lets a Bot
    prompt or schedule another, so one a Bot makes does nothing until the person prompts it. A call the Host sends again isn't
    recognised: it's refused, the name being taken.
- `store/schedules.rs`: `schedules` and `occurrences`. An occurrence and its delivery are
  written in one transaction, unique on schedule, scheduled time and `manual`; delivering it,
  the Host refusing it and its turn ending update it from `store.rs` and `link.rs`. The same
  transaction skips a Bot's occurrence while the Bot is paused, unless it's run by hand. A
  Bot's wake-ups to come (`TO_COME`: its time not yet considered, no occurrence but by hand)
  are counted, listed and cancelled here, and forgotten a week after their time once over; a
  Bot's own schedules are counted and written once per call here (`add_bot_schedule`). The
  `made_call` mark is the Dispatcher's own: the wire's `Schedule` doesn't carry it.
- `calls.rs` (WVE-185, ADR 0029): the Host tool calls naming another Host that a Host passes it
  (`HostEvent::HostCall`, since each link declares `hosts`), answered with `service/answerTool`.
  Reads and steers go straight to the named Host while its link is connected; `thread/run` and
  `queue/add` are deliveries with a `calls` row, under a key hashed from the calling Host, thread
  and the agent's key, sent at once (`begin`), and if the answer is lost, sent again by the named
  Host's link, the caller told then (`settled`). It checks one hop from the caller's listing,
  narrows the policy and counts `room` against `Store::delegated_running`.
- `follows.rs`: the turns calls began, checked when their thread goes idle or waits and when
  the link connects (`link::look`), into continuations, and reported to the caller as
  `Work::Report` deliveries in the Host's words (`weave_host_protocol::reports`).
- `api.rs`, `client.rs`, `socket.rs`: the Dispatcher's own API (`weave_host_protocol::dispatcher`)
  over a Unix socket in its directory (0600, peer uid checked, one Dispatcher per directory by
  its lock), and the CLI's end of it. One `Connection` answers both the socket (`Peer::Local`)
  and the WebSocket (`Peer::Remote`): a remote client signs its `dispatcher/challenge` at hello
  (`dispatcher_auth_message`) or pairs with a code, and may ask everything but `devices/*` and
  `hosts/offer` with `here` (`local_first`, `forbidden`). A Host's own connection asks for
  `weave-dispatcher-host` and goes to `joins.rs` instead. Its hello's features are
  `api::features`: `projects`, `bots`, `bots_home`, `bots_watch` and `bots_avatar`. `bots/watch` and
  `bots/unwatch` are answered there, and a connection that ends stops watching; `client.rs` hears
  the changes (`DispatcherConnection::bot_change`, `BotChange`).
- `carry.rs` (WVE-195, ADR 0030): the person's devices' connections carried to their Hosts. A
  device asks on the WebSocket with `weave-dispatcher-carry` (`device`: its challenge, hello and
  `hosts/open`, read with `weave_remote::preamble`), or on the socket after a hello there, which
  `api::local` answers itself to see what follows it (`carry::local`, one line a message, the
  device `local` named after the computer). `open` asks the Host's link `dispatcher/carry` with a
  token (`Carries::expect`, which keeps the Host it's for) and waits for the Host's own
  connection: `joins.rs` answers its `hosts/carry` with the Dispatcher's signature of the Host's
  nonce (`carry_message`), which proves its key there, and hands it over (`Carries::arrive`); a Host the link isn't connected to answers
  `host_unavailable` with `hosts/list`'s status and why. `splice` passes frames between the two
  `Side`s unread: a writer per side with its own pings, a bounded channel each way so a side is
  read no faster than the other takes it, and either side's close passed on, after what it sent
  before it. Each carried connection is in `Carries::live` by Host, which `remove_host` and a
  Host leaving close (`close_host`), and among its device's connections in `Devices`, so revoking
  closes it with `CLOSE_REVOKED`.
- `devices.rs`, `store/devices.rs` (WVE-176): the person's devices paired with it, the only
  program they pair with since Hosts stopped taking them (WVE-197), which `weave pair` and `weave
  devices` manage on its computer: offers and live connections in memory
  (`weave_remote::pairing`), the devices and the
  Dispatcher's own id (`identity`) in SQLite. The WebSocket is `weave-remote`'s, turned on by
  `devices/offer` and `hosts/offer` and kept on while a device is paired or a Host joined over
  it (`DispatcherConfig::remote`, loopback 7342 with its own Tailscale Serve entry as `weave
  dispatcher run` sets it, or where its `--listen` and `--url` say, a URL leaving Serve alone,
  as the app's dev Dispatcher has it; none in tests unless they give a fake Serve), and off with
  the last revoke or removal (`api::stop_if_unused`). It asks for `weave-dispatcher`, so a
  client asking for anything else fails at the upgrade.

Work reaches a Host through a **delivery** only: written to SQLite first, under a request key
(its own, or `dispatcher/<delivery id>`), then sent, and sent again on each connection until
the Host answers. An answer records it `delivered`; an error that may go otherwise later (the
Host stopping, or an internal error, which a lost connection gives) leaves it `pending`; any
other error records it `failed` with the Host's message. The Host's request keys make the
repeats safe, which `tests/dispatcher.rs` checks across a Host restart and the Dispatcher's own.

Its key (`key.json`) is `DeviceKey::kept`, in the Secure Enclave
on a Mac that has one, otherwise in the file (0600). It proves it to Hosts at `host/hello`, and
they learn it when they join.

Tests: in-process Hosts join the Dispatcher over its `hosts.sock`, each through a Unix-socket
relay that a restart cuts, as a Host process exiting closes its connections (`tests/common`).
`tests/devices.rs` pairs devices over a loopback WebSocket with a fake Serve, and checks
what proves a device and what doesn't, what a device may ask, revoking, the Serve entry, and the
WebSocket's subprotocol and `Origin` checks, hello deadline and pings, which moved here from the
Host's tests when the Host stopped listening (WVE-197).
`tests/projects.rs` runs a Project's life through the socket and through a paired device, and
checks a Host's removal and a restart. `tests/bots.rs` runs a Bot's life the same two ways, on a
clock the test moves (`TestClock`), with the fake agent: its first prompt starting its thread
and the rest following it, its state, a new thread asked for and daily, across Dispatcher
restarts at each step (the relay deafened to lose the Host's answers) and a Host restart,
pausing while its thread waits on the person, one-offs, and wake-ups its agent asks for, lists
and cancels with the Dispatcher's tools; and (WVE-178) its Host making its home, `bots/watch`,
`schedules/list` for a Bot, a Bot making another (`create_bot`, and the cap of 20), a Bot adding
and managing its own schedules within their limits, and every new tool refusing a thread that
isn't a Bot's; and (WVE-223) a Bot's avatar, from the person and from the Bot's `set_avatar`. Its Hosts run git away from the configuration of whoever runs the tests
(`common::ISOLATED_GIT`).
`tests/hosts.rs` runs two or three Hosts whose fake agents call Host tools naming each
other, the relay deafened to lose an answer, and name Projects the test adds directly
(WVE-208). `tests/carry.rs` has a paired device reach two
Hosts through the Dispatcher, a Host serve nothing where something without the Dispatcher's key
answers at its address, a terminal's stream through a fake owner that echoes
(`EchoingOwner`), a client on its socket, what a carried device may not ask a Host, and a replay
many times a Host's backlog limit (`World::with_websocket`) reaching a device whole. `tests/dispatcher.rs` drives the Dispatcher through
its socket across Host and Dispatcher restarts. `tests/joins.rs` checks joining: a code once,
keys both ways, removal, a Host paired before Hosts joined, and one joining over the WebSocket.
