# WVE-175: The Dispatcher

Status: implemented 2026-11-03, with `install` and `status` checked live as a launchd service on
macOS and a systemd user service on Debian 13, each restarting a Dispatcher that was killed.
Schedules (WVE-145) since 2026-11-04, calls from Hosts' agents to the person's other Hosts
(WVE-185) since 2026-11-04, the person's devices pairing with it and reaching it over the
tailnet (WVE-176) since 2026-11-06, Hosts joining it and keeping a connection open to it
(WVE-194) since 2026-11-07, the person's devices reaching every Host through it (WVE-195)
since 2026-11-08, the app pairing with it alone and reaching every Host through it (WVE-196)
since 2026-11-08, on the person's iPad and iPhone, Hosts taking no remote connections of
their own (WVE-197), built 2026-11-08, the person's Projects (WVE-189, ADR 0031), built
2026-11-08, the person's Bots (WVE-118), with one-off schedules and a Bot's wake-ups, built
2026-11-10, and Bots in the app, their homes made by their Hosts, their own schedules and Bots
that Bots make (WVE-178), built 2026-11-11. The decisions are in
[ADR 0027](../adr/0027-the-dispatcher-starts-work-on-the-persons-hosts-as-a-client-of-them.md),
[ADR 0029](../adr/0029-agents-reach-the-persons-other-hosts-through-the-dispatcher.md) and
[ADR 0030](../adr/0030-the-dispatcher-is-the-hub-hosts-dial-out-to-it-and-devices-reach-every-host-through-it.md);
Bots' in
[ADR 0028](../adr/0028-bots-are-dispatcher-records-whose-work-goes-on-in-ordinary-threads.md),
as WVE-118 and WVE-178 settled it there, and how the app shows a Bot in
[ADR 0031](../adr/0031-the-app-lays-out-blocks-in-sessions-their-host-keeps-under-projects-the-dispatcher-keeps.md).

## Purpose

