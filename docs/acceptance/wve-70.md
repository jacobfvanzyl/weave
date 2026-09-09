# WVE-70 — Bun Host runtime

The active Host uses Bun 1.3.14 for execution, tests and executable compilation.
Deno configuration, locks, APIs and JSR imports are removed. Runtime boundaries
cover filesystem operations/watchers, subprocesses, WebSockets and Unix streams;
protocol and persisted identity/journal formats remain unchanged.

Validation on 2026-09-09:

- Root `bun run check`: boundary/protocol, 174 Alpha tests, renderer build, explicit
  Host TypeScript check and 60 Host tests. Real tmux restart test ran on macOS.
- Packaged arm64 macOS Host passed authenticated pairing, ACP prompt and crashed
  provider recovery with obsolete-generation filtering, durable Thread replay,
  controller/observer exclusion, terminal resize and survival across SIGTERM and
  restart, Host identity and credential retention, local ACP listing, private
  state mode and provider signal delivery.
- The same compiled harness passed against the x64 Linux executable on Bazzite
  under its ordinary user account. No Bun or Deno CLI was installed there.
- Native requirements: tmux, shell and terminfo; provider executables are external.
  These checks use a compiled deterministic ACP fixture. Real client/provider,
  service installation and upgrade/rollback acceptance remain WVE-71/WVE-46.

Evidence: `/tmp/wve70-final-check.log`, `/tmp/wve70-packaged-macos.log`,
`/tmp/wve70-packaged-linux.log`. The repeatable harness is
`product/portal/scripts/packaged-acceptance.ts`.

Bun's server-side WebSocket closure can leave its shutdown promise pending
(oven-sh/bun#36223). The Host tracks real connection closure, stops admission,
and terminates stragglers. A dedicated test proves client closure, Unix socket
mode/removal and reuse of the same TCP port. macOS and Linux packaged SIGTERM
checks confirm process exit without a forced kill.
