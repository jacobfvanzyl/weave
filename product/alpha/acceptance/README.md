# Apple Browser acceptance

This directory is the maintained Phase 1 release boundary for Alpha's embedded Apple Browser. It
uses the deterministic local fixture and DEBUG-only host orchestration. Normal release builds do
not enable the mock Alpha shell or accept acceptance launch arguments.

## Automated macOS evidence

From `product/`:

```bash
bun run acceptance:browser:fixture:test
bun run acceptance:browser:macos:test
bun run acceptance:browser:macos -- --output /absolute/evidence/directory
```

The test covers Right and Bottom dock geometry, navigation/history, reload/stop,
errors/recovery, popup policy, upload/download policy, camera/microphone denial, frame restrictions,
Reset, separate-process storage, and the bounded snapshot/type/key/click/wait/scroll probe. The
evidence command retains JSON reports and AppKit screenshots at the requested path.

## Physical-iPad evidence

Connect one paired, unlocked, developer-enabled physical iPad. Find a Mac IP reachable from the
iPad, then run:

```bash
bun run acceptance:browser:ipad -- \
  --fixture-host 192.168.1.10 \
  --device "Jaco’s iPad" \
  --output /absolute/evidence/directory
```

The runner's steps are deliberately distinct and machine-readable: select a physical iPad, sync
the acceptance-only client bundle, make a signed DEBUG build, install it, launch it, then copy the
app-written JSON and PNG from its data container. A successful install or launch is not browser
acceptance. The JSON must independently pass fixture, native slot, ephemeral store, Reset, bounded
control, screenshot, restart-seed, and restart-verify assertions.

The runner uses public `xcodebuild` and `devicectl` commands only. It does not expose a listener,
debugging protocol, production browser-control API, or private WebKit API. Build intermediates live
under `/tmp`; retained evidence contains device metadata, reports, and screenshots.

## Human-only checks

Record these beside the automated evidence for a release candidate:

1. On each Apple target, choose the fixture's file input and confirm the platform file picker is
   presented. Select a harmless file, submit it, and record the returned name, size, and type.
2. If an OS-driven WebContent termination can be induced without private automation, confirm Alpha
   shows the content-process error and Reload recovers. Otherwise record it explicitly as not
   deterministically exercised; the delegate and recovery path remain covered by code review.

## Release gate

Phase 1 is releasable only when the deterministic fixture tests and macOS host suite pass, a current
physical-iPad run has passing full/reset/restart JSON plus an inspected screenshot, the human file
picker check is recorded for both targets, and any unexercised OS-driven termination check is named
as a gap. Do not substitute public-website behavior, build success, install success, or launch
success for these artifacts.
