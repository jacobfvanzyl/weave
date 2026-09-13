# Pinned Chromium build

The dedicated current checkout is `/var/home/admin/weave-viz-spike/src` on Bazzite. It is separate from Weave's deployed services and from the earlier WebRTC harness.

Observed setup: shallow Chromium checkout, dependency sync, hooks, explicit depot_tools bootstrap, GN generation and patch application succeeded. The patched display translation unit compiled successfully after an internal-linkage fix. The complete headless browser is building; no runtime capture result is implied.

Pins and the diagnostic GN configuration are in `../chromium-pin.json` and `args.gn`. The initial build is a debug component build with symbols disabled, using Chromium's Linux sysroot and Ozone headless platform. It is unsuitable for production performance conclusions. Actual build output confirms offline execution; no remote build service is used.

A reproducible setup uses the pinned tag and verifies the commit before patching. Put `gclient-config` at the checkout parent as `.gclient`. It uses a complete literal solution list because gclient rejects indexed assignment statements.

Use absolute paths when bootstrapping depot_tools, and include it on PATH. In this environment calling `ensure_bootstrap` through a relative path caused its nested CIPD bootstrap to resolve the digest file incorrectly. The absolute invocation fixed it without changing upstream source:

```sh
export DEPOT_TOOLS_DIR=/var/home/admin/weave-viz-spike/depot_tools
export PATH="$DEPOT_TOOLS_DIR:$PATH"
export DEPOT_TOOLS_UPDATE=0
"$DEPOT_TOOLS_DIR/ensure_bootstrap"
```

From the parent directory:

```sh
gclient sync --no-history --nohooks --shallow -j4
gclient runhooks
```

From `src`, apply the checked-in patch and copy `args.gn` into `out/VizSpike/args.gn`, then:

```sh
gn gen out/VizSpike
autoninja -C out/VizSpike -j4 obj/components/viz/service/service/display.o
```

The object-only build catches the interception patch's integration errors first, though it still requires thousands of generated inputs/compiler dependencies. Once it passes, the required real-browser target is:

```sh
autoninja -C out/VizSpike -j6 headless_shell
```

Current long operations run under `tools/run_guarded.py`, preserving a 25 GiB disk reserve and logging explicit exit status. The guard signals only its own subprocess group. It does not remove unrelated files or stop other services.

The existing stock Chrome diagnostic can also drive the patched binary by setting `CHROME_BINARY`, `WEAVE_VIZ_CAPTURE_DIR`, `CHROME_STDERR` and optionally `CAPTURE_ANIMATE=1`. It launches a separate browser profile and loopback fixture server, fixes the content viewport at 800×600 through CDP, sends an actual mouse click and cleans up only its own profile/process. It lets normal browser shutdown flush the capture writer before terminating a stuck process. The capture helper writes individual raster resources directly from the provider.

For a separate screenshot reference, omit `WEAVE_VIZ_CAPTURE_DIR` and set `REFERENCE_PNG` to the output path. The driver rejects combining reference and Viz capture modes. Compare a static equivalent state with `tools/compare_images.py REFERENCE.png REPLAY.png --diff DIFF.png`. The comparison reports decoded RGBA error and an amplified RGB difference image; it is not a perceptual/color-profile or latency measurement.

Run `tools/inspect_capture.py` on the resulting directory before copying selected capture files to the Mac for native replay. It refuses synthetic fixtures and incomplete resource captures, verifies byte counts and hashes, and reports same-resource transform changes independently from resource reread costs.

The full build was resumed with six workers after observing about 21 GiB MemAvailable on the four-core/eight-thread i7-7700. The object-only build used four.
