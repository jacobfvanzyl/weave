# WVE-79: sandboxed CEF foundation validation

Validated 2026-09-13. **Conditional pass for continuing with prebuilt CEF and lossless RFB.** Sandboxed rendering, ordinary maintained MCP workflows and raw CDP debugging work on both tested Hosts. Unmodified MCP page creation does not work. This is a foundation experiment, not the product Browser Service or a release acceptance result.

## Composition and scope

- CEF `152.0.6+g708dc14`, Chromium `152.0.7977.83`, prebuilt minimal distributions for macOS arm64 and Linux x64.
- LibVNCServer 0.9.15 and the existing RFB spike adapter, with sandbox initialization and task-owned lifecycle probes added here.
- Unmodified `chrome-devtools-mcp` 1.9.0, Node 24.19.0. Exact npm dependencies are in `tools/package-lock.json`.
- Mac M4 and remote Bazzite Intel i7-7700. Linux ran with `DISPLAY` unset and the headless Ozone platform.
- Separate task-owned profiles, loopback-only HTTP fixture, CDP and RFB listeners. Linux access used an SSH tunnel. Audio muted; software rendering and the existing 30 FPS capture cap retained.
- No Chromium source build, installed dependency edits, privileged sandbox setup, host sysctl changes or product Browser Service changes.

The small adapter built in approximately 4.3 seconds on Mac (including ad-hoc bundle signing/verification) and 2.6 seconds on Linux. This reuses already downloaded CEF binaries and the previously built wrapper/LibVNC dependencies; it is not a clean-machine total setup time.

## Results

| Check | macOS arm64 | Linux x64 |
| --- | --- | --- |
| Prebuilt runtime loads and renders local HTTP fixture | Pass | Pass, no display server |
| Renderer sandbox denies native access to task-owned file that browser process can open | Pass, EPERM | Pass, EPERM |
| Unsandboxed negative control opens that same file | Pass | Pass |
| Additional OS evidence | Seatbelt helper argument | Seccomp filter, NoNewPrivs, separate PID/user/network namespaces |
| RFB decoded pixels versus independent CDP screenshot | 480,000 pixels exact | 480,000 pixels exact |
| MCP navigation, accessibility snapshot, typing, click, JS evaluation | Pass | Pass |
| MCP console, network request/body, screenshot and performance trace | Pass | Pass |
| Raw CDP debugger pause, step, resume and evaluated return value 42 | Pass | Pass |
| MCP select/inspect/close among two CEF-created pages | Pass | Pass |
| MCP `new_page` | **Fails** | **Fails** |
| Local storage survives stopping and relaunching with same profile | Pass | Pass |
| Final restart/control run browser shutdown | Exit 0, no forced kill | Exit 0, no forced kill |

Pixel comparison is exact decoded RGB/RGBA on a frozen 800 × 600 fixture, not a color-management or motion-fidelity test. The sandbox canary is a native `open()` in the renderer, not JavaScript being denied by normal web security. These are functional restriction checks, not a sandbox security audit.

## MCP compatibility blocker

Both Hosts return `Error: Failed to create a page for context (id = undefined)` from the maintained server's `new_page` tool. Raw CDP discovery captures the created target initially reported as `type: "other"`, then reported as `type: "page"` by a later target-info query. The bundled Puppeteer page-creation path receives no Page object and throws. The target classification timing is the likely compatibility cause; an upstream fix has not been established.

Raw `Target.createTarget` returning success does **not** establish a usable, lifecycle-managed CEF page. CEF-created pages already present when MCP connects can be selected, operated and closed by unmodified MCP on both Hosts. This supports investigating Browser Service ownership of page creation, with maintained tools operating those pages. It does not yet prove discovery of native pages created after MCP connects, popup handling, or a complete lifecycle adapter. Do not silently patch or reimplement the MCP server.

The maintained tool's official support is Chrome and Chrome for Testing; compatibility with CEF is pinned empirical evidence, not an upstream guarantee. Raw CDP separately demonstrated debugger stepping because the MCP tool catalog does not provide the complete debugger API. Full authorized agent debugging therefore still needs a Portal-mediated CDP capability alongside maintained MCP workflows. [Chrome DevTools MCP documentation](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/README.md)

## Packaging and sandbox conclusions

