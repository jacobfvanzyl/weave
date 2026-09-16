# Lossless compression backends for the RFB worker

Research date: 2026-09-15. This document records the source-backed proposal. The subsequent builds, compatibility tests, measurements and adoption decisions are in [the experiment results](gpu-metal-compression-results.md).

The first candidate should be **zlib-ng 2.3.3, built privately as a static zlib-compatible library with prefixed symbols**, replacing only the native Host's LibVNCServer compression dependency. Keep ZRLE, its default compression setting, the existing worker, physical 2× pixels, and the current Mac/iPad decoders unchanged. This tests a maintained upstream implementation without introducing an encoding or browser fork. Its benefit remains a hypothesis until paired measurements establish compression CPU, wire size, and end-to-end latency.

The reason to test it is the existing worker profile: the implementation agent reports approximately 35 FPS and 111 ms median response on Mac, CEF painting near 60 FPS, and substantial worker time in ZRLE/deflate. Those are existing-stack observations, not zlib-ng results. On iPad, transfer wait and route variation also matter, so a faster compressor that emits more bytes can still lose. See [worker results](latency-worker-results.md) and [request cadence](rfb-request-cadence.md).

## Exact dependency and required API

Upstream's latest stable release resolves to 2.3.3, published 2026-02-03. The tag currently points directly to commit `12731092979c6d07f42da27da673a9f6c7b13586`. The archive below was downloaded and hashed during this research; its digest is a locally verified pin, not an upstream signed checksum. A future download must match before extraction. [Release](https://github.com/zlib-ng/zlib-ng/releases/tag/2.3.3), [tag reference](https://api.github.com/repos/zlib-ng/zlib-ng/git/ref/tags/2.3.3).

```json
{
  "version": "2.3.3",
  "commit": "12731092979c6d07f42da27da673a9f6c7b13586",
  "url": "https://codeload.github.com/zlib-ng/zlib-ng/tar.gz/refs/tags/2.3.3",
  "sha256": "f9c65aa9c852eb8255b636fd9f07ce1c406f061ec19a2e7d508b318ca0c907d1"
}
```

Pinned LibVNCServer 0.9.15 does not declare a minimum zlib version in `find_package(ZLIB)`. ZRLE needs the classic `z_stream`, `deflateInit`, `deflate`, and `deflateEnd` API, including `Z_NO_FLUSH` and `Z_SYNC_FLUSH`. Its stream persists across rectangles/updates. The separately compiled zlib encoding also uses `deflateInit2`; Tight uses `deflateParams` when available. There is no need for a new zlib API here. The candidate's compatible header declares `ZLIB_VERSION "1.3.1.zlib-ng"` and `ZLIBNG_VERSION "2.3.3"`: distinguish API compatibility from implementation release. [LibVNC build](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/CMakeLists.txt), [ZRLE stream](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/src/libvncserver/zrleoutstream.c), [candidate header](https://github.com/zlib-ng/zlib-ng/blob/2.3.3/zlib.h.in).

