# WVE-90: Remote clients of the weave Host

Status: implemented, and checked live through Tailscale Serve from the Host's own Mac on
2026-10-16. Since 2026-10-21 pairing turns remote access on, and the Host keeps its own Serve
entry (WVE-100). The decisions are recorded in
[ADR 0010](../adr/0010-remote-clients-through-the-tailnet-with-device-keys.md) and
[ADR 0016](../adr/0016-pairing-turns-on-remote-access-and-the-host-keeps-its-serve-entry.md).

## Purpose

Let a client on another of the person's devices, starting with the mobile client (WVE-91),
connect to the Host and use it as the TUI does: list, open and attach to sessions, prompt and
steer, and answer pending requests. They speak the Host protocol
([`wve-85-host-protocol.md`](wve-85-host-protocol.md)). This adds a WebSocket transport,
pairing and device authentication, and what a remote client may do.

## Decisions

- **The tailnet is the only way in.** A device must be in the tailnet of the Host's computer.
  The Host listens on loopback, and Tailscale Serve, never Funnel, forwards to it, with TLS on
  the tailnet's certificate.
- **A device proves itself on every connection** by signing a Host challenge with a P-256 key
  that never leaves it, in the Secure Enclave on Apple devices.
- **A paired device can do what a local client can,** except administer the Host.

## Topology

```text
iPad · iPhone (WVE-91) · test client on another computer
                 │  wss://<computer>.<tailnet>.ts.net:7341, tailnet devices only
                 ▼
Tailscale Serve on the Host's computer: TLS with the tailnet's certificate
                 │  ws://127.0.0.1:7341
                 ▼
     Host (`weave daemon run`) ── Unix socket ── TUI · weave run · weave sessions
```

## Principles

1. **Only the tailnet reaches the listener.** It binds loopback and nothing else. Serve, which
   accepts only the tailnet's devices, is the way in. The Host keeps one Serve entry of its own,
   on its own HTTPS port, touches no other, and refuses while Funnel would put the listener on
   the internet.
2. **Every WebSocket connection proves a paired device.** Serve's connections and any local
   process's arrive the same way, from loopback, so where a connection comes from counts for
   nothing. `local` is never accepted on the WebSocket.
3. **The Host keeps no device secrets.** It stores each device's public key. Pairing codes live
   in its memory for minutes.
4. **A paired device acts for the person.** An agent's shell isn't confined to its session's
   directory, so a list of allowed directories wouldn't be a boundary. Revoking the device is
   the control.
5. **Nothing else changes.** Sessions, turns, the journal and pending requests work as on the
   Unix socket. After a network drop or a backgrounded app, a client reconnects and attaches
   after its position, as the TUI does.

## Remote access

Nothing needs configuring. Pairing turns remote access on (ADR 0016):

- **On.** A `devices/offer`, as `weave pair` makes, has the Host listen on `127.0.0.1:7341` and
  make its Serve entry, which forwards HTTPS port 7341 on the Host's tailnet name to that
  listener (`tailscale serve --bg --https=7341 http://127.0.0.1:7341`). The offer answers with
  the URL devices connect to, `wss://<computer>.<tailnet>.ts.net:7341`.
- **Staying on.** While any device is paired, remote access stays on, across restarts: a Host
  starting with paired devices listens and makes the entry again. One whose entry can't be made
  yet, as when Tailscale starts after it, listens anyway and tries again every minute.
- **Off.** Revoking the last device, or an offer expiring with no device paired, stops the
  listener and removes the entry.
