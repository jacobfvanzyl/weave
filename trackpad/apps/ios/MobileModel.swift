import TrackpadCore
import UIKit
import Network
import SwiftUI

@MainActor
final class MobileModel: ObservableObject {
    @Published var status = "Connect this device to your Mac by USB"
    @Published var approval: String?
    @Published var connected = false
    @Published private(set) var pencilMode = false
    @Published var display: DisplayInfo?
    @Published var displayCount = 0
    @Published var mappingRevision = 0
    private var listener: NWListener?
    private var channel: NetworkChannel?
    private var session: UUID?
    private var generation: UInt64 = 0
    private var sequence: UInt64 = 0
    private var lastReceived = ProcessInfo.processInfo.systemUptime
    private var heartbeat: Timer?
    private var approved = false
    private var connectionID = UUID()
    private var started = false
    private var awaitingMapping = false
    @Published private(set) var automaticPaused = false
    private var vault: PairingVault?
    private var pairing: MobilePairing?
    private var authenticated = false
    private let diagnostic = CommandLine.arguments.contains("--usb-diagnostic")

    func start() {
        guard !started else { return }
        automaticPaused = false
        do {
            if !diagnostic && vault == nil { vault = try PairingVault() }
            started = true
            let tcp = NWProtocolTCP.Options(); tcp.noDelay = true
            let parameters = NWParameters(tls: nil, tcp: tcp)
            // Cable-only preview. No LAN listener or unauthenticated wireless port.
            parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: 49181)
            parameters.allowLocalEndpointReuse = true
            let listener = try NWListener(using: parameters)
            self.listener = listener
            listener.stateUpdateHandler = { [weak self] state in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    if case .failed(let error) = state { self.stop(); self.status = error.localizedDescription }
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                MainActor.assumeIsolated { self?.accept(connection) }
            }
            listener.start(queue: .main)
            heartbeat = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.tick() }
            }
            if let heartbeat { RunLoop.main.add(heartbeat, forMode: .common) }
            status = diagnostic ? "USB diagnostic ready — waiting for the Mac" : "Open Trackpad on your Mac and connect by USB"
        } catch { started = false; status = error.localizedDescription }
    }
    private func accept(_ connection: NWConnection) {
        guard channel == nil else { connection.cancel(); return }
        let id = UUID(); connectionID = id
        let channel = NetworkChannel(connection)
        self.channel = channel
        lastReceived = ProcessInfo.processInfo.systemUptime
        channel.onMessage = { [weak self] message in
            guard let self, self.connectionID == id else { return }
            self.receive(message)
        }
        channel.onClose = { [weak self] reason in
            guard let self, self.connectionID == id else { return }
            self.disconnect(reason)
        }
        channel.start()
    }
    private func receive(_ message: WireMessage) {
        lastReceived = ProcessInfo.processInfo.systemUptime
        if message.kind == .hello {
            guard session == nil else { disconnect("Unexpected second handshake"); return }
            session = message.session
            if diagnostic {
                guard message.name == "Trackpad diagnostic", message.challenge == nil else { disconnect("Diagnostic peer required"); return }
                approve()
            } else {
                do {
                    guard let challenge = message.challenge, let vault else { throw PairingError.unexpectedMessage }
                    let handshake = try MobilePairing(id: vault.id, session: message.session, challenge: challenge,
                        hostName: message.name ?? "Mac", knownPeer: vault.peer(id: challenge.peerID))
                    pairing = handshake
                    if handshake.needsApproval {
                        approval = message.name ?? "Mac"
                        status = "Confirm pairing with this Mac"
                    } else { sendApproval(userApproved: false) }
                } catch { disconnect("Pairing could not be verified. Pair again from the Mac.") }
            }
            return
        }
        guard message.session == session else { disconnect("Unexpected session"); return }
        switch message.kind {
        case .ready, .mapping:
            guard approved, let display = message.display, let generation = message.generation,
                  display.width > 0, display.height > 0 else { return }
            if !diagnostic {
                if message.kind == .ready {
                    do {
                        guard !connected, let auth = message.authentication, var pairing, let vault else { throw PairingError.unexpectedMessage }
                        let (peer, confirmation) = try pairing.verify(auth)
                        if pairing.needsApproval { try vault.remember(peer) }
                        self.pairing = pairing; authenticated = true
                        channel?.send(WireMessage(.confirm, session: message.session, authentication: confirmation))
                    } catch { disconnect("Mac pairing could not be verified or saved"); return }
                } else { guard connected && authenticated else { return } }
            }
            self.generation = generation; self.display = display; displayCount = message.displayCount ?? 1
            connected = true; awaitingMapping = false; mappingRevision += 1
            status = diagnostic ? "Diagnostic connected — Mac input disabled" : "USB connected"
            UIApplication.shared.isIdleTimerDisabled = true
            if diagnostic && message.kind == .ready {
                // Let the view's initial mapping reset finish before this synthetic
                // gesture. This delay applies only to the opt-in diagnostic burst.
                let readySession = message.session
                Task { [weak self] in
                    try? await Task.sleep(for: .milliseconds(200))
                    guard let self, self.connected, self.session == readySession else { return }
                    self.diagnosticBurst()
                }
            }
        case .heartbeat:
            if approved, let session { channel?.send(WireMessage(.heartbeat, session: session, name: "pong")) }
        case .goodbye: disconnect("Mac disconnected")
        default: break
        }
    }
    func approve() { sendApproval(userApproved: true) }
    private func sendApproval(userApproved: Bool) {
        guard let session else { return }
        do {
            let auth: PairingAuthentication?
            if diagnostic { auth = nil }
            else {
                guard var pairing else { throw PairingError.unexpectedMessage }
                auth = try pairing.approval(userApproved: userApproved)
                self.pairing = pairing
            }
            approval = nil; approved = true
            channel?.send(WireMessage(.approve, session: session, name: UIDevice.current.name, authentication: auth))
            status = "Authenticating USB session…"
        } catch { disconnect("Pairing requires approval") }
    }
    func send(_ action: InputAction, x: Double = 0, y: Double = 0, time: Double = 0, count: Int = 1) {
        guard connected, let session else { return }
        guard !awaitingMapping || [.reset, .penUp, .dragEnd, .scrollEnd, .contactEnd].contains(action) else { return }
        sequence &+= 1
        channel?.send(WireMessage(.input, session: session, sample: InputSample(sequence: sequence, generation: generation, action: action, x: x, y: y, time: time, count: count)))
        if action == .nextDisplay && displayCount > 1 { awaitingMapping = true }
    }
    // CaptureView owns physical tool transitions and releases input synchronously.
    // A tool change is not a new display mapping and must not reset the new stroke.
    func reportPencilMode(_ pencil: Bool) { if pencilMode != pencil { pencilMode = pencil } }
    func disconnect() {
        automaticPaused = true
        disconnect("Disconnected — reopen the app or reconnect to resume")
        stopListening()
    }
    func resumeConnection() { start() }
    private func disconnect(_ reason: String) {
        if let session { channel?.send(WireMessage(.goodbye, session: session)) }
        channel?.close(); channel = nil; session = nil; connectionID = UUID()
        approved = false; authenticated = false; pairing = nil; connected = false; pencilMode = false; approval = nil; generation = 0; sequence = 0
        awaitingMapping = false; display = nil; displayCount = 0; mappingRevision += 1
        UIApplication.shared.isIdleTimerDisabled = false
        status = reason
    }
    func stop() {
        disconnect("App inactive — input released")
        stopListening()
    }
    private func stopListening() {
        heartbeat?.invalidate(); heartbeat = nil
        listener?.cancel(); listener = nil; started = false
    }
    private func tick() {
        guard channel != nil else { return }
        if ProcessInfo.processInfo.systemUptime - lastReceived > (connected ? 2 : 45) { disconnect("USB session timed out") }
    }
    private func diagnosticBurst() {
        // Explicit launch-argument diagnostic, accepted only by a receive-only Mac.
        // These generated samples validate the wire/reducer, not UIKit or Pencil hardware.
        send(.move, x: 1, y: 1)
        send(.primaryClick)
        send(.secondaryClick)
        send(.scrollBegin); send(.scrollMove, x: 2, y: 3); send(.scrollEnd)
        send(.penDown, x: 0.25, y: 0.25)
        send(.penMove, x: 0.75, y: 0.75)
        send(.penUp); send(.reset)
        // Source timestamps deliberately travel in one burst: the host still
        // derives velocity from capture time and schedules its own momentum.
        send(.contactBegin, time: 1, count: 2)
        send(.scrollBegin, time: 1)
        for index in 1...6 { send(.scrollMove, y: 10, time: 1 + Double(index) * 0.01) }
        send(.scrollEnd, time: 1.065)
        send(.contactEnd, time: 1.065, count: 0)
    }
}
