import SwiftUI
import LiveKitWebRTC

final class Harness: ObservableObject {
    let media = BrowserMediaReceiver()
    @Published var status = "Connecting"
    @Published var tab = "A"
    @Published var geometry = "Waiting for video"
    @Published var inputReady = false
    private var disconnected = false
    private var generation = 0
    private var width = 960
    private var height = 640
    private var socket: URLSessionWebSocketTask?
    private var connection: [String: Any] = [:]
    init() {
        media.onSignal = { [weak self] message in self?.send(message) }
        media.onStatus = { [weak self] text in self?.status = text }
        media.onFrame = { [weak self] peer, generation, width, height in
            self?.geometry = "\(width) × \(height) · generation \(generation)"
            self?.send(["type": "frame", "peer": peer, "generation": generation, "width": width, "height": height])
        }
        do {
            let path = ProcessInfo.processInfo.environment["WEAVE_BROWSER_SPIKE_CONFIG"]
            let url = path.map { URL(fileURLWithPath: $0) } ?? Bundle.main.url(forResource: "connection", withExtension: "json")!
            connection = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
            let endpoint = URL(string: connection["endpoint"] as! String)!
            socket = URLSession.shared.webSocketTask(with: endpoint); socket?.resume()
            #if os(iOS)
            let platform = "iPadOS"; width = 800; height = 600
            #else
            let platform = "macOS"
            #endif
            send(["type": "hello", "role": "viewer", "token": connection["token"]!, "platform": platform])
            receive()
        } catch { status = "Configuration error: \(error)" }
    }
    func focus(_ tab: String) { self.tab = tab; inputReady = false; send(["type": "focus", "tab": tab, "width": width, "height": height]) }
    func resize() { width = width == 960 ? 800 : 960; height = width == 960 ? 640 : 600; focus(tab) }
    func click(_ x: Int, _ y: Int) { send(["type": "click", "generation": generation, "x": x, "y": y]) }
    func staleClick() { send(["type": "click", "generation": generation - 1, "x": 240, "y": 95]) }
    func disconnect() { disconnected = true; socket?.cancel(with: .normalClosure, reason: nil); media.reset(); inputReady = false; status = "Disconnected; browser remains alive" }
    private func send(_ message: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: message), let text = String(data: data, encoding: .utf8) else { return }
        socket?.send(.string(text)) { error in if let error { DispatchQueue.main.async { if self.disconnected { return }; self.status = "Signaling: \(error.localizedDescription)" } } }
    }
    private func receive() {
        socket?.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .failure(let error): if self.disconnected { return }; self.status = "Disconnected: \(error.localizedDescription)"; self.media.reset(); self.inputReady = false
                case .success(let value):
                    let data: Data
                    switch value { case .string(let text): data = Data(text.utf8); case .data(let bytes): data = bytes; @unknown default: return }
                    if let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { self.handle(message) }
                    self.receive()
                }
            }
        }
    }
    private func handle(_ message: [String: Any]) {
        switch message["type"] as? String {
        case "welcome": focus("A")
        case "reset": tab = message["tab"] as? String ?? tab; inputReady = false; media.reset(); generation = message["generation"] as? Int ?? 0; status = "Waiting for new media"
        case "offer": media.offer(peer: message["peer"] as! String, generation: message["generation"] as! Int, sdp: message["sdp"] as! String)
        case "ice": media.ice(peer: message["peer"] as! String, value: message["candidate"] as! [String: Any])
        case "inputReady": inputReady = true; status = "Native video received"
        default: break
        }
    }
}
#if os(macOS)
struct VideoSurface: NSViewRepresentable {
    let media: BrowserMediaReceiver
    func makeNSView(context: Context) -> LKRTCMTLVideoView { media.videoView }
    func updateNSView(_ nsView: LKRTCMTLVideoView, context: Context) {}
}
#else
struct VideoSurface: UIViewRepresentable {
    let media: BrowserMediaReceiver
    func makeUIView(context: Context) -> LKRTCMTLVideoView { media.videoView }
    func updateUIView(_ uiView: LKRTCMTLVideoView, context: Context) {}
}
#endif
@main
struct BrowserSpikeApp: App {
    @StateObject private var harness = Harness()
    var body: some Scene {
        WindowGroup("Weave Browser Spike") {
            VStack(spacing: 12) {
                HStack {
                    Button("Tab A") { harness.focus("A") }
                    Button("Tab B") { harness.focus("B") }
                    Button("Claim / resize") { harness.resize() }
                    Button("Toggle tone") { harness.click(100, 95) }.disabled(!harness.inputReady)
                    Button("Test click") { harness.click(240, 95) }.disabled(!harness.inputReady)
                    Button("Stale click") { harness.staleClick() }
                    Button("Disconnect") { harness.disconnect() }
                }
                Text("\(harness.status) · Tab \(harness.tab) · \(harness.geometry)").font(.caption)
                VideoSurface(media: harness.media).opacity(harness.inputReady ? 1 : 0).background(Color.black)
            }.padding().frame(minWidth: 760, minHeight: 540)
        }
    }
}