- **Serve's way of saying no.** When Serve can't reach the Host the offer fails with
  `remote_unavailable` saying why: Tailscale isn't installed or running, Serve or HTTPS is off
  for the tailnet (with Tailscale's link that turns it on), port 7341 already serves something
  else, or Funnel would expose the entry. The Host finds `tailscale` on `PATH`, or where
  Homebrew or the Mac app put it.
- **Idle.** A Host with remote access on doesn't exit when idle, because a remote device can't
  start one. `weave daemon install` keeps it running across restarts; `weave pair` says so when
  the Host isn't installed.

`[remote]` is optional, to change the defaults:

```toml
[remote]
listen = "127.0.0.1:7341"                           # loopback only
url = "https://mac.example-tailnet.ts.net:7341"     # what devices connect to; the Host then leaves Serve alone
origins = []                                        # Origin values allowed besides none and the app's
```

- `listen` must be a loopback address (`127.0.0.1` or `[::1]`); any other is ignored, logged.
- With `url`, the person routes devices to the Host themselves, and the Host makes and removes
  no Serve entry.
- The Host reads `[remote]` when it starts; clients ignore it.

## Transport

| Transport | Framing | Authentication |
| --- | --- | --- |
| WebSocket on `listen` | One JSON-RPC message per text frame | `device`, or `pair` once |

- The upgrade must offer the subprotocol `weave-host`. Others are refused before any message.
- `Origin`: none is accepted, since native clients send none, and so is the app's,
  `capacitor://localhost`, which its web view sends (WVE-91; seen from the iOS simulator on
  2026-10-20) and no web page can. Any other value must equal one in `[remote] origins`
  exactly. Both are checked at the upgrade, which stops web pages, DNS rebinding included.
- A message is at most 32 MiB; a larger one closes the connection.
- The Host pings every 20 seconds and closes a connection that hasn't answered 20 seconds later.
- A connection that hasn't proved a paired device within 30 seconds is closed (4002).
- **Falling behind.** A WebSocket connection whose unsent messages pass 8 MiB is closed. The
  client reconnects and attaches after its position, so it misses nothing. The Unix socket keeps
  buffering, as now.

Close codes:

| Code | Meaning |
| --- | --- |
| 4000 | The device was revoked |
| 4001 | The client fell behind |
| 4002 | The connection failed `host/hello`, after its error |

## Host identity

The Host has a random id, made when it first starts and kept in `devices.json`. `host/hello`
gives it as `host.id`, so a client tells Hosts apart, and challenges are bound to it.

## Pairing

1. On the Host's computer, `weave pair [--name <device>]` asks the Host for an offer
   (`devices/offer`), which turns remote access on and answers with the URL, and shows it as a
   QR code and as text: the URL and a code. The QR code
   encodes `weave://pair?url=<url>&code=<code>`, a link the mobile client opens. An offer is
   good for one pairing within five minutes, lives only in the Host's memory, and at most three
   are live. `weave pair` waits and says which device paired.
2. The device shows the URL's host name and has the person confirm it before it connects.
3. The device makes its key: P-256, in the Secure Enclave where there is one, otherwise a key
   that can't be exported or leave the device (Keychain, `ThisDeviceOnly`).
4. It connects and says hello with `auth: {method: "pair", code, device: {name, publicKey}}`.
   `publicKey` is a JWK (`{"kty": "EC", "crv": "P-256", "x": …, "y": …}`); an offer made with
   `--name` uses that name instead. The Host takes the offer, so a second use fails, records the
   device, and answers as any hello does, plus `device: {id, name}`. The connection is that
   device's from then on.

The code is 128 random bits in Crockford base32.

## Authenticating

Every other connection from a paired device:

```json
{"jsonrpc": "2.0", "id": 1, "method": "host/challenge", "params": {}}
```

```json
{"jsonrpc": "2.0", "id": 1, "result": {"hostId": "…", "nonce": "…", "expiresAt": 1760180030000}}
```

```json
{"jsonrpc": "2.0", "id": 2, "method": "host/hello", "params": {
  "protocol": {"min": 2, "max": 2},
  "client": {"name": "weave-ios", "version": "0.1.0"},
  "auth": {"method": "device", "deviceId": "…", "signature": "…"},
  "capabilities": {}
}}
```

- `host/challenge` is answered before hello, and only on the WebSocket. Its nonce is 32 random
  bytes, base64url, good for one hello on this connection within 30 seconds.
- The device checks that `hostId` is the Host it paired with, then signs the UTF-8 bytes of
  `weave-host-auth/1 <hostId> <deviceId> <nonce>` with ECDSA P-256 and SHA-256. `signature` is
  the DER signature in base64url, which is what Apple's `SecKeyCreateSignature` gives with
  `ecdsaSignatureMessageX962SHA256`.
- Every failure (an unknown or revoked device, a wrong signature, a missing, used or expired
  nonce) answers `unauthenticated` with the same message, and the Host closes the connection
  (4002).
- `local` and `token` are refused on the WebSocket. `device`, `pair` and `host/challenge` are
  refused on the Unix socket. `token` stays reserved and refused; the next major version
  removes it.

## What a remote client may do

Everything a local client may, except administer the Host. These answer `forbidden`:

- `host/shutdown`;
- `devices/*`;
- `agents/authenticate`, `agents/logout` and `agents/terminalSignIn`, since an agent's sign-in
  belongs to the Host's computer. As now, only local clients may claim
  `capabilities.terminalSignIn`;
- `agents/update` (WVE-93), since it changes what the Host launches. Remote clients still see
  `agents/updateAvailable` and may `session/reopen` a session onto a version a local client
  updated to.

A remote client's turn origin names its device, so transcripts can say where a prompt came
from: `{"client": {"name": "weave-ios", "id": "c9", "device": "Jaco's iPad"}}`.

## Devices

All local only.

**`devices/offer`** `{name?}` → `{code, expiresAt}`

`weave pair` adds the URL and draws the QR code. The connection that made the offer gets
**`devices/paired`** `{device: Device}` when a device takes it.

**`devices/list`** `{}` → `{devices: Device[]}`

```ts
type Device = { id: string; name: string; pairedAt: number; lastSeenAt?: number; connections: number };
```

**`devices/revoke`** `{deviceId}` → `{}`

Forgets the device and closes its connections (4000). The device has to pair again.

`features` lists `devices`. The CLI adds `weave pair`, `weave devices` and
`weave devices revoke <id>`.

`devices.json` in the Host's directory (mode 0600, written atomically) holds the Host's id and
each device's id, name, public key and pairing and last-seen times. It holds no secrets; losing
it unpairs every device. `daemon.log` records pairings, refused hellos and revocations, never
codes, nonces or signatures.

## Security

It protects against:

- devices outside the tailnet, which have no route to the listener;
- tailnet devices that aren't paired;
- a captured proof, since a nonce is good once and keys never leave devices;
- web pages, through `Origin` and the subprotocol;
- revoked devices, which are disconnected at once.

It doesn't protect against someone using the Host computer's account, who can read
`devices.json`, run `weave pair` or use the Unix socket, or against someone holding an unlocked
paired device. Other accounts on the Host's computer can reach the loopback port, which the
socket's file mode keeps them away from, but they can't get past `host/hello` without a
device's key. TLS ends at Tailscale on the Host's computer; the last hop is loopback.

Removing the Serve entry stops new connections but leaves connected clients connected, so
revoking a device, not turning Serve off, is what cuts one off.

## Crates

| Crate | Adds |
| --- | --- |
| `protocol` | `device` and `pair` auth, `host/challenge`, `devices/*`, `host.id`, the hello's `device`, the turn origin's `device`, `forbidden`, the close codes; golden fixtures for each |
| `daemon` | The WebSocket listener (`tokio-tungstenite`, as Codex uses), `devices.json`, challenges and signature checks (RustCrypto `p256`), what remote clients may call, pings and the 8 MiB limit; turning remote access on and off with pairing (`remote.rs`) and its Serve entry (`tailscale.rs`) |
| `host-client` | A WebSocket transport (`remote::connect_websocket`), device credentials and a software key (`remote::DeviceKey`), for tests and the live check's client (`examples/remote.rs`) |
| `cli` | `[remote]` as overrides, `weave pair` with a QR code in the terminal, and `weave devices` |

`host/status` says where the WebSocket listens (`remote`) while remote access is on. The ping
interval and the 8 MiB limit are the Host's defaults; tests shorten them through
`RemoteConfig`, and use a fake Serve through `RemoteSettings`.

## Acceptance

- **Remote access:** nothing listens before pairing; an offer turns it on and makes the Serve
  entry once; revoking the last device, or an offer expiring untaken, turns it off and removes
  the entry; a Serve that can't reach the Host fails the offer with `remote_unavailable`; a
  Host starting with paired devices listens again and retries the entry until it's there.
- **Listener:** loopback only; upgrades without `weave-host`, or with an `Origin` other than the
  app's or one in `origins`, are refused; a Host with remote access on doesn't exit when idle.
- **Pairing:** an offer pairs once, expires after five minutes, and is gone after a Host
  restart; pairing records the device and `devices/paired` reaches the offering connection.
- **Authenticating:** a right signature attaches; a wrong key, a used or expired nonce, an
  unknown or a revoked device each get the same `unauthenticated` and a close; `local` and
  `token` are refused on the WebSocket, and `device`, `pair` and `host/challenge` on the socket.
- **Authority:** a device's `host/shutdown`, `devices/*`, `agents/authenticate`,
  `agents/logout` and `agents/terminalSignIn` answer `forbidden`; everything else works as for
  a local client.
- **Revoking** closes the device's connections with 4000 and refuses it afterwards.
- **Connections:** a silent peer is closed by the pings; a client past 8 MiB is closed with 4001,
  reconnects and catches up with nothing missing or repeated.
- **CLI:** `weave pair` shows the Host's URL as a QR code and text, or the Host's reason it
  can't; `weave devices` lists and revokes.
- **Live:** from another computer on the tailnet, the test client pairs through Serve, attaches
  to a session the TUI started, prompts, and survives a dropped network. This also confirms that
  Serve passes WebSockets through.

## Later

- A remote mode for the TUI or `weave` CLI on another computer.
- Replacing a device's key, and renaming devices.
- TLS in the Host, for networks without Tailscale.