Modern prebuilt CEF includes the Mac sandbox library. Helpers load it before the CEF framework using the supplied sandbox context API. The self-contained development app bundle passed strict ad-hoc signature verification and ran sandboxed. Linux ran from a separate runtime directory containing copied prebuilt libraries/resources with ordinary user namespace sandboxing; no root-owned setuid helper was installed. This matches the upstream integration model. [CEF sandbox setup](https://chromiumembedded.github.io/cef/sandbox_setup.html), [CEF general usage](https://chromiumembedded.github.io/cef/general_usage)

Still required during implementation/release work:

- Actual Portal distribution layout, Developer ID signing, hardened runtime/entitlements and notarization on Mac; clean-install/update checks on both platforms.
- Supported Linux distribution/dependency and user-namespace restrictions matrix; fail closed when the required sandbox cannot start.
- Page creation and popup ownership compatible with the agreed browser domain model, including discovery while tools are connected, renderer crashes and service restart recovery.
- Pin/update CEF and maintained tooling with repeatable compatibility checks. A successful profile restart here proves local-storage persistence, not full session restoration or isolation between multiple simultaneous Workspace profiles.
- Production GPU/WebGL, website compatibility, downloads/dialogs/permissions, native input/IME and security boundaries were outside this fixture test.
- 60 FPS remains unvalidated. This test retained the earlier 30 FPS limit. Native iPad acceptance was not rerun here. Audio remains deferred.

The CEF foundation is viable enough to proceed to domain design. A claim of completely interchangeable stock Chrome/CDP/MCP behavior or production-ready packaging would be incorrect.

## Evidence and harness corrections

- `evidence/mac-sandbox/`, `evidence/linux-sandbox/`: initial sandbox, CDP, MCP, target lifecycle and independent pixel comparisons. MCP failure is preserved.
- `evidence/mac-sandbox-managed-threaded/`, `evidence/linux-sandbox-managed/`: two native CEF pages, real MCP output and selection/closure.
- `evidence/mac-sandbox-restart/`, `evidence/linux-sandbox-restart/`: persisted local-storage readback and final browser shutdown.
- `evidence/mac-control-fresh/`, `evidence/linux-control-threaded/`: unsandboxed native-file negative controls. The older Mac control fixture did not finish navigation; its file-access observation remains valid.
- `evidence/build-*`: build timing and signature verification.

Intermediate failures are retained. The probe initially installed one WebSocket open handler too late, used a single-threaded Python HTTP fixture that could stall concurrent browsing, and invalidated an owned-browser vector while closing pages. Those harness problems were repaired; the final threaded fixture and scoped shutdown snapshot passed. The first Linux two-page runner terminated its SSH channel before remote shutdown completed, so that run's SSH exit code is not a trustworthy CEF exit result. The remote process later disappeared; the corrected runner keeps the channel alive and captures exit 0 on the subsequent restart/control runs. Do not count these intermediate harness failures as proven CEF limitations or omit them from the evidence.

## Reproduction

This experiment depends on the existing `experiments/rfb-spike/.build` prebuilt CEF, wrapper and LibVNC artifacts. `build-mac.py` clones that development app bundle and rebuilds only this adapter. The remote runtime is `/var/home/admin/weave-cef-foundation/runtime`; the remote adapter uses the same source with the existing CEF wrapper and `libvncserver.so.1`.

Install the locked MCP package in `.build/tools` using the public files in `tools/`. Run only one host probe at a time because they intentionally use the same local ports:

```sh
python3 experiments/cef-foundation/build-mac.py
FOUNDATION_TWO_PAGES=1 python3 experiments/cef-foundation/run-host.py mac sandbox unique-label
python3 experiments/cef-foundation/mcp-probe.py mac-sandbox-unique-label managed
```

Use `linux` in the runner for the remote Host. Omit `managed` from the MCP probe to reproduce the `new_page` failure. Create a `STOP` file in that run's evidence directory to stop it. Use a fresh label for each launch; set `FOUNDATION_PROFILE` to the previous profile directory name when testing persistence, then run `profile-probe.ts` with an output JSON path. Runs are bounded even without STOP. Only use the `control` mode with the task-owned fixture: it deliberately disables the sandbox for the negative control.

These are disposable validation tools, not a production lifecycle, authentication or RFB transport implementation.
