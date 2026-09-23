import TrackpadCore
import Foundation
import Darwin

struct USBDevice: Identifiable, Sendable {
    let id: Int
    let serial: String
    var label: String { "USB device \(id)" }
}
enum USBError: LocalizedError {
    case failure(String)
    var errorDescription: String? { if case .failure(let message) = self { message } else { "USB failed" } }
}

/// Minimal usbmuxd plist protocol. Only explicitly wired devices are eligible.
/// Blocking daemon negotiation runs away from the UI; DispatchIO owns the tunnel afterward.
enum USBMux {
    static let port: UInt16 = 49181
    static func devices() throws -> [USBDevice] {
        let fd = try openDaemon(); defer { Darwin.close(fd) }
        let result = try request(["MessageType": "ListDevices"], on: fd)
        return (result["DeviceList"] as? [[String: Any]] ?? []).compactMap { entry in
            guard let properties = entry["Properties"] as? [String: Any],
                  properties["ConnectionType"] as? String == "USB",
                  let id = entry["DeviceID"] as? Int,
                  let serial = properties["SerialNumber"] as? String else { return nil }
            return USBDevice(id: id, serial: serial)
        }
    }
    static func connect(_ device: USBDevice) throws -> Int32 {
        let fd = try openDaemon()
        do {
            let response = try request(["MessageType": "Connect", "DeviceID": device.id,
                                        "PortNumber": Int(port.bigEndian)], on: fd)
            guard response["Number"] as? Int == 0 else {
                throw USBError.failure("Open Trackpad on the wired device, then connect again.")
            }
            return fd
        } catch { Darwin.close(fd); throw error }
    }
    private static func openDaemon() throws -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw USBError.failure("Cannot create USB socket") }
        var timeout = timeval(tv_sec: 3, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        var noSignal: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let path = Array("/var/run/usbmuxd".utf8CString)
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            for (index, byte) in path.enumerated() { buffer[index] = UInt8(bitPattern: byte) }
        }
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard result == 0 else { Darwin.close(fd); throw USBError.failure("Cannot reach macOS usbmuxd") }
        return fd
    }
    private static func request(_ fields: [String: Any], on fd: Int32) throws -> [String: Any] {
        var plist = fields
        plist["ClientVersionString"] = "WeaveTrackpad/1"
        plist["ProgName"] = "WeaveTrackpad"
        plist["kLibUSBMuxVersion"] = 3
        let body = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        var packet = Data()
        for value: UInt32 in [UInt32(body.count + 16), 1, 8, 1] {
            var little = value.littleEndian
            withUnsafeBytes(of: &little) { packet.append(contentsOf: $0) }
        }
        packet.append(body)
        try packet.withUnsafeBytes { bytes in
            var written = 0
            while written < bytes.count {
                let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: written), bytes.count - written)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw USBError.failure("USB negotiation write failed") }
                written += count
            }
        }
        let header = try readExactly(16, from: fd)
        let length = header.prefix(4).enumerated().reduce(0) { $0 | Int($1.element) << ($1.offset * 8) }
        guard (16...1_048_576).contains(length) else { throw USBError.failure("Invalid usbmuxd response") }
        let result = try PropertyListSerialization.propertyList(from: readExactly(length - 16, from: fd), format: nil)
        guard let dictionary = result as? [String: Any] else { throw USBError.failure("Invalid usbmuxd plist") }
        return dictionary
    }
    private static func readExactly(_ count: Int, from fd: Int32) throws -> Data {
        var data = Data(count: count)
        try data.withUnsafeMutableBytes { bytes in
            var offset = 0
            while offset < count {
                let received = Darwin.read(fd, bytes.baseAddress!.advanced(by: offset), count - offset)
                if received < 0 && errno == EINTR { continue }
                guard received > 0 else { throw USBError.failure("USB negotiation timed out or disconnected") }
                offset += received
            }
        }
        return data
    }
}

@MainActor
final class USBChannel: MessageChannel {
    var onMessage: ((WireMessage) -> Void)?
    var onClose: ((String) -> Void)?
    private let io: DispatchIO
    private var decoder = FrameDecoder()
    private var stopped = false
    private var pendingBytes = 0
    init(fileDescriptor: Int32) {
        io = DispatchIO(type: .stream, fileDescriptor: fileDescriptor, queue: .main) { _ in Darwin.close(fileDescriptor) }
        io.setLimit(lowWater: 1)
        io.setLimit(highWater: 16_384)
    }
    func start() {
        io.read(offset: 0, length: Int.max, queue: .main) { [weak self] done, bytes, error in
            MainActor.assumeIsolated {
                guard let self, !self.stopped else { return }
                do {
                    if let bytes {
                        for message in try self.decoder.append(Data(bytes)) {
                            guard !self.stopped else { break }
                            self.onMessage?(message)
                        }
                    }
                    if error != 0 || done { self.fail("USB disconnected (\(error))") }
                } catch { self.fail("Invalid USB frame: \(error)") }
            }
        }
    }
    func send(_ message: WireMessage) {
        guard !stopped else { return }
        do {
            let bytes = try Frames.encode(message)
            guard pendingBytes + bytes.count <= 65_536 else { fail("USB input queue stalled"); return }
            pendingBytes += bytes.count
            let data = bytes.withUnsafeBytes { DispatchData(bytes: $0) }
            io.write(offset: 0, data: data, queue: .main) { [weak self] done, _, error in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    if done { self.pendingBytes -= bytes.count }
                    if error != 0 { self.fail("USB write failed (\(error))") }
                }
            }
        } catch { fail("Cannot encode USB frame") }
    }
    private func fail(_ reason: String) { guard !stopped else { return }; close(); onClose?(reason) }
    func close() { guard !stopped else { return }; stopped = true; io.close(flags: .stop) }
    deinit { io.close(flags: .stop) }
}
