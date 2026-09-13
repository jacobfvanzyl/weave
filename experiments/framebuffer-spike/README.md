# Framebuffer remoting first gate — WVE-79

Evaluated 2026-09-13. **Stop before the CEF/browser adapter.** The tested SPICE composition does not satisfy shared viewing with audio using its existing multi-client mode, and extracting frameworks from published UTM apps does not provide a complete CocoaSpice SDK.

This is a result for **SPICE + CocoaSpice**, not a rejection of framebuffer remoting generally. WebRTC remains the accepted browser backend. The Viz experiment is preserved.

## Subsequent scope change

On 2026-09-13 Jaco deferred audio completely and authorized a separate RFB/LibVNC experiment. The shared-audio blocker below remains historical evidence for SPICE, but is not a current audio acceptance requirement. See the [RFB native and CEF results](../rfb-spike/README.md).

## What ran

A small producer uses SPICE's public QXL and playback interfaces directly. It submits changing 640×360 bitmaps at a nominal 10 Hz and synthetic stereo PCM, with lossless QUIC image compression and video streaming disabled. There is no QEMU, VM, CEF, Chromium or desktop capture in this test. QXL setup follows the upstream test producer; derived server code retains its LGPL notice.

The diagnostic native arm64 Mac client uses the published SPICE client library to receive and decode display and playback channels. It counts changed frame markers and PCM samples. It **does not present a Metal view or play audio through the device**. Nonzero PCM proves reception and decoding, not audible playback, timing quality or audio/video synchronization.

Two independent client processes connect to one server: A stays connected, B joins, B leaves, and B reconnects while A remains. Each case runs a bounded 24-second server. The same source runs on the Mac and Bazzite. Linux is reached by SSH loopback forwarding over Tailscale; this is not direct-SPICE LAN/VPN acceptance. Test servers are unauthenticated but bound only to loopback and all have exited.

| Host and mode | Viewer A | Viewer B | B reconnect |
| --- | --- | --- | --- |
| Mac, default | Display + PCM, then disconnected when B joins | Display + PCM | Display + PCM |
| Mac, experimental multi-client | 184 changing updates, 696,000 PCM samples; remains connected | 58 changing updates, **zero PCM; no playback channel** | 48 changing updates, **zero PCM** |
| Linux, default | Display + PCM, then disconnected when B joins | Display + PCM | Display + PCM |
| Linux, experimental multi-client | 196 changing updates, 810,240 PCM samples; remains connected | 66 changing updates, **zero PCM; no playback channel** | 50 changing updates, **zero PCM** |

These are total callback/sample counts over different connection intervals, not throughput or latency benchmarks. All non-silent streams had normalized PCM RMS approximately 0.0388. The synthetic producer does not establish audio clock correctness or continuity. [Structured results](evidence/summary.json), [process outcomes](evidence/process-results.json), individual `*-viewer-*.jsonl` and `*-server.jsonl` files retain the observations.

The diagnostic client exits successfully after receiving display and audio at any point. Thus viewer A's zero exit in default mode does **not** mean shared viewing passed: the channel-close events and stopped frame sequence show replacement. Additional viewers exit 1 in multi-client mode because they never receive audio.

## Why audio fails for additional viewers

This is an explicit server limitation, not missing Apple playback configuration:

- In spice-server 0.16.0 `server/reds.cpp:959`, `channel_supports_multiple_clients` allows main, display, cursor and input channels. Playback is absent.
- `reds_fill_channels` excludes unsupported channels when there is more than one client. The server logs `sent 3 out of 4` for additional viewers.
- In `server/sound.cpp:1001`, `SndChannel::set_peer_common` disconnects an existing sound client when a replacement connects. The sound implementation is designed around one client.

Consequently, merely advertising playback to every viewer is insufficient. Supporting audio on all attachments requires a server change, independent per-viewer server sessions, or a separate media transport. Even a focused-client-only audio policy would need explicit handoff work; the tested default gives audio to the first attachment and does not follow Portal focus.

