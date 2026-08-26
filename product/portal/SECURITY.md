# Portal security

Portal treats each paired Alpha installation as a principal with one or more P-256 credentials. A credential proves
device possession; it is not a bearer token and is never placed in a URL.

## Trust boundary

The Host operating-system account remains the administrative boundary. Anyone who can modify Portal's config, state
directory, executable, Agent commands, TLS private key, or allowed Workspace contents can act with Host authority.
Pairing does not defend against a compromised Host or client device.

Portal protects against an unpaired network client, a replayed connection proof, accidental cross-Host identifier
collisions, browser-origin abuse, and a paired principal reaching resources outside its grants. It does not provide
Host discovery, account recovery, cloud credential backup, or cross-Host synchronization.

## Pairing and authentication

1. A Host administrator runs `weave-portal pairing create`. Portal creates a random, one-time offer that expires after
   five minutes by default and persists only its SHA-256 hash.
2. Alpha generates a P-256 key pair. iOS requests a Secure Enclave key and falls back to a non-exportable,
   ThisDeviceOnly Keychain key when the enclave is unavailable. Browser builds use a non-exportable Web Crypto key in
   IndexedDB. Connection metadata contains only opaque Host, principal, credential, and key identifiers.
3. Alpha redeems the offer over `/pair` with the public key. Portal consumes the offer atomically and issues stable,
   opaque principal and credential IDs.
4. Every `/rpc` or `/acp` connection receives a fresh, 15-second challenge bound to Host ID, nonce, transport
   audience, browser origin, challenge ID, and expiry. Alpha signs the canonical challenge. Portal verifies the
   signature before exposing capabilities or attaching an ACP Thread.

The WebSocket subprotocol is a fixed version identifier, not a secret. Browser `Origin` validation is exact and
independent of credential validation. A supplied origin must appear in `allowedOrigins`.

## Transport

Non-loopback listeners fail configuration unless TLS certificate and private-key paths and an explicit origin list are
present. Alpha should connect with `wss://`. Tailscale HTTPS certificates are a supported first deployment path, but
Portal does not renew them; the Host administrator must automate renewal and restart or reload Portal before expiry.

Loopback `ws://` remains available for local tests and command-line acceptance. Do not expose a loopback-mode listener
through port forwarding or a reverse proxy without terminating trusted TLS and preserving the expected origin policy.

## Authorization and identifiers

Credentials carry action, Workspace, and Agent grants. Portal checks the active credential and relevant resource grant
for every RPC request and ACP Thread attachment. Lists are filtered to authorized resources. A denied or unknown Thread
returns the same `RESOURCE_UNAVAILABLE` result so it cannot be used to enumerate configured resources.

Clients scope Workspace and Thread keys by stable Host ID. Equal raw IDs from two Hosts are distinct resources. WVE-51
owns the future aggregate presentation across those Host-scoped resources.

## Revocation, forgetting, and rollover

- **Revoke** is a Host-side security action. It closes active connections within the revocation check interval and
  prevents new challenge proofs.
- **Forget Host** is a client-side action. It removes Alpha's metadata and local private key but deliberately does not
  mutate Portal. Use the Host credential command when remote revocation is required.
- **Rotate** is explicit. Portal stages a pending replacement while the old credential remains active. The first valid
  proof from the replacement activates it and revokes the old credential atomically. Portal never rotates credentials
  on a timer or as a side effect of reconnection.

If Alpha loses a private key, create a new pairing offer and then revoke the abandoned credential from the Host.

## ACP compatibility

Credential admission is a transport concern, not an ACP extension. After `/acp` admission, Portal forwards ordinary
ACP JSON-RPC frames and does not add required Weave fields. The stable Zed compatibility interface remains newline-
delimited ACP over the Host-local stdio connector described in `docs/specs/direct-host-acp.md`; Zed does not need to
understand Portal pairing. Weave's namespaced replay metadata remains optional and is sent only to clients that opt in.

## Persistence and audit

`security.json` stores Host identity, public credentials, grants, and hashed live pairing offers with mode `0600`.
`security-audit.jsonl` records pairing, authentication, authorization denial, rollover, and revocation events without
private keys, pairing secrets, signatures, or Workspace paths. Back up these files only with the same care as the rest
of the Portal state directory.
