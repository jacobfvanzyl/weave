# Host installation and operations

Build from a fresh checkout with Bun 1.3.14:

```sh
bun install --frozen-lockfile
bun run check
bun run build:host
bun run build:host:linux
```

Artifacts live in `product/portal/dist/`. Each binary has a JSON manifest with
its SHA-256, source hash, Git revision, Bun version, wire protocol and state
format. The compiled executable includes Bun; the destination does not need a
source checkout, Bun CLI or Deno. Install tmux and each configured ACP provider
separately. Providers own their model credentials and may require their own
runtime. Neovim is a terminal application, not an embedded Editor dependency.

Keep configuration outside releases, use absolute paths, and keep state and TLS
private keys private to the service user. Copy `portal.config.example.json`,
set the Host display name and accessible Workspace paths, and allow the exact
client origins `weave://app` and `capacitor://localhost`. Non-loopback listeners
require TLS. Use the certificate's hostname in client URLs and diagnostics.

## Linux systemd user service

Copy the binary to the target user and run it without sudo:

```sh
./weave-portal-linux-x64 --version
./weave-portal-linux-x64 service install --name alpha --config /absolute/path/host.json
./weave-portal-linux-x64 service status --name alpha
./weave-portal-linux-x64 service restart --name alpha
./weave-portal-linux-x64 service stop --name alpha
./weave-portal-linux-x64 service start --name alpha
```

The installer copies the artifact under
`~/.local/share/weave/hosts/alpha/releases/<sha256>/`, selects it through an
atomic `current` symlink, and installs `weave-host-alpha.service` under the
user's systemd directory. It records the absolute config path and service PATH.
Use `loginctl show-user "$USER" -p Linger` to check whether services remain
available without a login; enabling linger is a host administration choice.
Bazzite already has linger enabled for its development user.

Upgrade and roll back with compatible packaged artifacts:

```sh
./new-weave-portal service upgrade --name alpha --binary /absolute/path/new-weave-portal
./new-weave-portal service rollback --name alpha
journalctl --user -u weave-host-alpha.service -n 100 --no-pager
```

An upgrade checks binary identity, architecture, protocol and state-format
compatibility before activation. The preceding release remains available for
rollback. State format 1 and protocol 2 retain existing Host IDs, credentials,
Workspace catalogs, Thread IDs, journals, and tmux terminal identities. A
provider process is restarted; durable Thread recovery follows its ACP support.
An interrupted prompt retains the established uncertainty semantics. Rollback
never rewinds a journal or copies older state over current state.

The service stops only the Host process. The Host terminates each private ACP
process group, including launchers and descendants, with a bounded grace period.
The separate tmux server survives a normal restart. A forced crash can leave a
Unix socket; startup removes it only when it is owned by this user, is a socket,
and has no accepting listener. Live sockets and unrelated paths are preserved.

To adopt the existing Bazzite Alpha unit, use `--unit
weave-portal-bazzite.service --adopt` on the first installation. The original
unit is backed up privately. This does not modify unrelated `weave-host-*`
services. Before adopting an older runtime, also back up its config, binary and
state. The initial Bun installation has no previous Bun release to roll back
to; the prior-runtime backup is a separate recovery artifact.

```sh
./weave-portal-linux-x64 service uninstall --name alpha
```

Uninstall disables and removes the managed unit. Configuration, credentials,
Threads, journals, terminal processes, release artifacts and adoption backups
remain. There is deliberately no data-deletion flag. Closing terminals or
removing retained data requires a separate explicit operation. A fresh install
can reuse the retained config/state. A stale `.operation` directory means an
installer was interrupted: verify no installer is running before removing it.

On macOS, run the packaged Host directly with `serve --config <path>`. Preserve
its stable signing identity when replacing an installation that has macOS
privacy grants; see `README.md` for signing. The systemd installer is Linux-only.

## Diagnostics and recovery

```sh
./weave-portal diagnose --config /absolute/path/host.json --url https://host.example.ts.net:4122
```

Diagnostics emits JSON and exits nonzero for failed checks. It separates:

| Area | What is checked |
| --- | --- |
| Host | Owned, private, readable/writable state directory and packaged version |
| ACP provider | Executable availability and a bounded ACP initialize exchange |
| Filesystem | Configured Workspace directory access |
| Terminal | tmux availability in the service PATH |
| Trust | TLS certificate expiry, key permissions and exact client origins |
| Network | Health endpoint reachability with ordinary TLS verification |

ACP initialize does not prove model authentication; complete a client prompt
for that check. Diagnostics starts and closes a temporary provider without
sending a model prompt. It does not print environment values, private keys or
pairing tokens. `/health` reports listener health and build identity; it does
not claim all providers are healthy. Use provider errors in the client and the
service journal to diagnose prompt failures.

Electron's old WebKit keys cannot migrate. Generate a new Pairing Token on the
same Host and re-pair; verify existing Threads, then revoke the previous desktop
credential if it is no longer used. Keep the Host state directory intact.

## Acceptance

`bun run test:host:packaged <Host binary> <compiled fake-agent>` exercises the
actual binary, transport, crash fencing, journal replay, terminals and shutdown.
The portable `scripts/service-acceptance.ts` harness additionally exercises an
isolated `wve46-acceptance` systemd installation through crash, restart, upgrade,
rollback and uninstall. It takes two compatible Host artifacts and the prepared
isolated config root; it never targets the named Alpha service.

Physical-iPad tests require an unlocked provisioned device and a private
`Documents/host-acceptance-input.json` in its app container. The input is one
Host object or an array of `{hostUrl, workspaceName, pairingToken?, permission}`.
Omit `pairingToken` for a Host already saved on that device. The debug harness
consumes and removes this private input file; copy a new one before another run.
`permission: true` selects the deterministic fixture; false uses a real provider.
Build acceptance assets with `VITE_ALPHA_ACCEPTANCE=1`, then run
`WEAVE_IPAD_UDID=<udid> bun run test:ipad`. Production builds omit that driver.
The test uses native touch/typing, Neovim, rotation and a visible composer.
See `docs/acceptance/wve-46.md` for the recorded environment and evidence.
