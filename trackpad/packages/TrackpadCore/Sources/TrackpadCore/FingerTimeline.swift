import Foundation

public struct TimedFinger: Sendable {
    public let finger: Finger
    public let time: Double
    public init(_ finger: Finger, time: Double) { self.finger = finger; self.time = time }
}
public struct FingerFrame: Sendable {
    public let fingers: [Finger]
    public let time: Double
}

/// Reconstruct actual sample order across changed fingers. Coalesced UITouch
/// objects must retain their ORIGINAL touch's identity when entering this seam.
/// Simultaneous positions update the centroid together; stationary fingers keep
/// their last position in FingerGestures. No interpolation or prediction.
public struct FingerTimeline: Sendable {
    private var lastTime: Double?
    public init() {}
    public mutating func boundary(at time: Double) {
        guard time.isFinite else { return }
        lastTime = max(lastTime ?? time, time)
    }
    public mutating func frames(_ samples: [TimedFinger]) -> [FingerFrame] {
        var grouped: [Double: [Int: Finger]] = [:]
        for sample in samples {
            guard sample.time.isFinite, sample.finger.point.x.isFinite, sample.finger.point.y.isFinite,
                  lastTime == nil || sample.time > lastTime! else { continue }
            grouped[sample.time, default: [:]][sample.finger.id] = sample.finger
        }
        let frames = grouped.keys.sorted().map { time in
            FingerFrame(fingers: grouped[time]!.values.sorted { $0.id < $1.id }, time: time)
        }
        if let latest = frames.last { lastTime = latest.time }
        return frames
    }
}

/// Bounded timing-only diagnostics. No coordinates or contact identities are
/// retained. Summaries are computed off the capture thread when saved.
public struct FingerCaptureMetrics: Sendable {
    private struct Window: Sendable {
        var values: [Double] = []
        var next = 0
        mutating func add(_ value: Double) {
            guard value.isFinite, value >= 0 else { return }
            if values.count < 512 { values.append(value) }
            else { values[next] = value; next = (next + 1) % 512 }
        }
        var summary: Timing {
            let sorted = values.sorted()
            func percentile(_ p: Double) -> Double? {
                sorted.isEmpty ? nil : sorted[min(sorted.count - 1, Int(Double(sorted.count - 1) * p))] * 1000
            }
            return Timing(count: sorted.count, medianMilliseconds: percentile(0.5), p95Milliseconds: percentile(0.95))
        }
    }
    public struct Timing: Codable, Sendable {
        public let count: Int
        public let medianMilliseconds: Double?
        public let p95Milliseconds: Double?
    }
    public struct Snapshot: Codable, Sendable {
        public let updatedAt: Date
        public let callbacks: Int
        public let rawTouchSamples: Int
        public let deliveredSampleFrames: Int
        public let callbacksWithExtraFrames: Int
        public let maximumFramesPerCallback: Int
        public let callbackInterval: Timing
        public let sampleInterval: Timing
        public let newestSampleAge: Timing
        public let oldestSampleAge: Timing
        public let captureProcessing: Timing
    }
    private var callbacks = 0, rawSamples = 0, frames = 0, extraCallbacks = 0, maximumBatch = 0
    private var previousCallback: Double?, previousSample: Double?
    private var callbackInterval = Window(), sampleInterval = Window()
    private var newestAge = Window(), oldestAge = Window(), processing = Window()
    public init() {}
    public mutating func boundary() { previousCallback = nil; previousSample = nil }
    public mutating func record(callbackTime: Double, rawSamples: Int, frameTimes: [Double], processingSeconds: Double) {
        callbacks += 1; self.rawSamples += rawSamples; frames += frameTimes.count
        if frameTimes.count > 1 { extraCallbacks += 1 }
        maximumBatch = max(maximumBatch, frameTimes.count)
        // Moving intervals only. Contact transitions and long pauses must not
        // turn a nominal cadence into a misleading average across idle time.
        if let previousCallback, (0...0.15).contains(callbackTime - previousCallback) {
            callbackInterval.add(callbackTime - previousCallback)
        }
        previousCallback = callbackTime
        for time in frameTimes {
            if let previousSample, time > previousSample, time - previousSample <= 0.15 {
                sampleInterval.add(time - previousSample)
            }
            previousSample = time
        }
        if let newest = frameTimes.last { newestAge.add(callbackTime - newest) }
        if let oldest = frameTimes.first { oldestAge.add(callbackTime - oldest) }
        processing.add(processingSeconds)
    }
    public var snapshot: Snapshot {
        Snapshot(updatedAt: Date(), callbacks: callbacks, rawTouchSamples: rawSamples, deliveredSampleFrames: frames,
                 callbacksWithExtraFrames: extraCallbacks, maximumFramesPerCallback: maximumBatch,
                 callbackInterval: callbackInterval.summary, sampleInterval: sampleInterval.summary,
                 newestSampleAge: newestAge.summary, oldestSampleAge: oldestAge.summary,
                 captureProcessing: processing.summary)
    }
}
