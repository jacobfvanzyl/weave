# The Dispatcher

`weave-dispatcher` is the Dispatcher (ADR 0027, WVE-175; spec
`docs/specs/wve-175-dispatcher.md`): the person's program, apart from their Hosts, that keeps
triggers and Bots and starts their work on the Hosts. The `weave dispatcher` subcommands in
`cli/src/commands/dispatcher.rs` run, start, stop and install it as a service, and `weave hosts`
and `weave schedules` ask it over its socket, or from another computer paired with it over its
WebSocket (`cli/src/dispatcher.rs`, `cli/src/paired.rs`; WVE-176).

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
  edit one once released, add the next. The sixth (WVE-200) renamed the `session_id` columns to
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
  `unjoined` until it joins.
- `scheduler.rs` (WVE-145): the task that considers every schedule when one is due, when they
  change, and every 30 seconds of wall clock at most (`Clock`; tests pass one they move), and
  `Plan`, a schedule's croner expression in its jiff time zone. Catch-ups, the one-week look-back
  and the minute's grace are here; overlap and pausing are in the store, inside the
  transaction that writes an occurrence down. A thread an occurrence starts is labelled
  `dispatcher` (`LABEL`) and `schedule:<id>` (WVE-173).
- `store/schedules.rs`: `schedules` and `occurrences`. An occurrence and its delivery are
  written in one transaction, unique on schedule, scheduled time and `manual`; delivering it,
  the Host refusing it and its turn ending update it from `store.rs` and `link.rs`.
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
  `weave-dispatcher-host` and goes to `joins.rs` instead.
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
- `devices.rs`, `store/devices.rs` (WVE-176): the person's devices paired with it, as with a
  Host: offers and live connections in memory (`weave_remote::pairing`), the devices and the
  Dispatcher's own id (`identity`) in SQLite. The WebSocket is `weave-remote`'s, turned on by
  `devices/offer` and `hosts/offer` and kept on while a device is paired or a Host joined over
  it (`DispatcherConfig::remote`, loopback 7342 with its own Tailscale Serve entry as `weave
  dispatcher run` sets it, or where its `--listen` and `--url` say, a URL leaving Serve alone,
  as the app's dev Dispatcher has it; none in tests unless they give a fake Serve), and off with
  the last revoke or removal (`api::stop_if_unused`). It asks for `weave-dispatcher`, so a
  client pointed at a Host fails at the upgrade.

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
what proves a device and what doesn't, what a device may ask, revoking, and the Serve entry.
`tests/hosts.rs` runs two or three Hosts whose fake agents call Host tools naming each
other, the relay deafened to lose an answer. `tests/carry.rs` has a paired device reach two
Hosts through the Dispatcher, a Host serve nothing where something without the Dispatcher's key
answers at its address, a terminal's stream through a fake owner that echoes
(`EchoingOwner`), and a client on its socket. `tests/dispatcher.rs` drives the Dispatcher through
its socket across Host and Dispatcher restarts. `tests/joins.rs` checks joining: a code once,
keys both ways, removal, a Host paired before Hosts joined, and one joining over the WebSocket.
