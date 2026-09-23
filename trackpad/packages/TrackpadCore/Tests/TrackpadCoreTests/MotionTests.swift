import XCTest
@testable import TrackpadCore
#if os(macOS)
import AppKit
#endif

final class MotionTests: XCTestCase {
    func testPointerSlowPrecisionFastTravelAndVectorGain() {
        var slow = PointerDynamics(), fast = PointerDynamics(), diagonal = PointerDynamics()
        slow.reset(at: 0); fast.reset(at: 0); diagonal.reset(at: 0)
        let settings = MotionSettings()
        let a = slow.move(x: 0.2, y: 0, time: 0.01, settings: settings)
        let b = fast.move(x: 10, y: 0, time: 0.01, settings: settings)
        let c = diagonal.move(x: 6, y: 8, time: 0.01, settings: settings)
        XCTAssertEqual(a.x / 0.2, 0.85, accuracy: 0.0001)
        XCTAssertEqual(b.x / 10, 3.2, accuracy: 0.0001)
        XCTAssertEqual(hypot(c.x, c.y), b.x, accuracy: 0.0001)
        XCTAssertEqual(c.x / c.y, 0.75, accuracy: 0.0001)
    }
    func testPointerConstantVelocityIndependentOfSamplingCadence() {
        func distance(hz: Int) -> Double {
            var dynamics = PointerDynamics(); dynamics.reset(at: 0)
            return (1...hz).reduce(0) { sum, frame in
                sum + dynamics.move(x: 500 / Double(hz), y: 0, time: Double(frame) / Double(hz), settings: MotionSettings()).x
            }
        }
        XCTAssertEqual(distance(hz: 60), distance(hz: 120), accuracy: 0.001)
        XCTAssertEqual(distance(hz: 120), distance(hz: 240), accuracy: 0.001)
    }
    func testLinearPointerAndResetAfterPause() {
        var dynamics = PointerDynamics(), settings = MotionSettings()
        settings.acceleration = false; settings.pointerSpeed = 2
        XCTAssertEqual(dynamics.move(x: 3, y: -2, time: 0, settings: settings), Point(x: 10.2, y: -6.8))
        settings = MotionSettings(); dynamics.reset(at: 0)
        _ = dynamics.move(x: 20, y: 0, time: 0.01, settings: settings)
        XCTAssertEqual(dynamics.move(x: 1, y: 0, time: 1, settings: settings).x, 0.85, accuracy: 0.001)
    }
    func testQuantizerConservesPositiveNegativeAndReversingSubpixels() {
        var quantizer = ScrollQuantizer()
        let total = (0..<100).reduce(Point(x: 0, y: 0)) { value, _ in
            let next = quantizer.consume(x: 0.25, y: -0.25)
            return Point(x: value.x + next.x, y: value.y + next.y)
        }
        XCTAssertEqual(total, Point(x: 25, y: -25))
        XCTAssertEqual(quantizer.consume(x: 0.75, y: 0), Point(x: 0, y: 0))
        XCTAssertEqual(quantizer.consume(x: -1.25, y: 0), Point(x: 0, y: 0))
        XCTAssertEqual(quantizer.consume(x: -0.5, y: 0), Point(x: -1, y: 0))
    }
    private func preparedScroll() -> ScrollDynamics {
        var dynamics = ScrollDynamics()
        _ = dynamics.begin(time: 0)
        for frame in 1...6 { _ = dynamics.move(x: 5, y: 10, time: Double(frame) * 0.01) }
        _ = dynamics.end(time: 0.065)
        return dynamics
    }
    func testMomentumDistanceIndependentOfHostCadenceAndStopsOnce() {
        func tail(hz: Int) -> Point {
            var dynamics = preparedScroll()
            XCTAssertEqual(dynamics.contactsEnded(time: 0.065, now: 100, enabled: true), [ScrollStep(.momentumBegan)])
            var total = Point(x: 0, y: 0), ends = 0
            for frame in 1...(hz * 3) {
                for step in dynamics.tick(now: 100 + Double(frame) / Double(hz)) {
                    total.x += step.x; total.y += step.y
                    if step.phase == .momentumEnded { ends += 1 }
                }
            }
            XCTAssertEqual(ends, 1); XCTAssertFalse(dynamics.isMomentum)
            XCTAssertTrue(dynamics.cancel().isEmpty)
            return total
        }
        let slow = tail(hz: 60), fast = tail(hz: 120)
        XCTAssertGreaterThan(slow.y, 200)
        XCTAssertEqual(slow.y, fast.y, accuracy: 0.2)
        XCTAssertEqual(slow.y, slow.x * 2, accuracy: 0.001)
    }
    func testPauseAndStaggeredLiftDoNotFling() {
        var dynamics = preparedScroll()
        XCTAssertTrue(dynamics.contactsEnded(time: 0.2, now: 1, enabled: true).isEmpty)
        dynamics = preparedScroll()
        XCTAssertTrue(dynamics.contactsEnded(time: 0.065, now: 1, enabled: false).isEmpty)
        // The first lift ends direct motion, but only the last lift may start inertia.
        dynamics = preparedScroll()
        XCTAssertFalse(dynamics.isMomentum)
        XCTAssertTrue(dynamics.tick(now: 1).isEmpty)
    }
    func testReversalUsesLatestDirectionAndStalledHostCancels() {
        var dynamics = ScrollDynamics()
        _ = dynamics.begin(time: 0)
        _ = dynamics.move(x: 0, y: 10, time: 0.01)
        _ = dynamics.move(x: 0, y: 10, time: 0.02)
        _ = dynamics.move(x: 0, y: -10, time: 0.03)
        _ = dynamics.end(time: 0.035)
        _ = dynamics.contactsEnded(time: 0.035, now: 10, enabled: true)
        XCTAssertLessThan(dynamics.tick(now: 10.01).first!.y, 0)
        XCTAssertEqual(dynamics.tick(now: 10.5), [ScrollStep(.momentumEnded)])
        XCTAssertTrue(dynamics.tick(now: 10.51).isEmpty)
    }
    func testTouchEndsMomentumBeforeNextDirectGesture() {
        var dynamics = preparedScroll()
        _ = dynamics.contactsEnded(time: 0.065, now: 1, enabled: true)
        XCTAssertEqual(dynamics.begin(time: 0.1), [ScrollStep(.momentumEnded), ScrollStep(.began)])
        XCTAssertTrue(dynamics.tick(now: 1.01).isEmpty)
        XCTAssertEqual(dynamics.cancel(), [ScrollStep(.ended)])
        XCTAssertTrue(dynamics.cancel().isEmpty)
    }
    func testLiftNoiseCannotCreateScrollOrPointerMovement() {
        var fingers = FingerGestures()
        _ = fingers.begin([Finger(id: 1, x: 0, y: 0)], time: 0)
        XCTAssertEqual(fingers.end([Finger(id: 1, x: 40, y: 40)], time: 0.1), [GestureOutput(.contactEnd, count: 0)])
        _ = fingers.begin([Finger(id: 1, x: 0, y: 0), Finger(id: 2, x: 20, y: 0)], time: 1)
        let output = fingers.end([Finger(id: 1, x: 0, y: 40), Finger(id: 2, x: 20, y: 40)], time: 1.1)
        XCTAssertEqual(output, [GestureOutput(.contactEnd, count: 0)])
    }
    func testSettingsClampAndPencilMappingIsUnaffected() {
        var session = InputSession(displays: [DisplayInfo(id: 1, name: "Display", x: -100, y: -200, width: 1000, height: 500)])
        var settings = MotionSettings(); settings.pointerSpeed = 100; settings.scrollSpeed = .nan
        _ = session.configure(settings)
        XCTAssertEqual(session.settings.pointerSpeed, 3); XCTAssertEqual(session.settings.scrollSpeed, 1)
        XCTAssertEqual(session.handle(InputSample(sequence: 1, generation: 1, action: .penDown, x: 0.5, y: 0.5)), [.absolute(Point(x: 400, y: 50), contact: .down)])
    }
    func testMomentumStopTouchDoesNotClickAndConfigureEndsTail() {
        var session = InputSession(displays: [])
        var sequence: UInt64 = 0
        func send(_ action: InputAction, time: Double, y: Double = 0, count: Int = 1) -> [InputEffect] {
            sequence += 1
            return session.handle(InputSample(sequence: sequence, generation: 1, action: action, y: y, time: time, count: count), now: 100 + time)
        }
        func fling(time: Double) {
            _ = send(.contactBegin, time: time, count: 2)
            _ = send(.scrollBegin, time: time)
            for i in 1...6 { _ = send(.scrollMove, time: time + Double(i) * 0.01, y: 10) }
            _ = send(.scrollEnd, time: time + 0.065)
            XCTAssertEqual(send(.contactEnd, time: time + 0.065, count: 0), [.scroll(0, 0, phase: .momentumBegan)])
        }
        fling(time: 0)
        XCTAssertEqual(send(.contactBegin, time: 0.1), [.scroll(0, 0, phase: .momentumEnded)])
        XCTAssertTrue(send(.primaryClick, time: 0.15).isEmpty)
        _ = send(.contactEnd, time: 0.15, count: 0)
        _ = send(.contactBegin, time: 0.3)
        XCTAssertEqual(send(.primaryClick, time: 0.35).count, 2)
        _ = send(.contactEnd, time: 0.35, count: 0)
        fling(time: 1)
        XCTAssertEqual(session.configure(MotionSettings()), [.scroll(0, 0, phase: .momentumEnded)])
        XCTAssertTrue(session.tick(now: 101.08).isEmpty)
        XCTAssertTrue(session.release().isEmpty)
    }
    func testDistantSecondTapDoesNotPressDrag() {
        var session = InputSession(displays: [])
        _ = session.handle(InputSample(sequence: 1, generation: 1, action: .contactBegin, time: 0))
        _ = session.handle(InputSample(sequence: 2, generation: 1, action: .primaryClick, time: 0.05))
        _ = session.handle(InputSample(sequence: 3, generation: 1, action: .contactEnd, time: 0.05, count: 0))
        XCTAssertTrue(session.handle(InputSample(sequence: 4, generation: 1, action: .contactBegin, x: 100, time: 0.1)).isEmpty)
        XCTAssertTrue(session.release().isEmpty)
    }
    func testSourceTimingIgnoresPacketArrivalJitter() {
        func output(arrivals: [Double]) -> [InputEffect] {
            var session = InputSession(displays: [])
            _ = session.handle(InputSample(sequence: 1, generation: 1, action: .contactBegin, time: 0), now: 100)
            return arrivals.enumerated().flatMap { index, arrival in
                session.handle(InputSample(sequence: UInt64(index + 2), generation: 1, action: .move,
                                           x: 5, time: Double(index + 1) * 0.01), now: arrival)
            }
        }
        XCTAssertEqual(output(arrivals: [100.01, 100.02, 100.03, 100.04]), output(arrivals: [100.02, 100.021, 100.05, 100.051]))
    }
    func testStaleScrollSampleCannotChangeVelocity() {
        var dynamics = ScrollDynamics()
        _ = dynamics.begin(time: 1)
        _ = dynamics.move(x: 0, y: 10, time: 1.01)
        XCTAssertTrue(dynamics.move(x: 0, y: -100, time: 1).isEmpty)
        _ = dynamics.move(x: 0, y: 10, time: 1.02)
        _ = dynamics.end(time: 1.025)
        _ = dynamics.contactsEnded(time: 1.025, now: 5, enabled: true)
        XCTAssertGreaterThan(dynamics.tick(now: 5.01).first!.y, 0)
    }
    func testSessionReleaseStopsMomentumAndNaturalDirectionAppliesOnce() {
        var session = InputSession(displays: [])
        var settings = MotionSettings(); settings.naturalScrolling = false; settings.scrollSpeed = 2
        _ = session.configure(settings)
        _ = session.handle(InputSample(sequence: 1, generation: 1, action: .scrollBegin, time: 0))
        XCTAssertEqual(session.handle(InputSample(sequence: 2, generation: 1, action: .scrollMove, x: 5, y: 10, time: 0.01)), [.scroll(-10, -20, phase: .changed)])
        _ = session.handle(InputSample(sequence: 3, generation: 1, action: .scrollEnd, time: 0.015))
        _ = session.handle(InputSample(sequence: 4, generation: 1, action: .contactEnd, time: 0.015, count: 0), now: 100)
        let tail = session.tick(now: 100.01)
        guard case .scroll(let x, let y, .momentumChanged) = tail.first else { return XCTFail("Expected momentum") }
        XCTAssertLessThan(x, 0); XCTAssertLessThan(y, 0)
        XCTAssertEqual(session.release(), [.scroll(0, 0, phase: .momentumEnded)])
        XCTAssertTrue(session.tick(now: 100.02).isEmpty)
        XCTAssertTrue(session.release().isEmpty)
    }
    #if os(macOS)
    func testQuartzContactAndMomentumPhaseConversion() throws {
        var encoder = QuartzScrollEncoder()
        let cases: [(ScrollPhase, NSEvent.Phase, NSEvent.Phase, Int64, Int64)] = [
            (.began, .began, [], 1, 0), (.changed, .changed, [], 2, 0), (.ended, .ended, [], 4, 0),
            (.momentumBegan, [], .began, 0, 1), (.momentumChanged, [], .changed, 0, 2), (.momentumEnded, [], .ended, 0, 3)
        ]
        for (phase, contact, momentum, rawContact, rawMomentum) in cases {
            let event = try XCTUnwrap(encoder.event(x: 2, y: 3, phase: phase))
            let native = try XCTUnwrap(NSEvent(cgEvent: event))
            XCTAssertEqual(native.phase, contact); XCTAssertEqual(native.momentumPhase, momentum)
            XCTAssertEqual(event.getIntegerValueField(.scrollWheelEventScrollPhase), rawContact)
            XCTAssertEqual(event.getIntegerValueField(.scrollWheelEventMomentumPhase), rawMomentum)
            XCTAssertTrue(native.hasPreciseScrollingDeltas)
            XCTAssertEqual(native.scrollingDeltaX, 2); XCTAssertEqual(native.scrollingDeltaY, 3)
        }
    }
    func testQuartzRetainsSubpixelScrollAndZeroLifecycle() throws {
        var encoder = QuartzScrollEncoder()
        XCTAssertNotNil(encoder.event(x: 0, y: 0, phase: .began))
        for _ in 0..<3 { XCTAssertNil(encoder.event(x: 0, y: 0.25, phase: .changed)) }
        let event = try XCTUnwrap(encoder.event(x: 0, y: 0.25, phase: .changed))
        XCTAssertEqual(NSEvent(cgEvent: event)?.scrollingDeltaY, 1)
        XCTAssertNotNil(encoder.event(x: 0, y: 0, phase: .ended))
        XCTAssertNotNil(encoder.event(x: 0, y: 0, phase: .momentumBegan))
        XCTAssertNotNil(encoder.event(x: 0, y: 0, phase: .momentumEnded))
    }
    #endif
}
