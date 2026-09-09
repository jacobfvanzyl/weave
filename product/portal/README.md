# Portal

Portal is the host-side Weave product. It runs beside Workspace files and Agent credentials, exposes an authenticated
WebSocket interface to Alpha, and owns ACP Agent processes and Thread identity.

It has no source or package dependency on the earlier Weave server or Portal implementation.

See [installation, service lifecycle and diagnostics](OPERATIONS.md).

## Configure

Copy `portal.config.example.json` to the ignored `portal.config.json` and set absolute state, certificate, key, and
Workspace paths. Agent commands are explicit so installation and version policy stay outside the runtime. A listener
that is not loopback-only must use TLS and an explicit browser-origin allowlist.
The example allowlist covers the Vite development client, the Capacitor iPad host, and the packaged macOS
`weave://app` host.

Configured Workspaces seed the Portal project catalog, but the list may be empty. A paired administrative Alpha can
choose this Portal and add an existing Host-local directory from the Projects sidebar. Portal validates and
canonicalizes the absolute path, persists the resulting Workspace in `workspaces.json`, and makes it available without
rewriting the config file. Registration does not clone repositories or create missing directories.

For Git Workspaces, Portal resolves the repository top-level and fetch remotes, preferring `upstream`, then `origin`,
then the first remote alphabetically. SSH and HTTP(S) remote URLs normalize to the same lowercase
`host/owner/repository` identity. Alpha uses that identity to present matching physical Workspaces from several Hosts
as one logical Project while retaining each Host-specific Workspace as an execution and filesystem target. Non-Git
Workspaces remain Host-scoped.

Start Portal, then create a short-lived, one-time Pairing Token for the device:

```bash
bun run dev
bun src/main.ts pairing create --config portal.config.json
```

Paste the compact JWT output into Alpha's Connections dialog and enter the Portal Host URL separately. The URL is
deliberately not embedded in the bearer token, so altered unverified routing data cannot redirect it to another Host.
Alpha generates a P-256 key on the device and sends only its public key to Portal. On iOS the private key is stored in the Secure Enclave when available, with a
ThisDeviceOnly Keychain fallback. Portal stores public credentials, grants, and audit records in its state directory.
It never rotates a device credential automatically.

List or revoke paired credentials from the Host:

```bash
bun src/main.ts credential list --config portal.config.json
bun src/main.ts credential revoke --config portal.config.json <credential-id>
```

See [Portal security](./SECURITY.md) for the trust model, rollover behavior, and TLS requirements.

## Zed External Agent

While `weave-portal serve` is running, Portal also exposes a mode-`0600` host-local Unix socket for standard ACP
clients. Configure Zed with the compiled `weave-portal` command and the same Portal config used by the daemon:

```json
{
  "agent_servers": {
    "weave-product-codex": {
      "type": "custom",
      "command": "/absolute/path/to/weave-portal",
      "args": [
        "acp",
        "connect",
        "--config",
        "/absolute/path/to/portal.config.json",
        "--agent",
        "codex"
      ]
    }
  }
}
```

Zed launches the command in the current project directory. Portal canonicalizes that path, chooses the narrowest
configured Workspace containing it, and rejects paths outside every configured Workspace. Pass `--workspace <id>`
after the Agent ID only for an explicit configured Workspace selection.

The adapter advertises standard ACP session list, load, resume, and close capabilities. Listed session IDs are stable,
opaque identities scoped by the Portal Host and logical Thread; provider session replacement during recovery does not
change them. Load replays Portal's journal, resume reattaches without replay, and close only detaches Zed. The adapter
does not advertise or implement ACP delete, and Zed archive state does not change Portal archive state. Portal-archived
Threads remain discoverable but must be restored in Alpha before Zed can attach to them.

Open Zed's Threads Sidebar, switch to Thread History, and choose **Import Threads**. Only sessions whose configured
Workspace has a valid path in that Zed context can be imported. Use `dev: open acp logs` in Zed to inspect the exchange.

## Verify

```bash
bun run check
bun run test
bun run build
```

On macOS, create a build whose privacy grants survive compatible Portal upgrades by signing it with a stable Apple
code-signing identity and identifier:

```bash
WEAVE_PORTAL_CODESIGN_IDENTITY="Apple Development: developer@example.com (TEAMID)" \
  bun run build:macos-signed
```

