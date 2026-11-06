# The Dispatcher

`weave-dispatcher` is the Dispatcher (ADR 0027, WVE-175; spec
`docs/specs/wve-175-dispatcher.md`): the person's program, apart from their Hosts, that keeps
triggers and Bots and starts their work on the Hosts. The `weave dispatcher` subcommands in
`cli/src/commands/dispatcher.rs` run, start, stop and install it as a service, and `weave hosts`
and `weave schedules` ask it over its socket, or from another computer paired with it over its
WebSocket (`cli/src/dispatcher.rs`, `cli/src/paired.rs`; WVE-176).

It is a client of each Host over the Host protocol, paired with it as a **service**
(`NewDevice.service`), so a Host lets it do only what starting and following threads needs
(`FOR_SERVICES` in `host/src/client.rs`). It is never a Host: it runs no agents,
and Hosts never connect to it and work on without it. Keep it that way. It depends on
`weave-host-client`, `weave-host-protocol` and `weave-remote`, never on `weave-host`, so it can run
on a computer of its own; `weave-host` is only a dev-dependency, for the tests' in-process Hosts.

- `lib.rs`: `Dispatcher`, opened from its directory (`DispatcherPaths`: `$WEAVE_DISPATCHER_DIR`
  or `~/.local/state/weave/dispatcher`), and what the API does: pairing (`add_host`, which pairs
  over a Host's WebSocket with `Credentials::Pair { service: true }`), listing and forgetting
  Hosts, and `deliver`.
- `store.rs`: its state in SQLite (`rusqlite`, bundled): `hosts` and `deliveries`, and in
  `store/calls.rs` the `calls` from Hosts' agents and the turns they began (`follows`). Migrations are
  numbered SQL in `MIGRATIONS`, applied in order and recorded in `PRAGMA user_version`; never
  edit one once released, add the next. Times are milliseconds, kept signed.
- `link.rs`: one task per Host that keeps a connection to it with backoff (`retry` doubling to
  `retry_most`), watches its threads (`sessions/watch`) and sends it its pending deliveries,
  oldest first, settling a thread's prompt (`Work::Prompt`) into `queue/add` or `session/run`
  before its first send (in the last of the thread's successors, WVE-168), and reads with
  `sessions/get` how started occurrences' turns ended when their threads go idle, following an
  interrupted turn into its continuation (`continuedIn`). A Host that refuses the Dispatcher's key, or closes with `CLOSE_REVOKED`, is
  recorded as refused in `hosts.refused` and not tried again until `hosts/add` pairs with it
  again.
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
  Reads and steers go straight to the named Host while its link is connected; `session/run` and
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
  (`dispatcher_auth_message`) or pairs with a code, and may ask everything but `devices/*`
  (`local_first`, `forbidden`).
- `devices.rs`, `store/devices.rs` (WVE-176): the person's devices paired with it, as with a
  Host: offers and live connections in memory (`weave_remote::pairing`), the devices and the
  Dispatcher's own id (`identity`) in SQLite. The WebSocket is `weave-remote`'s, turned on by
  `devices/offer` and kept on while a device is paired (`DispatcherConfig::remote`, loopback
  7342 with its own Tailscale Serve entry as `weave dispatcher run` sets it; none in tests unless
  they give a fake Serve), and off with the last revoke. It asks for `weave-dispatcher`, so a
  client pointed at a Host fails at the upgrade.

Work reaches a Host through a **delivery** only: written to SQLite first, under a request key
(its own, or `dispatcher/<delivery id>`), then sent, and sent again on each connection until
the Host answers. An answer records it `delivered`; an error that may go otherwise later (the
Host stopping, or an internal error, which a lost connection gives) leaves it `pending`; any
other error records it `failed` with the Host's message. The Host's request keys make the
repeats safe, which `tests/dispatcher.rs` checks across a Host restart and the Dispatcher's own.

Its key (`key.json`) is `DeviceKey::kept`, in the Secure Enclave
on a Mac that has one, otherwise in the file (0600).

Tests: `tests/devices.rs` pairs devices over a loopback WebSocket with a fake Serve, and checks
what proves a device and what doesn't, what a device may ask, revoking, and the Serve entry.
`tests/hosts.rs` runs two or three Hosts whose fake agents call Host tools naming each
other, the relay deafened to lose an answer. `tests/dispatcher.rs` runs in-process Hosts behind a TCP relay that a restart cuts, as a
Host process exiting closes its connections, and drives the Dispatcher through its socket.
