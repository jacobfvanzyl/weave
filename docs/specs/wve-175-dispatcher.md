# WVE-175: The Dispatcher

Status: implemented 2026-11-03, with `install` and `status` checked live as a launchd service on
macOS and a systemd user service on Debian 13, each restarting a Dispatcher that was killed.
Schedules (WVE-145) since 2026-11-04, calls from Hosts' agents to the person's other Hosts
(WVE-185) since 2026-11-04, the person's devices pairing with it and reaching it over the
tailnet (WVE-176) since 2026-11-06, Hosts joining it and keeping a connection open to it
(WVE-194) since 2026-11-07, and the person's devices reaching every Host through it (WVE-195)
since 2026-11-08. The decisions are in
[ADR 0027](../adr/0027-the-dispatcher-starts-work-on-the-persons-hosts-as-a-client-of-them.md),
[ADR 0029](../adr/0029-agents-reach-the-persons-other-hosts-through-the-dispatcher.md) and
[ADR 0030](../adr/0030-the-dispatcher-is-the-hub-hosts-dial-out-to-it-and-devices-reach-every-host-through-it.md);
Bots, which it will keep, in
[ADR 0028](../adr/0028-bots-are-dispatcher-records-whose-work-goes-on-in-ordinary-threads.md).

## Purpose

The Dispatcher (`weave dispatcher`) keeps triggers and Bots and starts their work on the
person's Hosts. This is its core: its state, its key, the Hosts that join it and the connection
each keeps open to it, the one path work takes to a Host, schedules (WVE-145), and the calls a
Host's agents make to the person's other Hosts (WVE-185), and the person's devices, which pair
with it, reach its API over the tailnet (WVE-176) and reach every Host through it (WVE-195).
Webhooks (WVE-146) and Bots (WVE-118) build on it.

## Decisions

