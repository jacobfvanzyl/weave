import XCTest
@testable import TrackpadCore

final class CoreTests: XCTestCase {
    let upper = DisplayInfo(id: 1, name: "Upper", x: -120, y: -1440, width: 2560, height: 1440)
    let lower = DisplayInfo(id: 2, name: "Built-in", x: 0, y: 0, width: 1470, height: 956)
    func testFragmentedAndAdjacentFrames() throws {
        let id = UUID(), a = try Frames.encode(WireMessage(.hello, session: UUID()))
        let b = try Frames.encode(WireMessage(.heartbeat, session: id))
        var decoder = FrameDecoder()
        XCTAssertTrue(try decoder.append(a.prefix(2)).isEmpty)
        let decoded = try decoder.append(a.dropFirst(2) + b)
        XCTAssertEqual(decoded.count, 2)
        XCTAssertEqual(decoded.last?.session, id)
        XCTAssertEqual(try decoder.append(b).count, 1)
    }
    func testRejectOversizedAndUnknownProtocol() throws {
        var decoder = FrameDecoder()
        XCTAssertThrowsError(try decoder.append(Data([0, 2, 0, 0])))
        decoder = FrameDecoder()
        var message = WireMessage(.hello, session: UUID()); message.version = 999
        XCTAssertThrowsError(try decoder.append(Frames.encode(message)))
    }
    func testNegativeScreenOriginAndCorners() {
        XCTAssertEqual(upper.point(u: 0, v: 0), Point(x: -120, y: -1440))
        XCTAssertEqual(upper.point(u: 1, v: 1), Point(x: 2439, y: -1))
        let area = TabletArea.fitted(width: 1000, height: 1000, aspect: 2)
        XCTAssertEqual(area.origin, Point(x: 0, y: 250))
        XCTAssertEqual(area.size, Point(x: 1000, y: 500))
    }
    func testSqueezeReleasesAndRequiresLiftAcrossGenerations() {
        var session = InputSession(displays: [upper, lower])
        XCTAssertEqual(session.handle(InputSample(sequence: 1, generation: 1, action: .penDown, x: 0.5, y: 0.5)).count, 1)
        let effects = session.handle(InputSample(sequence: 2, generation: 1, action: .nextDisplay))
        XCTAssertEqual(effects, [.absolute(upper.point(u: 0.5, v: 0.5), contact: .up), .mapping(lower, generation: 2)])
        XCTAssertTrue(session.handle(InputSample(sequence: 3, generation: 1, action: .penMove)).isEmpty)
        XCTAssertTrue(session.handle(InputSample(sequence: 4, generation: 2, action: .penDown)).isEmpty)
        _ = session.handle(InputSample(sequence: 5, generation: 1, action: .penUp))
        XCTAssertEqual(session.handle(InputSample(sequence: 6, generation: 2, action: .penDown)).count, 1)
        XCTAssertEqual(session.release().count, 1)
        XCTAssertTrue(session.release().isEmpty)
    }
    func testDuplicateStaleAndNonfiniteInputCannotPress() {
        var session = InputSession(displays: [lower])
        _ = session.handle(InputSample(sequence: 1, generation: 1, action: .move))
        XCTAssertTrue(session.handle(InputSample(sequence: 1, generation: 1, action: .dragBegin)).isEmpty)
        XCTAssertTrue(session.handle(InputSample(sequence: 2, generation: 0, action: .dragBegin)).isEmpty)
        XCTAssertTrue(session.handle(InputSample(sequence: 3, generation: 1, action: .dragBegin, x: .infinity)).isEmpty)
        XCTAssertTrue(session.release().isEmpty)
    }
    func testDisconnectReleasesDragAndScrollAndTopologyCancelsPen() {
        var session = InputSession(displays: [upper, lower])
        _ = session.handle(InputSample(sequence: 1, generation: 1, action: .dragBegin))
        XCTAssertEqual(session.release(), [.button(down: false, secondary: false, count: 1)])
        _ = session.handle(InputSample(sequence: 2, generation: 1, action: .scrollBegin))
        XCTAssertEqual(session.release(), [.scroll(0, 0, phase: .ended)])
        _ = session.handle(InputSample(sequence: 3, generation: 1, action: .penDown))
        XCTAssertEqual(session.replaceDisplays([lower]).first, .absolute(upper.point(u: 0, v: 0), contact: .up))
        XCTAssertEqual(session.selected, lower)
    }
    func testTwoFingerTapCannotBecomeLeftClickOrMotionAfterFirstLift() {
        var recognizer = FingerGestures()
        let a = Finger(id: 1, x: 20, y: 20), b = Finger(id: 2, x: 40, y: 20)
        _ = recognizer.begin([a], time: 0)
        _ = recognizer.begin([b], time: 0.01)
        XCTAssertEqual(recognizer.end([a], time: 0.1), [GestureOutput(.secondaryClick), GestureOutput(.contactEnd, count: 1)])
        XCTAssertTrue(recognizer.move([Finger(id: 2, x: 60, y: 20)], time: 0.2).isEmpty)
        XCTAssertEqual(recognizer.end([b], time: 0.25), [GestureOutput(.contactEnd, count: 0)])
    }
    func testScrollSuppressesTapAndCancellationReleases() {
        var recognizer = FingerGestures()
        _ = recognizer.begin([Finger(id: 1, x: 0, y: 0), Finger(id: 2, x: 20, y: 0)], time: 0)
        let moved = recognizer.move([Finger(id: 1, x: 0, y: 20), Finger(id: 2, x: 20, y: 20)], time: 0.1)
        XCTAssertEqual(moved.map(\.action), [.scrollBegin, .scrollMove])
        let ended = recognizer.end([Finger(id: 1, x: 0, y: 20)], time: 0.2)
        XCTAssertTrue(ended.contains { $0.action == .scrollEnd })
        XCTAssertFalse(ended.contains { $0.action == .secondaryClick })
        XCTAssertEqual(recognizer.cancel(), [GestureOutput(.reset)])
    }
    func testDoubleTapStartsAndEndsDrag() {
        var recognizer = FingerGestures()
        var session = InputSession(displays: [lower])
        var sequence: UInt64 = 0
        func deliver(_ outputs: [GestureOutput], time: Double) -> [InputEffect] {
            outputs.flatMap { output in
                sequence += 1
                return session.handle(InputSample(sequence: sequence, generation: 1, action: output.action,
                                                 x: output.x, y: output.y, time: time, count: output.count))
            }
        }
        let a = Finger(id: 1, x: 0, y: 0)
        XCTAssertTrue(deliver(recognizer.begin([a], time: 0), time: 0).isEmpty)
        XCTAssertEqual(deliver(recognizer.end([a], time: 0.1), time: 0.1),
                       [.button(down: true, secondary: false, count: 1), .button(down: false, secondary: false, count: 1)])
        // Mac interval is 0.5s; this would fail the former mobile 0.3s cutoff.
        XCTAssertEqual(deliver(recognizer.begin([a], time: 0.5), time: 0.5), [.button(down: true, secondary: false, count: 2)])
        let movement = deliver(recognizer.move([Finger(id: 1, x: 30, y: 0)], time: 0.6), time: 0.6)
        guard case .relative(_, _, dragging: true) = movement.first else { return XCTFail("Second contact must drag") }
        XCTAssertEqual(deliver(recognizer.end([a], time: 0.7), time: 0.7), [.button(down: false, secondary: false, count: 2)])
    }
    func testDisplayChangeBetweenStrokesDoesNotEatNextContact() {
        var session = InputSession(displays: [upper])
        _ = session.replaceDisplays([lower])
        XCTAssertEqual(session.handle(InputSample(sequence: 1, generation: 2, action: .penDown)).count, 1)
    }
    func testDoubleClickReleaseKeepsClickCount() {
        var session = InputSession(displays: [lower])
        _ = session.handle(InputSample(sequence: 1, generation: 1, action: .dragBegin, count: 2))
        XCTAssertEqual(session.handle(InputSample(sequence: 2, generation: 1, action: .dragEnd)),
                       [.button(down: false, secondary: false, count: 2)])
    }

}
