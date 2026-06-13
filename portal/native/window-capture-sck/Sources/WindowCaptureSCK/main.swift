import AppKit
import CoreImage
import CoreMedia
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

struct HelperError: Error, CustomStringConvertible {
    let description: String
}

final class FramedOutput {
    private let lock = NSLock()
    private let output = FileHandle.standardOutput

    func write(_ header: [String: Any], payload: Data = Data()) {
        do {
            let json = try JSONSerialization.data(withJSONObject: header, options: [])
            guard json.count <= UInt32.max, payload.count <= UInt32.max else {
                writeDiagnostic("frame too large: json=\(json.count) payload=\(payload.count)")
                return
            }

            var prefix = Data(capacity: 8)
            appendLittleEndian(UInt32(json.count), to: &prefix)
            appendLittleEndian(UInt32(payload.count), to: &prefix)

            lock.lock()
            defer { lock.unlock() }
            output.write(prefix)
            output.write(json)
            if !payload.isEmpty {
                output.write(payload)
            }
        } catch {
            writeDiagnostic("failed to serialize output header: \(error.localizedDescription)")
        }
    }

    func reply(id: String?, ok: Bool = true, fields: [String: Any] = [:]) {
        guard let id else { return }
        var header: [String: Any] = ["id": id, "ok": ok]
        for (key, value) in fields {
            header[key] = value
        }
        write(header)
    }

    private func appendLittleEndian(_ value: UInt32, to data: inout Data) {
        var littleEndian = value.littleEndian
        withUnsafeBytes(of: &littleEndian) { bytes in
            data.append(contentsOf: bytes)
        }
    }
}

func writeDiagnostic(_ message: String) {
    FileHandle.standardError.write(Data("[window-capture-sck] \(message)\n".utf8))
}

func isRecord(_ value: Any?) -> [String: Any]? {
    value as? [String: Any]
}

func optionalString(_ value: Any?) -> String? {
    guard let value = value as? String else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
}

func optionalDouble(_ value: Any?, default defaultValue: Double) -> Double {
    if let value = value as? Double { return value }
    if let value = value as? Int { return Double(value) }
    return defaultValue
}

func optionalInt(_ value: Any?, default defaultValue: Int) -> Int {
    if let value = value as? Int { return value }
    if let value = value as? Double { return Int(value) }
    return defaultValue
}

func shareableContent() async throws -> SCShareableContent {
    try await withCheckedThrowingContinuation { continuation in
        let lock = NSLock()
        var didResume = false

        func resume(_ result: Result<SCShareableContent, Error>) {
            lock.lock()
            if didResume {
                lock.unlock()
                return
            }
            didResume = true
            lock.unlock()

            switch result {
            case .success(let content):
                continuation.resume(returning: content)
            case .failure(let error):
                continuation.resume(throwing: error)
            }
        }

        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
            if let error {
                resume(.failure(error))
                return
            }
            guard let content else {
                resume(.failure(HelperError(description: "ScreenCaptureKit returned no shareable content.")))
                return
            }
            resume(.success(content))
        }

        DispatchQueue.global().asyncAfter(deadline: .now() + 10) {
            resume(.failure(HelperError(description: "Timed out while requesting ScreenCaptureKit shareable content.")))
        }
    }
}

func windowIdString(_ window: SCWindow) -> String {
    "sck:\(window.windowID)"
}

func parseWindowId(_ value: String?) -> CGWindowID? {
    guard let value else { return nil }
    if value.hasPrefix("sck:"), let raw = UInt32(value.dropFirst(4)) {
        return CGWindowID(raw)
    }
    if let raw = UInt32(value) {
        return CGWindowID(raw)
    }
    return nil
}

func jsonWindow(_ window: SCWindow) -> [String: Any] {
    var output: [String: Any] = [
        "id": windowIdString(window),
        "title": window.title ?? "",
        "x": window.frame.origin.x,
        "y": window.frame.origin.y,
        "width": window.frame.size.width,
        "height": window.frame.size.height,
    ]

    if let app = window.owningApplication {
        output["appName"] = app.applicationName
        output["pid"] = Int(app.processID)
        output["bundleIdentifier"] = app.bundleIdentifier
    }

    return output
}

func isUsefulWindow(_ window: SCWindow) -> Bool {
    guard window.isOnScreen, window.windowLayer == 0 else { return false }
    guard window.frame.width >= 80, window.frame.height >= 60 else { return false }
    guard optionalString(window.title) != nil else { return false }
    return true
}