The encoded bytes and compression ratio need not match stock zlib. Acceptance is exact decoded pixels and valid continuing streams, not identical compressed output. Changing the implementation does not make ZRLE honor a client compression-level setting: the pinned ZRLE path still initializes with `Z_DEFAULT_COMPRESSION`. Keep that unchanged for this comparison. The 2.3.3 release also fixes deterministic output after `deflateReset`; it is preferable to an older convenient package pin. [Release changes](https://github.com/zlib-ng/zlib-ng/releases/tag/2.3.3), [zlib streaming contract](https://zlib.net/manual.html).

## Reproducible private build proposal

Use a new dependency cache variant keyed by archive digest, backend/version, platform/architecture, compiler/SDK, and flags. The following are proposed commands, not executed recipes. They use upstream CMake (minimum 3.14), C11, static output, optimizations and runtime CPU detection, and avoid `-march=native`. Explicitly setting `BUILD_SHARED_LIBS=OFF` matters: leaving it unset builds both static and shared variants. [Pinned build options](https://github.com/zlib-ng/zlib-ng/blob/2.3.3/CMakeLists.txt).

Run the common configure on a native x86-64 Linux builder, targeting the same oldest supported runtime as CEF. For Mac arm64, add the three Apple options below to that same configure invocation. Cross-compiling Linux from Mac is a separate toolchain concern and is unnecessary for the first acceptance.

```sh
cmake -S "$rfb_zng_source" -B "$rfb_zng_build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$rfb_zng_prefix" \
  -DCMAKE_INSTALL_LIBDIR=lib \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DBUILD_SHARED_LIBS=OFF \
  -DZLIB_COMPAT=ON \
  -DZLIB_SYMBOL_PREFIX=weave_rfb_ \
  -DWITH_OPTIM=ON \
  -DWITH_RUNTIME_CPU_DETECTION=ON \
  -DWITH_NATIVE_INSTRUCTIONS=OFF \
  -DBUILD_TESTING=ON \
  -DWITH_GTEST=OFF \
  -DWITH_BENCHMARKS=OFF
cmake --build "$rfb_zng_build" --parallel 4
ctest --test-dir "$rfb_zng_build" --output-on-failure
cmake --install "$rfb_zng_build"
```

Mac configure additions, matching the current native Browser deployment target:

```sh
-DCMAKE_OSX_ARCHITECTURES=arm64
-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0
-DCMAKE_OSX_SYSROOT="$rfb_macos_sdk"
```

Obtain `rfb_macos_sdk` from `xcrun --sdk macosx --show-sdk-path`. Keep the Apple architecture/SDK/deployment values identical across compressor, LibVNCServer, worker test, and Browser executable. Linux relies on runtime dispatch for newer x86 SIMD rather than baking the builder's ISA into every function. The upstream ARM build enables ARMv8/NEON implementations. Do not separately force advanced ISA flags. [Architecture options and dispatch configuration](https://github.com/zlib-ng/zlib-ng/blob/2.3.3/CMakeLists.txt), [supported platforms and build guidance](https://github.com/zlib-ng/zlib-ng/blob/2.3.3/README.md).

`WITH_GTEST=OFF` avoids an implicit GoogleTest network fetch and still retains upstream CTest examples, regression/CVE, and data tests. This is not the entire upstream test suite. For release qualification, run its GoogleTest suite too using an explicitly pinned test dependency; keep that qualification build separate from cached product artifacts. Check `ctest -N` and record the actual executed tests. [Upstream test configuration](https://github.com/zlib-ng/zlib-ng/blob/2.3.3/test/CMakeLists.txt).

Integrate through the existing `product/portal/scripts/build-browser-runtime.py` server-only build:

1. Create a new LibVNC output directory; preserve `WITH_THREADS=OFF`, JPEG/PNG off, and all existing worker options. Set `WITH_ZLIB=ON`, `ZLIB_INCLUDE_DIR="$rfb_zng_prefix/include"`, and `ZLIB_LIBRARY="$rfb_zng_prefix/lib/libz.a"`. Inspect CMakeCache and the compile commands to prove the chosen headers and archive, rather than trusting discovery.
2. Compile both `rfb-display-test.cc` and the Browser executable with the private include directory, and link the explicit private `libz.a` **after** `libvncserver.a`. Replace the corresponding bare `-lz` arguments for this candidate. Rebuild every consumer that includes RFB/zlib structures; never mix native zlib-ng headers with compat headers.
3. Keep the generated `zlib.h`, `zconf.h`, and `zlib_name_mangling.h` together. Upstream `ZLIB_SYMBOL_PREFIX` generates declarations/macros that rename the public calls. This requires rebuilding LibVNCServer but no LibVNC source patch. A plain unprefixed archive is simpler to link but provides weaker isolation from other zlib users in the CEF process. [Generated symbol mapping](https://github.com/zlib-ng/zlib-ng/blob/2.3.3/zlib_name_mangling.h.in), [header/install generation](https://github.com/zlib-ng/zlib-ng/blob/2.3.3/CMakeLists.txt).
4. Verify with `nm` that the worker archive references `weave_rfb_deflate*`, the candidate archive defines them, and the final executable resolves them. Inspect `otool -L`/`readelf -d` and a link map. CEF or unrelated frameworks may legitimately retain their own system zlib dependency; the test is which implementation satisfies RFB's prefixed calls.
5. Do not install into `/usr`, Homebrew, global search paths, or modify `LD_PRELOAD`/`DYLD_*`. Alpha's Mac/iPad decoder should keep its existing library for the first comparison. This confines the candidate to Host compression and proves interoperability with an unchanged upstream decoder.

## Other upstream options

| Candidate | Fit for this experiment |
| --- | --- |
| zlib-ng 2.3.3 | First choice: compatible streaming API, C/CMake already fits the native dependency build, architecture dispatch, private prefix support. No performance guarantee on Weave's small ZRLE chunks. |
| Stock zlib 1.3.2 | Useful reproducible control beyond the current OS library. Upstream's current release is dated 2026-02-17 and includes audit fixes; use it if a pinned baseline is needed. Its advertised changes do not establish a large ARM ZRLE acceleration. [Official release](https://zlib.net/). |
| zlib-rs | Credible maintained second candidate: upstream provides a zlib-compatible C API and symbol prefixing. Its C distribution path introduces Rust/Cargo and possibly cargo-c packaging; the project documents static output as well as shared output. That adds build ownership versus zlib-ng. Benchmark the real C ABI path before choosing it; upstream's general performance comparison is not Weave evidence. [Project](https://github.com/trifectatechfoundation/zlib-rs), [C integration](https://github.com/trifectatechfoundation/zlib-rs/blob/main/libz-rs-sys-cdylib/README.md). |
| Cloudflare zlib | Existing optimized fork worth knowing about, but this pass did not establish a current stable release pin and supported arm64 Mac packaging equivalent to the first candidate. Do not claim it abandoned or adopt it based on the repository's performance wording. [Upstream repository](https://github.com/cloudflare/zlib). |
| libdeflate | Exclude for this seam: its upstream API is explicitly not zlib compatible and does not support streaming. Replacing a continuing ZRLE deflate stream with its chunk compressor requires protocol/state work, contradicting this bounded drop-in test. [Upstream API limits](https://github.com/ebiggers/libdeflate#api). |

## Acceptance before adoption

Run the upstream tests and existing worker tests with the exact candidate flags. Then run a focused streaming compatibility test: many input chunks, repeated `Z_SYNC_FLUSH`, small output buffers that require repeated deflate calls, and persistent stock-inflate state. Include text/palette-like data, gradients, random/incompressible input, tiny changes, and data exceeding the deflate history window. Verify every decoded byte after each logical update, independent streams for two clients, and fresh streams after reconnect. Test reset/reuse separately if the helper exercises `deflateReset`; do not add resets to product ZRLE just for a test.

The live gate remains the unchanged Mac and iPad clients decoding ZRLE through the actual Portal route: exact pixels at 2×, repeated updates, scale/viewport resize, reconnect, two viewers, and a slow/disconnected client. Confirm page content continues and the worker's cancellation path still terminates during compression/output. Exercise ordinary navigation, popups, and stale focus/revocation acceptance after the rebuilt runtime. Compression cannot change those authorization contracts.

Use paired A/B runs with one backend change at a time. Report worker CPU and pump time, bytes/update and total bandwidth, client decode CPU, frame arrival cadence, input-to-display median/p95, memory, and idle CPU. Include text scrolling, animation and high-entropy content, with the same viewport and display backend. Keep iPad runs paired closely on the same route and report variance. Adopt only a repeatable improvement without pixel, protocol, memory, or lifecycle regressions; neither compression microbenchmarks nor a higher encoder throughput alone establishes 60 FPS or lower iPad latency.