- **A client of each Host, as a service.** Over each Host's connection it says hello with its own
  key, and the Host lets it do only what starting and following threads needs
  ([Services](wve-90-remote-clients.md#services)). It is never a Host; it runs no agents.
- **Hosts connect to it** (ADR 0030). A Host joins it once and keeps a connection open to it,
  so only the Dispatcher needs an address; it never dials a Host. A Host works on, unchanged,
  while it's away.
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
| `dispatcher.db` | SQLite (WAL), 0600: `hosts`, `deliveries`, `schedules`, `occurrences`, `calls` and `follows`; its own id (`identity`) and its paired `devices`; later issues add other triggers and Bots |
| `key.json` | its key, 0600: the Secure Enclave's wrapped form of it on a Mac that has one, otherwise the key itself |
| `dispatcher.sock` | its API, 0600 |
| `hosts.sock` | where Hosts on its own computer connect to it, 0600 ([Hosts](#hosts)) |
| `dispatcher.lock` | held while a Dispatcher runs from the directory, so only one does |
| `dispatcher.log` | its service's diagnostics |

The database's version is `PRAGMA user_version`: each migration takes it one further, in a
transaction, and none changes once released.

## Devices

The person's other computers reach its API as paired devices (WVE-176), as their devices reach
a Host ([remote clients](wve-90-remote-clients.md)); the server's end is the Host's, in
`weave-remote`. It runs on a computer that's always on, such as the person's homelab, and the
CLI on every other computer asks it there.

- **A WebSocket of its own,** on loopback port 7342 beside the Host's 7341, with its own
  Tailscale Serve entry on HTTPS port 7342. `devices/offer` and `hosts/offer` turn both on;
  they stay on while a device is paired or a Host joined over them, across restarts, and go
  when the last is revoked or removed, or an offer expires with neither. The upgrade asks for
  the `weave-dispatcher` subprotocol, so a client pointed at a Host's URL fails there, and the
  other way round; a Host's own connection asks for `weave-dispatcher-host`, and a device's
  connection to one of the Hosts `weave-dispatcher-carry` ([Devices reaching
  Hosts](#devices-reaching-hosts)).
- **Pairing:** a one-time code good for five minutes, from `weave dispatcher pair` on its
  computer, taken at `dispatcher/hello` with `auth: {method: "pair", code, device}`. The device
  makes a P-256 key that never leaves it, and the Dispatcher keeps its public key.
- **Proving a device:** every WebSocket connection asks `dispatcher/challenge` and signs
  `weave-dispatcher-auth/1 <dispatcher id> <device id> <nonce>`, the nonce good for one hello
  and 30 seconds, at `dispatcher/hello` with `auth: {method: "device", deviceId, signature}`. A
  Host's message is no use here, nor this one at a Host. The id is the Dispatcher's own, made
  when it first starts. A wrong signature, an unknown or revoked device, or a used or expired
  nonce answers `unauthenticated` and closes the connection (4002).
- **What a device may do:** everything in the API but `devices/*`, which answer `forbidden`
  (-32069) off the Dispatcher's own computer, and `hosts/offer` with `here`, which gives the
  socket on its computer. `hosts/offer` is open otherwise, so `weave hosts add studio` on a
  laptop gets a code and runs `weave hosts add <url> <code>` on studio over SSH.
- **Both at once:** pairing a computer with the Dispatcher lets it ask the Dispatcher; having
  that computer's Host join lets the Dispatcher start work there. They're different
  permissions, so `weave dispatcher connect` asks before doing the second: with a Host running
  here that hasn't joined, it asks, defaulting to yes; `--host` and `--no-host` answer ahead;
  with no terminal and neither, it says `weave hosts add` does it. The Host gets the computer's
  name in the Dispatcher too.
- **Revoking** a device closes its connections (4000), those carried to Hosts too; it has to
  pair again.
- **The socket is unchanged:** a hello there without `auth` is the Dispatcher's own user.

## Hosts

Hosts join the Dispatcher (ADR 0030) and keep a connection open to it, over which the
Dispatcher is the Host's client, so only the Dispatcher needs an address.

- **Joining.** `hosts/offer` gives a code good for five minutes and where to connect: the
  Dispatcher's WebSocket URL, which it turns on, or with `here`, on its own computer, its
  `hosts.sock`. The Host is handed both by `dispatcher/join`, a local-only method of the Host
  protocol ([remote clients](wve-90-remote-clients.md)), and joins with the code, its id, its name
  and a P-256 key of its own, which it keeps in `key.json` in its directory, in the Secure Enclave
  on a Mac that has one. The Dispatcher keeps the Host's id, the name it gave, its key, when it
  joined and whether it joined over the socket.
- **Each connection.** The Host opens the WebSocket (`weave-dispatcher-host`), or the same over
  the socket, and asks `dispatcher/challenge`; then `hosts/connect` proves its key, signing
  `weave-dispatcher-host-auth/1 <dispatcher id> <host id> <nonce>`. Both are read before the
  ACP SDK takes the connection (`weave_remote::preamble`), and a refusal answers
  `unauthenticated` and closes it (4002). The answer gives the Dispatcher's id, name and key.
  Then the roles turn: the Dispatcher says `host/hello` with its key, as a device with its own
  id, and the Host takes it only on a connection it opened itself, as a service.
- **The Host's side.** It keeps where the Dispatcher is in `dispatcher.json`, and the
  Dispatcher's key among its devices, marked joined, so the tools the Dispatcher declares outlive
  its connections; that entry keeps no remote access on and isn't listed with its devices. It
  dials again when the connection drops, after 1 second, doubling to a minute, and a joined Host
  doesn't exit when idle. Joining revokes a service pairing with the Dispatcher's key from
  before Hosts joined. Joining another Dispatcher leaves the first.
- **Over the connection** the Dispatcher says it reaches the person's Hosts
  (`service/declareTools` with `hosts`), watches the Host's threads (`threads/watch`) and sends
  it the work waiting for it. A newer connection from the same Host replaces the older.
- **Leaving and removing.** `dispatcher/leave` on the Host closes its connection with
  `CLOSE_REVOKED`; the Dispatcher records it as refused, with why, across restarts, until it
  joins again. `weave hosts remove <id or name>` forgets a Host and the work waiting for it: a
  Host connected then is told as its connection closes with `CLOSE_REVOKED`, and one that isn't
  is refused when it next connects; either way it forgets the Dispatcher.
- **Paired before.** A Host the Dispatcher paired with before Hosts joined it keeps its row,
  listed as `unjoined`, and the Dispatcher no longer dials it. Joining matches the row by Host
  id, so schedules naming it carry on.
- **Renaming the Dispatcher's computer** leaves every Host with a URL that no longer resolves,
  as it does a device's pairing; joining again is the fix.

## Devices reaching Hosts

A paired device reaches any of the person's Hosts through the Dispatcher (ADR 0030, WVE-195),
which passes the Host protocol through unchanged: hello, attaching, replay, pending requests
and the journal stay the Host's.

```text
device                       Dispatcher                              Host
  WebSocket, weave-dispatcher-carry
  dispatcher/challenge ───►
  dispatcher/hello (device) ►
  hosts/open {host} ───────► dispatcher/carry {token, device} ──────► (its own connection)
                             ◄── WebSocket, weave-dispatcher-host ─── dials back
                             ◄── dispatcher/challenge, hosts/carry {token, nonce}
                             signs the nonce with its key ─────────► checks it, or serves nothing
  ◄── {hostId, name}         joins the two
  host/hello (dispatcher) ──────────────── passed through ─────────► the device's client
```

- **Asking for a Host.** The device opens the Dispatcher's WebSocket with the
  `weave-dispatcher-carry` subprotocol and, before anything passes through, asks
  `dispatcher/challenge`, proves its key at `dispatcher/hello` as on the API's WebSocket, and
  names the Host in `hosts/open {host, stream}`, by id or name as `hosts/list` gives them, with
  `stream` `host` or `terminal`. A refused hello answers `unauthenticated` and closes (4002).
  Nothing about the Hosts is said before the device has proved itself.
- **A Host the Dispatcher isn't connected to** answers at once with `host_unavailable`, whose
  `data` is `{status, why}` as `hosts/list` says them; a Host that never joined, invalid params;
  a Host whose weave doesn't carry yet (no `carry` feature), `host_unavailable`, saying to update
  it.
- **The Host's end.** Over the Host's own connection the Dispatcher asks `dispatcher/carry`
  `{token, device: {id, name}, stream}`, the token random and good once within its reach timeout.
  The Host opens a connection of its own, as its own connection does, asks
  `dispatcher/challenge`, and presents the token with `hosts/carry {token, nonce}` in place of
  `hosts/connect`, the nonce fresh and its own. The Dispatcher answers with its signature of
  `weave-dispatcher-carry/1 <dispatcher id> <host id> <token> <nonce>`, made with its key, which
  the Host checks against the key it learned when it joined before it serves anything there: a
  connection where the signature is missing or wrong it closes (4002), serving nothing, and
  answers `dispatcher/carry` with the error. So whatever answers at the Dispatcher's address
  without its key gets nothing from the Host. Then the Dispatcher answers `hosts/open` with
  `{hostId, name}`, and joins the two
  ([the Host protocol](wve-85-host-protocol.md#connections-the-dispatcher-carries)).
- **Passing it through.** From then on every data frame goes through unread, either way. Each
  side's pings stay with that side, and a side that stops answering ends the connection. Either
  side's close code reaches the other, as the Host's fallen-behind close (4001) does; one that
  ends without a code is passed on as going away (1001). A side is read only as fast as the other
  takes what it sent, so a slow device falls behind in the Host, whose 8 MiB limit holds.
- **The Dispatcher's own computer.** A client there asks the same on the socket: after its hello
  there, `hosts/open`, and from then on one line on the socket is one message to the Host. Its
  device is `{id: "local", name: <the computer's name>}`. The socket carries text, so a
  terminal's stream goes over the WebSocket.
- **Revoking and removing.** The Dispatcher keeps each connection it carries, by device and by
  Host. Revoking a device closes its end of each with 4000 and the Host's normally; removing a
  Host, or the Host leaving, closes everything carried to it.

## Deliveries

A delivery is a request for one Host, `thread/run`, `queue/add` or `thread/report`, written to
the database before it is sent:

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
and otherwise `thread/run` with its `threadId`, which opens it. A thread the Dispatcher saw
name a successor (`continuedIn`, WVE-168) is prompted in the last of its successors instead.
That choice is written down before it's sent, so a repeat asks the same request under its key
(`key_reused` otherwise).

## Calls from Hosts' agents

A Host's agents reach threads on the person's other Hosts through the Host tools' `host`
([Other Hosts](wve-85-host-protocol.md#other-hosts) in the Host protocol, ADR 0029). The calling
Host passes such a call to the Dispatcher over the Dispatcher's own connection, as
`service/hostCall` `{callId, host, call: {method, params}, caller, room?}`, and the Dispatcher
answers it with `service/answerTool`. The calling Host keeps no record of it.

- **Which Host.** `host` is the id or name of a Host that joined the Dispatcher, other than
  the calling one (a tool error otherwise, naming the Hosts it does reach). It sends the call
  there only while connected to it: a call for a Host it can't reach now fails at once, with
  nothing left to send. `list_hosts` (`hosts/list`) answers with the calling Host's id and every
  other Host, with whether the Dispatcher is connected to it and why not.
- **For the calling thread.** It sends `thread/run`, `queue/add` and `turn/steer` with
  `caller: {threadId, host, hostName}`, the calling thread and its Host, so the turn's origin
  and a new thread's `startedBy` name them. It narrows `thread/run`'s policy to the calling
  thread's, and refuses a call from a thread another Host's agent started (one hop).
- **Sent once.** `thread/run` and `queue/add` are deliveries with a `calls` row naming the
  calling Host and thread, under a key made from the calling Host, the thread and the agent's
  own key (or a new one), hashed: one agent's retry is the same request, and two agents' keys
  never meet. The call's answer is the named Host's, as the tool's; `start_thread`'s is
  `{threadId, turnId, policy, host}`. When the connection goes before the Host answers, the
  tool says the Dispatcher keeps asking; the delivery stays pending, is sent again on the next
  connection, and once the Host answers, the calling thread is told whether it started ("…
  took the thread your thread asked start_thread for after all").
- **Delegation.** A `start_thread` that starts a delegated thread gives `room`, how many more
  of the caller's delegated threads may run on other Hosts; the Dispatcher refuses it when the
  turns it follows for that thread, with its calls not yet taken, are as many.
- **Following.** Once the named Host takes a call that began a turn, a `follows` row keeps the
  turn: the Host, thread and turn, the calling Host and thread, whether it's delegated, and the
  pending requests the caller has been told of. When the thread goes idle on the named Host, or
  the link connects, the Dispatcher reads the turn with `threads/get`, following one the Host
  stopped under into its continuation (`continuedIn`), and waiting for that in a headless thread
  until its Host takes it up. When it's over it reports how it ended to the calling thread, in
  the Host's words (`weave_host_protocol::reports`), and forgets it, in one transaction. A
  thread that waits on a person there it observes for a moment (`thread/attach` with
  `observe`) to read what's asked, and reports each request once. A turn whose thread closed
  before it ran, or stopped with its Host and wasn't taken up again, a turn the Host has no
  record of, are reported as such.
- **Reports.** A report is a delivery to the calling Host: `thread/report` `{threadId:
  <caller>, about: {threadId, host, hostName}, text}`, which the Host tells the thread as it
  tells its own reports. It lands however long the calling Host is away.

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
when the thread it watches goes idle or closes, with `threads/get` and the turn's id, and
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
protocol, and over its WebSocket ([Devices](#devices)), one message per text frame; types in
`weave_host_protocol::dispatcher`. Only the socket owner's user is served on the socket. Every
connection says hello first; anything else before it answers `unauthenticated`.

**`dispatcher/challenge`** `{}` → `{dispatcherId, nonce, expiresAt}`

Only on the WebSocket, before hello, and first on a Host's own connection.

**`hosts/connect`** `{protocol: 2, hostId, name, version, signature, join?: {code, publicKey}}` →
`{dispatcherId, dispatcherName, publicKey, name}`

Only on a Host's own connection, after its challenge ([Hosts](#hosts)); then the Dispatcher says
`host/hello` there.

**`dispatcher/hello`** `{protocol: 2, client: {name, version}, auth?}` → `{protocol, version,
id, device?}`

Another `protocol` answers `incompatible_protocol`. `auth` is the Host's (`device` or `pair`),
and none on the socket; `device` is the paired device a WebSocket client connected as.

**`dispatcher/status`** `{}` → `{version, pid, startedAt, name, database, pending, id, remote?,
devices}`

`name` is what it calls itself to the Hosts that join it; `pending` is the work waiting for any
Host; `remote`, where its WebSocket listens while it's on; `devices`, how many are paired.

**`devices/offer`** `{name?}` → `{code, expiresAt, url}`, **`devices/list`** `{}` →
`{devices: Device[]}`, **`devices/revoke`** `{deviceId}` → `{}`

The Host's, on its own computer only. The connection that offered is told `devices/paired`
when a device takes the code. Without remote access configured, an offer answers
`remote_unavailable`.

**`hosts/list`** `{}` → `{hosts: DispatcherHost[]}`

```ts
type DispatcherHost = {
  hostId: string; name: string;
  url: string;               // where it dialed a Host paired before Hosts joined; "" once joined
  deviceId: string;          // what the Host knows the Dispatcher as
  pairedAt: number;          // when it first paired or joined
  joinedAt?: number;         // none for a Host paired before Hosts joined
  here?: boolean;            // it joined over the socket, on the Dispatcher's computer
  connected: boolean;
  status: Reachability;      // reachable, unchecked, refused, unjoined, unreachable (and down,
                             // otherHost, from before)
  why?: string;              // why it isn't connected, or why it left
  connectedAt?: number;      // when it last connected
  pending: number;           // work waiting for it
};
```

**`hosts/offer`** `{here?}` → `{code, expiresAt, address: {url} | {socket}}`

A code a Host joins with ([Hosts](#hosts)). `here` only on the Dispatcher's own computer; without
it, it turns remote access on, and without remote access configured answers
`remote_unavailable`.

**`hosts/remove`** `{host}` → `{}`

By id or name; invalid params when no such Host joined. It closes what's carried to the Host.

**`hosts/open`** `{host, stream?: "host" | "terminal"}` → `{hostId, name}`

The last request on a connection a device asks the Dispatcher to carry to a Host
([Devices reaching Hosts](#devices-reaching-hosts)): on the WebSocket with
`weave-dispatcher-carry`, after `dispatcher/challenge` and `dispatcher/hello`, or on the socket
after a hello there. `host_unavailable`, with `{status, why}`, for a Host it isn't connected to.

**`hosts/carry`** `{token, nonce}` → `{signature}`

Only on a connection a Host opens with `weave-dispatcher-host`, after `dispatcher/challenge`, in
place of `hosts/connect`: the token `dispatcher/carry` gave it, and a nonce of the Host's own, 32
random bytes in base64url. `signature` is the Dispatcher's of `weave-dispatcher-carry/1
<dispatcher id> <host id> <token> <nonce>` with its key, as a device signs at hello, which the
Host checks before it serves the connection. A token that isn't good answers `unauthenticated`
and closes the connection (4002).

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
  threadId?: string; turnId?: string;
  recordedAt: number; endedAt?: number;
};
```

**`schedules/add`** `{name, cron, zone?, host, agentId, cwd, prompt, policy, mode?, thread?,
missed?, overlap?}` → `{schedule}`

Invalid params, saying why, for an empty name or prompt, a name taken, a cron expression or
zone that doesn't parse, a Host that hasn't joined it, or `overlap: allow` with a thread. It
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
| `weave dispatcher start \| stop \| restart` | through the service once it's installed, and otherwise runs `weave dispatcher run` in the background, logging to `dispatcher.log`, or stops it with SIGTERM; `start` and `restart` wait for it to answer. Stopping it drains nothing: its work is kept as it goes. |
| `weave dispatcher install` | has launchd (`local.weave.dispatcher`) or systemd (`weave-dispatcher.service`) run `weave dispatcher run` from login or boot and restart it, then waits for it to answer; on Linux it turns lingering on as `weave daemon install` does. A Dispatcher directory of its own (`WEAVE_DISPATCHER_DIR`, which the service is given) gets a service of its own, named after it. launchd won't start a weave in `~/Documents`, `~/Desktop` or `~/Downloads`, and a process it starts can't use a removable volume without the person's leave, so install from a copy elsewhere, such as `~/.local/bin/weave`. |
| `weave dispatcher uninstall` | stops the service and removes it |
| `weave dispatcher [status] [--json]` | its version, pid, uptime, name and waiting work, and its Hosts; from a paired computer, where it runs too |
| `weave dispatcher pair [--name] [--json]` | on its computer, a code and a QR code (`weave://pair-dispatcher?url=…&code=…`) another computer pairs with, waiting for it; `--json` prints the URL and code and doesn't wait |
| `weave dispatcher devices [list [--json] \| revoke <id>]` | on its computer, the computers paired with it, and revoking one |
| `weave dispatcher connect <computer \| url code> [--name] [--host \| --no-host]` | on another computer, pairs it: over SSH runs `weave dispatcher pair --json` there; keeps the pairing in `$XDG_STATE_HOME/weave/client` (`dispatcher.json` and the device's `key.json`, 0600), the key in the Secure Enclave on a Mac that has one; then offers to have this computer's Host join the Dispatcher |
| `weave dispatcher disconnect` | forgets the pairing and the key; the Dispatcher lists the computer until it's revoked there |
| `weave --host <host>`, `weave threads --host <host>`, `weave run --host <host>` | the TUI, `threads` and `run` on another of the person's Hosts, by id or name, through the Dispatcher running here or the one this computer is paired with ([Devices reaching Hosts](#devices-reaching-hosts)); this computer's own Host, by either, over its socket. A new thread works in this directory's counterpart under the home there, `~/…`, unless `--cwd` names one there; the Host says so when there's none. With neither Dispatcher, it says to run `weave dispatcher connect` |
| `weave hosts add [computer \| url code] [--name] [--json]` | has a Host join it: this computer's, given neither, over the Dispatcher's socket when it runs here; another's over SSH, which runs `weave hosts add <url> <code>` there; or, on the Host's computer, with a URL and code; `--json` prints what the Host joined |
| `weave hosts add --code [--json]` | a URL and code for `weave hosts add <url> <code>` on a computer SSH doesn't reach |
| `weave hosts [list] [--json]` | the Hosts that joined it, and how each stands |
| `weave hosts remove <host>` | removes one, which forgets the Dispatcher |
| `weave daemon status` | names the Dispatcher the Host joined and whether it's connected |
| `weave schedules [list] [--json]` | the schedules, when each runs next and how it last went |
| `weave schedules add <name> --cron <expr> --host <host> --agent <id> [--cwd] [--zone] [--thread \| --mode] [--approve <kinds>] [--missed latest\|skip] [--allow-overlap] -- <prompt>` | adds one; `--cwd` is this directory when omitted, `--approve` is `weave run`'s, and the prompt is read from stdin when omitted |
| `weave schedules remove \| pause \| resume \| run <schedule>` | as the API's methods |
| `weave schedules occurrences [<schedule>] [--limit] [--json]` | what they did, newest first |

A command that asks the Dispatcher asks the one running from this computer's Dispatcher
directory if one answers, and otherwise the paired one, and says both when neither does. With
`$WEAVE_DISPATCHER_DIR` set it asks only that one. On a paired computer, `run`, `start`,
`restart` and `install` refuse, and `pair` and `devices` say where it runs.

## Acceptance

- `tests/dispatcher.rs`: two in-process Hosts join with codes its socket gave, each through a
  relay to `hosts.sock`, and neither lists it among its devices; it starts a headless turn on
  each; one Host restarts and connects again, and the Dispatcher delivers there; the Dispatcher
  stops between a Host taking a delivery and recording it, and started again the Hosts connect
  again, it sends it again, and the Host starts nothing twice. A Host that leaves is refused
  across a restart, work waits for it, and joining again delivers it.
- `tests/joins.rs` (WVE-194): a code joins once; a Dispatcher with another key is refused at
  the Host's hello, and a Host with another key is refused at `hosts/connect` and forgets the
  Dispatcher; a removed Host forgets it, connected or away; a Host paired before Hosts joined is
  `unjoined` until it joins, and work waiting for it gets there; a Host elsewhere joins over the
  WebSocket, which stays on for it after the code expires and goes when it's removed.
- `install` and `status` on macOS and Linux.
- `tests/schedules.rs`, on a clock the test moves: a schedule starts a turn at its time with
  its origin, and by hand; an occurrence written down while its Host is down starts once after
  a Dispatcher restart and the Host coming back; missed times catch up once, late, and are
  skipped with `missed: skip`; an occurrence while the last still runs is skipped; a schedule
  that names a thread queues there; three failures in a row pause a schedule, which resumes
  from then on.
- `tests/hosts.rs` (WVE-185), two or three Hosts and one Dispatcher: an agent lists the Hosts and
  their agents, starts a thread on another Host whose agent asks permission there, hears that it
  waits and, once answered there, how it ended; prompts, steers and cancels threads there; a
  thread without a directory runs in the same checkout under the home there, or is refused;
  calls fail at once with no Dispatcher, with it away, and for a Host it can't reach, leaving
  nothing to send; a start whose answer was lost lands once and its caller is told; one hop; the
  policy ceiling; delegation limits across Hosts; following again after a Dispatcher restart;
  a turn the named Host stops under followed into its continuation.
- `tests/devices.rs` (WVE-176), over a loopback WebSocket with a fake Serve: a device pairs with
  a code once, proves its key at hello and lists Hosts and schedules; another key, an unknown
  device, a Host's message, a reused challenge and a hello without one are refused and closed;
  `devices/*` answer `forbidden` to a device; devices and remote access outlive a restart;
  revoking closes the device's connections, and the last one gone, or an offer nobody took,
  removes the Serve entry; a device may ask `hosts/offer` but not for the socket. CLI
  `tests/dispatcher.rs`: `weave dispatcher connect` with a code and over SSH, `weave hosts` and
  `weave schedules` through the pairing, and `disconnect`; with a Host on the computer, `connect`
  has it join too when told to, says how when there's no terminal to ask in, and leaves it when
  it has joined already; `weave hosts add` alone has it join, and so do `weave hosts add --code`
  and `weave hosts add <url> <code>`, once per code, and `weave hosts add <computer>` over SSH.
- `tests/carry.rs` (WVE-195), two Hosts and a paired device over a loopback WebSocket: the
  device lists, opens and prompts on each Host through the Dispatcher, catches up after a
  dropped connection with nothing missing or repeated, and answers a pending request there;
  revoking it closes its carried connections with 4000 and refuses it after; a Host serves
  nothing where whatever answers at the Dispatcher's address signs its nonce with another key,
  or not at all, and serves again where the Dispatcher answers; a Host the
  Dispatcher isn't connected to answers at once with the status and why `hosts/list` gives, and
  one that never joined is refused; a Host refuses the Dispatcher's word for a device from a
  local client, on its own WebSocket, and anything else on a connection it opened for it;
  removing a Host closes what's carried to it and nothing else; a client on the Dispatcher's
  computer goes through its socket as its computer; a terminal's stream goes through, refused
  with another device's ticket and closed when the device is revoked. CLI `tests/dispatcher.rs`:
  `weave run --host` and `weave threads --host` reach a Host as on another computer, in the
  directory's counterpart under the home there.
- Live: the Dispatcher on the homelab as a systemd user service, and `weave hosts` and
  `weave schedules` from the Mac; the Mac's and homelab-1's Hosts join it, and a schedule works
  without the Dispatcher dialing either. A thread on homelab-1 opened from the Mac's CLI through
  the Dispatcher (WVE-195).

## Later

- Webhooks (WVE-146) make deliveries as schedules do; the edge (WVE-117) holds webhook
  deliveries and pushes for it.
- The app pairs with the Dispatcher alone and reaches every Host through it (WVE-196), and Hosts
  stop taking remote connections of their own (WVE-197).
- The Dispatcher's own tools, declared with `service/declareTools` (WVE-171), and Bots
  (WVE-118).
- Choosing the Host a piece of work runs on, which a delivery's Host can become a rule for.
