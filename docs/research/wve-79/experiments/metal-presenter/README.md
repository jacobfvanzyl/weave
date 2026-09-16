# Unadopted Metal presenter experiment

This prototype is not a build input. It reduced Mac submission cost but did not materially improve distinct scroll FPS. Visual fidelity, GPU errors, drawable completion/scanout timing, occlusion/reconnect, and iPad behavior have not passed acceptance. It is not ready to ship.

To reproduce from the accompanying WVE-79 worktree, copy `WeaveBrowserMetalPresenter.h` to `product/alpha/native/browser/`, apply `integration.patch`, and build an acceptance desktop app. Run the worker benchmark with `WEAVE_BROWSER_DIAGNOSTICS=1 WEAVE_BROWSER_METAL=1`. The patch skips the existing CGImage-only raw capture in this diagnostic mode; obtain actual drawable/display evidence separately. Diagnostic epoch timestamps record post-commit callback time, while the interval clock records entry to the main-thread submission block; refine that distinction before treating intervals as physical presentation timing.

The prototype uses sRGB texture sampling/render targets, nearest sampling, opaque output, aspect-fit layout, a two-texture pool, and latest-image coalescing. Allocation/command failure handling is incomplete. The established CGImage renderer remains the product default.

See [results](../../latency-worker-results.md) and the two saved Mac Metal summaries for the measured benefit and limitations.