func userFacingError(_ error: Error) -> String {
    let nsError = error as NSError
    if nsError.domain == "com.apple.ScreenCaptureKit.SCStreamErrorDomain" || nsError.domain.contains("ScreenCapture") {
        return "\(nsError.localizedDescription) Enable Screen Recording permission for the app that launched Portal, then restart Portal."
    }
    return nsError.localizedDescription
}

final class CaptureSession: NSObject, SCStreamOutput, SCStreamDelegate {
    let sampleQueue = DispatchQueue(label: "weave.window-capture-sck.samples")

    private let writer: FramedOutput
    private let ciContext = CIContext(options: [.cacheIntermediates: false])
    private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)
    private let jpegQuality: Double
    private let sessionId: String
    private let windowId: String
    private var lastPayload: Data?
    private var lastWidth = 0
    private var lastHeight = 0
    private var lastEmitTime = 0.0
    private var minimumRepeatInterval = 1.0 / 20.0
    private var sequence = 0
    private var stream: SCStream?
    private var repeatTimer: DispatchSourceTimer?

    init(writer: FramedOutput, sessionId: String, windowId: String, jpegQuality: Double) {
        self.writer = writer
        self.sessionId = sessionId
        self.windowId = windowId
        self.jpegQuality = max(0.1, min(1.0, jpegQuality))
    }

    func attach(stream: SCStream) {
        self.stream = stream
    }

    func startRepeatingLastFrame(frameRate: Int) {
        minimumRepeatInterval = 1.0 / Double(max(1, frameRate))
        let timer = DispatchSource.makeTimerSource(queue: sampleQueue)
        timer.schedule(deadline: .now() + minimumRepeatInterval, repeating: minimumRepeatInterval)
        timer.setEventHandler { [weak self] in
            self?.repeatLastFrameIfNeeded()
        }
        repeatTimer = timer
        timer.resume()
    }

    func stop() async throws {
        repeatTimer?.cancel()
        repeatTimer = nil
        guard let stream else { return }
        try await stream.stopCapture()
        self.stream = nil
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        writer.write([
            "type": "event",
            "event": "error",
            "sessionId": sessionId,
            "windowId": windowId,
            "error": userFacingError(error),
        ])
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, isCompleteFrame(sampleBuffer) else { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        autoreleasepool {
            guard let jpeg = encodeJpeg(pixelBuffer: pixelBuffer) else { return }
            emitFrame(
                payload: jpeg,
                width: CVPixelBufferGetWidth(pixelBuffer),
                height: CVPixelBufferGetHeight(pixelBuffer),
                timestamp: sampleBuffer.presentationTimeStamp.seconds,
                repeated: false
            )
        }
    }

    private func repeatLastFrameIfNeeded() {
        guard let payload = lastPayload, lastWidth > 0, lastHeight > 0 else { return }
        let now = Date().timeIntervalSince1970
        if now - lastEmitTime < minimumRepeatInterval * 0.8 { return }
        emitFrame(payload: payload, width: lastWidth, height: lastHeight, timestamp: now, repeated: true)
    }

    private func emitFrame(payload: Data, width: Int, height: Int, timestamp: Double, repeated: Bool) {
        lastPayload = payload
        lastWidth = width
        lastHeight = height
        lastEmitTime = Date().timeIntervalSince1970
        sequence += 1
        writer.write([
            "type": "frame",
            "sessionId": sessionId,
            "windowId": windowId,
            "sequence": sequence,
            "width": width,
            "height": height,
            "timestamp": timestamp,
            "contentType": "image/jpeg",
            "repeated": repeated,
        ], payload: payload)
    }

    private func isCompleteFrame(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard
            let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
            let rawStatus = attachments.first?[SCStreamFrameInfo.status] as? Int
        else {
            return true
        }
        return rawStatus == SCFrameStatus.complete.rawValue
    }

    private func encodeJpeg(pixelBuffer: CVPixelBuffer) -> Data? {
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        let rect = CGRect(x: 0, y: 0, width: width, height: height)
        guard let cgImage = ciContext.createCGImage(image, from: rect, format: .RGBA8, colorSpace: colorSpace) else {
            return nil
        }

        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
            return nil
        }
        let options = [kCGImageDestinationLossyCompressionQuality as String: jpegQuality] as CFDictionary
        CGImageDestinationAddImage(destination, cgImage, options)
        guard CGImageDestinationFinalize(destination) else {
            return nil
        }
        return data as Data
    }
}

final class CaptureController {
    private let writer: FramedOutput
    private var activeSession: CaptureSession?

    init(writer: FramedOutput) {
        self.writer = writer
    }

