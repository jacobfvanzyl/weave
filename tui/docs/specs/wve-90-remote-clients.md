# WVE-90: Remote clients of the weave Host

Status: draft. The decisions are recorded in [ADR 0010](../../../docs/adr/0010-remote-clients-through-the-tailnet-with-device-keys.md).

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
   accepts only the tailnet's devices, is the way in. Weave never changes Tailscale's
   configuration, and `weave pair` refuses while Funnel puts the listener on the internet.
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

## Configuration

```toml
[remote]
listen = "127.0.0.1:7341"                           # loopback only
url = "https://mac.example-tailnet.ts.net:7341"     # optional: what devices connect to
origins = []                                        # Origin values allowed besides none
```

- Without `[remote]`, there is no listener. The Host reads `[remote]`; clients ignore it.
- `listen` must be a loopback address (`127.0.0.1` or `[::1]`); any other fails the config.
- `url` is what pairing gives devices. Without it, `weave pair` looks up the Serve entry that
  forwards to `listen` in `tailscale serve status --json`, and when there's none, fails with
  the command that makes one.
- A Host with `[remote]` doesn't exit when idle, because a remote device can't start one.
  `weave daemon install` keeps it running across restarts; `weave pair` says so when the Host
  isn't installed.

Serve is set up once, on the Host's computer:

```bash
tailscale serve --bg --https=7341 http://127.0.0.1:7341
```

An HTTPS port of its own leaves the computer's other Serve entries alone.

## Transport

| Transport | Framing | Authentication |
| --- | --- | --- |
| WebSocket on `listen` | One JSON-RPC message per text frame | `device`, or `pair` once |

- The upgrade must offer the subprotocol `weave-host`. Others are refused before any message.
- `Origin`: none is accepted, since native clients send none. Any other value must equal one in
  `origins` exactly. Both are checked at the upgrade, which stops web pages, DNS rebinding
  included.
- A message is at most 32 MiB; a larger one closes the connection.
- The Host pings every 20 seconds and closes a connection that hasn't answered 20 seconds later.
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
   (`devices/offer`) and shows it as a QR code and as text: the URL and a code. The QR code
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
  `capabilities.terminalSignIn`.

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

## Crates

| Crate | Adds |
| --- | --- |
| `protocol` | `device` and `pair` auth, `host/challenge`, `devices/*`, `host.id`, the hello's `device`, the turn origin's `device`, `forbidden`, the close codes; golden fixtures for each |
| `daemon` | The WebSocket listener (`tokio-tungstenite`, as Codex uses), `devices.json`, challenges and signature checks (RustCrypto `p256`), what remote clients may call, pings and the 8 MiB limit |
| `host-client` | A WebSocket transport with a key it's given, for tests and the live check |
| `cli` | `[remote]`, `weave pair` with a QR code in the terminal, `weave devices` |

## Acceptance

- **Listener:** only with `[remote]`; a non-loopback `listen` fails the config; upgrades
  without `weave-host`, or with an `Origin` not in `origins`, are refused; a configured Host
  doesn't exit when idle.
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
- **CLI:** `weave pair` finds the Serve URL, refuses when Funnel exposes the listener, and draws
  the QR code; `weave devices` lists and revokes.
- **Live:** from another computer on the tailnet, the test client pairs through Serve, attaches
  to a session the TUI started, prompts, and survives a dropped network. This also confirms that
  Serve passes WebSockets through.

## Later

- A remote mode for the TUI or `weave` CLI on another computer.
- Replacing a device's key, and renaming devices.
- TLS in the Host, for networks without Tailscale.