Source: [official spice-server 0.16.0 release](https://www.spice-space.org/download/releases/spice-0.16.0.tar.bz2), hash recorded in [artifact hashes](evidence/artifact-hashes.json). The release README continues to mark multi-client mode experimental (`SPICE_DEBUG_ALLOW_MC=1`).

## Apple packaging probe

The standard Homebrew dry run proposed 53–56 new dependencies and eight upgrades through GStreamer and related packages. That installation was not performed. The existing Homebrew installation and unrelated apps were preserved.

Instead, downloaded the official UTM v4.7.5 Mac disk image and iOS Remote IPA, and used their bundled native frameworks in an isolated build. The frameworks were sufficient to compile and run the diagnostic Mac server/client above. They were **not sufficient to link unchanged CocoaSpice with its audio initializer**.

Both macOS arm64 and iOS arm64 builds reached the linker and failed on 19 static GStreamer plugin registration symbols, including `gst_plugin_coreelements_register`, `gst_plugin_app_register`, `gst_plugin_audioconvert_register`, `gst_plugin_audioresample_register`, and `gst_plugin_osxaudio_register`. A symbol audit of all 47 Mac and 38 iOS non-QEMU bundled frameworks found none of the missing registrations. Existing GStreamer core/app/video dynamic frameworks do not supply those plugin implementations. See the [symbol audit](evidence/apple-plugin-symbol-audit.json). The logs also retain upstream compiler warnings and auto-linked-framework warnings; they are not counted as successful native-client acceptance.

- [Mac linker evidence](evidence/apple-link-mac.log)
- [iOS linker evidence](evidence/apple-link-ios.log)
- [Build outcomes](evidence/apple-link-results.json)
- [CocoaSpice source/package](https://github.com/utmapp/CocoaSpice/tree/127033fa3e59cd49678f49ed54f8adfc060afb56)
- [UTM dependency build documentation](https://github.com/utmapp/UTM/blob/v4.7.5/Documentation/Dependencies.md)

This disproves the **frameworks-only prebuilt shortcut**, not CocoaSpice's ability to run on Apple devices. UTM's documented dependency build pipeline can supply the missing libraries. Adopting it means selecting, building, packaging, tracking licenses and updating the dependency graph; no Chromium source build is implied. We stopped before building that stack because shared audio had already failed the functional gate. No SPICE app was installed or run on the physical iPad, and no native SPICE audio was heard or accepted.

An additional version caveat: [UTM v4.7.5 source declarations](https://github.com/utmapp/UTM/blob/v4.7.5/patches/sources) pin its Mac server to **spice 0.14.3**, its client to **spice-gtk 0.42**, and GStreamer to **1.19.1**, with UTM patches. The Mac runtime test is not a test of Homebrew spice-server 0.16.0. Bazzite's independently installed package is **spice-server-0.16.0-2.fc43.x86_64**, and reproduced the limitation on the newer release. A compatibility enum in server logs is not a library version.

## Decision

**The first gate is not passed. Do not start the browser adapter for this composition without revisiting the added maintenance.** Shared display works in experimental mode, but shared audio and a self-contained Apple dependency package do not come with the tested components.

Possible follow-ups, not implemented or adopted:

1. Separate SPICE server process/session per viewer, with the producer feeding each. This avoids changing the wire protocol but adds per-viewer buffering, lifecycle, audio and resource costs; it needs its own bounded test.
2. SPICE display plus the existing WebRTC audio path. This adds two transport lifecycles and synchronization work.
3. Another framebuffer protocol/library with an acceptable Apple client and audio story.

Continue the accepted WebRTC implementation unless a further framebuffer experiment is selected. No claim about framebuffer latency, browser fidelity, performance or general feasibility follows from this gate.

## Reproduction

The experiment never installs native packages or edits dependency sources. Downloads and extracted sources are under ignored `.build/`; original source URLs, versions and checksums are recorded above and in `evidence/artifact-hashes.json`.

Prerequisites: Xcode, Python 3, the four pinned archives, and Bazzite's SPICE runtime. Extract `spice-0.16.0.tar.bz2` and `CocoaSpice.tar.gz` into `.build/`, and `UTM-Remote.ipa` into `.build/utm-ios/`.

```sh
hdiutil attach -readonly -nobrowse -mountpoint /tmp/wve79-utm-mount experiments/framebuffer-spike/.build/UTM.dmg
python3 experiments/framebuffer-spike/build-probes.py
python3 experiments/framebuffer-spike/check-apple-link.py
python3 experiments/framebuffer-spike/run-gate.py
hdiutil detach /tmp/wve79-utm-mount
```

`check-apple-link.py` is a result collector: inspect `apple-link-results.json`, not only its process exit. Both link outcomes are expected failures in this setup. `run-gate.py` likewise records raw process outcomes and channel events rather than declaring the architecture passed.

For Linux, development RPMs were **downloaded and extracted**, not installed, under `/var/home/admin/weave-framebuffer-spike/sysroot`. They are glib2-devel, spice-protocol, spice-server-devel and spice-glib-devel. The last was available for investigation but not needed by the Mac client. The source compiled against these headers and the already-installed runtime libraries:

```sh
cc -g -I sysroot/usr/include/spice-server -I sysroot/usr/include/spice-1 \
  -I sysroot/usr/include/glib-2.0 -I sysroot/usr/lib64/glib-2.0/include \
  server.c -l:libspice-server.so.1 -l:libglib-2.0.so.0 -lm -o server-linux
```

The downloaded RPMs and sources remain isolated for reproducibility. No installed Host configuration, Workspace profile, Portal runtime, WebRTC implementation or remote Chromium build was changed.
