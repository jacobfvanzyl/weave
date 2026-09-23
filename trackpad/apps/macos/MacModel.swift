import TrackpadCore
import AppKit
import ApplicationServices
import Network
import SwiftUI

@MainActor
final class MacModel: ObservableObject {
    @Published var devices: [USBDevice] = []
    @Published var status = "Connect your iPad or iPhone by USB"
    @Published var connected = false
    @Published var selectedName = "No display"
    @Published var received = 0
    @Published var posted = 0
    @Published var heartbeats = 0
    @Published var trusted = AXIsProcessTrusted()
    @Published var controlEnabled = false
    @Published var busy = false
    private var receivedCount = 0
    private var postedCount = 0
    private var scrollPhases: [String: Int] = [:]
    private var channel: (any MessageChannel)?
    private var sessionID = UUID()
    private var input = InputSession(displays: [])
    private var timer: Timer?
    private var lastReceived = ProcessInfo.processInfo.systemUptime
    private var observers: [NSObjectProtocol] = []
    private var connectAttempt = UUID()
    private let simulatorDiagnostic = CommandLine.arguments.contains("--simulator-diagnostic")
    private let diagnostic = CommandLine.arguments.contains("--usb-diagnostic") || CommandLine.arguments.contains("--simulator-diagnostic")
    private var transportName: String { simulatorDiagnostic ? "Simulator loopback (not USB)" : "USB/usbmuxd" }
    private var processingMicros: [Double] = []
    private var roundTripsMillis: [Double] = []
    private var pendingHeartbeat: Double?
    private var heartbeatSent = 0.0
    @Published private(set) var motion = MotionSettings()
    private let poster = MacInputPoster()
    private var momentumTimer: Timer?
    private let settingsKey = "motionSettings.v1"
    @Published private(set) var automaticPaused = false
    @Published private(set) var pairedCount = 0
    private var vault: PairingVault?
    private var pairing: HostPairing?
    private var activeDevice: USBDevice?
    private var automaticAttempt = false
    private var reconnect = USBReconnectPolicy()
    private var discoveryInFlight = false
    private var nextDiscovery = 0.0
    private var automaticConnections = 0

