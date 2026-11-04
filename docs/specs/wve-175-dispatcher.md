# WVE-175: The Dispatcher

Status: implemented 2026-11-03, with `install` and `status` checked live as a launchd service on
macOS and a systemd user service on Debian 13, each restarting a Dispatcher that was killed.
Schedules (WVE-145) since 2026-11-04. The decisions are in
[ADR 0027](../adr/0027-the-dispatcher-starts-work-on-the-persons-hosts-as-a-client-of-them.md);
Bots, which it will keep, in
[ADR 0028](../adr/0028-bots-are-dispatcher-records-whose-work-goes-on-in-ordinary-threads.md).

## Purpose

The Dispatcher (`weave dispatcher`) keeps triggers and Bots and starts their work on the
person's Hosts. This is its core: its state, its key, the Hosts it pairs with as a service and
its connection to each, the one path work takes to a Host, and schedules (WVE-145). Webhooks
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
| `dispatcher.db` | SQLite (WAL), 0600: `hosts`, `deliveries`, `schedules` and `occurrences`; later issues add other triggers and Bots |
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

Schedules make deliveries ([Schedules](#schedules)); so may the Dispatcher's library.

A delivery may also be a prompt for a thread: the first time it's sent it becomes
`queue/add` if the Dispatcher last saw the thread open, so it waits for whatever runs there,
and otherwise `session/run` with its `sessionId`, which opens it. A thread the Dispatcher saw
name a successor (`continuedIn`, WVE-168) is prompted in the last of its successors instead.
That choice is written down before it's sent, so a repeat asks the same request under its key
(`key_reused` otherwise).

## Schedules

A schedule (WVE-145, a trigger, ADR 0027) starts a headless turn on one of the person's Hosts
at the times its cron expression gives, with nobody there. It names:

- `cron`: five fields, minute, hour, day of month, month, day of week, such as `0 9 * * 1-5`,
  or `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`; seconds and years are refused, so
  nothing runs more than once a minute. croner reads it.
- `zone`: an IANA time zone, by default the one of the Dispatcher's computer. A time in an hour
  a clock change skips runs at the first valid moment after it; one in an hour it repeats runs
  once, the first time, as GitHub Actions has it.
- the Host, by id or name, which a rule may replace when the Dispatcher chooses Hosts;
- what each occurrence starts: `agentId`, `cwd` on that Host (`~/` there allowed), `prompt`,
  `policy` and `mode`, and `thread`, a thread each occurrence prompts instead of starting one;
- `missed`: `latest` (the default) or `skip`;
- `overlap`: `skip` (the default) or `allow`, which only a schedule that starts a thread may.

### Occurrences

Each occurrence is written down in `occurrences`, keyed on its schedule and its **scheduled**
time, with the delivery that starts it in the same transaction. The delivery's request key is
`schedule/<schedule id>/<scheduled time>` (`schedule/<id>/run/<time>` for one run by hand),
and its turn's origin is the schedule's: `{"service": {"name": <the Dispatcher's>, "label":
"schedule <name>", "id": <occurrence id>}}` ([Service origins](wve-85-host-protocol.md#service-origins)).
So however often the Dispatcher considers a time, and across its restarts and the Host's,
an occurrence starts once.

A thread a schedule starts is labelled `dispatcher` and `schedule:<id>` (WVE-173), so clients
can find or set aside the Dispatcher's threads; a thread a schedule prompts keeps its own labels.

An occurrence is `skipped` (with why), `waiting` (written down, its Host hasn't taken it,
as while it's unreachable), `started`, `finished` (with its turn's `outcome`, and its error),
or `failed` (its Host refused it, saying why). The Dispatcher reads how a started turn ended
when the thread it watches goes idle or closes, with `sessions/get` and the turn's id, and
again on each connection. A turn its Host stopped under that the thread continued
(`continuedIn`, WVE-168) is followed into the continuation, whose id the occurrence takes and
whose outcome it ends with.

The scheduler wakes when the next occurrence of any schedule is due, when schedules change,
and at least every 30 seconds by the wall clock, so a computer waking from sleep finds what
came due. Each time it considers every schedule that isn't paused, from where it last did:

- **Missed times.** Of the times due since then, within a week, the latest starts; one
  that's more than a minute late is a **catch-up**, whose prompt begins with a line telling
  the agent so: "This turn is the schedule daily-review's, due at Sat 7 Nov 09:00 UTC and
  started late, at Sat 7 Nov 10:00 UTC, because the Dispatcher couldn't start it on time."
  The ones before it are written down as one skipped occurrence that says how many were
  missed and over what span. With `missed: skip`, a late one is skipped too.
- **Overlap.** While the schedule's previous occurrence is waiting or started, a new one is
  skipped, "its previous occurrence was still waiting or running", unless `overlap: allow`.
- **Pausing.** Three failed or interrupted occurrences in a row (a refused delivery counts)
  pause the schedule, saying why; a turn that fails because the agent's login expired (ACP's
  `auth_required`) pauses it at once. Any other ending clears the count. Resuming starts from
  then: nothing missed while paused catches up.

Not yet: agents creating schedules, through tools the Dispatcher serves under the calling
thread's policy (WVE-173); a per-schedule hourly cap, which matters once they can; changing a
schedule in place (remove it and add it again).

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

**`schedules/list`** `{}` → `{schedules: Schedule[]}`

```ts
type Schedule = {
  id: string; name: string; cron: string; zone: string;
  hostId: string; hostName: string;
  agentId: string; cwd: string; prompt: ContentBlock[]; policy: PermissionPolicy;
  mode?: string; thread?: string;
  missed: "latest" | "skip"; overlap: "skip" | "allow";
  createdAt: number;
  paused?: string;       // why
  failures: number;      // failed or interrupted occurrences in a row
  nextAt?: number;       // unless paused
  next?: string;         // nextAt in its zone: "Wed 4 Nov 09:00 SAST"
  last?: Occurrence;
};
type Occurrence = {
  id: string; scheduleId: string;
  scheduledAt: number;   // when it was due, or run by hand
  late?: true; manual?: true;
  state: "skipped" | "waiting" | "started" | "finished" | "failed";
  outcome?: TurnState;   // finished ones
  why?: string;          // why skipped or failed, or the turn's error
  sessionId?: string; turnId?: string;
  recordedAt: number; endedAt?: number;
};
```

**`schedules/add`** `{name, cron, zone?, host, agentId, cwd, prompt, policy, mode?, thread?,
missed?, overlap?}` → `{schedule}`

Invalid params, saying why, for an empty name or prompt, a name taken, a cron expression or
zone that doesn't parse, a Host it isn't paired with, or `overlap: allow` with a thread. It
first considers times after it's added.

**`schedules/remove`** `{schedule}` → `{}`, **`schedules/pause`** `{schedule}` → `{schedule}`,
**`schedules/resume`** `{schedule}` → `{schedule}`

By id or name. Removing forgets its occurrences; a turn it started runs on.

**`schedules/run`** `{schedule}` → `{occurrence}`

Runs it now, paused or not, as an occurrence of its own (`manual`), which overlap may skip.

**`occurrences/list`** `{schedule?, limit?}` → `{occurrences: Occurrence[]}`

Newest first, 50 by default.

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
| `weave dispatcher schedules [list] [--json]` | the schedules, when each runs next and how it last went |
| `weave dispatcher schedules add <name> --cron <expr> --host <host> --agent <id> [--cwd] [--zone] [--thread \| --mode] [--approve <kinds>] [--missed latest\|skip] [--allow-overlap] -- <prompt>` | adds one; `--cwd` is this directory when omitted, `--approve` is `weave run`'s, and the prompt is read from stdin when omitted |
| `weave dispatcher schedules remove \| pause \| resume \| run <schedule>` | as the API's methods |
| `weave dispatcher occurrences [<schedule>] [--limit] [--json]` | what they did, newest first |

## Acceptance

- `tests/dispatcher.rs`: two in-process Hosts behind relays; the Dispatcher pairs with both
  through its socket and each lists it as a service; it starts a headless turn on each; one
  Host restarts and the Dispatcher connects again and delivers there; the Dispatcher stops
  between a Host taking a delivery and recording it, and started again it sends it again and
  the Host starts nothing twice. A Host that revokes it is refused across a restart, work
  waits for it, and pairing again delivers it.
- `install` and `status` on macOS and Linux.
- `tests/schedules.rs`, on a clock the test moves: a schedule starts a turn at its time with
  its origin, and by hand; an occurrence written down while its Host is down starts once after
  a Dispatcher restart and the Host coming back; missed times catch up once, late, and are
  skipped with `missed: skip`; an occurrence while the last still runs is skipped; a schedule
  that names a thread queues there; three failures in a row pause a schedule, which resumes
  from then on.

## Later

- Webhooks (WVE-146) make deliveries as schedules do; the edge (WVE-117) holds webhook
  deliveries and pushes for it.
- Paired devices (WVE-176) reach this API over a WebSocket of its own, with keys as a Host's
  devices have.
- Tools a service declares (WVE-173), labels (WVE-171) and Bots (WVE-118).
- Choosing the Host a piece of work runs on, which a delivery's Host can become a rule for.