    func handle(line: String) async -> Bool {
        let id: String?
        let type: String?
        let message: [String: Any]

        do {
            guard let data = line.data(using: .utf8) else {
                throw HelperError(description: "Command is not valid UTF-8.")
            }
            guard let parsed = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
                throw HelperError(description: "Command must be a JSON object.")
            }
            message = parsed
            id = optionalString(parsed["id"])
            type = optionalString(parsed["type"])
        } catch {
            writer.reply(id: nil, ok: false, fields: ["error": userFacingError(error)])
            return true
        }

        do {
            switch type {
            case "windows.list":
                let content = try await shareableContent()
                let windows = content.windows
                    .filter(isUsefulWindow)
                    .map(jsonWindow)
                writer.reply(id: id, fields: [
                    "backend": "screencapturekit",
                    "windows": windows,
                ])

            case "capture.start":
                try await startCapture(id: id, message: message)

            case "capture.stop":
                try await stopCapture()
                writer.reply(id: id, fields: ["backend": "screencapturekit"])

            case "shutdown":
                try await stopCapture()
                writer.reply(id: id)
                return false

            default:
                throw HelperError(description: "Unsupported command.")
            }
        } catch {
            writer.reply(id: id, ok: false, fields: ["error": userFacingError(error)])
        }

        return true
    }

    private func startCapture(id: String?, message: [String: Any]) async throws {
        try await stopCapture()

        let sessionId = optionalString(message["sessionId"]) ?? "sck"
        guard let requestedWindowId = parseWindowId(optionalString(message["windowId"])) else {
            throw HelperError(description: "capture.start requires a ScreenCaptureKit windowId.")
        }

        let content = try await shareableContent()
        guard let window = content.windows.first(where: { $0.windowID == requestedWindowId }) else {
            throw HelperError(description: "Selected window is no longer capturable.")
        }

        let frameRate = max(1, min(60, optionalInt(message["maxFrameRate"], default: 20)))
        let maxDimension = max(320, min(4096, optionalInt(message["maxDimension"], default: 1920)))
        let quality = optionalDouble(message["quality"], default: 0.75)
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let outputSize = scaledOutputSize(filter: filter, window: window, maxDimension: maxDimension)

        let configuration = SCStreamConfiguration()
        configuration.width = outputSize.width
        configuration.height = outputSize.height
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(frameRate))
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.queueDepth = 3
        configuration.scalesToFit = true
        configuration.preservesAspectRatio = true
        configuration.showsCursor = false
        configuration.shouldBeOpaque = true
        configuration.ignoreGlobalClipSingleWindow = true

        let session = CaptureSession(
            writer: writer,
            sessionId: sessionId,
            windowId: windowIdString(window),
            jpegQuality: quality
        )
        let stream = SCStream(filter: filter, configuration: configuration, delegate: session)
        try stream.addStreamOutput(session, type: .screen, sampleHandlerQueue: session.sampleQueue)
        session.attach(stream: stream)
        session.startRepeatingLastFrame(frameRate: frameRate)
        activeSession = session

        do {
            try await stream.startCapture()
            writer.reply(id: id, fields: [
                "backend": "screencapturekit",
                "windowId": windowIdString(window),
                "width": outputSize.width,
                "height": outputSize.height,
                "maxFrameRate": frameRate,
                "maxDimension": maxDimension,
                "quality": max(0.1, min(1.0, quality)),
                "showsCursor": false,
            ])
        } catch {
            activeSession = nil
            throw error
        }
    }

    private func stopCapture() async throws {
        guard let session = activeSession else { return }
        activeSession = nil
        try await session.stop()
    }

    private func scaledOutputSize(filter: SCContentFilter, window: SCWindow, maxDimension: Int) -> (width: Int, height: Int) {
        let contentRect = filter.contentRect
        let scale = CGFloat(filter.pointPixelScale)
        let fallbackWidth = max(1, window.frame.width)
        let fallbackHeight = max(1, window.frame.height)
        let sourceWidth = max(1, contentRect.width > 0 ? contentRect.width * scale : fallbackWidth * 2)
        let sourceHeight = max(1, contentRect.height > 0 ? contentRect.height * scale : fallbackHeight * 2)
        let limitScale = min(1, CGFloat(maxDimension) / max(sourceWidth, sourceHeight))
        return (
            width: max(2, Int((sourceWidth * limitScale).rounded())),
            height: max(2, Int((sourceHeight * limitScale).rounded()))
        )
    }
}

@main
struct WindowCaptureSCK {
    static func main() async {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.accessory)
        let controller = CaptureController(writer: FramedOutput())
        while let line = readLine(strippingNewline: true) {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            let shouldContinue = await controller.handle(line: trimmed)
            if !shouldContinue { break }
        }
    }
}
