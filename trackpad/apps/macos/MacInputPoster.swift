import AppKit
import TrackpadCore

/// Quartz owns delivery; this object preserves precision across asynchronously posted events.
@MainActor
final class MacInputPoster {
    private let source = QuartzInputSource.make()
    static let sourceTag: Int64 = 0x575645545241434B
    private var cursor: CGPoint?
    private var scroll = QuartzScrollEncoder()
    private var globalMonitor: Any?
    private var localMonitor: Any?
    private(set) var momentumEvents = 0
    var onLocalActivity: (() -> Void)?

    init() {
        let mask: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
                                         .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel]
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: mask) { [weak self] event in
            MainActor.assumeIsolated { self?.observe(event) }
        }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: mask) { [weak self] event in
            MainActor.assumeIsolated { self?.observe(event) }
            return event
        }
    }
    private func observe(_ event: NSEvent) {
        guard let cg = event.cgEvent, cg.getIntegerValueField(.eventSourceUserData) != Self.sourceTag else { return }
        cursor = cg.location
        onLocalActivity?()
    }
    func synchronize() { cursor = CGEvent(source: nil)?.location }
    private func constrained(_ point: CGPoint) -> CGPoint {
        // Keep our accumulated position aligned with the cursor at display edges and gaps.
        let candidates = NSScreen.screens.compactMap { screen -> CGPoint? in
            guard let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? UInt32 else { return nil }
            let rect = CGDisplayBounds(id)
            return CGPoint(x: min(max(point.x, rect.minX), rect.maxX - 1), y: min(max(point.y, rect.minY), rect.maxY - 1))
        }
        return candidates.min { hypot($0.x - point.x, $0.y - point.y) < hypot($1.x - point.x, $1.y - point.y) } ?? point
    }
    @discardableResult func post(_ effect: InputEffect) -> Bool {
        let location = cursor ?? CGEvent(source: nil)?.location ?? .zero
        var event: CGEvent?
        switch effect {
        case .relative(let dx, let dy, let dragging):
            let point = constrained(CGPoint(x: location.x + dx, y: location.y + dy))
            cursor = point
            event = CGEvent(mouseEventSource: source, mouseType: dragging ? .leftMouseDragged : .mouseMoved,
                            mouseCursorPosition: point, mouseButton: .left)
            event?.setIntegerValueField(.mouseEventDeltaX, value: Int64((point.x - location.x).rounded()))
            event?.setIntegerValueField(.mouseEventDeltaY, value: Int64((point.y - location.y).rounded()))
        case .absolute(let point, let contact):
            cursor = CGPoint(x: point.x, y: point.y)
            let type: CGEventType = switch contact { case .hover: .mouseMoved; case .down: .leftMouseDown; case .drag: .leftMouseDragged; case .up: .leftMouseUp }
            event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: cursor!, mouseButton: .left)
            if contact == .down || contact == .up { event?.setIntegerValueField(.mouseEventClickState, value: 1) }
        case .button(let down, let secondary, let count):
            let type: CGEventType = secondary ? (down ? .rightMouseDown : .rightMouseUp) : (down ? .leftMouseDown : .leftMouseUp)
            event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: location, mouseButton: secondary ? .right : .left)
            event?.setIntegerValueField(.mouseEventClickState, value: Int64(count))
        case .scroll(let dx, let dy, let phase):
            event = scroll.event(x: dx, y: dy, phase: phase, source: source)
            event?.location = location
            if event != nil && [.momentumBegan, .momentumChanged, .momentumEnded].contains(phase) { momentumEvents += 1 }
        case .mapping: return false
        }
        guard let event else { return false }
        event.setIntegerValueField(.eventSourceUserData, value: Self.sourceTag)
        event.post(tap: .cghidEventTap)
        return true
    }
}
