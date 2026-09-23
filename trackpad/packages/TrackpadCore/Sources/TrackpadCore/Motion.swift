import Foundation

public struct MotionSettings: Codable, Equatable, Sendable {
    public var pointerSpeed: Double = 1
    public var acceleration = true
    public var scrollSpeed: Double = 1
    public var naturalScrolling = true
    public var momentum = true
    public init() {}
    public var validated: Self {
        var result = self
        result.pointerSpeed = pointerSpeed.isFinite ? min(max(pointerSpeed, 0.25), 3) : 1
        result.scrollSpeed = scrollSpeed.isFinite ? min(max(scrollSpeed, 0.25), 3) : 1
        return result
    }
}

/// Source-time dynamics. Arrival time and display refresh never determine pointer gain.
public struct PointerDynamics: Sendable {
    private var previousTime: Double?
    private var speed: Double?
    public init() {}
    public mutating func reset(at time: Double? = nil) { previousTime = time; speed = nil }
    public mutating func move(x: Double, y: Double, time: Double, settings: MotionSettings) -> Point {
        guard x.isFinite, y.isFinite, time.isFinite else { return Point(x: 0, y: 0) }
        let dt = previousTime.map { time - $0 }
        if previousTime == nil || time > previousTime! { previousTime = time }
        if let dt, dt > 0, dt <= 0.15 {
            let measured = min(hypot(x, y) / dt, 5_000)
            let weight = 1 - exp(-dt / 0.012)
            speed = speed.map { $0 + (measured - $0) * weight } ?? measured
        } else if dt == nil || (dt ?? 0) > 0.15 { speed = nil }
        // Deliberately tunable app curve, not a claimed Apple factory preset.
        let t = min(max(((speed ?? 0) - 30) / 870, 0), 1)
        let gain = settings.acceleration ? 0.85 + 2.35 * t * t * (3 - 2 * t) : 1.7
        return Point(x: x * gain * settings.pointerSpeed, y: y * gain * settings.pointerSpeed)
    }
}

public struct ScrollStep: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var phase: ScrollPhase
    public init(_ phase: ScrollPhase, x: Double = 0, y: Double = 0) { self.phase = phase; self.x = x; self.y = y }
}

/// Direct movement uses capture time; the host advances inertia with monotonic time.
public struct ScrollDynamics: Sendable {
    private struct Segment: Sendable { var start: Double; var end: Double; var x: Double; var y: Double }
    public private(set) var isDirect = false
    public private(set) var isMomentum = false
    private var history: [Segment] = []
    private var lastTime: Double?
    private var lastMotion: Double?
    private var endedAt: Double?
    private var velocity = Point(x: 0, y: 0)
    private var tailTime = 0.0
    private var elapsed = 0.0
    private let decayTime = 0.24
    public init() {}
    public mutating func begin(time: Double) -> [ScrollStep] {
        var effects = cancel()
        isDirect = true; lastTime = time
        effects.append(ScrollStep(.began))
        return effects
    }
    public mutating func move(x: Double, y: Double, time: Double) -> [ScrollStep] {
        guard isDirect, x.isFinite, y.isFinite, time.isFinite else { return [] }
        // Out-of-order source data never contributes motion or velocity.
        guard lastTime == nil || time >= lastTime! else { return [] }
        let start = lastTime ?? time
        lastTime = time
        guard x != 0 || y != 0 else { return [] }
        if let previous = history.last, previous.x * x + previous.y * y < 0 { history.removeAll() }
        if time - start > 0.15 { history.removeAll() }
        if time > start && time - start <= 0.15 { history.append(Segment(start: start, end: time, x: x, y: y)) }
        history.removeAll { $0.end <= time - 0.08 }
        lastMotion = time
        return [ScrollStep(.changed, x: x, y: y)]
    }
    public mutating func end(time: Double) -> [ScrollStep] {
        guard isDirect else { return [] }
        isDirect = false; endedAt = time
        return [ScrollStep(.ended)]
    }
    public mutating func contactsEnded(time: Double, now: Double, enabled: Bool) -> [ScrollStep] {
        defer { history.removeAll(); endedAt = nil }
        guard enabled, !isDirect, let endedAt, let lastMotion,
              time >= endedAt, time - endedAt <= 0.08,
              time >= lastMotion, time - lastMotion <= 0.08 else { return [] }
        let cutoff = time - 0.08
        var duration = 0.0, dx = 0.0, dy = 0.0
        for segment in history {
            let span = segment.end - segment.start
            let included = max(0, segment.end - max(cutoff, segment.start))
            guard span > 0 else { continue }
            dx += segment.x * included / span; dy += segment.y * included / span
            duration += included
        }
        // A pause reduces release speed, rather than repeating the last moving sample.
        duration += max(0, time - lastMotion)
        guard duration >= 0.008 else { return [] }
        velocity = Point(x: dx / duration, y: dy / duration)
        let magnitude = hypot(velocity.x, velocity.y)
        guard magnitude >= 40 else { return [] }
        let limit = min(1, 6_000 / magnitude)
        velocity.x *= limit; velocity.y *= limit
        tailTime = now; elapsed = 0; isMomentum = true
        return [ScrollStep(.momentumBegan)]
    }
    public mutating func tick(now: Double) -> [ScrollStep] {
        guard isMomentum, now.isFinite else { return [] }
        let dt = now - tailTime
        guard dt > 0 else { return [] }
        // A stalled main loop must not replay a jump accumulated while it was blocked.
        guard dt <= 0.1 else { return cancel() }
        let decay = exp(-dt / decayTime)
        let dx = velocity.x * decayTime * (1 - decay)
        let dy = velocity.y * decayTime * (1 - decay)
        velocity.x *= decay; velocity.y *= decay
        tailTime = now; elapsed += dt
        var effects = [ScrollStep(.momentumChanged, x: dx, y: dy)]
        if hypot(velocity.x, velocity.y) < 8 || elapsed >= 2 {
            effects += cancel()
        }
        return effects
    }
    public mutating func cancel() -> [ScrollStep] {
        var effects: [ScrollStep] = []
        if isDirect { effects.append(ScrollStep(.ended)) }
        if isMomentum { effects.append(ScrollStep(.momentumEnded)) }
        isDirect = false; isMomentum = false; history.removeAll()
        lastTime = nil; lastMotion = nil; endedAt = nil
        velocity = Point(x: 0, y: 0); elapsed = 0
        return effects
    }
}

/// Conserves subpixel displacement while emitting integral precise-scroll pixels.
public struct ScrollQuantizer: Sendable {
    private var x = 0.0, y = 0.0
    public init() {}
    public mutating func reset() { x = 0; y = 0 }
    public mutating func consume(x dx: Double, y dy: Double) -> Point {
        x += dx; y += dy
        let wholeX = x.rounded(.towardZero), wholeY = y.rounded(.towardZero)
        x -= wholeX; y -= wholeY
        return Point(x: wholeX, y: wholeY)
    }
}
