# Build cost and artifact reuse

The first Chromium build is a substantial setup cost. It should not become the normal Alpha or Portal edit/test cycle if this architecture is adopted. This is a proposed development and distribution strategy, not implemented CI infrastructure.

## What we can reuse

| Change | Proposed build scope |
| --- | --- |
| Native Metal renderer, input UI or client resource cache | Standalone Apple client; use an existing compatible browser artifact and recorded captures |
| Portal browser lifecycle, profiles, ACP/CDP access or signaling | Portal and its tests; use an existing compatible browser artifact |
| Wire adapter outside Chromium | Adapter and protocol compatibility checks; retain the browser when its export contract is unchanged |
| Chromium capture hook | Incremental Chromium compilation and affected links, then capture/replay checks |
| Chromium revision, compiler, GN configuration or Host platform | Build a matching browser artifact; expect substantial cache invalidation and repeat acceptance |

Publish the patched browser with its runtime libraries/resources as an immutable artifact for each supported Host OS and architecture. Record Chromium commit, patch revision, export-protocol version, toolchain and build configuration. Ordinary application development and installation should download that artifact. The native client should not require Chromium source or link Chromium libraries.

This does not provide interchangeable prebuilt Blink, V8 and Viz SDKs. Chromium component builds expose symbols across internal shared libraries; those exports are not a public API. Reuse must preserve the matching revision, toolchain and configuration. [Pinned component-build documentation](https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/docs/component_build.md).

CEF prebuilt packages do not remove the custom build for this boundary: its inspected public offscreen callbacks expose completed images, not the post-aggregation pass/quad graph. See the [CEF source assessment](chromium-findings.md#cef-and-prebuilt-distributions).

## Incremental development

Keep a persistent checkout and output directory on each builder. The spike already uses `is_component_build=true` and disables debug symbols, including Blink and V8 symbols. Component builds reduce the scope of relinking; they are a development configuration with runtime and packaging tradeoffs, not the assumed release configuration. Symbols can be enabled selectively when debugging requires them.

Keep the capture hook narrow and avoid exposing frequently edited adapter implementation through broadly included Chromium headers. Most application behavior should live in the independent service or client. A change in our current capture-only header rebuilds its including translation unit; changing shared Chromium headers could affect many more targets.

Observed at this pin: the patched display object rebuilt in **14.69 seconds** after its internal-linkage correction. That excludes the browser's final links. The complete hook-edit-to-runnable-browser time has not yet been measured. The initial full build is running offline with six workers on Bazzite's four-core/eight-thread i7-7700.

After the first successful browser build, measure a harmless capture-hook edit through a runnable browser and retain the build log. Do not extrapolate a complete incremental-build time from the object-only result.

## Larger or shared builds

Start with persistent outputs and a dedicated builder with adequate CPU, RAM and fast storage. If browser build frequency warrants it, use Siso's supported remote execution and caching through a Remote Execution API compatible backend. Chromium documents configuration for non-Google backends; access to Google's Chromium RBE is separately granted and is not assumed here. Cache reuse depends on action inputs, including source, generated files, compiler and build flags. [Official Linux build guidance](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/linux/build_instructions.md#use-remote-execution).

Linux and macOS require separate supported build environments/artifacts. A cache does not make Linux object files reusable in a macOS browser. Chromium upgrades still carry source maintenance, compilation and behavioral-validation costs even when many build actions hit the cache.

No remote cache, paid service or new builder has been provisioned for this spike.
