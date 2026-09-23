import Foundation

public enum InputEffect: Equatable, Sendable {
    case relative(Double, Double, dragging: Bool)
    case absolute(Point, contact: Contact)
    case button(down: Bool, secondary: Bool, count: Int)
    case scroll(Double, Double, phase: ScrollPhase)
    case mapping(DisplayInfo, generation: UInt64)
}
public enum Contact: Sendable { case hover, down, drag, up }
public enum ScrollPhase: Sendable {
    case began, changed, ended, momentumBegan, momentumChanged, momentumEnded
}

/// Owns pressed state and mapping generations independently of transport and Quartz.
public struct InputSession: Sendable {
    public private(set) var displays: [DisplayInfo]
    public private(set) var selectedIndex = 0
    public private(set) var generation: UInt64 = 1
    public private(set) var lastSequence: UInt64 = 0
    private var dragHeld = false
    private var dragClickCount = 1
    private var penHeld = false
    private var pointer = PointerDynamics()
    private var scroll = ScrollDynamics()
    public private(set) var settings = MotionSettings()
    public var doubleClickInterval = 0.5
    private var contacts = 0
    private var contactDrag = false
    private var suppressTap = false
    private var contactOrigin = Point(x: 0, y: 0)
    private var lastTap: (time: Double, point: Point)?
    public var isMomentum: Bool { scroll.isMomentum }
    private func scrollEffects(_ steps: [ScrollStep]) -> [InputEffect] {
        steps.map { .scroll($0.x, $0.y, phase: $0.phase) }
    }
    public mutating func configure(_ value: MotionSettings) -> [InputEffect] {
        let effects = release(); settings = value.validated; return effects
    }
    public mutating func tick(now: Double) -> [InputEffect] {
        scrollEffects(scroll.tick(now: now))
    }
    private var awaitingPenLift = false
    private var lastPen = Point(x: 0, y: 0)
    public var selected: DisplayInfo? { displays.indices.contains(selectedIndex) ? displays[selectedIndex] : nil }
    public init(displays: [DisplayInfo]) { self.displays = displays }
    public mutating func release() -> [InputEffect] {
        var effects: [InputEffect] = []
        if dragHeld { effects.append(.button(down: false, secondary: false, count: dragClickCount)) }
        if penHeld { effects.append(.absolute(lastPen, contact: .up)) }
        effects += scrollEffects(scroll.cancel())
        dragHeld = false; penHeld = false; contactDrag = false
        pointer.reset(); contacts = 0; suppressTap = false; lastTap = nil
        return effects
    }
    public mutating func replaceDisplays(_ newDisplays: [DisplayInfo]) -> [InputEffect] {
        let previous = selected?.id
        let wasHeld = penHeld
        var effects = release()
        displays = newDisplays
        selectedIndex = newDisplays.firstIndex { $0.id == previous } ?? 0
        generation &+= 1; awaitingPenLift = wasHeld
        if let selected { effects.append(.mapping(selected, generation: generation)) }
        return effects
    }
    public mutating func handle(_ sample: InputSample, now: Double? = nil) -> [InputEffect] {
        guard sample.sequence > lastSequence,
              sample.x.isFinite, sample.y.isFinite, sample.time.isFinite,
              abs(sample.x) <= 10_000, abs(sample.y) <= 10_000 else { return [] }
        lastSequence = sample.sequence
        // Releases are accepted across a mapping boundary, but never create contact.
        if sample.action == .reset { awaitingPenLift = false; return release() }
        if sample.action == .penUp {
            awaitingPenLift = false
            guard penHeld else { return [] }
            penHeld = false
            return [.absolute(lastPen, contact: .up)]
        }
        if sample.action == .dragEnd {
            guard dragHeld else { return [] }; dragHeld = false
            return [.button(down: false, secondary: false, count: dragClickCount)]
        }
        if sample.action == .contactEnd && sample.count == 0 && sample.generation != generation {
            return release()
        }
        guard sample.generation == generation else { return [] }
        switch sample.action {
        case .contactBegin:
            guard (1...10).contains(sample.count) else { return [] }
            let stoppedMomentum = scroll.isMomentum
            var effects = scrollEffects(scroll.cancel())
            pointer.reset(at: sample.time)
            if contacts == 0 {
                suppressTap = stoppedMomentum
                contactOrigin = Point(x: sample.x, y: sample.y)
                if stoppedMomentum { lastTap = nil }
                let candidate = lastTap
                lastTap = nil
                if sample.count == 1, !penHeld, !dragHeld, !suppressTap, let lastTap = candidate,
                   sample.time >= lastTap.time, sample.time - lastTap.time <= doubleClickInterval,
                   hypot(sample.x - lastTap.point.x, sample.y - lastTap.point.y) <= 18 {
                    dragHeld = true; contactDrag = true; dragClickCount = 2
                    effects.append(.button(down: true, secondary: false, count: 2))
                }
            }
            contacts = sample.count
            if contacts > 1 {
                lastTap = nil
                if contactDrag {
                    effects.append(.button(down: false, secondary: false, count: dragClickCount))
                    dragHeld = false; contactDrag = false
                }
            }
            return effects
        case .contactEnd:
            guard (0...10).contains(sample.count) else { return [] }
            contacts = sample.count
            guard contacts == 0 else { return [] }
            var effects: [InputEffect] = []
            if contactDrag {
                effects.append(.button(down: false, secondary: false, count: dragClickCount))
                contactDrag = false; dragHeld = false; lastTap = nil
            }
            pointer.reset()
            effects += scrollEffects(scroll.contactsEnded(time: sample.time, now: now ?? sample.time, enabled: settings.momentum))
            suppressTap = false
            return effects
        case .move:
            guard !penHeld else { return [] }
            let point = pointer.move(x: sample.x, y: sample.y, time: sample.time, settings: settings)
            return [.relative(point.x, point.y, dragging: dragHeld)]
        case .primaryClick, .secondaryClick:
            guard !penHeld, !dragHeld, !suppressTap else { return [] }
            let secondary = sample.action == .secondaryClick
            lastTap = secondary ? nil : (sample.time, contactOrigin)
            let count = min(max(sample.count, 1), 2)
            return [.button(down: true, secondary: secondary, count: count),
                    .button(down: false, secondary: secondary, count: count)]
        case .dragBegin:
            guard !suppressTap, !penHeld, !dragHeld else { return [] }
            dragHeld = true; dragClickCount = min(max(sample.count, 1), 2)
            return [.button(down: true, secondary: false, count: dragClickCount)]
        case .dragMove:
            guard dragHeld else { return [] }
            let point = pointer.move(x: sample.x, y: sample.y, time: sample.time, settings: settings)
            return [.relative(point.x, point.y, dragging: true)]
        case .scrollBegin:
            guard !penHeld, !dragHeld, !scroll.isDirect else { return [] }
            lastTap = nil
            return scrollEffects(scroll.begin(time: sample.time))
        case .scrollMove:
            let gain = settings.scrollSpeed * (settings.naturalScrolling ? 1 : -1)
            return scrollEffects(scroll.move(x: sample.x * gain, y: sample.y * gain, time: sample.time))
        case .scrollEnd:
            return scrollEffects(scroll.end(time: sample.time))
        case .nextDisplay:
            guard displays.count > 1 else { return [] }
            let wasHeld = penHeld
            var effects = release()
            selectedIndex = (selectedIndex + 1) % displays.count
            generation &+= 1; awaitingPenLift = wasHeld
            if let selected { effects.append(.mapping(selected, generation: generation)) }
            return effects
        case .penHover, .penDown, .penMove:
            guard let selected, (0...1).contains(sample.x), (0...1).contains(sample.y), !dragHeld else { return [] }
            let point = selected.point(u: sample.x, v: sample.y)
            switch sample.action {
            case .penHover:
                // Hover is proof the tip has lifted, including display removal while hovering.
                guard !penHeld else { return [] }; awaitingPenLift = false
                lastPen = point; return [.absolute(point, contact: .hover)]
            case .penDown:
                guard !awaitingPenLift, !penHeld else { return [] }
                var effects = release(); penHeld = true; lastPen = point
                effects.append(.absolute(point, contact: .down)); return effects
            default:
                guard penHeld, !awaitingPenLift else { return [] }
                lastPen = point; return [.absolute(point, contact: .drag)]
            }
        default: return []
        }
    }
}
