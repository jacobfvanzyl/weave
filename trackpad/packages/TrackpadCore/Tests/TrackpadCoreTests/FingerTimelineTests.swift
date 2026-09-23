import XCTest
@testable import TrackpadCore

final class FingerTimelineTests: XCTestCase {
    private func sample(_ id: Int = 1, _ x: Double, _ time: Double) -> TimedFinger {
        TimedFinger(Finger(id: id, x: x, y: 0), time: time)
    }
    func testOrdersAndGroupsTwoFingerHistoryWithoutMixingFuturePositions() {
        var timeline = FingerTimeline()
        timeline.boundary(at: 0)
        let frames = timeline.frames([sample(2, 24, 0.02), sample(1, 2, 0.01), sample(2, 22, 0.01), sample(1, 4, 0.02)])
        XCTAssertEqual(frames.map(\.time), [0.01, 0.02])
        XCTAssertEqual(frames[0].fingers.map(\.id), [1, 2])
        XCTAssertEqual(frames[0].fingers.map(\.point.x), [2, 22])
        XCTAssertEqual(frames[1].fingers.map(\.point.x), [4, 24])
    }
    func testDuplicateEndpointsAndStaleSamplesCannotReplayMotion() {
        var timeline = FingerTimeline()
        timeline.boundary(at: 1)
        let frames = timeline.frames([sample(1, 1, 0.99), sample(1, 2, 1), sample(1, 3, 1.01), sample(1, 3, 1.01)])
        XCTAssertEqual(frames.count, 1); XCTAssertEqual(frames[0].fingers.count, 1)
        XCTAssertTrue(timeline.frames([sample(1, 3, 1.01), sample(1, 2, 1)]).isEmpty)
        XCTAssertTrue(timeline.frames([sample(1, .nan, 2), sample(1, 5, .infinity)]).isEmpty)
        timeline.boundary(at: 3)
        XCTAssertEqual(timeline.frames([sample(2, 5, 2.9), sample(2, 6, 3.01)]).map(\.time), [3.01])
    }
    func testCoalescedExcursionAndReturnDoesNotTurnIntoTap() {
        var timeline = FingerTimeline(), gestures = FingerGestures()
        _ = gestures.begin([Finger(id: 1, x: 0, y: 0)], time: 0)
        timeline.boundary(at: 0)
        let motion = timeline.frames([sample(1, 10, 0.01), sample(1, 0, 0.02)]).flatMap {
            gestures.move($0.fingers, time: $0.time)
        }
        XCTAssertEqual(motion, [GestureOutput(.move, x: 10), GestureOutput(.move, x: -10)])
        XCTAssertEqual(gestures.end([Finger(id: 1, x: 0, y: 0)], time: 0.03), [GestureOutput(.contactEnd, count: 0)])
    }
    func testTwoFingerThresholdConservesDistanceAcrossSampleDensities() {
        func scroll(positions: [Double]) -> Double {
            var gestures = FingerGestures()
            _ = gestures.begin([Finger(id: 1, x: 0, y: 0), Finger(id: 2, x: 20, y: 0)], time: 0)
            return positions.enumerated().flatMap { index, x in
                gestures.move([Finger(id: 1, x: x, y: 0), Finger(id: 2, x: 20 + x, y: 0)], time: Double(index + 1) * 0.01)
            }.filter { $0.action == .scrollMove }.reduce(0) { $0 + $1.x }
        }
        XCTAssertEqual(scroll(positions: [2, 4, 6, 8, 10]), 10)
        XCTAssertEqual(scroll(positions: [10]), 10)
    }
    func testStationaryFingerAndUnequalHistoriesPreserveCentroidDisplacement() {
        var timeline = FingerTimeline(), gestures = FingerGestures()
        _ = gestures.begin([Finger(id: 1, x: 0, y: 0), Finger(id: 2, x: 20, y: 0)], time: 0)
        timeline.boundary(at: 0)
        let effects = timeline.frames([sample(1, 8, 0.01), sample(2, 28, 0.015), sample(1, 16, 0.02)]).flatMap {
            gestures.move($0.fingers, time: $0.time)
        }
        XCTAssertEqual(effects.filter { $0.action == .scrollBegin }.count, 1)
        XCTAssertEqual(effects.filter { $0.action == .scrollMove }.reduce(0) { $0 + $1.x }, 12)
    }
    func testSecondContactRebasesExistingFingerAndPartialLiftStaysBlocked() {
        var gestures = FingerGestures()
        _ = gestures.begin([Finger(id: 1, x: 0, y: 0)], time: 0)
        _ = gestures.begin([Finger(id: 2, x: 40, y: 0)], time: 0.1, current: [Finger(id: 1, x: 20, y: 0)])
        let effects = gestures.move([Finger(id: 1, x: 28, y: 0), Finger(id: 2, x: 48, y: 0)], time: 0.12)
        XCTAssertEqual(effects, [GestureOutput(.scrollBegin), GestureOutput(.scrollMove, x: 8)])
        XCTAssertEqual(gestures.end([Finger(id: 2, x: 48, y: 0)], time: 0.13),
                       [GestureOutput(.scrollEnd), GestureOutput(.contactEnd, count: 1)])
        XCTAssertTrue(gestures.move([Finger(id: 1, x: 80, y: 0)], time: 0.14).isEmpty)
    }
    func testBatchingDoesNotChangePointerAccelerationOrScrollMomentum() {
        func run(fingerCount: Int, batched: Bool) -> [InputEffect] {
            var timeline = FingerTimeline(), gestures = FingerGestures(), host = InputSession(displays: [])
            var sequence: UInt64 = 0
            func deliver(_ outputs: [GestureOutput], time: Double) -> [InputEffect] {
                outputs.flatMap { output in
                    sequence += 1
                    return host.handle(InputSample(sequence: sequence, generation: 1, action: output.action,
                                                   x: output.x, y: output.y, time: time, count: output.count), now: 100)
                }
            }
            let initial = (1...fingerCount).map { Finger(id: $0, x: Double($0 * 20), y: 0) }
            _ = deliver(gestures.begin(initial, time: 0), time: 0)
            timeline.boundary(at: 0)
            let samples = (1...12).flatMap { frame in
                (1...fingerCount).map { sample($0, Double($0 * 20 + frame * 3), Double(frame) / 240) }
            }
            let batches = batched ? [samples] : stride(from: 0, to: samples.count, by: fingerCount).map {
                Array(samples[$0..<($0 + fingerCount)])
            }
            var result: [InputEffect] = []
            for batch in batches {
                for frame in timeline.frames(batch) { result += deliver(gestures.move(frame.fingers, time: frame.time), time: frame.time) }
            }
            result += deliver(gestures.end(initial, time: 0.055), time: 0.055)
            result += host.tick(now: 100.01)
            return result
        }
        for count in [1, 2] {
            let result = run(fingerCount: count, batched: true)
            XCTAssertEqual(result, run(fingerCount: count, batched: false))
            XCTAssertGreaterThan(result.count, 10)
            if count == 2 { XCTAssertTrue(result.contains(.scroll(0, 0, phase: .momentumBegan))) }
        }
    }
    func testMetricsDistinguishCallbackCadenceFromSampleCadenceAndBoundStorage() {
        var metrics = FingerCaptureMetrics()
        for callback in 1...600 {
            let now = Double(callback) / 60
            metrics.record(callbackTime: now + 0.001, rawSamples: 8,
                           frameTimes: (0..<4).map { now - Double(3 - $0) / 240 }, processingSeconds: 0.0002)
        }
        let snapshot = metrics.snapshot
        XCTAssertEqual(snapshot.callbacks, 600); XCTAssertEqual(snapshot.deliveredSampleFrames, 2400)
        XCTAssertEqual(snapshot.rawTouchSamples, 4800); XCTAssertEqual(snapshot.callbacksWithExtraFrames, 600)
        XCTAssertEqual(snapshot.maximumFramesPerCallback, 4)
        XCTAssertEqual(snapshot.sampleInterval.count, 512)
        XCTAssertEqual(snapshot.callbackInterval.medianMilliseconds!, 1000.0 / 60, accuracy: 0.0001)
        XCTAssertEqual(snapshot.sampleInterval.medianMilliseconds!, 1000.0 / 240, accuracy: 0.0001)
        XCTAssertEqual(snapshot.newestSampleAge.medianMilliseconds!, 1, accuracy: 0.0001)
        metrics.boundary()
        metrics.record(callbackTime: 100, rawSamples: 1, frameTimes: [100], processingSeconds: 0.0002)
        XCTAssertEqual(metrics.snapshot.sampleInterval.p95Milliseconds!, 1000.0 / 240, accuracy: 0.0001)
    }
}
