# WVE-90: Remote clients of the weave Host

Status: implemented, and checked live through Tailscale Serve from the Host's own Mac on
2026-10-16. From 2026-10-21 pairing turned the Host's remote access on, and the Host kept its own
Serve entry (WVE-100). From 2026-10-30 the person's other Hosts paired and connected as peer Hosts
(WVE-109), until 2026-11-04, when the Dispatcher took that over and peer Hosts were retired
(WVE-185). Since 2026-11-06 the person's devices pair with the Dispatcher the same way, with the
server's end shared in `weave-remote` ([WVE-175's Devices](wve-175-dispatcher.md#devices),
WVE-176); since 2026-11-07 a Host joins the Dispatcher and connects to it itself, over the same
WebSocket code ([WVE-175's Hosts](wve-175-dispatcher.md#hosts), WVE-194); and since 2026-11-08 a
device paired with the Dispatcher reaches every Host through it, which carries its connection to
the Host ([WVE-175's Devices reaching Hosts](wve-175-dispatcher.md#devices-reaching-hosts),
WVE-195), the app among them (WVE-196, [WVE-175's app](wve-175-dispatcher.md#the-app)). On
2026-11-08 Hosts stopped taking remote connections of their own (WVE-197): their WebSocket,
Serve entry, pairing and devices are retired ([below](#the-hosts-own-remote-access-retired)). The
decisions are recorded in
[ADR 0010](../adr/0010-remote-clients-through-the-tailnet-with-device-keys.md),
[ADR 0016](../adr/0016-pairing-turns-on-remote-access-and-the-host-keeps-its-serve-entry.md),
[ADR 0027](../adr/0027-the-dispatcher-starts-work-on-the-persons-hosts-as-a-client-of-them.md),
[ADR 0029](../adr/0029-agents-reach-the-persons-other-hosts-through-the-dispatcher.md) and
[ADR 0030](../adr/0030-the-dispatcher-is-the-hub-hosts-dial-out-to-it-and-devices-reach-every-host-through-it.md).

## Purpose

Let a client on another of the person's devices, starting with the app (WVE-91), connect to a
Host and use it as the TUI does: list, open and attach to threads, prompt and steer, and answer
pending requests. They speak the Host protocol ([`wve-85-host-protocol.md`](wve-85-host-protocol.md)),
over a connection the Dispatcher carries to the Host. This covers that transport, pairing and
proving a device, and what a remote client may do on a Host.

## Decisions

- **The tailnet is the only way in, and only the Dispatcher listens there.** A device must be in
  the tailnet of the Dispatcher's computer. The Dispatcher listens on loopback, and Tailscale
  Serve, never Funnel, forwards to it, with TLS on the tailnet's certificate. A Host listens for
  nothing but its own Unix socket: it opens its connections to the Dispatcher itself (ADR 0030).
- **A device proves itself on every connection** by signing a challenge of the Dispatcher's with
  a P-256 key that never leaves it, in the Secure Enclave on Apple devices. The Dispatcher proves
  its own key to each Host, which takes its word for which device a connection is for.
- **A paired device can do what a local client can,** except administer the Host.

## Topology

```text
iPad · iPhone · the CLI on another computer
                 │  wss://<computer>.<tailnet>.ts.net:7342, tailnet devices only
                 ▼
Tailscale Serve on the Dispatcher's computer: TLS with the tailnet's certificate
                 │  ws://127.0.0.1:7342
                 ▼
Dispatcher (`weave dispatcher run`) ◄── connections each Host opened to it ── Host (`weave daemon run`)
                                                                                │  Unix socket
                                                                                ▼
                                                                  TUI · weave run · weave threads
```

## Principles

1. **Only the tailnet reaches a listener.** The Dispatcher binds loopback and nothing else, and
   Serve, which accepts only the tailnet's devices, is the way in. It keeps one Serve entry of
   its own, on HTTPS port 7342, touches no other, and refuses while Funnel would put it on the
   internet. A Host binds nothing reachable from another computer.
2. **Every connection proves who it is.** Serve's connections and any local process's arrive at
   the Dispatcher the same way, from loopback, so where a connection comes from counts for
   nothing there: each proves a paired device, or a Host its key. On a Host, only a connection
   the Host opened to the Dispatcher it joined, after the Dispatcher has proved its key there,
   takes the Dispatcher's word for a device.
3. **No program keeps a device's secret.** The Dispatcher stores each device's public key, and a
   Host the Dispatcher's. Pairing codes live in the Dispatcher's memory for minutes.
4. **A paired device acts for the person.** An agent's shell isn't confined to its thread's
   directory, so a list of allowed directories wouldn't be a boundary. Revoking the device is
   the control.
5. **Nothing else changes.** Threads, turns, the journal and pending requests work as on the
   Unix socket. After a network drop or a backgrounded app, a client reconnects and attaches
   after its position, as the TUI does.

## The Dispatcher's WebSocket

Turning it on, its Serve entry and pairing are [WVE-175's Devices](wve-175-dispatcher.md#devices).
The connection itself is `weave-remote`'s, which a Host also serves the Host protocol with over
the connections it opens to the Dispatcher:

| Transport | Framing | Authentication |
| --- | --- | --- |
| The Dispatcher's WebSocket, `weave-dispatcher` | One JSON-RPC message per text frame: its API | `device`, or `pair` once, at `dispatcher/hello` |
| The Dispatcher's WebSocket, `weave-dispatcher-carry` | Its preamble, then one Host's protocol, or a terminal's stream, passed through | `device` at `dispatcher/hello`, then `dispatcher` at the Host's `host/hello` |
| A connection a Host opened to the Dispatcher it joined, `weave-dispatcher-host` | Its preamble, then the Host protocol with the Dispatcher as client | the Dispatcher's key, `device`, at `host/hello` |
| A connection a Host opened to the Dispatcher to carry a device's | Its preamble, then the Host protocol or a terminal's stream | `dispatcher`, the device the Dispatcher named |

- The upgrade must offer one of the subprotocols the program takes. Others are refused before
  any message.
- `Origin`: none is accepted, since native clients send none, and so is the app's,
  `capacitor://localhost`, which its web view sends (WVE-91; seen from the iOS simulator on
  2026-10-20) and no web page can. Any other value must be one the program is configured with.
  Both are checked at the upgrade, which stops web pages, DNS rebinding included.
- A message is at most 32 MiB; a larger one closes the connection.
- Each end pings every 20 seconds and closes a connection that hasn't answered 20 seconds later.
- A connection that hasn't proved itself within 30 seconds is closed (4002).
- **Falling behind.** A connection whose unsent messages pass 8 MiB, beyond the replays it asked
  for, is closed (4001). Attaching gives the connection room for its replay, which shrinks as the
  replay is sent, so a long journal reaches a slow client whole. The Dispatcher reads from a Host
  only as fast as the device takes it, so this is the Host's limit on its end of a carried
  connection. The client reconnects and attaches after its position, so it misses nothing. The
  Unix socket keeps buffering, as before.

Close codes:

| Code | Meaning |
| --- | --- |
| 4000 | The device was revoked |
| 4001 | The client fell behind |
| 4002 | The connection failed its hello, after its error |

## Through the Dispatcher

A device paired with the Dispatcher reaches a Host through it, on a connection the Host opens
itself ([the Host protocol](wve-85-host-protocol.md#connections-the-dispatcher-carries)):

- The device proves its key to the Dispatcher, and names the Host in `hosts/open`. Over the
  Host's own connection the Dispatcher asks `dispatcher/carry` with a one-time token and the
  device; the Host opens another connection where it joined the Dispatcher and presents the
  token with a nonce of its own; the Dispatcher joins the two and passes the frames through
  unread.
- The Dispatcher proves its key on that connection too: it signs the Host's nonce, bound to the
  token and both ids, and the Host checks the signature with the key it learned when it joined.
  Until it has, the Host serves nothing there, and with no signature or a wrong one it closes the
  connection (4002).
- The device's `host/hello` says `auth: {method: "dispatcher"}`, which the Host takes on such a
  connection only, and refuses on its socket and in-process. Its answer names the device the
  Dispatcher named in `device`.
- Pings stay with each side. The Host's fallen-behind close (4001) and the rest pass through to
  the device, which reconnects and attaches after its position, as here.
- A terminal's stream is carried the same way, with `stream: "terminal"`, and a ticket the
  Host gave the same device.

## Host identity

The Host has a random id, made when it first starts and kept in `devices.json`. `host/hello`
gives it as `host.id`, so a client tells Hosts apart, and the Dispatcher's challenge to it at
hello is bound to it.

## Pairing

A device pairs with the Dispatcher, once ([WVE-175's Devices](wve-175-dispatcher.md#devices)):

1. On the Dispatcher's computer, `weave pair [--name <device>]` asks it for an offer
   (`devices/offer`), which turns its WebSocket on and answers with the URL, and shows it as a QR
   code and as text: the URL and a code. The QR code encodes
   `weave://pair-dispatcher?url=<url>&code=<code>`, which the app opens. An offer is good for one
   pairing within five minutes, lives only in the Dispatcher's memory, and at most three are
   live. `weave pair` waits and says which device paired; `--json` prints the URL and code for
   `weave dispatcher connect`, which pairs another computer's CLI over SSH.
2. The device shows the URL's host name and has the person confirm it before it connects.
3. The device makes its key: P-256, in the Secure Enclave where there is one, otherwise a key
   that can't be exported or leave the device (Keychain, `ThisDeviceOnly`).
4. It connects and says `dispatcher/hello` with `auth: {method: "pair", code, device: {name,
   publicKey}}`. `publicKey` is a JWK (`{"kty": "EC", "crv": "P-256", "x": …, "y": …}`); an
   offer made with `--name` uses that name instead. The Dispatcher takes the offer, so a second
   use fails, records the device, and answers with `device: {id, name}`.

The code is 128 random bits in Crockford base32.

## Authenticating

To the Dispatcher, on every connection from a paired device: `dispatcher/challenge`, then
`dispatcher/hello` with `auth: {method: "device", deviceId, signature}`, signing
`weave-dispatcher-auth/1 <dispatcherId> <deviceId> <nonce>`
([WVE-175's Devices](wve-175-dispatcher.md#devices)).

To a Host, the Dispatcher it joined, on the connection the Host opened to it:

```json
{"jsonrpc": "2.0", "id": 1, "method": "host/challenge", "params": {}}
```

```json
{"jsonrpc": "2.0", "id": 1, "result": {"hostId": "…", "nonce": "…", "expiresAt": 1760180030000}}
```

```json
{"jsonrpc": "2.0", "id": 2, "method": "host/hello", "params": {
  "protocol": {"min": 3, "max": 3},
  "client": {"name": "weave-dispatcher", "version": "0.1.0"},
  "auth": {"method": "device", "deviceId": "<the Dispatcher's id>", "signature": "…"},
  "capabilities": {}
}}
```

- `host/challenge` is answered before hello, and only there. Its nonce is 32 random bytes,
  base64url, good for one hello on this connection within 30 seconds.
- The Dispatcher checks that `hostId` is the Host that joined it, then signs the UTF-8 bytes of
  `weave-host-auth/1 <hostId> <dispatcherId> <nonce>` with ECDSA P-256 and SHA-256, with the key
  the Host learned when it joined. `signature` is the DER signature in base64url, which is what
  Apple's `SecKeyCreateSignature` gives with `ecdsaSignatureMessageX962SHA256`.
- Every failure (another key, a wrong signature, a missing, used or expired nonce) answers
  `unauthenticated` with the same message, and the Host closes the connection (4002).
- A Host takes `local` only on its Unix socket and in-process, where `device`, `pair` and
  `host/challenge` are refused. It refuses `pair` everywhere: it pairs with nothing. `dispatcher`
  is refused everywhere but a connection the Host opened to carry a device's for the Dispatcher
  it joined, which takes nothing else, and no `host/challenge`. `token` stays reserved and
  refused; a later major version removes it.

## What a remote client may do

Everything a local client may, except administer the Host; a service may do less
([Services](#services)). These answer `forbidden`:

- `host/shutdown`, `host/drain`, `dispatcher/join` and `dispatcher/leave`;
- `agents/authenticate`, `agents/logout` and `agents/terminalSignIn`, since an agent's sign-in
  belongs to the Host's computer. As before, only local clients may claim
  `capabilities.terminalSignIn`.

`agents/update` (WVE-93) isn't administering the Host: it can only take an agent to its newest
version, which the Host checks starts, as `weave agents update` does. So remote clients may update an
agent and then `thread/reopen` their thread onto it, as the TUI's `/update` does.

A remote client's turn origin names its device, by the name the Dispatcher knows it by, so
transcripts can say where a prompt came from:
`{"client": {"name": "weave-ios", "id": "c9", "device": "Jaco's iPad"}}`. A client on the
Dispatcher's own computer is named after that computer. The Host keeps no record of such a
device: revoking it on the Dispatcher closes its connections.

## Devices

The person's devices are the Dispatcher's: `devices/offer`, `devices/list` and `devices/revoke`
are its API's, on its own computer only, and `weave pair` and `weave devices` ask them there
([WVE-175's CLI](wve-175-dispatcher.md#the-cli)). A Host answers none of them, and its hello no
longer lists `devices` in `features`.

```ts
type Device = { id: string; name: string; pairedAt: number; lastSeenAt?: number; connections: number; service?: boolean };
```

Revoking a device closes its connections (4000), those the Dispatcher carries to Hosts too. The
device has to pair again.

## Services

A service is a client that does work for the person rather than showing them anything: the
Dispatcher (ADR 0027), the only one now. A Host joins it (ADR 0030), with a code `hosts/offer`
gives there, and keeps its key in `devices.json` as the service it joined: it takes the key at
hello only on the connection the Host opened to the Dispatcher, and forgets it with
`dispatcher/leave` or when the Dispatcher removes the Host
([WVE-175's Hosts](wve-175-dispatcher.md#hosts)). Being a service only takes from what it may do,
which is what starting headless turns, following threads, naming and labelling the ones it
starts, serving its tools and reaching the person's other Hosts for this Host's agents
(ADR 0029) need:

- `host/hello`, `host/challenge`, `host/status`, `agents/list`;
- `threads/list`, `threads/get`, `threads/watch`, `threads/unwatch`;
- `thread/run` without `attach`, `thread/attach` with `observe`, `thread/detach`,
  `thread/rename`, `thread/setSuccessor`, `thread/label`, `thread/report`;
- `service/declareTools`, `service/answerTool`;
- `queue/add`, `turn/steer`, `turn/cancel`;
- `dispatcher/carry`, which only the Dispatcher the Host joined may ask, on the connection the
  Host opened to it ([the Host protocol](wve-85-host-protocol.md#connections-the-dispatcher-carries)).

Everything else answers `forbidden`, before any handler sees it: the computer's files,
terminals and worktrees, opening or attaching to a thread as a client of it, answering a
thread's pending requests, and agents' sign-in and updates. Its turns' origin names it, as any
remote client's does, unless it says what started a turn (`origin` on `thread/run`, `queue/add`
and `turn/steer`; see [Service origins](wve-85-host-protocol.md#service-origins)) or which thread
on another Host asks (`caller`; see [Other Hosts](wve-85-host-protocol.md#other-hosts)).

## The Host's own remote access, retired

Until WVE-197 each Host listened for remote clients itself (ADR 0010, ADR 0016): a WebSocket on
`127.0.0.1:7341` behind a Tailscale Serve entry of its own on HTTPS port 7341, which a pairing
offer turned on and the last device's revoke turned off; devices and services paired with it,
kept in its `devices.json`; `devices/*` and the `devices` feature; `weave pair` and `weave
devices` on the Host's computer; and `[remote]` in the config to move it. Once the app reached
every Host through the Dispatcher (WVE-196), all of it went (ADR 0030). The Host protocol's
version stayed 3: nothing off the Host's computer can reach what's gone, and the missing feature
tells any client.

When a Host of this version first starts:

- **Paired devices go.** `devices.json` keeps the Host's id and the Dispatcher it joined, and
  drops the devices and services that paired with it, peer Hosts' pairings among them, logging
  each. The file then notes `serveEntryLeft`: the Host served remote clients, and may have the
  Serve entry it made for them.
- **Its Serve entry goes.** Only while `serveEntryLeft` is noted does the Host touch Tailscale
  Serve, so a Host in a new directory, as every dev Host and test starts, never runs
  `tailscale`. It removes the entry that forwards to where it listened, `127.0.0.1:7341` or
  `[remote] listen` (none, with `[remote] url`, which meant it made none), under the computer's
  tailnet name, touching no other, and forgets the note once that entry is gone. Where it can't,
  as where only root may change Serve because another program's entry serves a Unix socket, it
  logs why, and `host/status` gives `serveEntry: {port, command, why}`, which `weave daemon
  status` prints with the command for the person to run once:
  `sudo tailscale serve --https=7341 off`. It tries again each time it starts, and whenever a
  local client asks for its status, so the note goes once the person has run it.
- **`[remote]` does nothing.** `weave daemon run` logs that it should go, and `weave daemon
  status` says so; it's read only for where the old entry forwarded.
- **`weave pair` and `weave devices` are the Dispatcher's** (WVE-188's rule: top-level commands
  are named for what the person manages); `weave dispatcher pair` and `weave dispatcher devices`
  went with no alias.

## Security

It protects against:

- devices outside the tailnet, which have no route to the Dispatcher's listener, and anything
  that isn't the Host's own user on its computer, which has no way into the Host at all;
- tailnet devices that aren't paired;
- a captured proof, since a nonce is good once and keys never leave devices;
- web pages, through `Origin` and the subprotocol;
- revoked devices, which are disconnected at once, from every Host too;
- anyone saying they're the Dispatcher's device: a Host takes that only on a connection it
  opened itself to the Dispatcher it joined, and only once the Dispatcher has signed a nonce of
  the Host's there with the key the Host learned when it joined;
- something else answering at the Dispatcher's address, as after a name or a Serve entry moves:
  without the Dispatcher's key it can't sign the Host's nonce, so the Host serves it nothing,
  neither a device's connection nor a terminal's stream.

It doesn't protect against someone using the Dispatcher computer's account, who can run `weave
pair` or use its socket, or someone using a Host computer's account, who can use the Host's
socket; or against someone holding an unlocked paired device. Nor against the Dispatcher
itself, which holds the keys to every Host (ADR 0030) and sees everything it carries. TLS ends at
Tailscale on the Dispatcher's computer; the last hop to it is loopback, and the hop from it to a
Host is whatever the Host dialed, `wss://` through the Dispatcher's Serve entry or its socket on
the same computer.

Removing the Serve entry stops new connections but leaves connected clients connected, so
revoking a device, not turning Serve off, is what cuts one off.

## Crates

| Crate | Adds |
| --- | --- |
| `protocol` | `device` and `pair` auth, which the Dispatcher's hello shares, `dispatcher` auth, `host/challenge`, `devices/*` for the Dispatcher, `host.id`, the hello's `device`, the turn origin's `device`, `forbidden`, the close codes, `HostStatus.serveEntry`; golden fixtures for each |
| `remote` | The server's end, which the Host and the Dispatcher share (WVE-176): the WebSocket (`tokio-tungstenite`, as Codex uses), pings and the 8 MiB limit (`websocket.rs`), for connections accepted and those a Host opens; the Dispatcher's remote access with pairing (`access.rs`) and its Serve entry (`tailscale.rs`), whose `Serve` a Host uses only to remove its old one; offers, codes and signature checks (RustCrypto `p256`, `pairing.rs`); the preamble (`preamble.rs`) |
| `host` | `devices.json`'s Host id and joined Dispatcher, `host/challenge` and `host/hello`'s check on its connections to the Dispatcher, what remote clients and services may call, and removing its old Serve entry (`serve_entry.rs`) |
| `host-client` | A WebSocket transport, device credentials and a software key (`remote`), for the CLI's pairing with the Dispatcher and a Host's connections to it; and opening a connection the Dispatcher carries to a Host (`carry`, WVE-195), which the CLI's `--host` uses |
| `cli` | `weave pair` with a QR code in the terminal, and `weave devices`, on the Dispatcher's computer; `weave daemon status`'s note of a Serve entry left |

## Acceptance

- **The Dispatcher's WebSocket** (`dispatcher/tests/devices.rs`): loopback only; upgrades without
  its subprotocol, or with an `Origin` other than the app's or one configured, are refused; a
  client that proves nothing in 30 seconds, or stops answering pings, is closed; pairing,
  authenticating and revoking as [WVE-175's acceptance](wve-175-dispatcher.md#acceptance) has
  them.
- **Through the Dispatcher** (`dispatcher/tests/carry.rs`): a device works on each Host, a
  carried device may do everything but administer the Host, a replay many times the Host's
  backlog limit arrives whole, revoking closes what's carried, and a Host serves nothing where
  the Dispatcher proves no key.
- **The Host** (`host/tests/joined.rs`, against a fake Dispatcher it joins): the Dispatcher may only
  start and follow threads, names what started its turns and declares tools agents call; the
  socket takes no `pair`, `device` or `dispatcher` auth and gives no challenge, and `devices/*`
  aren't the Host's; a Host in a new directory never touches Serve, one that served remote
  clients drops their devices and removes its entry once, and one that can't says how and looks
  again when asked.
- **CLI:** `weave pair` shows the Dispatcher's URL as a QR code and text, or its reason it can't;
  `weave devices` lists and revokes; from a paired computer both say where it runs; `weave
  daemon status` prints the command for a Serve entry left.
- **Live:** neither the Mac's nor homelab-1's Host has a weave Serve entry, and the iPad reaches
  both through the Dispatcher.

## Later

- Replacing a device's key, and renaming devices.
- TLS in the Dispatcher, for networks without Tailscale.
