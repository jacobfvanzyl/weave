# The Dispatcher

`weave-dispatcher` is the Dispatcher (ADR 0027, WVE-175; spec
`docs/specs/wve-175-dispatcher.md`): the person's program, apart from their Hosts, that keeps
triggers and Bots and starts their work on the Hosts. The `weave dispatcher` subcommands in
`cli/src/dispatcher.rs` run it, install it as a service and ask it over its socket.

It is a client of each Host over the Host protocol, paired with it as a **service**
(`NewDevice.service`), so a Host lets it do only what starting and following threads needs
(`FOR_SERVICES` in `host/src/client.rs`). It is never a peer and never a Host: it runs no agents,
and Hosts never connect to it and work on without it. Keep it that way. It depends on
`weave-host-client` and `weave-host-protocol`, never on `weave-host`, so it can run on a computer
of its own; `weave-host` is only a dev-dependency, for the tests' in-process Hosts.

- `lib.rs`: `Dispatcher`, opened from its directory (`DispatcherPaths`: `$WEAVE_DISPATCHER_DIR`
  or `~/.local/state/weave/dispatcher`), and what the API does: pairing (`add_host`, which pairs
  over a Host's WebSocket with `Credentials::Pair { service: true }`), listing and forgetting
  Hosts, and `deliver`.
- `store.rs`: its state in SQLite (`rusqlite`, bundled): `hosts` and `deliveries`. Migrations are
  numbered SQL in `MIGRATIONS`, applied in order and recorded in `PRAGMA user_version`; never
  edit one once released, add the next. Times are milliseconds, kept signed.
- `link.rs`: one task per Host that keeps a connection to it with backoff (`retry` doubling to
  `retry_most`), watches its threads (`sessions/watch`) and sends it its pending deliveries,
  oldest first. A Host that refuses the Dispatcher's key, or closes with `CLOSE_REVOKED`, is
  recorded as refused in `hosts.refused` and not tried again until `hosts/add` pairs with it
  again.
- `api.rs`, `client.rs`, `socket.rs`: the Dispatcher's own API (`weave_host_protocol::dispatcher`)
  over a Unix socket in its directory (0600, peer uid checked, one Dispatcher per directory by
  its lock), and the CLI's end of it.

Work reaches a Host through a **delivery** only: written to SQLite first, under a request key
(its own, or `dispatcher/<delivery id>`), then sent, and sent again on each connection until
the Host answers. An answer records it `delivered`; an error that may go otherwise later (the
Host stopping, or an internal error, which a lost connection gives) leaves it `pending`; any
other error records it `failed` with the Host's message. The Host's request keys make the
repeats safe, which `tests/dispatcher.rs` checks across a Host restart and the Dispatcher's own.

Its key (`key.json`) is kept as a Host keeps its own: `DeviceKey::kept`, in the Secure Enclave
on a Mac that has one, otherwise in the file (0600).

Tests: `tests/dispatcher.rs` runs in-process Hosts behind a TCP relay that a restart cuts, as a
Host process exiting closes its connections, and drives the Dispatcher through its socket.
