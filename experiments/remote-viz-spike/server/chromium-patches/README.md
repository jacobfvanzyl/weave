# Diagnostic Chromium capture patch

Status: patched headless browser built and actual capture validated against Chromium 153.0.8010.36, commit `507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c`.

`0001-capture-software-aggregated-frame.patch` adds one call immediately after Aggregate in `display.cc` and a diagnostic helper header. `viz_remote_capture.h` is the editable source of that helper; regenerate the patch after edits. This header-only placement avoids a build-target change for the first experiment.

Apply only to the pinned dedicated checkout:

```sh
git apply --check /path/to/0001-capture-software-aggregated-frame.patch
git apply /path/to/0001-capture-software-aggregated-frame.patch
```

Isolated capture launch after building:

```sh
WEAVE_VIZ_CAPTURE_DIR=/absolute/capture/directory out/VizSpike/headless_shell \
  --no-sandbox --disable-gpu --disable-gpu-compositing \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9229 \
  --window-size=800,600 http://127.0.0.1:9880/transforms.html
```

Sandbox disabling is limited to the isolated spike environment and deterministic spike fixtures. This command must not be promoted to product configuration.

The helper copies each distinct referenced software image under Chromium's existing read lock into owned BGRA8 premultiplied sRGB bytes. It writes a new resource file only when actual bytes or dimensions change. Generation IDs are capture-local; Chromium IDs are separately retained. It always rereads/compares the resources and records that cost. Zero new resource payload therefore does not claim zero readback/copy cost.

A sequenced task runner writes resource files before the referencing frame JSON. Captures are bounded to 180 frames per Display. Absent resources are evicted from this diagnostic cache; that is not Chromium resource-return instrumentation. GPU resources fail visibly. Trace JSON is not a stable or generally lossless rendering protocol: the first decoder must reject unsupported fields. Exact solid/texture-background colors, unsigned IDs, resource sampling origin and structured mask bounds/radii/gradient presence supplement upstream diagnostics. The mask extension rebuilt successfully in 19.24 seconds (three steps) after the initial full build. The subsequent single-blur supplement records decal behavior and Skia-computed expanded bounds using the public PaintFilter accessor; its successful incremental rebuild took 22.50 seconds (three steps).

Normal Chromium composition still runs after this hook to preserve its scheduling and supply reference output. No composited framebuffer is used as a resource payload. Runtime proof requires an actual captured file set and independent replay; patch applicability alone is insufficient.
