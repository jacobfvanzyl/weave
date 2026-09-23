import Foundation

public struct Finger: Sendable {
    public let id: Int
    public let point: Point
    public init(id: Int, x: Double, y: Double) { self.id = id; self.point = Point(x: x, y: y) }
}
public struct GestureOutput: Equatable, Sendable {
    public let action: InputAction
    public let x: Double
    public let y: Double
    public let count: Int
    public init(_ action: InputAction, x: Double = 0, y: Double = 0, count: Int = 1) {
        self.action = action; self.x = x; self.y = y; self.count = count
    }
}
/// Recognizes complete finger sessions. A remaining finger after a two-finger gesture
/// cannot accidentally become pointer motion or a tap until all fingers lift.
public struct FingerGestures: Sendable {
    private enum Mode { case idle, single, two, blocked }
    private var mode = Mode.idle
    private var fingers: [Int: Point] = [:]
    private var origins: [Int: Point] = [:]
    private var previous = Point(x: 0, y: 0)
    private var beganAt = 0.0
    private var moved = false
    private var scrolling = false
    public init() {}
    public mutating func cancel() -> [GestureOutput] {
        let output = [GestureOutput(.reset)]
        self = FingerGestures()
        return output
    }
    public mutating func begin(_ added: [Finger], time: Double, current: [Finger] = []) -> [GestureOutput] {
        // Establish a current baseline at a contact-count boundary without
        // replaying the held fingers' pre-boundary coalesced history.
        for finger in current where fingers[finger.id] != nil { fingers[finger.id] = finger.point }
        for finger in added { fingers[finger.id] = finger.point; origins[finger.id] = finger.point }
        if mode == .blocked { return [GestureOutput(.contactBegin, count: fingers.count)] }
        var result = [GestureOutput(.contactBegin, x: centroid().x, y: centroid().y, count: fingers.count)]
        if fingers.count == 1 && mode == .idle {
            mode = .single; beganAt = time; moved = false
            previous = centroid()
        } else if fingers.count == 2 {
            mode = .two; beganAt = time; moved = false
            origins = fingers; previous = centroid()
        } else {
            if scrolling { result.append(GestureOutput(.scrollEnd)) }
            scrolling = false; mode = .blocked
        }
        return result
    }
    public mutating func move(_ changed: [Finger], time: Double) -> [GestureOutput] {
        for finger in changed where fingers[finger.id] != nil { fingers[finger.id] = finger.point }
        guard mode == .single || mode == .two else { return [] }
        for (id, point) in fingers {
            if let origin = origins[id], hypot(point.x - origin.x, point.y - origin.y) > 6 { moved = true }
        }
        // Accumulate the initial slop instead of dropping a different distance
        // depending on whether UIKit delivers one position or several samples.
        if mode == .two && !moved { return [] }
        let current = centroid(), dx = current.x - previous.x, dy = current.y - previous.y
        previous = current
        guard dx != 0 || dy != 0 else { return [] }
        if mode == .single { return [GestureOutput(.move, x: dx, y: dy)] }
        guard moved else { return [] }
        var result: [GestureOutput] = []
        if !scrolling { scrolling = true; result.append(GestureOutput(.scrollBegin)) }
        result.append(GestureOutput(.scrollMove, x: dx, y: dy))
        return result
    }
    public mutating func end(_ ended: [Finger], time: Double) -> [GestureOutput] {
        // Lift locations can jump as the contact patch shrinks. Check tap slop but
        // never turn lift noise into pointer movement or a new fling velocity.
        for finger in ended {
            if let origin = origins[finger.id], hypot(finger.point.x - origin.x, finger.point.y - origin.y) > 6 { moved = true }
        }
        var result: [GestureOutput] = []
        if mode == .single {
            if !moved && time - beganAt < 0.3 { result.append(GestureOutput(.primaryClick)) }
        } else if mode == .two {
            if scrolling { result.append(GestureOutput(.scrollEnd)) }
            else if !moved && time - beganAt < 0.3 { result.append(GestureOutput(.secondaryClick)) }
        }
        for finger in ended { fingers.removeValue(forKey: finger.id); origins.removeValue(forKey: finger.id) }
        scrolling = false
        mode = fingers.isEmpty ? .idle : .blocked
        result.append(GestureOutput(.contactEnd, count: fingers.count))
        return result
    }
    private func centroid() -> Point {
        let count = Double(max(fingers.count, 1))
        return Point(x: fingers.values.reduce(0) { $0 + $1.x } / count,
                     y: fingers.values.reduce(0) { $0 + $1.y } / count)
    }
}