The signed task uses `xyz.veezee.weave.portal` by default. Override it only when packaging under another permanent
product identity by setting `WEAVE_PORTAL_CODESIGN_IDENTIFIER`. The portable `build` task deliberately remains
unsigned for CI and non-Mac development. Verify an installed binary with
`codesign --verify --strict --verbose=2 /path/to/weave-portal` and
`codesign --display --requirements - /path/to/weave-portal`.

The test suite starts the real Portal transport and a fake ACP subprocess, then registers and reloads Projects and
creates, lists, attaches to, prompts,
archives, and restores a Thread. It also exercises lifecycle authorization and audit records, busy-prompt rejection,
restart recovery, native replay cursors, bounded retention, acknowledgement gaps, unpaired-key rejection, explicit
credential rollover, and the Workspace filesystem contract.

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
PORTAL_PAIRING_TOKEN="$(bun src/main.ts pairing create --config portal.config.json)" \
PORTAL_WORKSPACE_ID=workspace \
PORTAL_AGENT_ID=codex \
PORTAL_ACCEPTANCE_MARKER=PORTAL_ACCEPTANCE_OK \
bun run acceptance
```

The filesystem acceptance is Agent-independent and creates and removes only a uniquely named directory below
`.weave-acceptance/` in the selected Workspace:

```bash
PORTAL_URL=ws://127.0.0.1:4122 \
PORTAL_PAIRING_TOKEN="$(bun src/main.ts pairing create --config portal.config.json)" \
PORTAL_WORKSPACE_ID=workspace \
bun run acceptance:filesystem
```

The same command can target a Portal running on Bazzite by changing `PORTAL_URL`; packaging and service installation
remain separate from this acceptance.

## Current persistence boundary

Portal writes the Thread catalog and normalized ACP event journal atomically with mode `0600`. Journal event IDs,
timestamps, per-Thread sequences, and compaction watermarks survive daemon restarts. `threadEventRetentionLimit` bounds
each Thread to 10,000 retained events by default; native clients behind the durable watermark receive `RESUME_GAP`
instead of a partial replay.

Portal also writes Alpha-registered Workspaces to `workspaces.json` with mode `0600`. Configured Workspaces remain
authoritative seeds; dynamic entries retain stable Workspace IDs across restarts and are loaded into the same bounded
filesystem and Thread runtime services.

Portal persists each provider generation separately from the Thread catalog. A failed provider is fenced, an interrupted
prompt returns `PROMPT_UNCERTAIN`, and recovery attempts advertised `session/resume` before falling back to
`session/load`. Provider transcript replay during recovery is suppressed because the Host journal remains authoritative.
Agents that support neither operation leave the logical Thread attached but explicitly unavailable with `CANNOT_RESUME`.

Archived Threads remain in the catalog and journal but are omitted from the default active list. Portal rejects archive
while a prompt is active, disconnects idle attachments when archiving, and refuses new attachments until restoration.
Restoring preserves the same Thread and provider session identities so the normal recovery path can resume its history.
Archive and restore use the existing Thread attachment grant and write audit records containing stable identifiers,
never prompt or transcript content.

## Bun runtime and distributable acceptance

Use Bun **1.3.14** from the repository root. `bun run build:host` produces
`product/portal/dist/weave-portal`; `bun run --cwd product/portal build:linux`
produces `weave-portal-linux-x64`. These executables include Bun and need no
source checkout or installed JavaScript runtime. The Host still requires tmux,
a POSIX shell, terminfo, and the configured external ACP providers. Neovim is
optional software inside a terminal, not an Alpha surface.

The configured state directory, Host identity, credential grants, Thread IDs,
provider journals and tmux socket remain compatible with the preceding Host.
Keep that directory and the same operating-system account across upgrades.
Terminal sessions survive Host restarts through tmux; this does not promise
survival across machine reboots.

`bun scripts/packaged-acceptance.ts <host-binary> <compiled-fixture-agent>`
starts an isolated loopback Host, pairs, exercises ACP recovery and the local
connector, and restarts the executable while preserving credentials, Thread
history and a real tmux terminal. Compile the harness and
`src/test-fixtures/fake-agent.ts` with `bun build --compile --target=bun-linux-x64`
to run the same checks on Linux without installing Bun. This fixture validates
runtime/protocol behavior; real provider and client acceptance is recorded separately.

Bun 1.3.14 has an upstream [WebSocket shutdown accounting bug](https://github.com/oven-sh/bun/issues/36223).
The Host stops admission and drains its own tracked connections instead of
awaiting the affected `server.stop()` promise. Tests verify actual client closure,
socket cleanup, port reuse and process exit. Re-evaluate this workaround when
upgrading the pinned Bun version.
