# Portal

Portal is the host-side Weave product. It runs beside Workspace files and Agent credentials, exposes an authenticated
WebSocket interface to Alpha, and owns ACP Agent processes and Thread identity.

It has no source or package dependency on the earlier Weave server or Portal implementation.

## Configure

Copy `portal.config.example.json` to the ignored `portal.config.json` and set absolute state, certificate, key, and
Workspace paths. Agent commands are explicit so installation and version policy stay outside the runtime. A listener
that is not loopback-only must use TLS and an explicit browser-origin allowlist.

Start Portal, then create a short-lived, one-time pairing code for the device:

```bash
deno task dev
deno run --allow-read --allow-write src/main.ts pairing create --config portal.config.json --name "Jaco's iPad"
```

Paste the complete JSON output into Alpha's Connections dialog. Alpha generates a P-256 key on the device and sends
only its public key to Portal. On iOS the private key is stored in the Secure Enclave when available, with a
ThisDeviceOnly Keychain fallback. Portal stores public credentials, grants, and audit records in its state directory.
It never rotates a device credential automatically.

List or revoke paired credentials from the Host:

```bash
deno run --allow-read --allow-write src/main.ts credential list --config portal.config.json
deno run --allow-read --allow-write src/main.ts credential revoke --config portal.config.json <credential-id>
```

See [Portal security](./SECURITY.md) for the trust model, rollover behavior, and TLS requirements.

## Verify

```bash
deno task check
deno task test
deno task build
```

The test suite starts the real Portal transport and a fake ACP subprocess, then creates, lists, attaches to, and prompts
a Thread. It also exercises restart recovery, native replay cursors, bounded retention, acknowledgement gaps,
unpaired-key rejection, explicit credential rollover, and the Workspace filesystem contract.

Workspace filesystem paths are canonical relative paths; absolute, traversal, Windows-style, and symbolic-link paths
are rejected without exposing Host paths. Text writes are create-only or conditioned on the current full SHA-256 hash.
Reads and writes are bounded UTF-8 payloads, while listing, hashing, moving, deleting, bounded search, and change
observation are available through the same authenticated RPC connection.

Conditional writes provide optimistic concurrency across authenticated Portal requests. Portal serializes mutations
within each Workspace, rechecks the expected hash immediately before replacing the file, and installs the replacement
with a same-directory atomic rename. A separately privileged local process can still race portable pathname APIs after
that final check, so Host filesystem permissions remain part of the trust boundary.

For a real Agent acceptance against an already running Portal:

```bash
PORTAL_URL=ws://127.0.0.1:4122 \
PORTAL_PAIRING_CODE="$(deno run --allow-read --allow-write src/main.ts pairing create --config portal.config.json --name acceptance)" \
PORTAL_WORKSPACE_ID=workspace \
PORTAL_AGENT_ID=codex \
PORTAL_ACCEPTANCE_MARKER=PORTAL_ACCEPTANCE_OK \
deno task acceptance
```

The filesystem acceptance is Agent-independent and creates and removes only a uniquely named directory below
`.weave-acceptance/` in the selected Workspace:

```bash
PORTAL_URL=ws://127.0.0.1:4122 \
PORTAL_PAIRING_CODE="$(deno run --allow-read --allow-write src/main.ts pairing create --config portal.config.json --name filesystem-acceptance)" \
PORTAL_WORKSPACE_ID=workspace \
deno task acceptance:filesystem
```

The same command can target a Portal running on Bazzite by changing `PORTAL_URL`; packaging and service installation
remain separate from this acceptance.

## Current persistence boundary

Portal writes the Thread catalog and normalized ACP event journal atomically with mode `0600`. Journal event IDs,
timestamps, per-Thread sequences, and compaction watermarks survive daemon restarts. `threadEventRetentionLimit` bounds
each Thread to 10,000 retained events by default; native clients behind the durable watermark receive `RESUME_GAP`
instead of a partial replay.

Portal persists each provider generation separately from the Thread catalog. A failed provider is fenced, an interrupted
prompt returns `PROMPT_UNCERTAIN`, and recovery attempts advertised `session/resume` before falling back to
`session/load`. Provider transcript replay during recovery is suppressed because the Host journal remains authoritative.
Agents that support neither operation leave the logical Thread attached but explicitly unavailable with `CANNOT_RESUME`.
