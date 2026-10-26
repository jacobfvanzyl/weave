// A terminal's stream (`docs/specs/wve-85-host-protocol.md`, "The terminal stream"), held here
// rather than in the web view, so a terminal's bytes never cross the bridge: base64 there held the
// WVE-150 spike to 5 to 10 MiB/s. The web view hears everything else.
import Foundation
import UIKit

final class TerminalStream: NSObject, URLSessionWebSocketDelegate {
    private static let subprotocol = "weave-terminal"
    private static let restoreFrame: UInt8 = 0x01
    private static let outputFrame: UInt8 = 0x03
    private static let inputFrame: UInt8 = 0x10
    /// The Host's own limit on a message.
    private static let maxMessage = 32 * 1024 * 1024
    /// How long the view's grid holds still before the Host hears it.
    private static let settle: TimeInterval = 0.15
    private static let maxRestore = 64 * 1024 * 1024

    typealias Size = (cols: Int, rows: Int)

    /// The stream's messages for the web view, as `{kind, …}`: `opened`, `updated`, `bell`,
    /// `notification`, `progress`, `clipboard` (without its text), `resized`, `resync`, `exited`.
    var onMessage: (([String: Any]) -> Void)?
    /// Once, when the stream ends: the close code, or 0 when the connection failed.
    var onClose: ((Int, String) -> Void)?
    /// The screen changed.
    var onScreen: (() -> Void)?

    /// What comes while a restore does, kept in order until it's in place.
    private enum Held {
        case output(Data)
        case size(Size)
    }

    private let renderer: WeaveTerminalRenderer
    private let url: URL
    private let ticket: String
    /// The view's grid, and the one the Host last heard.
    private var grid: Size
    private var sentGrid: Size
    private var pendingResize: DispatchWorkItem?
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var opened = false
    private var ended = false
    /// The terminal's size, in order with its output.
    private var size: Size
    private var restore = "snapshot"
    /// Restore bytes still to come, and those come so far.
    private var expected = 0
    private var restoreBytes = Data()
    /// A snapshot decoding, by generation, so one a resync overtakes is let go.
    private var decoding: Int?
    private var restores = 0
    private var held: [Held] = []
    private var restoring: Bool { expected > 0 || decoding != nil }

    init(url: URL, ticket: String, grid: Size, renderer: WeaveTerminalRenderer) {
        self.url = url
        self.ticket = ticket
        self.grid = grid
        self.sentGrid = grid
        self.size = grid
        self.renderer = renderer
    }

    func start() {
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
        let task = session.webSocketTask(with: url, protocols: [Self.subprotocol])
        task.maximumMessageSize = Self.maxMessage
        self.session = session
        self.task = task
        task.resume()
    }

    /// Ends the stream from this side.
    func stop() {
        guard !ended else { return }
        ended = true
        pendingResize?.cancel()
        task?.cancel(with: .normalClosure, reason: nil)
        // The session holds its delegate until it's invalidated.
        session?.invalidateAndCancel()
        onMessage = nil
        onClose = nil
        onScreen = nil
    }

    func send(input: Data) {
        guard opened, !ended else { return }
        var frame = Data([Self.inputFrame])
        frame.append(input)
        task?.send(.data(frame)) { _ in }
    }