The Dispatcher (`weave dispatcher`) keeps triggers and Bots and starts their work on the
person's Hosts. This is its core: its state, its key, the Hosts that join it and the connection
each keeps open to it, the one path work takes to a Host, schedules (WVE-145), and the calls a
Host's agents make to the person's other Hosts (WVE-185), and the person's devices, which pair
with it, reach its API over the tailnet (WVE-176) and reach every Host through it (WVE-195).
It keeps the person's Projects too ([Projects](#projects), WVE-189), and their Bots, whose
work goes on in ordinary threads on one Host each ([Bots](#bots), WVE-118), which the person
adds from the app or the CLI, or a Bot adds when the person asks it to (WVE-178). Webhooks
(WVE-146) build on it.

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
| `dispatcher.db` | SQLite (WAL), 0600: `hosts`, `deliveries`, `schedules`, `occurrences`, `calls` and `follows`; its own id (`identity`) and its paired `devices`; `projects` and their `project_locations`; `bots`, the threads each has had (`bot_threads`) and the new thread each is starting (`bot_new_threads`); later issues add other triggers |
| `key.json` | its key, 0600: the Secure Enclave's wrapped form of it on a Mac that has one, otherwise the key itself |
| `dispatcher.sock` | its API, 0600 |
| `hosts.sock` | where Hosts on its own computer connect to it, 0600 ([Hosts](#hosts)) |
| `dispatcher.lock` | held while a Dispatcher runs from the directory, so only one does |
| `dispatcher.log` | its service's diagnostics |

The database's version is `PRAGMA user_version`: each migration takes it one further, in a
transaction, and none changes once released.

## Devices

The person's devices and other computers reach its API as paired devices (WVE-176), and every
Host through it ([remote clients](wve-90-remote-clients.md)). It is the only program they pair
with: Hosts take no remote connections of their own (WVE-197). The server's end is in
`weave-remote`, which the Host shares for the connections it opens to the Dispatcher. It runs on
a computer that's always on, such as the person's homelab, and the CLI on every other computer
asks it there.

- **A WebSocket of its own,** on loopback port 7342 (Hosts listened on 7341 until WVE-197),
  with its own Tailscale Serve entry on HTTPS port 7342. `weave dispatcher run --listen
  <loopback address> --url <url>` puts it elsewhere, and with a URL makes and removes no Serve
  entry: the app's tests run a dev Dispatcher so. `devices/offer` and `hosts/offer` turn both on;
  they stay on while a device is paired or a Host joined over them, across restarts, and go
  when the last is revoked or removed, or an offer expires with neither. The upgrade asks for
  the `weave-dispatcher` subprotocol, so a client asking for anything else fails there; a Host's
  own connection asks for `weave-dispatcher-host`, and a device's connection to one of the Hosts
  `weave-dispatcher-carry` ([Devices reaching Hosts](#devices-reaching-hosts)). The rest of the
  WebSocket's rules, `Origin`, sizes, pings and close codes, are the [remote clients
  spec's](wve-90-remote-clients.md#the-dispatchers-websocket).
- **Pairing:** a one-time code good for five minutes, from `weave pair` on its computer, taken
  at `dispatcher/hello` with `auth: {method: "pair", code, device}`. The device
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
  Dispatcher's key in `devices.json`, marked joined, so the tools the Dispatcher declares outlive
  its connections. It dials again when the connection drops, after 1 second, doubling to a
  minute, and a joined Host doesn't exit when idle. Joining another Dispatcher leaves the first.
  A pairing with the Dispatcher from before Hosts joined it went with the Host's other paired
  devices ([remote clients](wve-90-remote-clients.md#the-hosts-own-remote-access-retired)).
- **Over the connection** the Dispatcher declares its own tools, a Bot's
  ([A Bot's tools](#a-bots-tools)), and says it reaches the person's Hosts (`service/declareTools` with
  `hosts`), watches the Host's threads (`threads/watch`) and sends it the work waiting for it. A
  newer connection from the same Host replaces the older.
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

### The app

The app on the iPad and iPhone (WVE-196) pairs only with the Dispatcher and reaches every Host
through it; it never connects to a Host directly, and has no fallback while the Dispatcher is away
(ADR 0030).

- **One pairing.** It scans the QR code `weave pair` shows
  (`weave://pair-dispatcher?url=…&code=…`), shows the address's host name for the person to
  confirm, makes a key in the Secure Enclave and pairs at `dispatcher/hello`. It keeps the
  Dispatcher's id, name (`dispatcher/status`) and URL, its device id there, its key's name, and
  the Hosts it last listed. Until it's paired it shows the pairing screen; once it is, it deletes
  the records it kept per Host before and their keys.
- **Its Hosts** are `hosts/list`'s, on one connection to the API it keeps open, listed when it
  connects, when the app comes to the front, and after a Host's connection fails, then again,
  backing off, while one is away. There's no notification of a Host coming back. A Host the
  Dispatcher isn't connected to says why, `why` or its status.
- **Each Host** has a connection of its own the Dispatcher carries, said hello to with
  `auth: {method: "dispatcher"}`; attaching, replay, pending requests and reconnecting are as
  before. A terminal's stream is carried by the native terminal itself, which says the same
  preamble with `stream: "terminal"`, signing with the same key, before the stream's first frame.
- **When things fail.** While the Dispatcher can't be reached, a banner says so and the sidebar
  keeps the Hosts it last listed, greyed out. A device it refuses at hello is told to pair again;
  one it revokes (4000, on any of its connections) forgets the pairing and its key, and is told to
  pair again.

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

Schedules and Bots make deliveries ([Schedules](#schedules), [Bots](#bots)); so may the
Dispatcher's library.

A delivery may also be a prompt for a thread: the first time it's sent it becomes
`queue/add` if the Dispatcher last saw the thread open, so it waits for whatever runs there,
and otherwise `thread/run` with its `threadId`, which opens it. A thread the Dispatcher saw
name a successor (`continuedIn`, WVE-168) is prompted in the last of its successors instead.
That choice is written down before it's sent, so a repeat asks the same request under its key
(`key_reused` otherwise). A prompt for a Bot is settled the same way when it's first sent, into
the Bot's current thread, or into `thread/run` starting its first; one that has to wait, as
while the Bot starts a new thread, stays written down unsent, and the work after it goes on.

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
- **Projects** (WVE-208). `list_projects` (`projects/list`, with no `host`) answers with the
  calling Host's id, every Project as `projects/list` gives it, and every Host joined as
  `{hostId, name}`, the calling one included. Agents only read Projects. The calling Host works
  out what an agent's `project` names from it, so the calls it sends on name a directory as
  before ([Projects](wve-85-host-protocol.md#projects) in the Host protocol).
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
at the times its cron expression gives, or once at the time it names (a one-off), with nobody
there; or prompts one of the person's Bots then. It names:

- `cron`: five fields, minute, hour, day of month, month, day of week, such as `0 9 * * 1-5`,
  or `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`; seconds and years are refused, so
  nothing runs more than once a minute. croner reads it.
- or `at`, a one-off's time, after now, in place of `cron` (feature `bots`): its one
  occurrence comes then ([One-offs](#one-offs)).
- `zone`: an IANA time zone, by default the one of the Dispatcher's computer. A time in an hour
  a clock change skips runs at the first valid moment after it; one in an hour it repeats runs
  once, the first time, as GitHub Actions has it.
- the Host, by id or name, which a rule may replace when the Dispatcher chooses Hosts;
- what each occurrence starts: `agentId`, `cwd` on that Host (`~/` there allowed), `prompt`,
  `policy` and `mode`, and `thread`, a thread each occurrence prompts instead of starting one;
- or `bot`, a Bot by id or name, in place of the Host and all of those but `prompt` (feature
  `bots`): each occurrence prompts the Bot, into its current thread or starting its first, with
  its agent, home, policy and mode as they are then ([Bots](#bots));
- `missed`: `latest` (the default) or `skip`;
- `overlap`: `skip` (the default) or `allow`, which only a schedule that starts a thread may, so
  not a Bot's.

### Occurrences

Each occurrence is written down in `occurrences`, keyed on its schedule and its **scheduled**
time, with the delivery that starts it in the same transaction. The delivery's request key is
`schedule/<schedule id>/<scheduled time>` (`schedule/<id>/run/<time>` for one run by hand),
and its turn's origin is the schedule's: `{"service": {"name": <the Dispatcher's>, "label":
"schedule <name>", "id": <occurrence id>}}` ([Service origins](wve-85-host-protocol.md#service-origins)),
or `schedule <name> by <bot>` for one a Bot added itself ([Its schedules](#its-schedules)).
So however often the Dispatcher considers a time, and across its restarts and the Host's,
an occurrence starts once.

A thread a schedule starts is labelled `dispatcher` and `schedule:<id>` (WVE-173), so clients
can find or set aside the Dispatcher's threads; a thread a schedule prompts keeps its own labels.
A Bot's schedule's occurrence is a prompt for the Bot, settled when it's first sent, under the
same key and with the same origin, and a thread it starts is the Bot's, labelled as the Bot's
threads are ([Bots](#bots)).

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
- **A paused Bot.** While the Bot a schedule names is paused ([Bots](#bots)), each occurrence
  is written down as skipped, "the Bot odin is paused: its thread has waited on the person since
  Wed 4 Nov 08:30 UTC", unless it's run by hand. The schedule itself isn't paused and lists its
  next time; once the Bot goes on, so does the schedule, and nothing it skipped catches up.

### One-offs

A one-off (feature `bots`) has `at` in place of `cron`, which `schedules/add` refuses unless it
comes after now, and an empty `cron`. Its one time is considered as a cron expression's are: it
starts once, a catch-up if late, as `missed` says; one missed by more than the week the
scheduler looks back is written down as skipped, "missed at Wed 4 Nov 09:00 UTC, more than a
week ago, while the Dispatcher couldn't run it". Once its time has come it has no `nextAt`, and
it's kept, done, with its occurrence, until it's removed. A Bot's own wake-up is a one-off too,
which the Dispatcher forgets a week after its time once its occurrence is over
([Wake-ups](#wake-ups)).

A Bot's thread manages the schedules that name its Bot with the Dispatcher's tools (WVE-178):
it asks for wake-ups, and adds, lists, pauses, resumes and removes its schedules, each of its own
coming every five minutes at most ([A Bot's tools](#a-bots-tools)).

Not yet: other agents creating schedules of their own, through tools the Dispatcher serves
under the calling thread's policy (WVE-173); changing a schedule in place (remove it and add it
again).

## Projects

A Project (ADR 0031, WVE-189) is a named piece of the person's work with at most one location on
each of their Hosts. The Dispatcher keeps them, as the one of the person's programs that sees
every Host; Hosts know nothing of them, and the Host protocol is unchanged.

- **The record.** `{id, name, kind, remote?, locations: [{hostId, path}], createdAt,
  updatedAt}`. `kind` is `git` or `directory`, fixed when the Project is made. A git Project
  keeps its repository's remote (`GitLocation.remote`, such as `github.com/owner/name`) if it
  has one, and takes the first a location brings if it hasn't. Names are unique ignoring case;
  ids are `p-` and 20 hex digits. Host names aren't kept: `hosts/list` gives them, so a renamed
  Host doesn't go stale.
- **Locations.** At most one on each Host, and a directory is one Project's location at most. A
  repository is recorded by its primary worktree, so all its worktrees are in the Project; a
  directory outside one, as given. The client works that out from the directory's Host
  (`worktrees/list`, which answers `not_a_repository` outside one), since only the Host's
  computer can read git there, and tells the Dispatcher the kind and remote with the path. A
  location joins a Project only of its kind, and a git one only with the Project's remote or
  none.
- **Hosts.** A location is only on a Host that joined. Removing a Host (`hosts/remove`) removes
  its locations, and a Project left with none stays, listed with none. A Host that leaves keeps
  them, as it keeps its row.
- **Who may change them.** The Dispatcher's own computer, on its socket, and its paired devices.
  Hosts and their agents can't yet (WVE-208): a Host's own connection doesn't reach the API.
- **Which Project a thread is in** is a client's to work out, with
  `weave_host_protocol::projects::containing(projects, hostId, listing)`: the Project with a
  location on the thread's Host that is the thread's repository (`git.repo`) or contains its
  directory, the deepest winning.
- **The app** adds, renames, relocates and removes Projects as the CLI does (WVE-220): it asks
  the Host where a directory lies in git (`worktrees/list`), offers a clone to the Project with
  its remote, and puts the Project each request answers with in its own list.
- **Not yet:** `projects/watch`; clients list once, so one client's change shows in another
  when it next lists.

## Bots

A Bot (ADR 0028, as WVE-118 and WVE-178 settled it there) is a named assistant the person comes back to over
weeks: a Dispatcher record whose work goes on in ordinary threads, one at a time, on the one Host
it names, in its home there. The Host learns nothing of Bots: a Bot's threads carry its labels,
and the rest is the Dispatcher's. A Bot belongs to no Project; its agent works in Projects by
name through the Host tools (WVE-208), as any thread's does.

- **The record.** A name, an agent, the Host, its home there, a permission policy, a mode, a
  time zone, when to start a new thread daily if at all, how long a request may wait for the
  person before it pauses, its threads, the last its current one, and the Bot that made it, if
  one did (`createdBy`, WVE-178; `Bot`, [Its API](#its-api)). Names are unique ignoring case and
  one line; ids are `b-` and 20 hex digits. Host names aren't kept, as for Projects, nor the
  maker's name, which is read from its record while it's there and its id kept after. The
  policy approves nothing unless told to, and asks the person about the rest (`otherwise:
  ask`), so what it doesn't approve waits for them and the Bot shows as needing them. A change to
  the policy or mode applies to threads started after it: an open thread keeps its own.
- **Who adds one.** The person, from the app's New Bot or `weave bots add`, both `bots/add`; or
  one of their Bots, with `create_bot`, when the person asks it to ([Making Bots](#making-bots)).
  Either way its Host makes its home first, so it has to be connected to the Dispatcher.
- **Its home** is a directory on its Host, a git repository of its own that holds its memory:
  `AGENTS.md`, what it always has in mind, starting with its job when it was given one,
  `CLAUDE.md` pointing at it (`@AGENTS.md`), notes beside them, and `threads/`, a dated note
  about each thread before. The agent reads them as any thread in that directory does, and edits
  and commits them as it goes, as the `AGENTS.md` it starts with tells it to; weave keeps no
  memory of its own. The Dispatcher has the Bot's Host make it as it adds the Bot, with
  `repos/init` ([Its home](#its-home)), and keeps it as the Host gives it back, whole; a Bot
  added before WVE-178 may keep `~/…`. The Dispatcher reads no Host's files itself.
- **Prompts.** The person prompts a Bot's thread as any thread, over the Host protocol: through
  the Dispatcher from a device ([Devices reaching Hosts](#devices-reaching-hosts)), or over the
  Host's socket on its own computer, and answers its pending requests the same way. The Host's
  queue orders their prompts and the Bot's schedules'. `bots/send` is for senders that aren't
  attached, such as the CLI and scripts, and for a Bot with no thread yet: a delivery whose
  thread is settled when it's first sent, into the Bot's current thread as a thread's prompt is
  ([Deliveries](#deliveries)), so it waits behind whatever runs there. Its turn's origin is
  `{"service": {"name": <the Dispatcher's>, "label": "bot <name>", "id": <delivery id>}}`. Its
  request key is `bot/<bot id>/send/<key>` with the sender's `key`, hashed when that would be
  too long, so the same key again names the same delivery and sends nothing more, and
  `dispatcher/<delivery id>` without one.
- **The first thread.** A Bot has no thread until a prompt reaches it, from `bots/send` or a
  schedule. The first becomes `thread/run` in its home with its agent, policy and mode, labelled
  `dispatcher` and `bot:<id>`, and the thread its Host answers with is the Bot's from then on. A
  second prompt waits until the first is answered, so two sent together start one thread, and
  the second goes into it.
- **Schedules that name it** are ordinary schedules with `bot` in place of where and what they
  run ([Schedules](#schedules)), one-offs among them. Each occurrence is a prompt for the Bot,
  settled as `bots/send`'s is, under the occurrence's key and with the schedule's origin. Their
  `overlap` is `skip`. A Bot's schedule lists the Bot's Host, agent, home as `cwd`, policy, mode
  and current thread as they are now. The person adds them with `schedules/add`; the Bot adds
  its own, and manages the person's for it, with its tools ([Its schedules](#its-schedules)).
  `schedules/list` with `bot` lists only a Bot's.
- **State,** from the thread watch the Dispatcher keeps on the Bot's Host: `working` while its
  current thread runs a turn; `needsYou` while a pending request there waits for the person,
  with `waitingSince`; `idle` otherwise, when its thread is idle or not open, it has none yet,
  or the Dispatcher isn't connected to its Host, which `connected` says.
- **Pausing.** Once a request in its thread has waited for the person longer than `pauseAfter`
  (12 hours unless the Bot says otherwise), by the Dispatcher's clock, the Bot is `paused`,
  saying since when, and its schedules' occurrences are skipped
  ([Occurrences](#occurrences)); `bots/send` still delivers. It goes on by itself once the
  thread no longer waits. Nothing tells the person but the Bot's state yet (WVE-177).
- **Removing.** `bots/remove` forgets a Bot, its schedules, wake-ups among them, and the
  prompts still waiting for it; its threads and its home stay on its Host. Removing its Host
  (`hosts/remove`) removes it the same way; a Host that leaves keeps it, and its prompts wait.
  A Bot it made keeps its id as `createdBy`, with no name.
- **Watching.** A client that shows the Bots, as the app does, watches them (`bots/watch`): it
  hears of each Bot added, changed or removed, and of each change to how one lists, such as its
  state, its Host connecting or going, or its thread, until it unwatches or its connection ends.

### Its home

`bots/add` has the Bot's Host make its home (WVE-178), once everything else in the request has
been checked and before the Bot is written down, with `repos/init`
([A repository of its own](wve-85-host-protocol.md#a-repository-of-its-own)):

- the directory `home` names, whole or `~/…` under the home there, or `~/bots/<name>` without
  one, the name lowercased with a hyphen for each run of spaces and for a slash; a name that
  leaves nothing but dots needs a `home`. The CLI gives one relative to this directory whole,
  for a Bot on this computer's Host. It's made if it isn't there;
- a git repository there, with `git init`, unless the directory is the top of one already. A
  directory inside another repository is refused: a home is a repository of its own, so its
  memory files aren't committed into someone else's;
- unless an `AGENTS.md` or a `CLAUDE.md` is there, the Bot's first memory files: `AGENTS.md`,
  which starts "# <name>", says the directory is the Bot's home, gives its job under "## Your
  job" when it has one, says to write down what's worth remembering as it learns it, with a note
  in `threads/` for each thread, and commit, to save when asked before a new thread, which tools
  it has for Projects, wake-ups, its schedules and making Bots, and that a Bot it makes does
  nothing until the person prompts it, and ends with "## What I know"; and `CLAUDE.md`, which is
  `@AGENTS.md`. With either there, neither is written, and the job isn't written down;
- one commit of those two files alone, "Start <name>'s home", as the user git's configuration on
  the Host names, leaving anything else staged as it was. Without a `user.name` and `user.email`
  there it writes the files, commits nothing, and says so.

The Bot keeps the directory as its Host gives it back, whole, symlinks resolved. `bots/add`
answers with what making it did, which `weave bots add` and `create_bot` say. While the Host
isn't connected the Bot isn't added (`host_unavailable`), nor when its weave is too old to make
a home (no `repos_init`, invalid params saying to update it) or it refuses, saying why. Nothing
is made for a request the Dispatcher refuses first, a name taken among them.

### A new thread

`bots/newThread`, or daily at `newThreadAt` (`HH:MM` in the Bot's `zone`) for a Bot set so,
starts a Bot's new thread. A daily one starts only if the thread has had a turn since the one it
started with, so a thread nobody used isn't replaced, and days the Dispatcher missed start one,
once, when it next can. The sequence, which `startingThread` shows while it lasts:

1. **Waiting.** From then on the Bot's prompts wait, its schedules' and `bots/send`'s, oldest
   first.
2. **Saving.** Once the watch says the thread is idle, neither running a turn nor waiting on the
   person, the Dispatcher prompts it, as a thread's prompt, to save what's worth keeping to the
   memory files, write a note about itself at `threads/<date>-<its id's first 8>.md` in the home,
   the date in the Bot's zone, and commit. Its key is `bot/<id>/new-thread/<n>/save`, where `n`
   counts the Bot's new threads.
3. **Starting.** Once that turn is over, followed into its continuation if the Host stopped
   under it, `thread/run` starts the new thread in the home, labelled as the Bot's, with a prompt
   naming the thread it takes over from and that thread's note, and telling it to read the
   memory files first; if the save turn didn't finish, or the Host refused it, the prompt says
   so and why. Its key is `bot/<id>/new-thread/<n>/start`. A new thread the Host refuses leaves
   the Bot its thread, and the prompts go on there.
4. **Naming.** The old thread names the new one as its successor (`thread/setSuccessor`,
   [Successors](wve-85-host-protocol.md#successors)), unless it's no longer open. The new one is
   the Bot's thread from then, the old one ends in `threads` (`endedAt`), and the prompts that
   waited go into the new one, in order.

Each step is written down in the transaction that writes the delivery it sends, so after a
restart, the Dispatcher's or the Host's, it goes on where it was, and the Host's request keys
start nothing twice. While its Host is away, it waits. Prompts the person sends the old thread
over the Host protocol meanwhile go into it, as into any thread: the Host knows nothing of the
new one until it's named.

### A Bot's tools

The Dispatcher declares its own service tools on every Host that joined it
([Service tools](wve-85-host-protocol.md#service-tools), WVE-171): eleven, all a Bot's. Agents see
them as any service's, `<the Dispatcher's name>__<tool>`, in this order: the wake-ups
(WVE-118), `wake_me`, `list_wakeups` and `cancel_wakeup`; its schedules (WVE-178),
`add_schedule`, `list_schedules`, `pause_schedule`, `resume_schedule` and `remove_schedule`; and
making Bots (WVE-178), `create_bot` and `list_bots`, with `set_avatar` (WVE-223) after them. The
rules for all of them:

- **Only a Bot's own thread** is answered: on the Bot's Host, its current thread, one it had, or
  the new one it's starting. Any other thread gets a tool error saying only a Bot's thread may do
  what the tool does, as every tool's description tells every agent first.
- **Only the calling Bot.** None changes another Bot, prompts it or schedules it; `create_bot`
  makes one, `list_bots` reads them all, and `set_avatar` changes the caller's own.
- **Answers** are JSON text. A call refused, by the tool or by the API under it, is a tool error
  in words for the agent: the API's reason made a sentence.
- **New tools come with new threads.** A thread keeps the tools it was set up with
  ([Service tools](wve-85-host-protocol.md#service-tools)), so a Bot's thread set up before an
  updated Dispatcher connected to its Host lacks the tools that Dispatcher added; a thread
  started after, such as the Bot's next new thread (`bots/newThread`), has them.

#### Wake-ups

A Bot's thread asks to be prompted again later:

- `wake_me {prompt, at? | in?}`: a wake-up at `at`, an RFC 3339 time with its offset, or `in`
  seconds from now, exactly one of them, at least a minute away. It answers with the wake-up
  as JSON, `{id, at, when, prompt}`: `at` in RFC 3339 in the Bot's zone, `when` as people read
  it.
- `list_wakeups {}`: the Bot's wake-ups still to come, soonest first, `{wakeups}`.
- `cancel_wakeup {id}`: cancels one still to come, `{cancelled}`.

The rules:

- **A wake-up is a one-off schedule naming the Bot** ([One-offs](#one-offs)), listed with
  `wakeUp`, named `wake-up-` and the first twelve hex digits of its id, in the Bot's zone. It
  comes as the Bot's schedules' occurrences do: into its current thread then, held while it
  starts a new one, once across restarts, and as a catch-up if late, "This turn is the wake-up
  you asked for, due at …". Its turn's origin label is `wake-up <name>`. It keeps the Host's id
  for the call that asked for it, so a call the Host sends again makes one wake-up.
- **At most 20** still to come for each Bot; another is refused, saying to cancel one or wait.
- **The person sees them** among the schedules (`schedules/list`, `weave schedules`, the Bot's
  in `weave bots show`, and the Bot's page in the app), and may remove one as any schedule
  (`schedules/remove`). A week
  after its time, once its occurrence is over, the Dispatcher forgets it.
- **A known limit:** a wake-up due while its Bot is paused is skipped, as the Bot's schedules'
  occurrences are, and lost. It doesn't come again, and nothing tells the Bot.

#### Its schedules

A Bot manages the schedules that name it when the person asks it to (WVE-178), so the app has no
form to add one ([In the app](#in-the-app)). These are its own and the person's for it, but not
its wake-ups, which the wake-up tools manage.

- `add_schedule {name, cron, prompt, zone?}`: a schedule naming the calling Bot, checked as
  `schedules/add` checks one with `bot`: `name` unique among all the person's schedules, the
  cron expression's five fields or a name such as `@daily`, in `zone` or else the Bot's, with
  `missed: latest` and `overlap: skip`. It answers with the schedule, as `list_schedules` gives
  one. It keeps the Host's id for the call that added it (`made_call`), unique for the Bot, so a
  call the Host sends again adds one schedule and answers with it; its turns' origin label is
  `schedule <name> by <bot>`, by the Bot's name then.
- `list_schedules {}`: the schedules naming the Bot, the person's too, one-offs the person added
  among them (`cron` empty), wake-ups aside, by name, `{schedules}`. Each is `{id, name, cron,
  zone, prompt, paused?, next?: {at, when}, last?: {at, when, state, outcome?, why?},
  addedByYou?}`, `at` in RFC 3339 in the schedule's zone, `when` as people read it, and
  `addedByYou` on those the Bot added.
- `pause_schedule {id}`, `resume_schedule {id}`: by id or name, one of those, the person's too.
  Pausing says "<bot> paused it"; resuming has it come again from now, catching up nothing it
  missed while paused. One already so changes nothing. Each answers with the schedule.
- `remove_schedule {id}`: forgets one of those, the person's too, `{removed}`; a turn it started
  goes on. The description says to remove one only when the person asks, and to pause one to
  stop it for a while.

The rules, which hold for the Bot's tools only; the person's `schedules/*` aren't held to them:

- **Every five minutes at most,** for one the Bot adds. One whose next times, looked at over more
  than a day's worth at that rate, come closer than five minutes is refused, naming two of them.
- **At most 20** schedules naming the Bot when it adds one, its wake-ups aside and the person's
  for it counted; another is refused, saying to remove one, if the person agrees.
- **Only its own.** Pausing, resuming or removing a wake-up is refused, saying `cancel_wakeup`
  cancels it; so is a schedule that names another Bot or none, and one there isn't.

That a Bot added a schedule (`made_call`, migration 10) isn't on the wire: `Schedule` doesn't
say so, and `weave schedules` and the app show it as any of the Bot's. The origin label of its
turns says it.

#### Making Bots

A Bot makes another when the person asks it to (WVE-178): the person adds a Bot from the app or
the CLI, or asks one of their Bots for another (ADR 0028).

- `create_bot {name, job, agent?, host?}`: a Bot added as `bots/add` adds one, with the calling
  Bot as its maker (`createdBy`). Its home is `~/bots/<name>` on its Host, made there
  ([Its home](#its-home)), its `AGENTS.md` starting with `job`; it has the caller's agent and Host
  unless `agent` (an id) or `host` (an id or name) names another, the caller's time zone, the
  policy `bots/add` gives without one, which asks the person, no mode and no daily new thread.
  `name` and `job` are needed, trimmed. It answers `{made, home, next}`: the Bot as `list_bots`
  gives one, what making its home did (`repos/init`'s answer), and what to do now, which says
  the Bot does nothing until the person prompts it and to tell the person it's there and what
  it's for, and says so when its home kept files that were there, so its job isn't written down,
  or its first memory files went uncommitted.
- `list_bots {}`: the person's Bots, by name, `{bots}`, each `{name, agent, host, home, state,
  paused?, emoji?, color?, madeBy?, you?}`: `host` by its name, `home` whole, `state` `working`,
  `needsYou` or `idle`, `paused` why its schedules are, `emoji` and `color` its avatar's, `madeBy`
  the Bot that made it by name, or "a Bot since removed", and `you` on the calling Bot.
- `set_avatar {emoji?, color?}` (WVE-223): the calling Bot's own avatar, changed as `bots/update`
  changes it, when the person asks. What's absent stays, `null` clears it, and one of them is
  needed. `color` is one of the eleven names; another doesn't fit the tool's input. It answers
  with the Bot as `list_bots` gives it.

The rules:

- **At most 20 Bots** when a Bot makes one, the person's counted: another is refused before its
  home is made and again as it's written down, "there are 20 Bots, the most there may be when a
  Bot makes one; the person can still add one themselves, or remove one". The person's
  `bots/add` isn't capped.
- **It does nothing until the person prompts it.** It has no thread and no schedules, none of
  the Dispatcher's tools prompts or schedules another Bot, and the tool tells its maker to tell
  the person it's there.
- **What `bots/add` refuses** comes back as a tool error, "Couldn't make <name>: …", a Host away
  or too old, a name taken and a home inside another repository among it.
- **Those watching the Bots** hear of the new one as of any (`bots/watch`), and it lists as made
  by its maker.

### Known limits

- **Adding a Bot needs its Host connected,** since the Host makes the home; and a Host whose
  weave is from before `repos_init` can't have one added until it's updated. Bots added before
  keep working there.
- **A Bot a Bot makes is inert only as far as the Dispatcher's tools go.** Once it has a thread,
  the Host tools let any thread prompt any thread (ADR 0023), its maker's among them.
- **`create_bot` isn't kept per call,** as `wake_me` and `add_schedule` are: a call the Host sends
  again is refused, the name being taken, though the Bot was made.
- **Schedule names are unique across all schedules,** the person's and every Bot's, so a Bot's
  `add_schedule` may be refused for a name another has.
- **The app shows a Bot's policy without changing it:** `weave bots update --approve` changes it.
- **Reading an earlier thread opens it in its agent,** the only way a Host gives its transcript,
  and the app closes it again once nothing needs it.
- **The app keeps a Bot's Session right only on a device that has the Bot open:** its Thread
  Block moves to the Bot's new thread when one of them writes the layout
  ([In the app](#in-the-app)).

### In the app

The app shows the Bots from a Dispatcher that keeps them (WVE-178, ADR 0031), watching them
(`bots/watch`) where it can and listing them again as it refreshes where it can't.

- **The list.** A Bots group above the Projects, a row for each Bot by name, with what it's
  doing, the most pressing first: away (its Host isn't connected), needs you, working, unread
  (its current thread ended a turn this device hasn't shown, the device's own), or idle; and
  "no thread yet", "starting a new thread" or "paused" when so. New Bot is there with
  `bots_home`, while a Host is connected: its name, its job, the Host and the agent, everything
  else set on the Bot's page afterwards; its home is `~/bots/<name>`.
- **A Bot opens as a Session,** the one at its home on its Host, listed under Bots and never under
  a Project or its Host. It has one tab and no tab bar, the Bot's name and state in its place, and
  the Bot's Thread Block at the top left of it, showing its current thread. That Block isn't
  closed, moved, floated, minimized or swapped, its thread isn't deleted from it, and no Block
  goes before it, to its left or above it; other Blocks, terminals and the like, dock to its
  right or below, or float. No second Thread Block is offered. When the Bot starts a new thread,
  or another device's write leaves something else there, the app puts the Bot's current thread
  back at the top left, the Block that left taking its thread with it, running. Once the Bot is
  removed, its Session is an ordinary one, under its Host.
- **Before its first thread** the Bot shows an empty conversation, whose first prompt goes
  through `bots/send` and starts the thread; the Session is made once the Bot lists it.
- **Its avatar** (WVE-223) is its emoji on its colour, in a circle, in its row in the list, atop
  its Session and on its page, with the robot for one with no emoji and a neutral circle for one
  with no colour. Its page's avatar opens a picker, on a Dispatcher with `bots_avatar`: emoji to
  pick from or type, the eleven colours, and Reset, each pick saved as it's made. Shapes, pictures
  and animation, as Grok Bot's avatars have, are left for later.
- **Its page,** from its name: its settings, changed with `bots/update` (name, mode, a new thread
  daily and how long a request may wait), its policy, shown only; its schedules and wake-ups,
  each paused or resumed, run now or removed, with no form to add one; its earlier threads,
  read-only; the threads it started elsewhere, by Project or else by Host, each given a Block in
  its directory's Session when tapped, the Session made if there's none; New thread
  (`bots/newThread`) and Remove.
- **Notifications** on the Mac are of a Bot's current thread too, as of a thread in a Session.

### Not yet

- The Dispatcher saving a Bot's memory and prompting `/compact` below the agent's own threshold,
  and a new thread when compacting stops freeing enough, from listings' context usage (WVE-174).
  The agent compacts itself, and the home's `AGENTS.md` tells it to write memory as it goes.
- A trigger running in a fresh thread whose result the Dispatcher relays to the Bot's thread.
  The Bot starts a delegated thread itself, and the Host's report comes back (ADR 0023).
- The Dispatcher choosing a Bot's Host, and a Bot moving to another by cloning its home there,
  which wait for WVE-217 and a successor on another Host: `thread/setSuccessor` names only a
  thread on the same Host. A home recorded as a Project's locations are, with its remote,
  waits for moving too.
- A push when a Bot's requests go unanswered (WVE-177). "Unread" is each device's own, in the
  app (WVE-178), not in the Bot's state.
- Changing a Bot's policy in the app.
- Bots in the TUI.

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
id, device?, features}`

Another `protocol` answers `incompatible_protocol`. `auth` is the Host's (`device` or `pair`),
and none on the socket; `device` is the paired device a WebSocket client connected as.
`features` names the optional parts of the API it answers: `projects` for `projects/*`
(WVE-189); `bots` for `bots/*`, `schedules/add`'s `bot` and `at`, and what `Schedule` says
of them (WVE-118); `bots_home` for `bots/add` having the Bot's Host make its home, without
`home` for `~/bots/<name>`, with `job`, answering what making it did, `Bot`'s `createdBy` and
`createdByName`, and `schedules/list`'s `bot` (WVE-178); `bots_watch` for `bots/watch` and
`bots/unwatch` (WVE-178); and `bots_avatar` for a Bot's `emoji` and `color`, which `bots/add` and
`bots/update` take (WVE-223). One from before them says none, and the API's version stays 2; the CLI
says such a Dispatcher is older than what it asks for, and to update it.

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

**`schedules/list`** `{bot?}` → `{schedules: Schedule[]}`

Every schedule, or with `bot` (feature `bots_home`), by id or name, only those naming that Bot,
its wake-ups among them; invalid params, "there's no Bot …", for none.

```ts
type Schedule = {
  id: string; name: string;
  cron: string;          // "" for a one-off
  at?: number;           // a one-off's time (feature bots)
  zone: string;
  hostId: string; hostName: string;
  botId?: string; botName?: string;   // the Bot it prompts (feature bots)
  wakeUp?: true;         // a Bot's own wake-up, which its thread asked for (feature bots)
  agentId: string; cwd: string; prompt: ContentBlock[]; policy: PermissionPolicy;
  mode?: string; thread?: string;     // a Bot's: its agent, home, policy, mode and thread now
  missed: "latest" | "skip"; overlap: "skip" | "allow";
  createdAt: number;
  paused?: string;       // why
  failures: number;      // failed or interrupted occurrences in a row
  nextAt?: number;       // unless paused; none for a one-off once its time has come
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

**`schedules/add`** `{name, cron?, at?, zone?, host?, agentId?, cwd?, prompt, policy?, mode?,
thread?, bot?, missed?, overlap?}` → `{schedule}`

`cron`, or `at` for a one-off (feature `bots`); and `host` with `agentId`, `cwd` and `policy`,
and maybe `mode` or `thread`, or `bot`, by id or name, in place of all of those (feature
`bots`). Invalid params, saying why, for an empty name or prompt, a name taken, both or neither
of `cron` and `at`, a cron expression or zone that doesn't parse, an `at` that has passed, a
Host that hasn't joined it, no such Bot, a Bot with any of what it stands in place of, neither a
Bot nor a Host with `agentId`, `cwd` and `policy`, or `overlap: allow` with a thread or a Bot. It
first considers times after it's added.

**`schedules/remove`** `{schedule}` → `{}`, **`schedules/pause`** `{schedule}` → `{schedule}`,
**`schedules/resume`** `{schedule}` → `{schedule}`

By id or name. Removing forgets its occurrences; a turn it started runs on.

**`schedules/run`** `{schedule}` → `{occurrence}`

Runs it now, paused or not, as an occurrence of its own (`manual`), which overlap may skip.

**`occurrences/list`** `{schedule?, limit?}` → `{occurrences: Occurrence[]}`

Newest first, 50 by default.

**`projects/list`** `{}` → `{projects: Project[]}`

```ts
type Project = {
  id: string; name: string;
  kind: "git" | "directory";
  remote?: string;            // a git Project's repository's remote: "github.com/owner/name"
  locations: {hostId: string; path: string}[];   // at most one per Host, as they were added
  createdAt: number; updatedAt: number;
};
type NewLocation = {hostId: string; path: string; kind: "git" | "directory"; remote?: string};
```

By name. Only with the `projects` feature, as are the rest.

**`projects/get`** `{project}` → `{project}`

By id or name, ignoring case; invalid params, "there's no Project …", for none.

**`projects/add`** `{name, location: NewLocation}` → `{project}`

A new Project of the kind its first location is. Invalid params, saying why, for an empty name or
one of more than one line, a name another Project has ignoring case, a Host that hasn't joined,
a path that isn't whole, or a location another Project has.

**`projects/update`** `{project, name?, removeHost?, add?: NewLocation}` → `{project}`

In that order, all or none: renames it, removes its location on a Host (by id or name), and adds
one. Adding is refused for a location of another kind, a repository with another remote, or a
Host it has a location on still (removing that one in the same request moves it); the same
location again changes nothing. `updatedAt` moves when anything changed.

**`projects/remove`** `{project}` → `{}`

Forgets it and its locations; what's in its directories stays.

**`bots/list`** `{}` → `{bots: Bot[]}`

```ts
type Bot = {
  id: string;                 // "b-" and 20 hex digits
  name: string;
  emoji?: string;             // its avatar's emoji, once given one (feature bots_avatar)
  color?: BotColor;           // the colour its avatar is drawn on, once given one
  agentId: string;
  hostId: string;
  hostName: string;           // what the Dispatcher calls its Host now
  connected: boolean;         // whether the Dispatcher is connected to its Host now
  home: string;               // on its Host: whole, as the Host made it; "~/…" for some added
                              // before WVE-178
  policy: PermissionPolicy;   // its new threads'
  mode?: string;              // its new threads'; the agent's configured one when absent
  newThreadAt?: string;       // "HH:MM" in zone: a new thread daily then
  zone: string;
  pauseAfter: number;         // how long a request may wait for the person, in ms
  thread?: string;            // its current thread; none until its first prompt reaches it
  threads: {threadId: string; startedAt: number; endedAt?: number}[];   // oldest first
  state: "working" | "needsYou" | "idle";
  waitingSince?: number;      // since when a request in its thread has waited for the person
  paused?: string;            // why its schedules' occurrences are skipped
  startingThread?: true;      // a new thread is being started; its prompts wait for it
  createdAt: number; updatedAt: number;
  createdBy?: string;         // the Bot that made it, by id, when one did (feature bots_home)
  createdByName?: string;     // that Bot's name now; absent once it's gone
};

type BotColor = "white" | "brown" | "red" | "orange" | "yellow" | "green" | "teal" | "blue"
  | "purple" | "pink" | "gray";   // by name: each client draws them in its own theme's
```

By name. Only with the `bots` feature, as are the rest.

**`bots/get`** `{bot}` → `{bot}`

By id or name, ignoring case; invalid params, "there's no Bot …", for none.

**`bots/add`** `{name, host, agentId, home?, job?, policy?, mode?, newThreadAt?, zone?,
pauseAfter?, emoji?, color?}` → `{bot, home?}`

A new Bot, with no thread yet ([Bots](#bots)), whose Host makes its home first (feature
`bots_home`, WVE-178; [Its home](#its-home)). `home` is `~/bots/<name>` when absent, the name
lowercased with a hyphen for each run of spaces or slash; `job`, what it's for in the person's
words, goes in its first `AGENTS.md`. `policy` approves nothing and asks about the rest when
absent, `zone` is the Dispatcher's computer's, and `pauseAfter` is 12 hours (43200000). The
answer's `home` is `repos/init`'s: the directory, whole, whether it was made and made a
repository, and whether the memory files were committed, kept what was there, or are
uncommitted and why ([A repository of its own](wve-85-host-protocol.md#a-repository-of-its-own));
the Bot's `home` is that directory.

Invalid params, saying why, for an empty name or one of more than one line, a name another Bot
has ignoring case, a Host that hasn't joined, an empty agent, a home neither whole nor under
`~`, a name that makes no directory name without a `home`, a zone that doesn't parse, or a
`newThreadAt` that isn't `HH:MM`, or an `emoji` `bots/update` would refuse; then `host_unavailable` while the Host isn't connected, or the
Dispatcher's request to it fails on the way, and invalid params when its weave is too old to
make a home (no `repos_init`) or it refuses, as for a directory inside another repository,
saying why in its words. No Bot is added then, and for any of the first, nothing is made. Before
`bots_home`, `home` was needed and `{bot}` the answer, and the CLI made the home itself.

**`bots/update`** `{bot, name?, policy?, mode?, newThreadAt?, zone?, pauseAfter?, emoji?,
color?}` → `{bot}`

All or none, checked as `bots/add` checks them. Absent leaves a field as it is; `null` clears
`mode`, `newThreadAt`, `emoji` and `color`. An `emoji` (feature `bots_avatar`, WVE-223) is
trimmed, and invalid params when it's empty, longer than 64 bytes, or has a space, an ASCII
letter or digit, or a control character in it: the Dispatcher takes it for one emoji, whatever
that's made of, and doesn't check further. A policy or mode applies to threads started from then
on. A changed
`newThreadAt` or `zone` is considered from then, so it doesn't start a missed one. `updatedAt`
moves when anything changed.

**`bots/remove`** `{bot}` → `{}`

Forgets it, its schedules and the prompts still waiting for it; its threads and its home stay on
its Host.

**`bots/send`** `{bot, prompt, key?}` → `{deliveryId, bot}`

A prompt from a sender that isn't attached to the Bot's thread, written down as a delivery
([Bots](#bots)): into its current thread when first sent, or starting its first, or, while it
starts a new thread, waiting for that one. `key` is the sender's own name for it, unique for the
Bot: the same key again answers with the same delivery and sends nothing more. `deliveryId` is
what its turn's origin names as `id`; `bot` is the Bot as it stands now. Invalid params for an
empty prompt or no such Bot.

**`bots/newThread`** `{bot}` → `{bot}`

Begins the Bot's new thread ([A new thread](#a-new-thread)). Invalid params, saying why, for a
Bot with no thread yet, or one starting one already.

**`bots/watch`** `{}` → `{bots: Bot[]}`, **`bots/unwatch`** `{}` → `{}`

Feature `bots_watch` (WVE-178). The Bots, as `bots/list` gives them; then, to that connection,
`bots/updated` `{bot}` whenever one is added or anything `bots/list` gives of it changes (its
state, its Host connecting, going or renamed, its threads, a change through `bots/update`), and
`bots/removed` `{bot: <id>}` when one is removed, or its Host is, each change once, until the
connection ends or sends `bots/unwatch`. A change made before the answer reaches the client may
come before it, and is newer than it.

## The CLI

| Command | What it does |
| --- | --- |
| `weave dispatcher run [--listen <addr>] [--url <url>]` | runs it here until SIGTERM or SIGINT; its stderr is its log. `--listen` puts its WebSocket on another loopback address, and `--url`, what devices and Hosts connect to, leaves Tailscale Serve alone ([Devices](#devices)) |
| `weave dispatcher start \| stop \| restart` | through the service once it's installed, and otherwise runs `weave dispatcher run` in the background, logging to `dispatcher.log`, or stops it with SIGTERM; `start` and `restart` wait for it to answer. Stopping it drains nothing: its work is kept as it goes. |
| `weave dispatcher install` | has launchd (`local.weave.dispatcher`) or systemd (`weave-dispatcher.service`) run `weave dispatcher run` from login or boot and restart it, then waits for it to answer; on Linux it turns lingering on as `weave daemon install` does. A Dispatcher directory of its own (`WEAVE_DISPATCHER_DIR`, which the service is given) gets a service of its own, named after it. launchd won't start a weave in `~/Documents`, `~/Desktop` or `~/Downloads`, and a process it starts can't use a removable volume without the person's leave, so install from a copy elsewhere, such as `~/.local/bin/weave`. |
| `weave dispatcher uninstall` | stops the service and removes it |
| `weave dispatcher [status] [--json]` | its version, pid, uptime, name and waiting work, and its Hosts; from a paired computer, where it runs too |
| `weave pair [--name] [--json]` | on its computer, a code and a QR code (`weave://pair-dispatcher?url=…&code=…`) a device or another computer pairs with, waiting for it; `--json` prints the URL and code and doesn't wait. It was `weave dispatcher pair` until WVE-197, which gave the name the Host's pairing had to the Dispatcher's, as WVE-188 names top-level commands for what the person manages, leaving no alias |
| `weave devices [list [--json] \| revoke <id>]` | on its computer, the devices and computers paired with it, and revoking one, which closes what it carries for it; `weave dispatcher devices` until WVE-197 |
| `weave dispatcher connect <computer \| url code> [--name] [--host \| --no-host]` | on another computer, pairs it: over SSH runs `weave pair --json` there; keeps the pairing in `$XDG_STATE_HOME/weave/client` (`dispatcher.json` and the device's `key.json`, 0600), the key in the Secure Enclave on a Mac that has one; then offers to have this computer's Host join the Dispatcher |
| `weave dispatcher disconnect` | forgets the pairing and the key; the Dispatcher lists the computer until it's revoked there |
| `weave --host <host>`, `weave threads --host <host>`, `weave run --host <host>` | the TUI, `threads` and `run` on another of the person's Hosts, by id or name, through the Dispatcher running here or the one this computer is paired with ([Devices reaching Hosts](#devices-reaching-hosts)); this computer's own Host, by either, over its socket. A new thread works in this directory's counterpart under the home there, `~/…`, unless `--cwd` names one there; the Host says so when there's none. With neither Dispatcher, it says to run `weave dispatcher connect` |
| `weave hosts add [computer \| url code] [--name] [--json]` | has a Host join it: this computer's, given neither, over the Dispatcher's socket when it runs here; another's over SSH, which runs `weave hosts add <url> <code>` there; or, on the Host's computer, with a URL and code; `--json` prints what the Host joined |
| `weave hosts add --code [--json]` | a URL and code for `weave hosts add <url> <code>` on a computer SSH doesn't reach |
| `weave hosts [list] [--json]` | the Hosts that joined it, and how each stands |
| `weave hosts remove <host>` | removes one, which forgets the Dispatcher, and its Projects' locations |
| `weave daemon status` | names the Dispatcher the Host joined and whether it's connected |
| `weave schedules [list] [--json]` | the schedules, when each runs next and how it last went |
| `weave schedules add <name> --cron <expr> --host <host> --agent <id> [--cwd] [--zone] [--thread \| --mode] [--approve <kinds>] [--missed latest\|skip] [--allow-overlap] -- <prompt>` | adds one; `--cwd` is this directory when omitted, `--approve` is `weave run`'s, and the prompt is read from stdin when omitted |
| `weave schedules add <name> --at <time> …`, `weave schedules add <name> --bot <bot> (--cron <expr> \| --at <time>) [--zone] [--missed latest\|skip] -- <prompt>` | `--at` in place of `--cron` adds a one-off: `2026-11-12 09:00` in `--zone`, or this computer's zone without one, which it's then given, or `2026-11-12T09:00:00+02:00`; a time that has passed is refused. `--bot` prompts a Bot in place of `--host`, `--agent`, `--cwd`, `--project`, `--thread`, `--mode`, `--approve` and `--allow-overlap`, which it can't be given with. A Dispatcher without the `bots` feature is said to be older than one-offs or Bots |
| `weave schedules remove \| pause \| resume \| run <schedule>` | as the API's methods |
| `weave schedules occurrences [<schedule>] [--limit] [--json]` | what they did, newest first |
| `weave projects [list] [--json]` | the Projects and where each is, Hosts by the names `hosts/list` gives; while the Dispatcher doesn't answer, the list it gave last, which the CLI keeps in `$XDG_STATE_HOME/weave/client/projects.json`, saying how old it is on stderr (none is kept for a Dispatcher named with `$WEAVE_DISPATCHER_DIR`) |
| `weave projects add [DIR] [--name N] [--to P] [--host H] [--json]` | registers DIR, this directory by default, on this computer's Host or with `--host` another's (a `~/` path there under the home there, as `--cwd` takes it): asks that Host where it lies in git (`worktrees/list`, and `files/list` for the home there), then the Dispatcher. A new Project is called `--name`, or after its directory. `--to` adds it to a Project as that Host's location. A clone whose remote a Project with no location on that Host has is offered to it, "odin has this repository on homelab; add this clone to odin? [Y/n]"; with no terminal, or with `--json`, it's refused, saying to give `--to` or `--name`. A plain directory joins only with `--to`. A location registered already is said to be so |
| `weave projects show <project> [--json]` | one, and its id |
| `weave projects rename <project> <name> [--json]` | `projects/update` with `name` |
| `weave projects update <project> --remove-host <host> [--json]` | removes its location on one Host |
| `weave projects remove <project> [--json]` | forgets it; `--json` prints `{}` |
| `weave --project <p>`, `weave run --project <p>`, `weave schedules add --project <p>` | work in the Project's location on the Host in question: `--host`'s, or this computer's without it (`schedules add` always names one), a git Project's primary worktree. Never another Host's: a Project with no location there is refused, saying where it is and `weave projects add --to <p> [--host <h>] <dir>`. Refused with `--cwd`. While the Dispatcher doesn't answer, it goes by the last list |
| `weave threads [list] --project <p> [--host <h>]` | only the threads `containing` places in that Project on that Host, the thread's Host id from its hello |
| `weave bots [list] [--json]` | the Bots, a line each: its state, agent, Host, and thread or none yet, and "made by" the Bot that made it, if one did |
| `weave bots add <name> --agent <id> [--host <host>] [--home <dir>] [--job <text>] [--approve <kinds>] [--mode] [--new-thread-at HH:MM] [--zone] [--pause-after <duration>] [--emoji] [--color] [--json]` | adds a Bot on this computer's Host, or `--host`'s, whose Host makes its home first ([Its home](#its-home)), here or on another computer alike, and says what that did (on stderr with `--json`). `--home` is `~/bots/<name>` when omitted; a directory there, whole or `~/…`, and on this computer's Host one relative to this directory too. `--job` is what it's for, which its first `AGENTS.md` says. `--approve` names what its threads approve without asking, as `weave run`'s does, and it asks about the rest; `--pause-after` takes `90s`, `30m`, `12h`. A Dispatcher without `bots_home` is said to need updating (WVE-178) |
| `weave bots show <bot> [--json]` | one, by the flags that set it: its threads, its schedules (`schedules/list` with `bot`), wake-ups said to be its own, and the Bot that made it |
| `weave bots update <bot> [--name] [--approve <kinds> \| --no-approve] [--mode \| --no-mode] [--new-thread-at HH:MM \| --no-new-thread-at] [--zone] [--pause-after] [--emoji] [--color] [--no-avatar] [--json]` | `bots/update`, refused with nothing to change; `--color` is one of the eleven names, and `--no-avatar` clears both; it says when the thread it has open keeps the approvals and mode it started with |
| `weave bots remove <bot> [--json]` | forgets it and its schedules, saying its threads and home stay where they are; `--json` prints `{}` |
| `weave bots send <bot> [<prompt>…] [--key <key>] [--json]` | `bots/send`, the prompt read from stdin when omitted or `-`; it says where the prompt goes: into the thread, after the turn running there, starting the first, or waiting for a new thread or for the Bot's Host |
| `weave bots new-thread <bot> [--json]` | `bots/newThread`, saying what happens next |

A command that asks the Dispatcher asks the one running from this computer's Dispatcher
directory if one answers, and otherwise the paired one, and says both when neither does. With
`$WEAVE_DISPATCHER_DIR` set it asks only that one. On a paired computer, `weave dispatcher run`,
`start`, `restart` and `install` refuse, and `weave pair` and `weave devices` say where it runs.

Until WVE-178, `weave bots add` made a Bot's home itself, and only on this computer's Host: for
another's it said what to run there. The Bot's Host makes it now, wherever the CLI runs
([Its home](#its-home)).

## Acceptance

- `tests/dispatcher.rs`: two in-process Hosts join with codes its socket gave, each through a
  relay to `hosts.sock`; it starts a headless turn on
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
  a turn the named Host stops under followed into its continuation; with Odin at different
  paths on two Hosts, an agent lists the Projects, starts threads by Project on each, in a
  directory inside it too, and lists them by Project, while an unknown Project, one with no
  location on the Host, and a `cwd` outside it are refused; a thread in a Project starts on
  another Host in the Project's location there, not the same path under the home, and fails
  naming the Hosts that have it when it has none there (WVE-208).
- `tests/devices.rs` (WVE-176), over a loopback WebSocket with a fake Serve: a device pairs with
  a code once, proves its key at hello and lists Hosts and schedules; another key, an unknown
  device, a Host's message, a reused challenge and a hello without one are refused and closed;
  `devices/*` answer `forbidden` to a device; devices and remote access outlive a restart;
  revoking closes the device's connections, and the last one gone, or an offer nobody took,
  removes the Serve entry; a device may ask `hosts/offer` but not for the socket; the WebSocket
  refuses an upgrade without its subprotocol or with an `Origin` that isn't allowed, and closes a
  client that proves nothing within its deadline or stops answering pings (moved from the Host's
  own WebSocket's tests, WVE-197). CLI `tests/dispatcher.rs`: `weave pair` and `weave devices` on
  its computer, and where it runs from a paired one; `weave dispatcher connect` with a code and
  over SSH, `weave hosts` and `weave schedules` through the pairing, and `disconnect`; with a Host on the computer, `connect`
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
  local client, and anything else on a connection it opened for it; removing a Host closes
  what's carried to it and nothing else; a client on the Dispatcher's computer goes through its
  socket as its computer; a terminal's stream goes through, refused with another device's ticket
  and closed when the device is revoked; a carried device may do everything but administer the
  Host; a replay many times the Host's backlog limit reaches a device whole (the last two moved
  from the Host's own WebSocket's tests, WVE-197). CLI `tests/dispatcher.rs`:
  `weave run --host` and `weave threads --host` reach a Host as on another computer, in the
  directory's counterpart under the home there.
- The app (WVE-196), `app/src/host/*.host.test.ts` against a dev Dispatcher whose WebSocket has a
  URL of its own, so nothing touches Serve, and dev Hosts that joined it over its socket: pairing,
  proving the device and listing Hosts; threads opened, prompted, steered and answered through
  it; a network dropped mid-turn and a Host restarting, caught up with nothing missing or
  repeated; the Dispatcher stopping and starting again, its last Hosts shown meanwhile; a Host it
  can't reach, and one it removes; a revoked device; a terminal's stream through it. The app's
  unit tests do the same against a scripted Dispatcher, and the shell's core has its own
  (`app/src-tauri/tests/relay.rs`), terminals' streams through a dev Dispatcher included.
- `tests/projects.rs` (WVE-189), two Hosts, through the socket and through a paired device: a
  Project added, renamed, given a second Host's location and removed; a name taken ignoring
  case, a second location on one Host and a clone of another repository refused; a directory
  Project refusing a repository, and a Host that never joined; removing a Host drops its
  locations, all of them leaving the Project with none; Projects outlive a restart. The store's
  unit tests check moving a location and a git Project taking a remote. `containing`'s unit
  tests in `protocol/src/projects.rs`: a registered repository's worktrees, a Project in a
  subdirectory of another's, a directory outside any repository, and other Hosts. CLI
  `tests/dispatcher.rs`: `weave projects add --host` on another computer's Host and in a clone
  here, refused without a terminal and joined with `--to`; listing, showing, renaming, removing a
  location and a Project, each `--json` parsing as the protocol type it claims; `weave run
  --project --host` and `weave threads --project`; `--project` refused where the Project has no
  location; and the last listing, and `--project`, while the Dispatcher is away.
- `tests/bots.rs` (WVE-118), a Host with the fake agent, on a clock the test moves: a Bot added,
  listed, got, changed and removed through the socket and through a paired device, with a name
  taken ignoring case, an unknown Host, a home neither whole nor under `~`, a `newThreadAt` or
  zone that doesn't parse, a name of two lines, a new thread with no thread and an empty prompt
  refused; a Host's own connection reaching no `bots/*`; removing a Host removing its Bots and
  their schedules; the first prompt starting the Bot's thread in its home with its labels and
  policy, two sent before it's answered starting one, and later prompts and a schedule's
  occurrences going into it in order; its state following its thread; a new thread asked for
  while its thread waits on the person, prompts and an occurrence waiting for it across a
  Dispatcher restart, the old thread saving itself, the new one taking over as its successor,
  and what waited going into it; a new thread across a Dispatcher restart at each step, with the
  Host's answers lost, and a Host restart, starting nothing twice; a daily new thread at its
  time only after a turn, and one for days missed while the Dispatcher was stopped; pausing while
  its thread waits on the person, occurrences skipped while `bots/send` still delivers, and going
  on once answered; a one-off prompting a Bot once, caught up late after a restart and not again
  after another, with both or neither of `cron` and `at`, a time that has passed, a Host beside
  the Bot, `overlap: allow` and an unknown Bot refused; a Bot's thread woken once at the time
  it asked for, late and once only across restarts, then no longer to come and forgotten a week
  after; wake-ups refused to a thread that isn't a Bot's, less than a minute away and past 20,
  and listed and cancelled by their own Bot only; a wake-up due while its Bot is paused skipped,
  saying why. The store's
  unit tests: names, the first thread answered and each new-thread step once, a new thread the
  Host refuses, and wake-ups counted, listed, cancelled and forgotten. CLI `tests/dispatcher.rs`:
  `weave bots` through this computer's pairing, a Bot on this computer's Host and one on
  another's, each Host making its home (WVE-178), with its job; listing, showing and changing
  them; the first prompt starting the thread in its home, the next going into it, a key sending
  once, and a new thread taking over; `weave schedules add --bot` with `--cron` and `--at`, a time
  that has passed and `--bot` beside what it stands in place of refused; removing, its home
  staying; and a home keeping what was there, the person's own `AGENTS.md`, a repository's
  commits and what's staged, a home given relative to this directory, and one inside another
  repository refused with no Bot added.
  `protocol/tests/wire.rs`: the Bot, its requests and answers, a Bot's schedule and its wake-up,
  and an older client's schedule reading as before; `bots/add` with a job and its answer,
  `bots/watch`, `bots/unwatch` and their notifications, `schedules/list` for a Bot, and
  `repos/init` and its answers.
- `tests/bots.rs` (WVE-178): `bots/add` having the Bot's Host make its home, `~/bots/<name>` by
  default, a repository of its own with its first memory files committed saying its job, and
  what was there kept, while what the Dispatcher refuses makes nothing and no Bot is added with
  its Host away or refusing; a Bot another made naming it, by name while it's there, which the
  API never sets; `bots/watch` hearing of each change once, until unwatched; `schedules/list`
  for a Bot listing only its schedules, its wake-ups too; a Bot's thread making another with
  `create_bot`, its maker, home, job, agent and zone recorded and nothing else happening until
  the person prompts it, watchers hearing of it, `list_bots` listing both, and what `bots/add`
  refuses coming back as the tool's error; a Bot's avatar, each part given, changed and cleared
  alone, a word for an emoji refused with nothing changed, and the Bot setting its own with
  `set_avatar` and no other's (WVE-223); a thread that isn't a Bot's refused by every new tool;
  a Bot making another only while there are fewer than 20, the person adding one regardless; a
  Bot adding a schedule of its own, listing it with the person's for it but not its wake-ups or
  another Bot's, it coming into the Bot's thread at its time with its origin saying the Bot made
  it, and pausing, resuming and removing its own and the person's for it, by id or name, but not
  another Bot's nor its wake-ups; and `add_schedule` refusing what `schedules/add` would, one
  coming more often than every five minutes, and one past 20, the person's counted but not its
  wake-ups. Unit tests: a home's default name and first files, the five-minute rule over the
  turn of the day, a made Bot naming its maker after it's gone, and a Bot's schedules counted
  and added once per call.
- The app's Bots (WVE-178): `app/src/host/bots.host.test.ts`, against a dev Dispatcher and a dev
  Host that joined it, each Bot's home under the dev Host's directory: the Bots listed with their
  state as the watch tells it, a first prompt through `bots/send` showing in the thread it
  starts, the Bot's Session kept out of the list of Sessions, and its Thread Block following it
  to a new thread. `bots-store.test.ts`, against a scripted Dispatcher: watched, with what's told
  before the answer made again on it, and again after a reconnect; listed where it keeps Bots but
  doesn't watch; none where it keeps none; adding, changing and removing, saying why not.
  `src/session/bots.test.ts`: a row's state, a Bot's Session and Thread Block, what may be
  dropped in its Session, and the threads it started elsewhere. `src/components/bots/bots.test.tsx`,
  on the mock controller: the list, the Bot's Session, its first prompt and new thread, its page,
  and New Bot.
- Live: the Dispatcher on the homelab as a systemd user service, and `weave hosts` and
  `weave schedules` from the Mac; the Mac's and homelab-1's Hosts join it, and a schedule works
  without the Dispatcher dialing either. A thread on homelab-1 opened from the Mac's CLI through
  the Dispatcher (WVE-195). Still to check live (WVE-118): a Claude Bot on one of the person's
  Hosts over several days, through its schedules, wake-ups and new threads.

## Later

- Webhooks (WVE-146) make deliveries as schedules do; the edge (WVE-117) holds webhook
  deliveries and pushes for it.
- More of the Dispatcher's own tools, declared with `service/declareTools` (WVE-171) beside a
  Bot's: schedules of other agents' own (WVE-173).
- Choosing the Host a piece of work runs on, which a delivery's Host can become a rule for, and
  a Bot moving to another Host ([Not yet](#not-yet), WVE-217).
- What Bots don't do yet ([Not yet](#not-yet)).
- Projects: `projects/watch`, agents naming Projects through the
  Host tools (WVE-208), and Sessions of a Project's worktrees (WVE-202).
