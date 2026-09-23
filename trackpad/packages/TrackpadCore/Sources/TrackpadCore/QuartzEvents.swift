#if os(macOS)
import CoreGraphics

/// The Core Graphics and AppKit phase enums are deliberately not interchangeable.
public struct QuartzScrollEncoder {
    private var quantizer = ScrollQuantizer()
    public init() {}
    public mutating func event(x: Double, y: Double, phase: ScrollPhase, source: CGEventSource? = nil) -> CGEvent? {
        guard x.isFinite, y.isFinite, abs(x) < Double(Int32.max), abs(y) < Double(Int32.max) else { return nil }
        if phase == .began { quantizer.reset() }
        let pixels = quantizer.consume(x: x, y: y)
        let terminal = phase == .ended || phase == .momentumEnded
        // Zero begin/end events carry lifecycle even when no pixel crosses a boundary.
        if pixels.x == 0 && pixels.y == 0 && (phase == .changed || phase == .momentumChanged) { return nil }
        let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                            wheel1: Int32(clamping: Int64(pixels.y)), wheel2: Int32(clamping: Int64(pixels.x)), wheel3: 0)
        let contact: Int64
        let momentum: Int64
        switch phase {
        case .began: contact = Int64(CGScrollPhase.began.rawValue); momentum = 0
        case .changed: contact = Int64(CGScrollPhase.changed.rawValue); momentum = 0
        case .ended: contact = Int64(CGScrollPhase.ended.rawValue); momentum = 0
        case .momentumBegan: contact = 0; momentum = 1
        case .momentumChanged: contact = 0; momentum = 2
        case .momentumEnded: contact = 0; momentum = 3
        }
        event?.setIntegerValueField(.scrollWheelEventScrollPhase, value: contact)
        event?.setIntegerValueField(.scrollWheelEventMomentumPhase, value: momentum)
        event?.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        if terminal { quantizer.reset() }
        return event
    }
    public mutating func reset() { quantizer.reset() }
}
#endif