    /// Asks for the view's grid. The Host decides: the last device to type sets the size. A drag,
    /// a rotation or the keyboard sliding in passes through many grids, so it asks for the one the
    /// view settles on.
    func resize(to grid: Size) {
        self.grid = grid
        pendingResize?.cancel()
        guard opened, !ended, grid != sentGrid else { return }
        let resize = DispatchWorkItem { [weak self] in
            guard let self, self.opened, !self.ended, self.grid != self.sentGrid else { return }
            self.sentGrid = self.grid
            self.sendJSON(["resize": ["cols": self.grid.cols, "rows": self.grid.rows]])
        }
        pendingResize = resize
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.settle, execute: resize)
    }

    private func sendJSON(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(text)) { _ in }
    }

    private func receive() {
        task?.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self, !self.ended else { return }
                switch result {
                case .success(.string(let text)): self.text(text)
                case .success(.data(let data)): self.binary(data)
                case .success: break
                case .failure: return // The delegate says how it ended.
                }
                if !self.ended { self.receive() }
            }
        }
    }

    private func text(_ text: String) {
        guard let data = text.data(using: .utf8), let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        if !opened {
            guard let terminal = message["terminal"] as? [String: Any], let restore = message["restore"] as? String else {
                finish(0, "the Host didn't open the stream")
                return
            }
            opened = true
            // The terminal as the restore has it.
            size = Self.size(terminal["size"]) ?? size
            self.restore = restore
            onMessage?(["kind": "opened", "terminal": terminal, "restore": restore])
            beginRestore(bytes: (message["restoreBytes"] as? NSNumber)?.intValue ?? 0)
            resize(to: grid)
            return
        }
        guard let (kind, payload) = message.first else { return }
        switch kind {
        case "resized":
            if let size = Self.size(payload) {
                if restoring { held.append(.size(size)) } else { follow(size) }
            }
            onMessage?(["kind": "resized", "size": payload])
        case "resync":
            let resync = payload as? [String: Any] ?? [:]
            if let size = Self.size(resync["size"]) { self.size = size }
            beginRestore(bytes: (resync["restoreBytes"] as? NSNumber)?.intValue ?? 0)
            onMessage?(["kind": "resync"])
        case "clipboard":
            // OSC 52 writes reach the pasteboard; the web view hears only that one came.
            if let text = (payload as? [String: Any])?["text"] as? String {
                UIPasteboard.general.string = text
            }
            onMessage?(["kind": "clipboard"])
        case "updated":
            onMessage?(["kind": "updated", "terminal": payload])
        default:
            var forwarded = payload as? [String: Any] ?? [:]
            forwarded["kind"] = kind
            onMessage?(forwarded)
        }
    }

    private func binary(_ data: Data) {
        guard let kind = data.first else { return }
        let payload = Data(data.dropFirst())
        switch kind {
        case Self.restoreFrame where expected > 0:
            restoreBytes.append(payload)
            expected -= payload.count
            if expected <= 0 { finishRestore() }
        case Self.outputFrame:
            if restoring {
                held.append(.output(payload))
            } else {
                renderer.write(payload)
                onScreen?()
            }
        default: break
        }
    }

    /// A restore of `bytes` comes next and replaces the screen; what was held for an earlier
    /// one is in it.
    private func beginRestore(bytes: Int) {
        guard bytes <= Self.maxRestore else { finish(0, "the restore is too big"); return }
        restores += 1
        decoding = nil
        expected = bytes
        restoreBytes = Data(capacity: bytes)
        held.removeAll()
        if bytes == 0 { finishRestore() }
    }

    private func finishRestore() {
        let bytes = restoreBytes
        restoreBytes = Data()
        expected = 0
        if restore == "vt" {
            // The formatter's VT of the screen, without history: a blank screen of the terminal's
            // size takes it as it would the program's output.
            _ = renderer.reset(columns: UInt(size.cols), rows: UInt(size.rows))
            renderer.write(bytes)
            release()
            return
        }
        let generation = restores
        decoding = generation
        renderer.restoreSnapshot(bytes) { [weak self] restored in
            guard let self, !self.ended, self.decoding == generation else { return }
            self.decoding = nil
            guard restored else { self.finish(0, "the snapshot didn't restore"); return }
            // A snapshot has the size it was made at.
            self.size = (Int(self.renderer.columns), Int(self.renderer.rows))
            self.release()
        }
    }

    /// Applies what was held, in order.
    private func release() {
        let held = self.held
        self.held.removeAll()
        for entry in held {
            switch entry {
            case .output(let data): renderer.write(data)
            case .size(let size): follow(size)
            }
        }
        onScreen?()
    }

    private func follow(_ size: Size) {
        self.size = size
        _ = renderer.resize(columns: UInt(size.cols), rows: UInt(size.rows))
        onScreen?()
    }

    private static func size(_ value: Any?) -> Size? {
        guard let size = value as? [String: Any], let cols = (size["cols"] as? NSNumber)?.intValue, let rows = (size["rows"] as? NSNumber)?.intValue, cols > 0, rows > 0 else { return nil }
        return (cols, rows)
    }

    private func finish(_ code: Int, _ reason: String) {
        guard !ended else { return }
        let close = onClose
        stop()
        close?(code, reason)
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard !ended else { return }
        sentGrid = grid
        sendJSON(["ticket": ticket, "size": ["cols": grid.cols, "rows": grid.rows], "codec": WeaveTerminalRenderer.codec()])
        receive()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        finish(closeCode.rawValue, reason.flatMap { String(data: $0, encoding: .utf8) } ?? "")
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let code = (task as? URLSessionWebSocketTask)?.closeCode ?? .invalid
        finish(code == .invalid ? 0 : code.rawValue, error?.localizedDescription ?? "")
    }
}
