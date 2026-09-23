import Foundation

public enum WireKind: String, Codable, Sendable {
    case hello, approve, ready, confirm, input, mapping, heartbeat, goodbye
}
public enum InputAction: String, Codable, Sendable {
    case contactBegin, contactEnd
    case move, primaryClick, secondaryClick, dragBegin, dragMove, dragEnd
    case scrollBegin, scrollMove, scrollEnd
    case penHover, penDown, penMove, penUp, nextDisplay, reset
}
public struct DisplayInfo: Codable, Sendable, Equatable {
    public var id: UInt32
    public var name: String
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    public init(id: UInt32, name: String, x: Double, y: Double, width: Double, height: Double) {
        self.id = id; self.name = name; self.x = x; self.y = y
        self.width = width; self.height = height
    }
    public func point(u: Double, v: Double) -> Point {
        Point(x: x + min(max(u * width, 0), max(width - 1, 0)),
              y: y + min(max(v * height, 0), max(height - 1, 0)))
    }
}
public struct Point: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public init(x: Double, y: Double) { self.x = x; self.y = y }
}
public struct InputSample: Codable, Sendable {
    public var sequence: UInt64
    public var generation: UInt64
    public var action: InputAction
    public var x: Double
    public var y: Double
    public var time: Double
    public var count: Int
    public init(sequence: UInt64, generation: UInt64, action: InputAction,
                x: Double = 0, y: Double = 0, time: Double = 0, count: Int = 1) {
        self.sequence = sequence; self.generation = generation; self.action = action
        self.x = x; self.y = y; self.time = time; self.count = count
    }
}
public struct WireMessage: Codable, Sendable {
    public static let version = 3
    public var version: Int = Self.version
    public var kind: WireKind
    public var session: UUID
    public var name: String?
    public var sample: InputSample?
    public var display: DisplayInfo?
    public var generation: UInt64?
    public var displayCount: Int?
    public var challenge: PairingChallenge?
    public var authentication: PairingAuthentication?
    public init(_ kind: WireKind, session: UUID, name: String? = nil,
                sample: InputSample? = nil, display: DisplayInfo? = nil,
                generation: UInt64? = nil, displayCount: Int? = nil,
                challenge: PairingChallenge? = nil, authentication: PairingAuthentication? = nil) {
        self.kind = kind; self.session = session; self.name = name; self.sample = sample
        self.display = display; self.generation = generation; self.displayCount = displayCount
        self.challenge = challenge; self.authentication = authentication
    }
}

/// Four-byte network-order length followed by a bounded JSON envelope.
/// This measurable baseline keeps control and input ordered on the USB stream.
public enum Frames {
    public static let maximumSize = 65_536
    public static func encode(_ message: WireMessage) throws -> Data {
        let body = try JSONEncoder().encode(message)
        guard body.count <= maximumSize else { throw FrameError.oversized }
        var size = UInt32(body.count).bigEndian
        var result = withUnsafeBytes(of: &size) { Data($0) }
        result.append(body)
        return result
    }
}
public enum FrameError: Error { case oversized, malformed, wrongVersion }
public struct FrameDecoder: Sendable {
    private var buffer = Data()
    public init() {}
    public mutating func append(_ bytes: Data) throws -> [WireMessage] {
        // Each caller supplies at most 64 KiB; one partial frame may already exist.
        guard bytes.count <= Frames.maximumSize + 4 else { throw FrameError.oversized }
        buffer.append(bytes)
        var messages: [WireMessage] = []
        while buffer.count >= 4 {
            let length = buffer.prefix(4).reduce(0) { ($0 << 8) | Int($1) }
            guard length > 0, length <= Frames.maximumSize else { throw FrameError.oversized }
            guard buffer.count >= length + 4 else { break }
            let message = try JSONDecoder().decode(WireMessage.self, from: buffer.subdata(in: 4..<4 + length))
            guard message.version == WireMessage.version else { throw FrameError.wrongVersion }
            messages.append(message)
            buffer.removeFirst(length + 4)
            // Data indices can remain nonzero after removeFirst.
            buffer = Data(buffer)
        }
        return messages
    }
}

public enum TabletArea {
    /// Centered active area in local view points, matching the selected screen's aspect.
    public static func fitted(width: Double, height: Double, aspect: Double) -> (origin: Point, size: Point) {
        guard width > 0, height > 0, aspect.isFinite, aspect > 0 else {
            return (Point(x: 0, y: 0), Point(x: 0, y: 0))
        }
        let w = min(width, height * aspect), h = min(height, width / aspect)
        return (Point(x: (width - w) / 2, y: (height - h) / 2), Point(x: w, y: h))
    }
}
