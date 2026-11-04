# A companion view for AirPlay displays in the app

Research snapshot, 2026-11-04, for WVE-181. Sections 1–6 are about the platform. They use only primary sources: Apple's developer documentation, release notes, WWDC sessions, Apple Support and Apple engineers' replies on the developer forums, and Capacitor's source and issues. These were read on 2026-11-04. Apple's documentation pages were also read as their JSON (`developer.apple.com/tutorials/data/documentation/...`), since their HTML is rendered by script. Sections 7–9 compare that with the app at `7c382072`, judge it against what's planned, and recommend. Nothing was built or run on a device. Section 10 lists what only a device can settle.

The question is how the app could put a view of its own on an AirPlay display (an Apple TV, or a Mac with AirPlay Receiver on), or on a wired one, while the iPad or iPhone stays the controller. And what that view should show.

## 1. In brief

- **iOS 27 changed how an app takes over a display.** "Beginning in iOS 27, your app receives a scene with the [`windowExternalDisplayNonInteractive`] role only after it registers a scene accessory. In earlier releases, the system connected this scene automatically, and your app opted out by declining to provide content for it" ([Presenting content on a connected display](https://developer.apple.com/documentation/uikit/presenting-content-on-a-connected-display)). The release note says: "In apps built with the iOS 27.0 SDK, `windowExternalDisplayNonInteractive` scenes are no longer offered automatically by the system. Use `UIViewController.registerSceneAccessory(_:)` with a `UISceneAccessory.externalNonInteractive` instance" ([iOS & iPadOS 27 release notes](https://developer.apple.com/documentation/ios-ipados-release-notes/ios-ipados-27-release-notes), 177015874). The app builds with Xcode 27.0 and the iOS 27.0 SDK, and both of the person's devices run 27.
- **The companion is non-interactive and full screen.** Nothing on the display takes input, and "Content for this scene spans the full screen" (same article). The device stays the controller.
- **The companion exists while the app is in front.** The system connects the scene "while your app presents the view controller, the registration is enabled, and an external display is available". It disconnects the scene "when the app dismisses the view controller or the display disconnects". Apple doesn't say what backgrounding does. On the iPhone it disconnects the scene and goes back to mirroring, and returning connects it again (section 10.1). This is a second screen for when the person is using the app, not a wall display that runs on its own.
- **The person starts it, not the app.** They choose Screen Mirroring in Control Center. No public API starts screen mirroring, and `AVRoutePickerView` lists media receivers only.
- **The app has a latent bug.** `AppDelegate` gives every scene role a `SceneDelegate`, which builds a second Capacitor bridge, and with it a second copy of the app. Capacitor's own template has the same flaw ([ionic-team/capacitor#8648](https://github.com/ionic-team/capacitor/issues/8648)). On iOS 16–26 that copy starts when mirroring starts. On the person's devices (iOS 27, SDK 27) it doesn't. The fix is one role check, needed whatever happens to the companion.
- **Recommendation (section 9):** a scene accessory registered on the bridge's view controller, showing a second, bridge-less `WKWebView`. It runs the same bundle in a display mode, drawing a projection of the `AppModel` that the main web view sends it. The companion is not a Host client, so the Host and protocol need nothing new. Terminals on the display are native `TerminalView`s with streams of their own. The device keeps the whole app, and the display shows something else drawn from the same state. What it shows, and what it's called, are still open (sections 9.4 and 9.5).

## 2. How an app takes over a display

### 2.1 The roles

- `windowExternalDisplayNonInteractive` (iOS 16 and later) is "a scene that displays noninteractive windows on an externally connected display" ([role](https://developer.apple.com/documentation/uikit/uiscenesession/role-swift.struct/windowexternaldisplaynoninteractive)). It replaced `windowExternalDisplay`, which is deprecated: "A scene that displays interactive windows uses windowApplication, even if the windows display on an externally connected screen" ([deprecated role](https://developer.apple.com/documentation/uikit/uiscenesession/role-swift.struct/windowexternaldisplay)).
- `UIScreen.didConnectNotification` and `UIScreen.screens` are deprecated since iOS 16 in favour of scene connection ([didConnectNotification](https://developer.apple.com/documentation/uikit/uiscreen/didconnectnotification), [screens](https://developer.apple.com/documentation/uikit/uiscreen/screens)). `UIScreen.main` is deprecated since iOS 26 ([main](https://developer.apple.com/documentation/uikit/uiscreen/main)).

### 2.2 iOS 27: scene accessories

From [Presenting content on a connected display](https://developer.apple.com/documentation/uikit/presenting-content-on-a-connected-display) and the [`UISceneAccessory`](https://developer.apple.com/documentation/uikit/uisceneaccessory) and [`registerSceneAccessory(_:)`](https://developer.apple.com/documentation/uikit/uiviewcontroller/registersceneaccessory(_:)) pages:

- A scene accessory "declares supplementary content that the system presents on your app's behalf when associated functionality becomes available, such as an external display connected by cable or AirPlay. Your app declares what content to provide, and the system decides when and where to present it."
- The app builds a `UISceneConfiguration`, either from a `delegateClass` or a configuration named in the scene manifest. It then registers `.externalNonInteractive(sceneConfiguration:)` on "a view controller in your app's main interface" and keeps the `UISceneAccessoryRegistration` it gets back. The scene delegate's `scene(_:willConnectTo:options:)` gets the scene and puts a `UIWindow` on it. `sceneDidDisconnect(_:)` follows a dismissal or a disconnect.
- `isEnabled` turns the content on and off. `isAvailable` says whether the system can show it now, observable in `updateProperties()` and `layoutSubviews()`. `unregisterSceneAccessory(_:)` withdraws it. `externalNonInteractive(sceneConfiguration:userInfo:)` passes context, which the delegate reads from `sceneAccessoryUserInfo`.
- "If more than one view controller in your app registers an external-display accessory, the system presents the registration that belongs to the topmost, most recently presented view controller." Our single bridge view controller is always that.
- "Because the content appears only when a display is available, design your app to remain fully functional without the external display."
- An Apple engineer confirms it: "Starting with iOS 27, the system no longer connects a `windowExternalDisplayNonInteractive` scene to the app" ([forum 836437](https://developer.apple.com/forums/thread/836437)).

### 2.3 Before iOS 27

- The system offers the scene to every app. An app takes the display by putting a window on it, as WWDC25's AirPlay timer does ([Make your UIKit app more flexible](https://developer.apple.com/videos/play/wwdc2025/282/)). It declines by leaving the scene empty, which keeps the device mirrored. Apple's DTS: "you do not need to put anything in the scene unless you want to stop mirroring" ([forum 815376](https://developer.apple.com/forums/thread/815376)). A frameworks engineer adds that the scene "is not something that can be blocked" ([forum 745553](https://developer.apple.com/forums/thread/745553)).
- Apple doesn't say what an app built with the iOS 27 SDK gets on an iOS 26 device. The wording "Beginning in iOS 27" suggests such a device still offers the scene automatically. The app's deployment target is iOS 15, so it has to handle both.

### 2.4 Multiple scenes

The app sets `UIApplicationSupportsMultipleScenes` to false. For that key, "UIKit never creates more than one scene" ([key](https://developer.apple.com/documentation/bundleresources/information-property-list/uiapplicationscenemanifest/uiapplicationsupportsmultiplescenes)), yet Apple's engineers call the external display "a special case" whose callback comes "regardless of the `Info.plist`" (forums 745553, 815376). Apple's accessory example sets a `delegateClass` with no manifest entry, and says nothing about the key. Whether an accessory works with the key false is open (section 10). Turning it on would also let iPadOS open several of the app's windows. The app isn't built for that, so it would be a decision of its own.

## 3. Where the display comes from

- **AirPlay:** Control Center → Screen Mirroring → an Apple TV or a Mac; "Stop Mirroring" ends it ([iPad User Guide](https://support.apple.com/guide/ipad/stream-video-mirror-screen-ipad-ipadf27a8cb7/ipados), [Apple Support 102661](https://support.apple.com/en-us/102661)). A Mac needs AirPlay Receiver on (System Settings → General → AirDrop & Handoff). An app needs nothing to appear in that list.
- **No API starts it.** `AVRoutePickerView` "presents a list of nearby media receivers" for audio and video ([AVRoutePickerView](https://developer.apple.com/documentation/avkit/avroutepickerview)). Nothing documented starts screen mirroring, so the app can only tell the person how to start it.
- **A cable:** a USB-C or Lightning AV adapter. On iPad models with extended display it works differently (section 4).

## 4. iPad: Stage Manager's extended display

- "When an external display connects, the system mirrors your app's primary display, or, on compatible iPad models with extended display enabled, presents your app's interactive windows on the external display" (connected-display article). Windows there are ordinary `windowApplication` scenes, placed by the person or the system ([forum 837091](https://developer.apple.com/forums/thread/837091)).
- Extended display needs "a compatible iPad model and a compatible cable or adapter" ([Move an app to an external display](https://support.apple.com/guide/ipad/move-an-app-to-an-external-display-ipad8baf19a7/ipados)). Apple's AirPlay guide describes mirroring only. Nothing found says AirPlay to an Apple TV ever extends the desktop.
- Apple's iPadOS 26 list of models that support it includes the iPad Air 11-inch (M3) ([Apple Support 105075](https://support.apple.com/en-us/105075)). That is the person's iPad.
- Whether a non-interactive accessory is offered while the extended display is in use isn't documented. The likely split is: AirPlay gives the companion, and a cable on that iPad gives a second desktop where the app's one window can be moved. That needs a test.

## 5. iPhone

- The same two paths exist: AirPlay mirroring, or a cable ([iPhone User Guide](https://support.apple.com/guide/iphone/connect-to-a-display-with-a-cable-iph93af723b9/ios)). There's no extended display, so a display is either mirrored or the companion.
- iPhone Mirroring (a Mac driving the locked iPhone) is a different feature. It requires that the Mac is "not … using AirPlay or Sidecar" ([Apple Support 120421](https://support.apple.com/en-us/120421)), and plays no part in this. WWDC26 notes that apps in it are resizable and their scene's screen isn't `UIScreen.main` ([Modernize your UIKit app](https://developer.apple.com/videos/play/wwdc2026/278/)). That's one more reason to take geometry from the scene.
- A phone with a companion makes sense: the phone is the remote, and the display holds what doesn't fit on it.

## 6. What the display asks of the content

- **Distance.** Apple has no guidance page for an app's content on another display. Its nearest is tvOS: viewers sit "often 8 feet or more" away ([Designing for tvOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-tvos)). It also gives a TV safe area: "Inset primary content 60 points from the top and bottom … and 80 points from the sides" ([Layout](https://developer.apple.com/design/human-interface-guidelines/layout)). A Mac receiver shows the scene in a window, with no overscan.
- **Overscan and modes.** `UIScreen.overscanCompensation` scales, insets or leaves overscan to the app ([overscanCompensation](https://developer.apple.com/documentation/uikit/uiscreen/overscancompensation-swift.property)); its default isn't documented. A non-interactive scene may change the screen's mode before it attaches its window ([connected-display article](https://developer.apple.com/documentation/uikit/presenting-content-on-a-connected-display), [currentMode](https://developer.apple.com/documentation/uikit/uiscreen/currentmode)), and `currentMode` defaults to the highest resolution. Display links come from the window scene now: `UIScreen.displayLink(withTarget:selector:)` is deprecated in iOS 27 ([displayLink](https://developer.apple.com/documentation/uikit/uiscreen/displaylink(withtarget:selector:))).
- **Lifecycle and power.** The scene gets `sceneDidEnterBackground` like any other (WWDC25 pauses its timer there). A suspended app draws nothing, and Apple doesn't say what the display shows then. Apple's only performance advice is the archived guide's: the app "needs to handle the performance implications of using one device's resources to generate a second screen's worth of content … test to discover an optimum frame rate" ([Window and screen guide, archived](https://developer.apple.com/library/archive/documentation/WindowsViews/Conceptual/WindowAndScreenGuide/UsingExternalDisplay/UsingExternalDisplay.html)).
- **Other routes, rejected.**
  - AVPlayer's external playback survives backgrounding ([usesExternalPlaybackWhileExternalScreenIsActive](https://developer.apple.com/documentation/avfoundation/avplayer/usesexternalplaybackwhileexternalscreenisactive)), but it carries video, not a live UI.
  - A tvOS app couldn't run the React UI, since `WKWebView` isn't available there ([WKWebView](https://developer.apple.com/documentation/webkit/wkwebview)). It would be a separate native client of the Host.
  - A page in the Mac's own browser is a different client entirely (section 9.4).

## 7. What the app has

### 7.1 The shell

- `SceneDelegate.swift` builds a `WeaveBridgeViewController` (a `CAPBridgeViewController`) for each scene it's given. A `WeaveSurfaceContainer` puts the native terminals beneath a transparent web view.
- `AppDelegate.application(_:configurationForConnecting:options:)` returns `SceneDelegate` for every `connectingSceneSession.role`. This is #8648's bug: on iOS 16–26, mirroring starts a second bridge, so a second copy of the app runs against the same storage, connects to the Hosts again with the same device key, and registers plugins twice. Capacitor's issue reports SQLite "database is locked" errors, and the template on `main` still has the bug.
- Capacitor 8.5.3's `CAPBridgeViewController` builds its own configuration, asset handler and bridge per instance, so two can run. Several singletons are shared, though: `SceneDelegateProxy.shared`, `ApplicationDelegateProxy.shared`, `KeyValueStore.standard`. The roadmap issue for multi-window, [#4001](https://github.com/ionic-team/capacitor/issues/4001), is closed with discovery "shortly", and nothing documents a second web view without a bridge.
- Two web views on the default `WKWebsiteDataStore` share cookies and storage ([WKWebsiteDataStore](https://developer.apple.com/documentation/webkit/wkwebsitedatastore)). Each has its own page and JavaScript, so nothing in memory is shared between them.

### 7.2 What a display could draw from

The UI reads one `AppModel` (`app/src/app/app-controller.ts`). All of it is plain data:

- **Hosts:** paired Hosts with their status (connecting, connected, reconnecting, …).
- **Threads:** every thread on every Host. Each has a title, agent, directory, git repository, worktree and branch, its state and activity (idle, running, waiting), what it waits on, attached clients, whether it's headless, its last activity, and the thread that started it. The sidebar groups them by Host, then project (WVE-162), with "Needs you" for those waiting.
- **The open thread:** its `AcpTranscript` (entries, plan, subagents, Host-run terminals, modes, `usage` from ACP's `usage_update`, and the turn's status), its queue and whether that's paused, its worktree's terminals with their commands and program status (OSC 7501), and its MCP servers.
- **Unread:** this device's set of threads whose turn ended since the person last looked.

### 7.3 Terminals

A worktree's terminals stream from their holder through the Host to any number of attachers (ADR 0022). "Size is the owner's policy, and a client's `resize` is a request": the last device to type sets the size and the others clip (protocol spec, Terminals). A display that never types never takes the size, so it can't resize anyone's shell. The app's native plugin holds each stream's WebSocket itself (`TerminalStream.swift`), from a ticket the web view gets with `attachTerminal`. Tickets are good once, so the display needs one of its own. `WeaveTerminalRenderer` takes a grid from a viewport size. A display would need the inverse: the largest font that fits the terminal's `cols × rows` into the screen.

## 8. What's planned, and how it fits a display

| Planned | What it adds to a display |
| --- | --- |
| MCP Apps views and the app's Pane (WVE-94, WVE-96) | ADR 0012 makes placement "per client and never journaled", so a display is one more placement. A `view` event journals the complete input and result, so a view can render from the journal with no calls of its own, which suits a display that takes no input. Views that call tools or send `ui/message` stay on the device. |
| Visuals (WVE-95) | A diagram, chart or page the agent keeps revising is presentation material, the most natural thing to put on a TV. A revision replaces it in place. |
| Bots (WVE-178, WVE-118) | Each Bot by name with its state (needs you, working, unread, idle): a row in an overview of every thread, or its own section at the top. |
| Schedules and triggers (WVE-145, WVE-146, WVE-176) | What runs next, and recent occurrences and how they ended. They come through the Dispatcher's device API, so they appear on the display only once the app pairs with the Dispatcher. |
| Context usage in listings (WVE-174) | A fill bar for each thread in an overview, not only for the open one. |
| Labels (WVE-173) | An overview follows the app's rule: Bot threads under their Bot, not among the ordinary threads. |
| Pushes and presence (WVE-177, WVE-147) | The companion isn't a client (section 9.2), so the Host and Dispatcher never see it. Showing a thread on a TV doesn't count as the person having seen it, and doesn't stop a push. |
| Successors (WVE-168) | The display follows a Bot's thread into its successor, as the device does. |

ADR 0018's rule holds: every client decides how far above the text floor it goes. A display is a placement within the app, not a new client, so the decision is the app's.

## 9. Recommendation

### 9.1 The platform route

1. **Fix the role bug first.** In `configurationForConnecting`, give `SceneDelegate` only to `.windowApplication`, and in `scene(_:willConnectTo:)` guard on the role, as #8648 proposes. On iOS 16–26 the non-interactive scene then stays empty and the device mirrors, as on iOS 27. This is small and stands alone.
2. **Register a scene accessory** on `WeaveBridgeViewController`, with a delegate of its own, `CompanionSceneDelegate`. On iOS 16–26, `configurationForConnecting` gives the automatic non-interactive scene the same delegate, so both paths draw the same companion. Below iOS 16 the app keeps mirroring. Raising the deployment target to 16 would remove that branch.
3. **Keep the registration enabled** whenever the app is in front. Nothing shows on the display unless the person mirrors to it. A setting could disable it, to fall back to mirroring.

### 9.2 What draws the companion

Of the three ways to draw it, the **projection** is recommended:

- **A projection (recommended).** A bridge-less `WKWebView` in the companion's window loads the same bundle in a display mode (`?display=external`), on its own `WKWebsiteDataStore`. A small native plugin, `Companion`, carries messages both ways: the main web view sends it a serialisable projection of the `AppModel` whenever that changes, and the native side posts it into the companion. It also relays the display's state back: available, connected, its size. The companion draws with the app's own components and never talks to a Host. The Host and protocol need nothing new; there's no second connection, device key or attach to count, and no second copy of the stores. The bundle's Content Security Policy already forbids the companion any fetch. What's sent is the person's own data, on the device, between two web views of the same app.
- **A second Host client** would mean a second `CAPBridgeViewController` (for `DeviceKeyPlugin`), or a native signer for a bare web view. Then a second connection per Host, attached threads that count as clients, and the shared-singleton risks of section 7.1. All of that to show what the device already has.
- **Native UIKit** would mean redrawing the transcript, Markdown, Mermaid, math and views natively. That's a second renderer to keep in step with the web one.

Terminals are the exception: their bytes stay native, as on the device. The companion's window puts a native `TerminalView` over the companion web view where the projection places it, with a stream of its own. The main web view gets a ticket through `attachTerminal`, and the native side opens the stream. The renderer fits the terminal's size to the space and never sends input, so the size stays with whoever types.

Views and Visuals (after WVE-96) render in the companion from the journal's `view` event, through the same host page the Pane uses, with the view's storage per server as on the device. The display passes no input back, so a view there never calls a tool or sends a message.

### 9.3 Two surfaces at once

The device keeps the whole app, interactive and unchanged. The display shows something else, read only, drawn from the same state: the device is the presenter view and the display is the slide, as in Keynote. It isn't a mirror of the device's pixels. It's the same data drawn another way, and only the device's web view talks to the Hosts.

- **Version 1: the device doesn't change** when a display is up. Nothing on the device depends on the display, which comes and goes every time the person leaves the app (section 10.1). Apple's rule is the same: "design your app to remain fully functional without the external display".
- **Later: hand-off.** "Show on display" on a terminal tab, a view or a Visual moves it to the display. The device then shows a small placeholder in its place and gives the room back to the transcript and the composer. This matters most on the iPhone, where a terminal and a transcript don't both fit. When the display goes away, the thing comes back to the device.
- **What's shown follows context by default, and the person can pin it** from a menu offered only while a display is connected. Turning it off hands the display back to mirroring. The choice is the device's own and never journaled, as ADR 0012 asks of placement.

Typography follows the display, not the device: type sized for distance, with the HIG's 60/80 pt margin on a TV as design, since the screen reports no overscan (section 10.1). A browser can render the display mode at 1920×1080 with `?mock=`, as it renders the device's layouts.

### 9.4 Still open: what it shows

This is the person's decision and isn't settled. The candidates, from what the app has and what's planned:

- **An overview of every thread:** each Host's threads by project, with those waiting on the person first and saying what they wait on, then running threads with their last activity, then idle ones. Later it could add Bots and their state (WVE-178), how full each thread's context is (WVE-174), and the next scheduled occurrences (WVE-145). It's useful while the person works in one thread on the device, but it adds little to the iPad's own sidebar.
- **What sits beside the open thread:**
  - its front terminal, such as a dev server, a test run or logs;
  - once WVE-96 builds the Pane, its view or latest Visual, the most presentation-like thing an agent makes;
  - the transcript's live tail at reading distance: the plan, the running tool calls and the agent's latest message.
- **The thread itself, large**, for showing someone else the work: close to mirroring, but laid out for the display rather than the phone.

What decides between them is the setting. Working alone at a desk with a TV or a Mac beside it, the terminal or the Pane earns the space. Showing someone the work, the thread or a Visual does. A glance at everything suits a room. One default plus a pinned choice covers more than one of these, so the first version doesn't have to pick only one.

### 9.5 Still open: what it's called

"Companion" is this note's working word, and "Board" and "Stage" were working names for two of the candidates above. None is in the glossary. The name should fit how the person turns it on, and what the app's menu says:

- **Display:** plain, and Apple's own word ("connected display"). But it's also what the device itself has, and "the display" is ambiguous in speech.
- **Second screen:** what people call it, but long, and it says where, not what.
- **Stage:** the device as presenter and the display as stage. Short, and it suits showing work, but less so the overview.
- **Tapestry:** woven work hung on a wall for the room to see, in weave's own image. It's distinctive, but a name people have to learn.

Whatever wins goes into `CONTEXT.md` with the words to avoid, mirror among them, since it isn't one.

### 9.6 What this isn't

The companion lasts while the app is in front. A display that stays up with the iPad asleep, such as an overview on a TV in the corner, is a different client: a page in a browser on the Mac or the Apple TV. Since ADR 0010 that would be a remote client of its own, with a device key, or a read-only role the Host doesn't have yet. If it's wanted, it belongs with the Dispatcher's device API (WVE-176), not here.

### 9.7 Decided, 2026-11-04

After the spike, the person settled sections 9.4 and 9.5 for a first phase (WVE-183):

- **The name is Surface** (`CONTEXT.md`), the display the device shows part of the app on. The terminal code's own "surface", Ghostty's word for a terminal view, stays as it is.
- **The first phase is the iPhone's.** The iPad keeps today's app, and its Surface comes later (WVE-184).
- **The split.**
  - The thread list fills the iPhone in portrait, as now.
  - Selecting a thread puts its thread view on the Surface, without the sidebar or the composer.
  - The iPhone keeps only the composer and the keyboard, with the thread's pending requests answered above the composer, and may rotate to landscape for a bigger keyboard.
- **A scrubber** on the iPhone's right edge scrolls the Surface's thread, with a Latest button to follow the end again.
- **Still open:** what the Surface shows while the iPhone shows the list.

## 10. The spike, and what a device still has to settle

### 10.1 The iPhone, 2026-11-04

A throwaway build on the iPhone (iPhone 17e, iOS 27.2 beta), uncommitted. It had:

- the role guard of section 9.1;
- a scene accessory registered in `WeaveBridgeViewController.viewDidLoad`;
- a companion scene with a bridge-less `WKWebView`, which loaded the app's own bundle through Capacitor's `WebViewAssetHandler` (`capacitor://localhost/?mock=running`) on a non-persistent data store;
- a native strip with the screen's facts, a clock, the scene's frame rate and a log of scene and device events.

It mirrored over AirPlay. What it showed:

- **The accessory works with `UIApplicationSupportsMultipleScenes` false.** At launch the registration was enabled and not available. The moment mirroring started, the system asked `configurationForConnecting` for the role, connected the scene (`sceneAccessoryUserInfo` arrived), and `isAvailable` turned true in `updateProperties`. Mirroring stopped, and the phone kept its own UI and stayed usable.
- **The bundle runs unchanged in the second web view.** The mock scenario drew the iPad layout full screen at 1080p and 60 fps, as the person saw it. No bridge, no plugins and no Host connection were needed.
- **The screen is the receiver's, not a TV mode list.** The first receiver gave 2940×1880 pt at scale 1, the second 1920×1080. Each had one mode, 60 fps at most, `overscanCompensation` 2 (`.none`) with zero insets, and a zero safe area. Moving to another receiver disconnected the scene and connected a new one at the new size, within about a second. A TV's overscan is the receiver's to handle, so the HIG's 60/80 pt inset is a design margin, not something the screen reports.
- **Backgrounding ends it.** Going to the Home Screen sent `willResignActive`, `didEnterBackground` and the companion's `didDisconnect` within about a second, and the display went back to mirroring the phone (the Home Screen). On returning, the scene connected again by itself within 0.3 s of `willEnterForeground`, with nothing new from the app. Since the scene is disconnected, not suspended, the companion must rebuild what it shows on each connection. A projection the main web view sends again handles that.
- **Heat.** After about 5½ minutes of the companion at 1080p and 60 fps the thermal state rose to fair, and to serious at about 6¼ minutes, with the battery at 65%. Mirroring's own encoding is part of that, and there was no baseline without the companion. Its cost is unmeasured, but it can't be taken as free. The companion should draw only when something changes: a display link at a low preferred rate, and no animation left running when nothing changes.

### 10.2 Still open

- Locking the phone with the companion up. It's probably the same as backgrounding, since locking backgrounds the app.
- A thermal baseline: the same minutes of plain mirroring, then the companion at a throttled rate.
- On the iPad with a cable: whether Stage Manager's extended display offers the accessory at all.
- On an iOS 26 simulator: that the role guard keeps mirroring and that the automatic scene draws the companion.
- A native terminal and a second stream in the companion's window.

## 11. Follow-ups this implies

1. **Bug:** on iOS 16–26, AirPlay mirroring starts a second copy of the app, a second bridge for the external-display scene. The fix is section 9.1's role guard, with a simulator check on iOS 26.
2. **The companion** (its name to come):
   - the scene accessory;
   - the bridge-less web view and its display mode;
   - the projection the device's web view sends it;
   - a native terminal in its window;
   - the menu that pins what it shows;
   - mock scenarios and the app spec's section.

   It first settles sections 9.4 and 9.5.
3. **Hand-off:** showing a terminal, a view or a Visual on the display in place of the device, after the companion.

The Pane's views and Visuals go to the display once WVE-96 builds them. Bots, context use and occurrences go there once WVE-178, WVE-174 and WVE-145 land, if the overview is one of the things it shows.
