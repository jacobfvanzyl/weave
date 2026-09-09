# WVE-46: Bun packaging, Host operations and final acceptance

WVE-46 completes the tooling and operating baseline after WVE-67 through WVE-71.
All application workspaces use Bun 1.3.14 for installation, script execution,
typechecking, tests, Vite and builds. Native Xcode and Electron remain platform
components. `check:tooling` verifies the pin, workspace list, command policy and
absence of retired lockfiles/configuration. CI covers Linux and macOS with
frozen installs, all checks, packaged Host acceptance and macOS desktop
packaging. CI is committed configuration; the evidence below was executed
locally and on Bazzite, not by a published GitHub Actions run.

## Executed evidence, 2026-09-09

- A clean source copy at `/tmp/wve46-fresh-root` (pointer to the fresh directory)
  completed frozen installation, all 175 Alpha tests, 63 Host tests, boundary
  and protocol checks, renderer/Host/Electron/tool typechecks and a Host build.
  Logs: `/tmp/wve46-fresh-{install,check,build}.log`.
- The final working-tree check passed: `/tmp/wve46-closeout-check.log`.
- Repeated Host builds from identical inputs produced identical SHA-256
  `51d34bf2b0443ad2672150789499ad3344b0eadfd1cf76db005c6cc523dced90`.
  Signed-artifact manifests were separately checked after code signing.
- Compiled Host acceptance passed on macOS arm64 and Bazzite Linux x64 without
  a source checkout or Bun/Deno CLI on Bazzite. It covered authentication,
  provider crash/generation fencing, journal replay, persistent terminals,
  controller/observer rules, local ACP, Host restart and graceful shutdown.
  Logs: `/tmp/wve46-packaged-{mac,linux}.log`.
- The isolated systemd service passed restart, SIGKILL/stale-socket recovery,
  upgrade, rollback, stop/start and uninstall. Each phase retained Host ID,
  pairing credentials, Thread identity and terminal output. Uninstall retained
  the durable files. `/tmp/wve46-service-acceptance.log` records each phase.
- Packaged Electron completed the Mac plus Bazzite flow twice: initial pairing,
  then existing-credential reconnect after both Hosts restarted. Each Host
  completed ACP prompting and native terminal paste/copy, resize and Neovim
  input. Mac permissions used the deterministic ACP fixture; Bazzite completed
  an actual Codex response. Evidence: `/tmp/weave-wve46-multi2/{pair,reconnect}.json`
  and corresponding PNGs. The existing Bazzite Thread catalog was also checked
  unchanged across restart.
- The production desktop was installed and launched at
  `~/Applications/Weave Alpha.app`. Its actual UI shows the explicit WebKit
  credential recovery instructions. No acceptance driver is enabled in that
  production build.
- Physical iPad two-Host acceptance passed with saved credentials in
  `/tmp/wve46-ipad-multi4.xcresult` (49.1 seconds, zero failures). Both Mac and
  Bazzite completed ACP prompting and native terminal/Neovim input; the Mac
  fixture also exercised permission approval. Portrait and landscape screenshots
  were inspected, including the composer above the software keyboard. Structured
  results: `/tmp/wve46-ipad-result4.json`; screenshots:
  `/tmp/wve46-ipad-multi4-attachments/`. Earlier WVE-71 device pairing and
  single-Host acceptance remain recorded in `/tmp/wve71-ipad-native-15.xcresult`.
  The driver now requires the pairing dialog to close before proceeding, so a
  saved workspace cannot conceal an expired or already-configured pairing error.
- The root `bun run build:ipad` completed using the committed shared App scheme
  and a fresh native build directory. The normal app was installed and launched
  on the same iPad without clearing its data; its assets contain no acceptance
  chunk. Logs: `/tmp/wve46-production-ipad2.log`,
  `/tmp/wve46-ipad-production-{install,launch}.log`.

## Installed Hosts and retained state

Bazzite's existing Alpha service was already crash-looping on a stale Deno ACP
socket before the migration. The new managed `bazzite-alpha` installation adopts
only `weave-portal-bazzite.service`; the unrelated legacy service is untouched.
The Bun Host is healthy with all diagnostic categories passing. Its config now
allows the Electron origin in addition to the existing iPad/development origins.
The private pre-migration backup is
`/home/admin/.local/share/weave/backups/wve46-20260909-174718/`.

The Mac launch agent keeps its existing paths and label
`dev.weave.product-portal`. Its Bun executable retains the prior Apple signing
identity and `xyz.veezee.weave.portal` requirement. The Host ID survived the
replacement. Backup:
`~/.local/share/weave/backups/wve46-macos-20260909-165703/`.
The existing local Codex ACP 1.6.2 returned a model-version error for the user's
configured model. Its two existing Mac config pins were updated to the already
verified 1.10.0; the real installed Host then completed `WVE46_MAC_PROVIDER_OK`.
Prior configs are retained in that backup. Bazzite's existing provider worked
and was retained.

Neovim 0.12.5 was installed from its official release into Bazzite's user-local
Weave tools directory after verifying the release asset's SHA-256. It does not
require a GUI or system-wide package change. The temporary `WVE-46 Bazzite`
Workspace and its six terminals were removed after acceptance; its five test
Threads were archived. The user's previously removed `bazzite-test` Workspace
was not restored. Two real-Mac acceptance Threads were also archived.

The iPad test removed the isolated Mac fixture connection through the normal
Forget Host flow and verified its disappearance. Its real Mac and Bazzite
connections remain. The disposable Mac Host and its dedicated tmux server were
stopped. Temporary Electron/setup credentials were revoked and their isolated
profiles removed. Private test input is consumed and removed by the debug
harness. Both installed real Hosts were read back healthy after cleanup.

Filetree, Editor, embedded Browser and Automation remain absent from active
surfaces/startup/capability advertisement. xterm.js remains in place. WVE-65's
transport, agent/workspace UX and libghostty work have not begun.
