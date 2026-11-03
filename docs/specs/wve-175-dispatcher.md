# WVE-175: The Dispatcher

Status: implemented 2026-11-03, with `install` and `status` checked live as a launchd service on
macOS and a systemd user service on Debian 13, each restarting a Dispatcher that was killed.
The decisions are in
[ADR 0027](../adr/0027-the-dispatcher-starts-work-on-the-persons-hosts-as-a-client-of-them.md);
Bots, which it will keep, in
[ADR 0028](../adr/0028-bots-are-dispatcher-records-whose-work-goes-on-in-ordinary-threads.md).

## Purpose

The Dispatcher (`weave dispatcher`) keeps triggers and Bots and starts their work on the
person's Hosts. This is its core: its state, its key, the Hosts it pairs with as a service and
its connection to each, and the one path work takes to a Host. Schedules (WVE-145), webhooks
(WVE-146), Bots (WVE-118) and paired devices (WVE-176) build on it.

## Decisions

- **A client of each Host, paired as a service.** It pairs with a Host as a device does, saying
  `device.service: true` ([Services](wve-90-remote-clients.md#services)), proves its own key at
  every hello, and may do only what starting and following threads needs. It is never a peer
  and never a Host; it runs no agents.
- **Hosts never connect to it.** It connects to each Host and keeps the connection up. A Host
  works on, unchanged, while it's away.
- **One path for work: a delivery,** written down before it is sent and sent until the Host
  takes it, under a request key, so it starts once.
- **Its state is SQLite**, in a directory of its own.
- **It runs anywhere in the tailnet**, as a service of launchd or systemd, beside a Host or on a
  computer of its own.

## Its directory

`$WEAVE_DISPATCHER_DIR`, or else `$XDG_STATE_HOME/weave/dispatcher`, by default
`~/.local/state/weave/dispatcher`, mode 0700:

| File | What it holds |
| --- | --- |
| `dispatcher.db` | SQLite (WAL), 0600: `hosts` and `deliveries`; later issues add triggers, occurrences and Bots |
| `key.json` | its key, 0600: the Secure Enclave's wrapped form of it on a Mac that has one, otherwise the key itself, as a Host keeps `host-key.json` |
| `dispatcher.sock` | its API, 0600 |
| `dispatcher.lock` | held while a Dispatcher runs from the directory, so only one does |
| `dispatcher.log` | its service's diagnostics |

The database's version is `PRAGMA user_version`: each migration takes it one further, in a
transaction, and none changes once released.

## Hosts

`weave dispatcher add-host studio` runs `weave pair --json` on studio over SSH, as `weave hosts
add` does, and asks the Dispatcher to pair with the URL and code it gave; `weave dispatcher
add-host <url> <code>` pairs with the ones `weave pair` showed there. The Dispatcher pairs as
"Dispatcher on <its computer>", and keeps the Host's id, its name (the computer's, or its
tailnet name), its URL, the device id the Host gave it and when.

It then keeps a connection to each Host: it connects, says hello with its key as
`weave-dispatcher`, watches the Host's threads (`sessions/watch`), and sends the Host the work
waiting for it. When the connection fails or closes it tries again after 1 second, doubling to
a minute. A Host that refuses its key, or revokes it while connected (`CLOSE_REVOKED`), is
recorded as refused, with why, and not tried again, across restarts, until `add-host` pairs
with it again, which `weave devices revoke` there and a new code make the way back.

`weave dispatcher remove-host <id or name>` forgets a Host and the work waiting for it; the
Host lists the Dispatcher among its devices until it's revoked there.

## Deliveries

A delivery is a request for one Host, `session/run` or `queue/add`, written to the database
before it is sent:

- it goes under the request's own key, which a trigger makes from itself and the occurrence's
  scheduled time, or else `dispatcher/<delivery id>`;
- it is sent when written, if the Host is connected, and on every connection after, oldest
  first, until the Host answers;
- the Host's answer records it `delivered`, with the answer;
- an error the Host may answer otherwise later, `host_stopping` or an internal error (as a
  connection lost mid-request gives), leaves it pending for the next connection;
- any other error records it `failed`, with the Host's message, and it isn't sent again.

The Host's request keys make every repeat safe: after a dropped connection, a Host restart,
or the Dispatcher stopping between the Host taking a delivery and the Dispatcher writing that
down, sending it again answers with the thread and turn it started the first time.

In this issue only the Dispatcher's library makes deliveries; schedules (WVE-145) are the first
to make them.

## Its API

JSON-RPC 2.0 over its Unix socket, one message per line, as the Host's socket carries the Host
protocol; types in `weave_host_protocol::dispatcher`. Only the socket owner's user is served.
Every connection says hello first; anything else before it answers `unauthenticated`.

**`dispatcher/hello`** `{protocol: 1, client: {name, version}}` → `{protocol, version}`

Another `protocol` answers `incompatible_protocol`.

**`dispatcher/status`** `{}` → `{version, pid, startedAt, name, database, pending}`

`name` is what it pairs with Hosts as; `pending` is the work waiting for any Host.

**`hosts/list`** `{}` → `{hosts: DispatcherHost[]}`

```ts
type DispatcherHost = {
  hostId: string; name: string; url: string;
  deviceId: string;          // what the Host knows the Dispatcher as
  pairedAt: number;
  connected: boolean;
  status: PeerStatus;        // as peers/list has it: reachable, unchecked, refused, down, unreachable, otherHost
  why?: string;              // why the last attempt failed, or why it refused the Dispatcher
  connectedAt?: number;
  pending: number;           // work waiting for it
};
```

**`hosts/add`** `{url, code, name?}` → `{host: DispatcherHost}`

Pairs as a service and starts the connection. A Host that can't be reached, refuses the code
or doesn't take the Dispatcher as a service answers `peer_unavailable` (-32081), saying why.

**`hosts/remove`** `{host}` → `{}`

By id or name; invalid params when it pairs with no such Host.

## The CLI

| Command | What it does |
| --- | --- |
| `weave dispatcher run` | runs it here until SIGTERM or SIGINT; its stderr is its log |
| `weave dispatcher install` | has launchd (`local.weave.dispatcher`) or systemd (`weave-dispatcher.service`) run `weave dispatcher run` from login or boot and restart it, then waits for it to answer; on Linux it turns lingering on as `weave daemon install` does. A Dispatcher directory of its own (`WEAVE_DISPATCHER_DIR`, which the service is given) gets a service of its own, named after it. launchd won't start a weave in `~/Documents`, `~/Desktop` or `~/Downloads`, and a process it starts can't use a removable volume without the person's leave, so install from a copy elsewhere, such as `~/.local/bin/weave`. |
| `weave dispatcher uninstall` | stops the service and removes it |
| `weave dispatcher status [--json]` | its version, pid, uptime, name and waiting work, and its Hosts |
| `weave dispatcher add-host <computer \| url code> [--name] [--json]` | pairs it with a Host |
| `weave dispatcher hosts [--json]` | its Hosts, and how it reaches each |
| `weave dispatcher remove-host <host>` | forgets one |

## Acceptance

- `tests/dispatcher.rs`: two in-process Hosts behind relays; the Dispatcher pairs with both
  through its socket and each lists it as a service; it starts a headless turn on each; one
  Host restarts and the Dispatcher connects again and delivers there; the Dispatcher stops
  between a Host taking a delivery and recording it, and started again it sends it again and
  the Host starts nothing twice. A Host that revokes it is refused across a restart, work
  waits for it, and pairing again delivers it.
- `install` and `status` on macOS and Linux.

## Later

- Schedules (WVE-145) and webhooks (WVE-146) make deliveries; the edge (WVE-117) holds webhook
  deliveries and pushes for it.
- Paired devices (WVE-176) reach this API over a WebSocket of its own, with keys as a Host's
  devices have.
- Tools a service declares (WVE-173), labels (WVE-171) and Bots (WVE-118).
- Choosing the Host a piece of work runs on, which a delivery's Host can become a rule for.
