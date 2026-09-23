import TrackpadCore
import Foundation
import Network

@MainActor
protocol MessageChannel: AnyObject {
    var onMessage: ((WireMessage) -> Void)? { get set }
    var onClose: ((String) -> Void)? { get set }
    func start()
    func send(_ message: WireMessage)
    func close()
}

/// Network callbacks and framing are confined to the main queue. No waits occur here.
@MainActor
final class NetworkChannel: MessageChannel {
    var onMessage: ((WireMessage) -> Void)?
    var onClose: ((String) -> Void)?
    private let connection: NWConnection
    private var decoder = FrameDecoder()
    private var stopped = false
    private var pendingBytes = 0
    init(_ connection: NWConnection) { self.connection = connection }
    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            MainActor.assumeIsolated {
                guard let self, !self.stopped else { return }
                switch state {
                case .ready: self.receive()
                case .failed(let error): self.fail(error.localizedDescription)
                case .cancelled: self.fail("Connection closed")
                default: break
                }
            }
        }
        connection.start(queue: .main)
    }
    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, complete, error in
            MainActor.assumeIsolated {
                guard let self, !self.stopped else { return }
                do {
                    if let data {
                        for message in try self.decoder.append(data) {
                            guard !self.stopped else { break }
                            self.onMessage?(message)
                        }
                    }
                    if let error { self.fail(error.localizedDescription) }
                    else if complete { self.fail("Peer disconnected") }
                    else { self.receive() }
                } catch { self.fail("Invalid input frame: \(error)") }
            }
        }
    }
    func send(_ message: WireMessage) {
        guard !stopped else { return }
        do {
            let data = try Frames.encode(message)
            // A stalled receiver must terminate the session, not accumulate old input.
            guard pendingBytes + data.count <= 65_536 else { fail("Input queue stalled"); return }
            pendingBytes += data.count
            connection.send(content: data, completion: .contentProcessed { [weak self] error in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.pendingBytes -= data.count
                    if let error { self.fail(error.localizedDescription) }
                }
            })
        } catch { fail("Cannot encode input") }
    }
    private func fail(_ reason: String) { guard !stopped else { return }; close(); onClose?(reason) }
    func close() { stopped = true; connection.cancel() }
}