    init() {
        if let data = UserDefaults.standard.data(forKey: settingsKey),
           let stored = try? JSONDecoder().decode(MotionSettings.self, from: data) { motion = stored.validated }
        _ = input.configure(motion)
        input.doubleClickInterval = NSEvent.doubleClickInterval
        poster.onLocalActivity = { [weak self] in
            guard let self, self.input.isMomentum else { return }
            self.apply(self.input.release())
        }
        if !diagnostic { loadPairings() }
        reconnect.sessionAvailable = Self.consoleAvailable()
        updateDisplays()
        writeDiagnostics()
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.updateDisplays() }
        })
        observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.suspend("Mac is sleeping") }
        })
        for name in [NSWorkspace.screensDidSleepNotification, NSWorkspace.sessionDidResignActiveNotification] {
            observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.suspend("Mac session inactive") }
            })
        }
        // macOS has no documented dedicated screen-lock notification here. Treat
        // this distributed signal as an additional best-effort release, alongside
        // the documented sleep and session-deactivation notifications above.
        observers.append(DistributedNotificationCenter.default().addObserver(forName: Notification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.suspend("Mac screen locked") }
        })
        for name in [NSWorkspace.didWakeNotification, NSWorkspace.screensDidWakeNotification, NSWorkspace.sessionDidBecomeActiveNotification] {
            observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.resumeSession() }
            })
        }
        observers.append(DistributedNotificationCenter.default().addObserver(forName: Notification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.resumeSession() }
        })
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.endSession("Mac app quit") }
        })
        timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        if let timer { RunLoop.main.add(timer, forMode: .common) }
        Task {
            await refresh()
            if simulatorDiagnostic {
                attach(NetworkChannel(NWConnection(host: "127.0.0.1", port: 49181, using: .tcp)))
            } else if diagnostic, let first = devices.first { await connect(first) }
        }
    }
    var canEnableControl: Bool { trusted && connected && !diagnostic && reconnect.sessionAvailable }
    private func loadPairings() {
        do { vault = try PairingVault(); pairedCount = vault?.peers.count ?? 0 }
        catch { status = error.localizedDescription }
    }
    func deviceLabel(_ device: USBDevice) -> String { vault?.peer(serial: device.serial)?.name ?? device.label }
    func refresh() async {
        do { devices = try await Task.detached { try USBMux.devices() }.value }
        catch { if channel == nil && !automaticAttempt { status = error.localizedDescription } }
    }
    func connect(_ device: USBDevice, automatically: Bool = false) async {
        guard !busy else { return }
        if !diagnostic {
            guard reconnect.sessionAvailable else { status = "Unlock this Mac to connect"; return }
            if vault == nil { loadPairings() }
            guard vault != nil else { return }
            if automatically { guard !automaticPaused, vault?.peer(serial: device.serial) != nil, channel == nil else { return } }
        }
        if !automatically { automaticPaused = false }
        endSession(automatically ? "Reconnecting to \(deviceLabel(device))…" : "Connecting by USB…")
        automaticAttempt = automatically; activeDevice = device; busy = true
        let attempt = UUID(); connectAttempt = attempt
        do {
            let fd = try await Task.detached { try USBMux.connect(device) }.value
            guard connectAttempt == attempt else { Darwin.close(fd); return }
            busy = false
            attach(USBChannel(fileDescriptor: fd))
        } catch {
            guard connectAttempt == attempt else { return }
            busy = false; activeDevice = nil
            status = automatically ? "Waiting for a paired USB device to open Trackpad" : error.localizedDescription
        }
    }
    func resumeAutomaticConnections() {
        automaticPaused = false; nextDiscovery = 0
        if vault == nil { loadPairings() }
        if connected { enableControl(true) }
        else { status = "Waiting for a paired USB device to open Trackpad" }
    }
    func forgetDevice(_ device: USBDevice) {
        guard let peer = vault?.peer(serial: device.serial) else { return }
        disconnect()
        do { try vault?.forget(id: peer.id); pairedCount = vault?.peers.count ?? 0; status = "Pairing forgotten. Connect manually to pair again." }
        catch { status = error.localizedDescription }
    }
    private static func consoleAvailable() -> Bool {
        guard let info = CGSessionCopyCurrentDictionary() as? [String: Any], info[kCGSessionOnConsoleKey as String] as? Bool == true else { return false }
        // Best-effort lock-state supplement to sleep/session notifications; no
        // documented dedicated lock-state API exists for this companion.
        return info["CGSSessionScreenIsLocked"] as? Bool != true
    }
    private func suspend(_ reason: String) { reconnect.sessionAvailable = false; endSession(reason) }
    private func resumeSession() {
        reconnect.sessionAvailable = Self.consoleAvailable(); nextDiscovery = 0
        if reconnect.sessionAvailable && vault == nil && !diagnostic { loadPairings() }
        if reconnect.sessionAvailable && !automaticPaused && channel == nil { status = "Waiting for a paired USB device to open Trackpad" }
    }
    private func discoverIfNeeded(now: Double) {
        guard !diagnostic, !automaticPaused, reconnect.sessionAvailable, channel == nil, !busy,
              !discoveryInFlight, now >= nextDiscovery else { return }
        nextDiscovery = now + 1; discoveryInFlight = true
        Task { [weak self] in
            guard let self else { return }
            await self.refresh()
            self.discoveryInFlight = false
            self.reconnect.paused = self.automaticPaused
            let candidates = self.devices.filter { self.vault?.peer(serial: $0.serial) != nil }
            if let serial = self.reconnect.candidate(serials: candidates.map(\.serial), occupied: self.channel != nil || self.busy, now: ProcessInfo.processInfo.systemUptime),
               let device = candidates.first(where: { $0.serial == serial }) {
                await self.connect(device, automatically: true)
            }
        }
    }
    private func attach(_ pipe: any MessageChannel) {
        let id = UUID(); sessionID = id
        input = InputSession(displays: Self.displays())
        _ = input.configure(motion)
        input.doubleClickInterval = NSEvent.doubleClickInterval
        poster.synchronize()
        channel = pipe
        scrollPhases = [:]
        receivedCount = 0; postedCount = 0; received = 0; posted = 0; heartbeats = 0; processingMicros = []; roundTripsMillis = []; pendingHeartbeat = nil
        lastReceived = ProcessInfo.processInfo.systemUptime
        pipe.onMessage = { [weak self] message in
            guard let self, self.sessionID == id else { return }
            self.receive(message)
        }
        pipe.onClose = { [weak self] reason in
            guard let self, self.sessionID == id else { return }
            self.endSession(reason)
        }
        pipe.start()
        if !diagnostic, let vault, let activeDevice {
            pairing = HostPairing(id: vault.id, session: id, knownPeer: vault.peer(serial: activeDevice.serial))
        }
        pipe.send(WireMessage(.hello, session: id, name: diagnostic ? "Trackpad diagnostic" : (Host.current().localizedName ?? "Mac"), challenge: pairing?.challenge))
        status = pairing?.challenge.requiresApproval == true ? "Approve pairing on your mobile device" : "Authenticating USB device…"
    }
    private func receive(_ message: WireMessage) {
        guard message.session == sessionID else { endSession("Unexpected session"); return }
        let started = ProcessInfo.processInfo.systemUptime
        lastReceived = started
        switch message.kind {
        case .approve:
            guard !connected else { return }
            if diagnostic {
                connected = true
                status = "\(transportName) diagnostic • input disabled"
                channel?.send(WireMessage(.ready, session: sessionID, display: input.selected, generation: input.generation, displayCount: input.displays.count))
                return
            }
            do {
                guard let auth = message.authentication, var pairing else { throw PairingError.unexpectedMessage }
                let reply = try pairing.accept(auth, name: message.name ?? "Mobile device")
                self.pairing = pairing
                channel?.send(WireMessage(.ready, session: sessionID, display: input.selected, generation: input.generation, displayCount: input.displays.count, authentication: reply))
            } catch { endSession("USB pairing could not be verified. Forget the pairing to pair again.") }
        case .confirm:
            guard !diagnostic, !connected else { return }
            do {
                guard let auth = message.authentication, var pairing, let activeDevice, let vault else { throw PairingError.unexpectedMessage }
                var peer = try pairing.confirm(auth)
                peer.usbSerial = activeDevice.serial
                if pairing.challenge.requiresApproval { try vault.remember(peer) }
                self.pairing = pairing; pairedCount = vault.peers.count
                connected = true; selectedName = input.selected?.name ?? "No display"
                trusted = AXIsProcessTrusted()
                controlEnabled = trusted && reconnect.sessionAvailable && !automaticPaused
                poster.synchronize()
                if automaticAttempt { automaticConnections += 1 }
                status = controlEnabled ? "USB connected • controlling this Mac" : "USB connected • allow Accessibility to start control"
                writeDiagnostics()
            } catch { endSession("USB pairing could not be saved or verified. Pair again.") }
        case .input:
            guard connected, let sample = message.sample else { return }
            receivedCount += 1
            if sample.action == .contactBegin && sample.count == 1 { poster.synchronize() }
            input.doubleClickInterval = NSEvent.doubleClickInterval
            apply(input.handle(sample, now: started))
            processingMicros.append((ProcessInfo.processInfo.systemUptime - started) * 1_000_000)
            if processingMicros.count > 10_000 { processingMicros.removeFirst(1000) }
        case .heartbeat:
            guard connected else { return }
            heartbeats += 1
            if message.name == "pong", let pendingHeartbeat {
                roundTripsMillis.append((started - pendingHeartbeat) * 1000)
                self.pendingHeartbeat = nil
                if roundTripsMillis.count > 1000 { roundTripsMillis.removeFirst(100) }
            }
        case .goodbye: endSession("Mobile device ended the session")
        default: break
        }
    }
    func enableControl(_ enabled: Bool) {
        // Always release with the old enabled state before changing the gate.
        apply(input.release())
        trusted = AXIsProcessTrusted()
        automaticPaused = !enabled
        controlEnabled = enabled && trusted && connected && !diagnostic && reconnect.sessionAvailable
        poster.synchronize()
        channel?.send(WireMessage(.mapping, session: sessionID, display: input.selected, generation: input.generation, displayCount: input.displays.count))
        status = controlEnabled ? "USB connected • controlling this Mac" : "USB connected • receive-only"
    }
    func updateMotion(_ change: (inout MotionSettings) -> Void) {
        var value = motion; change(&value); value = value.validated
        guard value != motion else { return }
        apply(input.configure(value))
        motion = value
        if let data = try? JSONEncoder().encode(value) { UserDefaults.standard.set(data, forKey: settingsKey) }
        // Reset the mobile recognizer too, so a held finger cannot restart a released gesture.
        channel?.send(WireMessage(.mapping, session: sessionID, display: input.selected, generation: input.generation, displayCount: input.displays.count))
    }
    private func updateMomentumTimer() {
        if !input.isMomentum { momentumTimer?.invalidate(); momentumTimer = nil; return }
        guard momentumTimer == nil else { return }
        let timer = Timer(timeInterval: 1.0 / 120, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.apply(self.input.tick(now: ProcessInfo.processInfo.systemUptime))
            }
        }
        timer.tolerance = 0.001
        momentumTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }
    func requestAccessibility() {
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        trusted = AXIsProcessTrustedWithOptions(options)
        if trusted && connected && !automaticPaused { enableControl(true) }
    }
    func disconnect() {
        automaticPaused = true
        endSession("Automatic connection paused")
    }
    private func endSession(_ reason: String) {
        apply(input.release())
        connectAttempt = UUID(); busy = false
        if connected { channel?.send(WireMessage(.goodbye, session: sessionID)) }
        channel?.close(); channel = nil; sessionID = UUID(); pairing = nil; activeDevice = nil
        connected = false; controlEnabled = false; pendingHeartbeat = nil
        status = reason
        writeDiagnostics()
    }
    private func tick() {
        received = receivedCount; posted = postedCount
        let permission = AXIsProcessTrusted()
        if trusted && !permission { automaticPaused = true; endSession("Accessibility permission was removed") }
        let newlyTrusted = !trusted && permission
        trusted = permission
        if newlyTrusted && connected && !automaticPaused { enableControl(true) }
        let now = ProcessInfo.processInfo.systemUptime
        discoverIfNeeded(now: now)
        guard channel != nil else { return }
        if now - lastReceived > (connected ? 2 : (automaticAttempt ? 3 : 45)) { endSession("USB session timed out; input released"); return }
        if connected, now - heartbeatSent >= 0.5 {
            heartbeatSent = now
            if pendingHeartbeat == nil {
                pendingHeartbeat = now
                channel?.send(WireMessage(.heartbeat, session: sessionID, name: "ping"))
            }
            writeDiagnostics()
        }
    }
    private static func displays() -> [DisplayInfo] {
        NSScreen.screens.compactMap { screen in
            guard let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? UInt32,
                  CGDisplayMirrorsDisplay(id) == kCGNullDirectDisplay else { return nil }
            let bounds = CGDisplayBounds(id)
            guard bounds.width > 0, bounds.height > 0 else { return nil }
            return DisplayInfo(id: id, name: screen.localizedName, x: bounds.minX, y: bounds.minY, width: bounds.width, height: bounds.height)
        }.sorted { $0.x == $1.x ? $0.y < $1.y : $0.x < $1.x }
    }
    private func updateDisplays() {
        apply(input.replaceDisplays(Self.displays()))
        selectedName = input.selected?.name ?? "No display"
        if input.selected == nil && connected { endSession("No active Mac display") }
    }
    private func apply(_ effects: [InputEffect]) {
        for effect in effects {
            if case .mapping(let display, let generation) = effect {
                selectedName = display.name
                channel?.send(WireMessage(.mapping, session: sessionID, display: display, generation: generation, displayCount: input.displays.count))
                continue
            }
            if case .scroll(_, _, let phase) = effect { scrollPhases[String(describing: phase), default: 0] += 1 }
            guard controlEnabled else { continue }
            if poster.post(effect) { postedCount += 1 }
        }
        updateMomentumTimer()
    }
    private func writeDiagnostics() {
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("WeaveTrackpad")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let sorted = roundTripsMillis.sorted(), processing = processingMicros.sorted()
            let data: [String: Any] = ["transport": transportName, "connected": connected, "status": status,
                "inputMessages": receivedCount, "postedEvents": postedCount, "heartbeats": heartbeats,
                "controlEnabled": controlEnabled, "accessibility": trusted,
                "pairingStorageAvailable": vault != nil, "pairedDevices": pairedCount,
                "automaticPaused": automaticPaused, "automaticConnections": automaticConnections, "sessionAvailable": reconnect.sessionAvailable,
                "momentumActive": input.isMomentum, "momentumPostedEvents": poster.momentumEvents, "scrollPhasesProcessed": scrollPhases,
                "pointerSpeed": motion.pointerSpeed, "acceleration": motion.acceleration,
                "scrollSpeed": motion.scrollSpeed, "naturalScrolling": motion.naturalScrolling, "momentumEnabled": motion.momentum,
                "doubleClickInterval": input.doubleClickInterval,
                "rttSamples": sorted.count, "rttP50Milliseconds": sorted.isEmpty ? 0 : sorted[sorted.count / 2],
                "rttP95Milliseconds": sorted.isEmpty ? 0 : sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))],
                "processingP95Microseconds": processing.isEmpty ? 0 : processing[min(processing.count - 1, Int(Double(processing.count) * 0.95))],
                "selectedDisplay": selectedName, "generation": input.generation,
                "displays": input.displays.map { ["name": $0.name, "x": $0.x, "y": $0.y, "width": $0.width, "height": $0.height] as [String: Any] },
                "updatedAt": ISO8601DateFormatter().string(from: Date())]
            try JSONSerialization.data(withJSONObject: data, options: [.prettyPrinted, .sortedKeys]).write(to: directory.appendingPathComponent("diagnostics.json"), options: .atomic)
        } catch { NSLog("Trackpad diagnostics: %@", error.localizedDescription) }
    }
}
