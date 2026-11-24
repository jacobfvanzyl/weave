# Sill's window streaming, and a screen Block

Research snapshot, 2026-11-15. Primary sources only. Sill was read from a clone of `Saffsanity/sill` at [`aea35475`](https://github.com/Saffsanity/sill/tree/aea35475f28a747dff8265ab416508f0ed1beef6) (`main`, 2026-11-15; latest release `v0.6.1`, 2026-11-11), with its issues and pull requests through the GitHub API. Paths below that start `Sources/`, `iOSClient/`, `docs/` or `Scripts/` are in that clone unless they say weave. Apple's and WebKit's claims were read from Apple's documentation and Safari release notes. Nothing was built, installed or run, and no stream was seen. Weave is judged at `6bdd342c`. Sections 1 to 8 are facts. Section 9 lists what wasn't verified. Sections 10 to 12 are analysis for weave, not a plan.

The question: what Sill is and how it works, and whether weave could take a new Block type from it, one that shows a window or the screen of a Host's computer.

This note uses weave's words (Host, Dispatcher, Session, Block, thread, device). Sill's *host* is its Mac app, written "Sill for Mac" here, and its *device* is the iPhone or iPad, as in weave.

## In brief

- **Identified with confidence.** `sill` is [Saffsanity/sill](https://github.com/Saffsanity/sill), "Any window from your Mac, live on your iPhone or iPad", with the site [getsill.app](https://getsill.app). A GitHub search for the name returned no other streaming project. Two unrelated repositories share the name: `lemonadesaltbagel/sill` (a Bash for Windows) and `TylerFisher/sill` (a link aggregator).
- **What it is.** A menu bar app for the Mac and a native app for the iPhone and iPad, both Swift with no third-party dependencies. The Mac captures one window, or one display, with ScreenCaptureKit, encodes it as HEVC with VideoToolbox, and sends it over TCP with TLS 1.3. The device decodes with `AVSampleBufferDisplayLayer` and sends touches, keys and scrolls back, which the Mac posts as CGEvents.
- **Licence and state.** Apache-2.0. Seven weeks old (first commit 2026-09-22), 1,607 commits, almost all by one maintainer, 4,897 stars, six releases, on the App Store. It moves fast and its wire format has a written compatibility rule.
- **Its distinctive idea is per-window streaming on a virtual display.** The window moves onto a private-API display sized for the device, so it keeps repainting when covered and its text is rendered at the device's scale.
- **For weave, the frame and input protocol is the easy part to borrow, and the capture end is the hard part.** Sill's wire format is small enough that others have written an Android client, a Linux host and a Python test client against it. Its capture, virtual display, input injection and permission handling are several thousand lines of macOS-specific Swift that need a signed app in the person's login session.
- **The web view can probably decode it.** Safari's WebCodecs has decoded video since 16.4 and HEVC since 17.4, per Apple's release notes. Whether that holds in the app's web view at the latency a remote screen needs is unmeasured.
- **Three things weave has that Sill doesn't** shape any Block: the page is a web view, devices reach a Host only through the Dispatcher, and one Host is Linux with no display.

## 1. The project

- **Repository.** [Saffsanity/sill](https://github.com/Saffsanity/sill), public since 2026-09-26, Apache-2.0 ([LICENSE](https://github.com/Saffsanity/sill/blob/aea35475f28a747dff8265ab416508f0ed1beef6/LICENSE), `README.md`: "Copyright 2026 Noah Saffer"). GitHub's API on 2026-11-15: 4,897 stars, 303 forks, 166 open issues and pull requests, last push that day.
- **Activity.** 1,607 commits since 2026-09-22; `git shortlog` gives 1,528 to the maintainer under two names, 40 and 24 to two contributors, and a handful to others. Releases v0.3.0 (2026-09-26) to v0.6.1 (2026-11-11), plus a nightly pre-release.
- **How it is developed.** The repository's contributor guide is a 1,878-line `CLAUDE.md`, with a dated note per branch in `docs/steps/` and some eighty standalone checks in `Tests/checks/`. The notes speak of agents doing the work under rules the maintainer sets.
- **Distribution.** Sill for Mac is a notarized download and a Homebrew cask, outside the Mac App Store because of the private API in section 3. The iPhone and iPad app is free on the App Store, with a TestFlight beta (`README.md`).
- **Requirements.** macOS 14 or later, Apple silicon or Intel. iOS or iPadOS 17 or later (`README.md`, `Package.swift`).
- **Stated rules.** "Swift and Apple frameworks only, no third-party dependencies, nothing that needs a server, and latency before picture quality" (`README.md`, Contributing). "Latency beats quality. Drop frames before queuing them" (`CLAUDE.md`, Conventions).
- **Its own competition table** (`docs/BRIEF.md`, checked by its author on 2026-09-21) names Mirage as the closest product: per-window, closed source, subscription. That table wasn't checked here.

## 2. What it streams, and capture

- **One source at a time, for every connected device.** "Sill shows one window, or the whole desktop, at a time" (`README.md`). Several devices may connect, and all get the same stream: `StreamServer.broadcast` sends each frame to every client (`Sources/SillHost/StreamServer.swift`).
- **A window** is captured with `SCContentFilter(desktopIndependentWindow:)`, and **the Desktop** with a display filter that leaves Sill's own windows out (`Sources/SillHost/StreamCoordinator.swift`, lines 2139 and 2366). An unreleased change steps the Desktop between the Mac's displays (kind 47, `Sources/StreamProtocol/DesktopDisplays.swift`).
- **Capture settings.** 8-bit 4:2:0 biplanar full range, `minimumFrameInterval` of one over the frame rate, queue depth 5, the cursor left out (`Sources/SillHost/WindowCapture.swift`). The frame rate is 24 to 120 (`Sources/SillHost/HostConfig.swift`).
- **Nothing runs while no device is connected**: no capture, and no polling of the window list (`Sources/SillHost/WindowCatalog.swift`).
- **The catalogue.** The Mac sends the list of windows as JSON, a JPEG thumbnail per window every two seconds at quality 0.6, each app's icon as PNG, and the installed apps, so the device can pick a window or launch an app (kinds 2 to 7, `Sources/StreamProtocol/StreamMessage.swift`; `WindowCatalog.swift`).
- **A covered window freezes.** "ScreenCaptureKit sends frames only when a window repaints, so a covered window freezes on the device" (`CLAUDE.md`, from `docs/steps/2026-09-22-milestone-1.md`). This is what the virtual display is for.

## 3. The virtual display, and fitting the window to the device

- **The private API.** `CGVirtualDisplay` and three sibling classes are in CoreGraphics and "in no public header". Sill looks each class and selector up through the Objective-C runtime and checks its type encoding, so a missing API "becomes a thrown `VirtualDisplay.Failure`, never a crash", and the stream falls back to the real window (`Sources/SillHost/VirtualDisplay.swift`).
- **What it does.** The stage creates a display, moves the picked window onto it with Accessibility position and size writes, which "do not raise or focus anything", and captures the display cropped to the window's rectangle. When the window is deselected or the last device leaves, it "puts the window back exactly where it was and removes the display" (`Sources/SillHost/VirtualStage.swift`).
- **Sizing.** The display is a square envelope from the device's panel, reused across rotations and text-size steps so "no display is recreated and nothing flashes on the Mac" (same file).
- **The cost to the person at the Mac.** "While the virtual display is on, the window your device shows isn't on your Mac's screen until you stop" (`README.md`).
- **It needs an AppKit event loop.** "The owning process must run an AppKit event loop, `NSApplication.shared.run()`"; with `dispatchMain()` or a bare run loop the process never learns the display's modes (`VirtualDisplay.swift`, "measured on macOS 27").
- **The fallback** resizes the real window through Accessibility to fit the device at a text scale the person picks, "Aa" (`Sources/SillHost/WindowSizer.swift`), and restores its frame after (`WindowRestore.swift`).
- **An open report against it.** [#359](https://github.com/Saffsanity/sill/issues/359) (2026-11-12) reports `kernel_task` growing to 54 GB on an M1 Mac mini with the virtual display at 120 fps. It is one user's report, with no maintainer reply seen.

## 4. Encoding, transport and latency

- **Codec.** HEVC Main, VideoToolbox, real time, no frame reordering, a keyframe at most every four seconds of frames, an average bitrate with a one-second data rate limit, and optionally `PrioritizeEncodingSpeedOverQuality` (`Sources/SillHost/HEVCEncoder.swift`, lines 153 to 173). Hardware first, software "while that is busy" (`README.md`). AV1 is ruled out: "no hardware encode on Apple silicon as far as we know" (`CLAUDE.md`).
- **Bitrate is a preset, not adaptive.** Low 4, Efficient 8, Balanced 15, High 25, Pro 40, Ultra 80 and Extreme 150 Mbps (`Sources/StreamProtocol/HostSettings.swift`). A device away from home starts at Low and standard resolution (`README.md`).
- **One frame in the encoder at a time**, with a one-slot mailbox behind it where "a newer frame replaces a waiting one" (`Sources/SillHost/EncoderMailbox.swift`).
- **The Mac has one hardware encoder to share.** Sill's notes record its Desktop stream falling "from 57 to 33–36 fps" while another process encoded an iOS Simulator's screen (`docs/steps/2026-09-24-encoder-recovery.md`, "Operational rule").
- **Transport is TCP.** `NWListener` with `noDelay`, service class `.interactiveVideo`, and TLS 1.3 (`Sources/SillHost/StreamServer.swift`, `Sources/StreamProtocol/RemoteTLS.swift`). The brief expected "to move to UDP/QUIC" (`docs/BRIEF.md`); a contributor's pull request for QUIC beside TCP is open and unmerged ([#124](https://github.com/Saffsanity/sill/pull/124)). There is no WebRTC, RTP or WebSocket.
- **Framing.** A 14-byte header, big endian: kind (1), timestamp (8, a double), keyframe flag (1), payload length (4). A frame's payload is one HEVC access unit with length-prefixed NAL units; parameter sets travel as their own kind. Control messages are JSON. Kinds run from 0 to 47, and "a kind this build does not know is skipped by the reader, not a reason to stop reading" (`Sources/StreamProtocol/StreamMessage.swift`).
- **Dropping instead of queueing, at home.** When a device has more than two messages unacknowledged, the Mac drops the next delta frame, marks the device as needing a keyframe and asks the encoder for one: "that queue is latency" (`StreamServer.swift`, `broadcast`).
- **Away from home** the rule counts bytes the connection hasn't taken, lets frames queue behind a keyframe still crossing, and asks for a new keyframe only once the backlog has drained. The comment records why: dropping behind a keyframe looped at "0–3 fps and rtt up to 12 s at 150 Mbps on a phone's hotspot" (`StreamServer.swift`, `paceRemote`).
- **The link is judged, not acted on.** Once a second the Mac classes each device's link as fine, behind or stalled, and "the host only counts, and nothing it sends or drops changes". The device shows a notice and offers a lower preset (`Sources/SillHost/LinkJudge.swift`, `README.md`).
- **A device can ask for a keyframe** (kind 44), at most one a second, when its decoder was interrupted, since "a still window never sends" one (`StreamMessage.swift`).
- **A keep-awake tick** (kind 13, empty) stops the device's Wi-Fi radio dozing, where "every next packet waits up to ~300 ms" (`StreamMessage.swift`).
- **Latency, as recorded.** On 5 GHz Wi-Fi to an iPad mini, ping round trips of 6 to 9 ms, and "glass-to-glass at roughly 40–60 ms", which the note calls an estimate from the transport figure plus capture, encode and display refreshes (`docs/steps/2026-09-22-milestone-2.md`). The brief's target is under about 60 ms on a local network.
- **Audio** is a beta: ScreenCaptureKit's audio of the window's app, AAC-ELD at 128 kbps in 10 ms packets, as kind 43, played "a moment behind the picture, never ahead of it" (`Sources/SillHost/AudioPipeline.swift`, `docs/DEVELOPMENT.md`, `README.md`).

## 5. Input

- **Positions are fractions of the video frame**, 0 to 1, "so the phone never learns anything about Mac geometry and a window that moves or resizes just changes `rect`" (`Sources/SillHost/InputInjector.swift`, `Sources/StreamProtocol/Input.swift`).
- **The events**: pointer move, left and right down and up; scroll deltas with gesture phases and momentum the device generates; typed text; and keys by USB HID usage with modifier bits (`Input.swift`).
- **Injection.** CGEvents made from `CGEventSource(stateID: .hidSystemState)` and posted at `.cghidEventTap`: mouse events, pixel scroll events, text through `keyboardSetUnicodeString`, and key repeat done by Sill since "posted events never repeat by themselves" (`InputInjector.swift`). This needs the Accessibility permission (`README.md`).
- **Touch is direct**: "where you touch is where the Mac's pointer goes, and the Apple Pencil is the mouse". An on-screen trackpad and key row serve the phone in portrait. The overlay is a `UITextInput`, so input methods and dictation compose on the device and the result is typed on the Mac (`iOSClient/InputOverlay.swift`). Pencil pressure isn't sent ([#81](https://github.com/Saffsanity/sill/issues/81), open).
- **Gestures** of three and four fingers are recognised on the device and sent by name; the Mac presses its own shortcut for Mission Control, Spaces and the rest (kind 28, `README.md`).
- **The pointer isn't in the video.** The Mac sends its cursor's image when it changes (kind 14) and its position when someone else moves it (kind 26), and the device draws a sprite, so its own pointer moves "at touch rate rather than a network round trip behind" (`iOSClient/HEVCDisplayView.swift`).
- **Menus and window controls go through Accessibility**: the Mac reads the app's menu bar on request and presses the chosen item (kinds 24, 25, 27), and closes, minimizes or full-screens a window (kind 15).
- **Clipboard**: text only, up to 256 KB, both ways, opt-in on both ends (kind 32).

## 6. Discovery, pairing and security

- **Finding the Mac.** Bonjour `_sill._tcp` on the local network; a USB cable; peer-to-peer Wi-Fi (AWDL), off by default; and Remote Access, off by default, through "your own VPN, such as Tailscale" or a forwarded port. A device learns the Mac's remote addresses while connected at home (kind 18, signed). "There is no account and no server in between" (`README.md`).
- **So it works over a tailnet**, and classes such a connection as away from home by the interface it arrives on (`Sources/SillHost/OriginPolicy.swift`).
- **Identity.** One P-256 key per Mac install and per device install, self-signed certificates, and each side pins the SHA-256 of the other's public key: "the verify block decides trust entirely and never evaluates names, dates or chains". TLS 1.3 only, tickets and resumption off, "because resumption would skip the certificate and a removed device could come back on an old ticket" (`Sources/StreamProtocol/RemoteTLS.swift`, `RemoteIdentity.swift`).
- **Two ALPN protocols** tell a session (`sill/1`) from a pairing (`sill-pair/1`) before any data, and the Mac refuses an unpaired key on `sill/1` inside the handshake (`RemoteTLS.swift`).
- **Pairing.** The Mac shows a QR code holding a `sill://pair` link, and a 12-digit code whose last digit is a Damm check digit, so a typo is caught on the device and "never uses up one of the Mac's five tries". Over a cable the device pairs by itself (`Sources/StreamProtocol/Pairing.swift`, `README.md`).
- **A locked Mac** shows devices a placeholder and takes typing only from paired devices; a session off the console gets "nothing: no capture, no input" (`Sources/SillHost/LockPolicy.swift`). The second rule locks out a Mac whose only remote access is Sill ([#316](https://github.com/Saffsanity/sill/issues/316), open).
- **Permissions.** Screen Recording, Accessibility, and Local Network on macOS 15 and later (`README.md`). The grants "belong to the bundle ID plus the designated requirement", so builds signed with one identity keep them and "ad hoc would lose it on every rebuild"; a binary run from Terminal makes "Terminal the responsible process, with Terminal's permissions" (`docs/steps/2026-09-23-menu-bar-app.md`, `docs/DEVELOPMENT.md`, Permissions).

## 7. The device app

- **Native Swift**, SwiftUI and UIKit, in `iOSClient/`. No web view and no Metal were found in it.
- **Decode and display** is one `AVSampleBufferDisplayLayer`, "which decodes HEVC in hardware itself. No VTDecompressionSession needed". The format description comes from the parameter sets, and each sample is marked `DisplayImmediately` (`iOSClient/HEVCDisplayView.swift`).
- **UX of note.** A bar of live window thumbnails; a searchable list of apps to launch; a Desktop button; pinch to zoom the picture up to 5×; Picture in Picture; the app's menus in the iPad's menu bar; layouts for the phone in portrait and for a folding phone; and a screenshot of each Mac as the last session left it on the connect screen (`README.md`).
- **Out of scope by decision**: several windows at once and layout customisation (`CLAUDE.md`, "Decisions already made").

## 8. Other clients and hosts of its protocol

- **A Python client**, `Scripts/sillclient.py`, ships in the repository for testing a host with no device.
- **An Android client** in Kotlin "speaks the existing wire protocol … unchanged" ([#90](https://github.com/Saffsanity/sill/issues/90), draft pull request #89, unmerged).
- **A Mac viewer** is an open pull request ([#66](https://github.com/Saffsanity/sill/pull/66)).
- **A Linux host and desktop viewers** exist as a separate project in Python and Rust, [NateHag/Sill-Viewer](https://github.com/NateHag/Sill-Viewer) (Apache-2.0), whose author says the App Store app connects to the Linux host unchanged ([#109](https://github.com/Saffsanity/sill/issues/109)). That repository wasn't read.
- **A compatibility floor is written down**: a host offers `sill/1` and `sill-pair/1` "for good", and later generations go beside them (`RemoteTLS.swift`).

## 9. Not verified

- **Nothing was run.** Sill's latency, picture quality and behaviour over a tailnet are its own notes' claims. The 40 to 60 ms figure is its author's estimate, not a measurement.
- **The reading was partial.** Of about 41,000 lines of Swift, the file headers and the capture, encode, send, input, TLS and display paths were read. `StreamCoordinator.swift` (3,754 lines) was searched, not read through. Most of `CLAUDE.md` and `docs/` was not read.
- **Issues** were read as their opening posts. "Open" and counts are the API's on 2026-11-15.
- **Sill-Viewer, the Android draft and Mirage** were not read. Mirage's description is Sill's brief's.
- **WebCodecs in the app's web view.** Apple's notes say Safari 16.4 "Added video-only support for Web Codecs" and Safari 17.4 "Added WebCodecs HEVC support", for iOS 16.4 and 17.4 ([16.4](https://developer.apple.com/documentation/safari-release-notes/safari-16_4-release-notes), [17.4](https://developer.apple.com/documentation/safari-release-notes/safari-17_4-release-notes)). That a `WKWebView` in a Tauri app has the same, that decoding is in hardware, and its latency, were not tested.
- **Managed Media Source on the iPhone** since Safari 17.1 is from a search summary of [WebKit's post](https://webkit.org/blog/14735/), not the post itself. **WebRTC in `WKWebView`** was not checked at all.
- **macOS's recurring Screen Recording reminder**, introduced in macOS 15, is known here only from press reports. Apple's page for the [Persistent Content Capture](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.persistent-content-capture) entitlement (macOS 14.4 and later) says it is for "a Virtual Network Computing (VNC) app" and granted on request; it doesn't mention the reminder.
- **Whether a bare binary started by launchd can hold Screen Recording and Accessibility grants**, and keep them across a rebuild, was not found in Apple's documentation. Sill's notes on signing (section 6) are the nearest evidence.
- **Linux capture** (PipeWire, the desktop portal, a headless compositor) was not researched.
- **ScreenCaptureKit on iOS.** Apple's [framework page](https://developer.apple.com/documentation/screencapturekit) now lists iOS 27 and says it "replaces ReplayKit for screen streaming and mirroring". Not followed up.

## 10. Weave as it stands

Facts from the repository at `6bdd342c`.

- **A Block is a type name and props the Host doesn't read.** `Block { id, type, props }`, where the type is "a reverse-DNS name, such as `weave.thread` … or `weave.terminal`", and "a client without the type shows the type and props as text" (`protocol/src/sessions.rs`, `sessions::layout`). ADR 0031 names "a tool call's view, a diff, a browser, and types of the person's own" as later types.
- **The app has two types**, in `app/src/session/blocks.ts`, drawn in `app/src/components/session/blocks.tsx`, where an unknown type falls to a text floor (`unknown`, line 305).
- **A Block points at "another thing on the Session's Host"** and closing it closes what it shows (`CONTEXT.md`; ADR 0031 as WVE-203 settled it).
- **A terminal's bytes have a stream of their own.** `terminals/attach` gives a ticket good once for 30 seconds; the stream is a WebSocket with subprotocol `weave-terminal`, binary frames of a kind byte and payload, and text frames of JSON (`protocol/src/terminals.rs`, `stream`; `host/src/terminals/stream.rs`). ADR 0022 gives the reason: "a flood of output has its own flow control and can't trip the thread connection's fell-behind limit".
- **A device reaches it through the Dispatcher.** The device's core opens the Dispatcher's WebSocket, proves its key and asks `hosts/open {host, stream}` with `stream` `host` or `terminal`. The Host dials back on "a connection of its own", and "every data frame goes through unread, either way". A slow device "falls behind in the Host, whose 8 MiB limit holds" (`docs/specs/wve-175-dispatcher.md`, Devices reaching Hosts; `host-client/src/carry.rs`).
- **The page gets the bytes over loopback.** The page opens a WebSocket per terminal on a loopback port of the core's, at an address with a single-use key, and the core passes it through; "a terminal's bytes never cross Tauri's IPC" (`app/src-tauri/src/terminals.rs`).
- **The page is a web view on every device** (ADR 0033), with no Content Security Policy set (`app/src-tauri/tauri.conf.json`, `"csp": null`). The app's minimum iOS is 15.0 (same file).
- **A Host listens for no remote client** (ADR 0030, WVE-197 in `AGENTS.md`).
- **The Host on a Mac is a per-user launchd agent** in the `gui/<uid>` domain (`cli/src/service/launchd.rs`), and the installed binary is a copy at `~/.local/bin/weave` that `scripts/update-hosts` replaces on every update (`AGENTS.md`). It is not an app bundle.
- **Hosts also run on Linux** as a systemd user service (`AGENTS.md`, WVE-116).
- **Agents already read and type into terminals** through `list_terminals`, `read_terminal` and `write_terminal` (`host/AGENTS.md`, WVE-233).
- **A holder is the precedent for a helper process**: one per terminal, outside the Host's process tree, outliving it (ADR 0022).

## 11. A screen Block: what it could be, and what carries over

Analysis from here on.

### 11.1 What it would be for

A Block that shows one window, or one display, of its Session's Host, beside the thread and terminal Blocks. The cases that fit how the person works:

- **The thing the agent is building**, where it runs: an iOS Simulator, a Mac app, a browser on a dev server. Today that is visible only at the Mac.
- **An app only the Mac has**, such as Xcode or a design tool, from the iPad or iPhone without leaving the Session.
- **What an agent is driving.** A thread with a tool to look at a window, and perhaps click in it, next to a Block where the person watches the same window.

It is of little use on the Mac for the Mac's own Host, which would show the screen the person is already looking at. Its use is from the iPad and iPhone, and from the Mac for another Host.

Sill's "one window as if it were an app" is the right grain for a Block. A whole desktop in a Block the size of a pane is hard to read; one window sized to the Block is not.

### 11.2 What carries over

- **The wire format's shape.** A kind byte, a keyframe flag, a timestamp and a length, with one access unit per frame and parameter sets apart, is nearly the terminal stream's "a kind byte and a payload". A third stream kind beside `host` and `terminal` would carry it.
- **Fractional coordinates for input.** The page never learns the Host's geometry, and a Block resized on one device doesn't disturb another.
- **Drop, then ask for a keyframe.** Sill's two pacing rules are the part most worth reading before writing any of this. The remote rule matters most, since every weave device is "away" in Sill's sense.
- **The cursor outside the video**, drawn by the page from an image and a position.
- **Idle means idle.** No capture with no Block attached.
- **The catalogue.** A list of windows with thumbnails is what New Block would need to offer a window to show.
- **Lock handling.** A locked Host shows a placeholder and takes nothing.
- **The code itself, on a Mac.** Apache-2.0 permits reuse with attribution. `WindowCapture`, `HEVCEncoder`, `EncoderMailbox`, `InputInjector`, `VirtualDisplay` and `WindowSizer` are the pieces, each written to be checked alone. They are Swift, so they would be a helper program beside the Host, as `weave-holder` is, not code in a Rust crate.

### 11.3 What has to differ

- **Decoding in a web view.** Sill hands HEVC to a system layer. The page would use WebCodecs' `VideoDecoder` and draw to a canvas, which Apple's notes put at iOS 17.4 for HEVC and 16.4 for other video. The app's minimum is iOS 15, so the Block would need a floor of its own or a raised minimum. H.264 would widen support at a cost in bitrate. Media Source Extensions add buffering that works against latency. WebRTC would bring its own congestion control and jitter buffer, but needs a peer path and signalling the Dispatcher doesn't carry today.
- **The path.** Sill's device talks to the Mac directly. A weave device's frames would cross two TCP connections joined at the Dispatcher, then a loopback WebSocket into the page. Each stream has its own connections, so a screen wouldn't hold up a thread, but loss on either leg stalls the stream behind it, and the Dispatcher's computer is a detour unless it is on the path anyway. Sill's own history is the warning: its pacing away from home was reworked after it looped on a phone's hotspot (section 4), and QUIC is still an open pull request.
- **Who captures.** Capture and input need Screen Recording and Accessibility, granted to a signed identity in the person's login session. The Host is a bare binary that every update replaces. If grants follow the signature, as Sill's notes say, each `scripts/update-hosts` could lose them. The Mac's app is a signed bundle that could hold the grants, but then a window is only available while that app runs. A separately signed helper that updates rarely is the third choice. This is the largest unknown, and it is checkable in an afternoon.
- **The virtual display** needs a private API and an AppKit event loop in the process that owns it. Without it a covered window freezes, so a Block showing a window behind others on the Mac would stall until Sill's fallback, or the person, uncovers it.
- **One encoder.** Sill streams one source for all devices, and measured other encoders halving its frame rate. Two screen Blocks on one Host, or a Block beside Sill itself, would contend.
- **Several Blocks, several devices.** A Session's layout is shared, so an iPad and an iPhone may show the same Block at different sizes. Sill sizes the window to one device. Weave's terminals already have a rule for this, the last device to type sets the size and the others clip, and a screen Block could take the same rule.
- **Linux Hosts.** None of the capture end applies. A Linux Host with a desktop would need another capturer, and a headless one has no screen to show unless something makes one. The honest first position is that the Block exists only on Hosts that say they can serve it, and is the text floor elsewhere.
- **Single user** makes pairing simpler than Sill's. Devices are already paired with the Dispatcher, and a Host already knows which device a carried connection is for, so a screen stream needs a ticket, as a terminal's does, and no pairing of its own.

## 12. Options, smallest first

1. **Use Sill beside weave, and build nothing.** It is free, works over a tailnet, and already does the hard parts. It can't sit in a Session's layout, and it shows one window at a time. *Open:* whether a week of using it shows that a Block is wanted at all, and for which windows.
2. **Stills.** A Host tool that returns a window's picture to an agent, and a Block that shows the same picture refreshed every second or two, as Sill's thumbnails are. No codec, no stream kind, no input, or input limited to a click. *Risks:* the permission question above applies in full, and a still that lags reads as broken for anything that moves. *Open:* whether agents looking at a simulator or a browser is the real need, in which case this may be enough.
3. **Sill as the backend.** The app's Rust core pairs with a Sill for Mac running on the Host's computer as a device would, speaks `sill/1` to it directly over the tailnet, and passes frames to the page as it passes terminal bytes. No Host work and no capture code of weave's own. *Risks:* it departs from ADR 0030, since the device dials the Host's computer; Sill serves one source to all devices, so two Blocks can't show two windows; the virtual display takes the window off the Mac's screen; and weave would depend on a seven-week-old project's protocol, though it has a written floor and other clients rely on it. *Open:* whether Sill's maintainer would welcome it, and whether the page can decode what Sill sends.
4. **A stream of weave's own, on a Mac.** A third carried stream kind; a helper that captures and encodes one window per Block, borrowing Sill's code or its design; WebCodecs in the page; input as text frames in fractions; Sill's pacing rules. Real window only, no virtual display. *Risks:* the helper's permissions and signing; latency through the Dispatcher; the covered-window freeze; one encoder. *Open:* everything in "What to measure".
5. **Parity with Sill.** Add the virtual display, sizing the window to the Block, audio, menus, clipboard and gestures. Each is a feature Sill took weeks to settle and still has open reports against. Not worth weighing until option 4 has been used.
6. **Linux Hosts.** A separate capturer behind the same stream, after everything else. For the headless Host the question is first what there would be to show.

Options 2 and 4 share their hardest part, which is a process on the Mac that may capture and inject. Settling that settles most of what separates them.

### What to measure before deciding

- **Permissions.** Give the installed Host binary Screen Recording and Accessibility, capture one window from the launchd agent, run `scripts/update-hosts --here`, and see whether the grants hold. Repeat with a signed helper.
- **Decode in the page.** Feed a recorded HEVC stream to `VideoDecoder` in the app on the iPad, iPhone and Mac: whether it is supported there, the time from a frame's arrival to the canvas, and heat over ten minutes at 30 and 60 fps.
- **The path.** Round-trip time and sustained throughput of a carried stream from each device to each Host, against the same pair connected directly, at home and away. Sill's figures to compare with are 6 to 9 ms on local Wi-Fi and a lowest preset of 4 Mbps.
- **Loopback.** A terminal flood already passes through the core's loopback WebSocket; confirm 15 Mbps of video does without the page falling behind.
- **The covered window.** How often a window the person wants to watch from the iPad is covered on the Mac, which decides whether the virtual display is optional or the point.
- **The encoder.** Frame rate of one stream while a second, or an iOS Simulator recording, runs on the same Mac.
