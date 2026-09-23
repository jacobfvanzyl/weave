import TrackpadCore
import UIKit
import SwiftUI

struct TouchSurface: UIViewRepresentable {
    @ObservedObject var model: MobileModel
    func makeUIView(context: Context) -> CaptureView { CaptureView(model: model) }
    func updateUIView(_ view: CaptureView, context: Context) { view.update() }
}

@MainActor
final class CaptureView: UIView, UIPencilInteractionDelegate {
    private let model: MobileModel
    private var recognizer = FingerGestures()
    private var fingerTimeline = FingerTimeline()
    private var fingerMetrics = FingerCaptureMetrics()
    private let metricsWriter = DispatchQueue(label: "Trackpad.finger-metrics", qos: .utility)
    private var lastMetricsSave = 0.0
    private var tool = InputTool()
    private var ids: [ObjectIdentifier: Int] = [:]
    private var nextID = 0
    private var revision = -1
    private var pencilTouch: UITouch?
    private var penSuppressed = false
    private var oldSize = CGSize.zero
    private var activeArea = CGRect.zero
    private var updateLink: UIUpdateLink?
    private let hoverDot = CAShapeLayer()
    init(model: MobileModel) {
        self.model = model
        super.init(frame: .zero)
        isMultipleTouchEnabled = true
        backgroundColor = UIColor(red: 0.065, green: 0.085, blue: 0.105, alpha: 1)
        layer.cornerRadius = 24; clipsToBounds = true
        // A local tip preview, independent of the Mac round trip. Keep the
        // layer out of hit testing and disable implicit animation on updates.
        hoverDot.bounds = CGRect(x: 0, y: 0, width: 6, height: 6)
        hoverDot.path = UIBezierPath(ovalIn: hoverDot.bounds).cgPath
        hoverDot.fillColor = UIColor.white.cgColor
        hoverDot.strokeColor = UIColor.black.withAlphaComponent(0.65).cgColor
        hoverDot.lineWidth = 0.75
        hoverDot.isHidden = true
        layer.addSublayer(hoverDot)
        let updateLink = UIUpdateLink(view: self)
        updateLink.wantsLowLatencyEventDispatch = true
        updateLink.isEnabled = true
        self.updateLink = updateLink
        addInteraction(UIPencilInteraction(delegate: self))
        let hover = UIHoverGestureRecognizer(target: self, action: #selector(hovered(_:)))
        hover.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.pencil.rawValue)]
        addGestureRecognizer(hover)
        accessibilityLabel = "Trackpad input surface"
        accessibilityIdentifier = "trackpad.surface"
    }
    required init?(coder: NSCoder) { fatalError("Use init(model:)") }
    func update() {
        if revision != model.mappingRevision {
            revision = model.mappingRevision
            cancel()
            if !model.connected {
                tool = InputTool(); ids.removeAll()
                pencilTouch = nil; penSuppressed = false
            }
        }
        setNeedsLayout()
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        if oldSize != bounds.size { cancel(); oldSize = bounds.size }
        activeArea = bounds
    }
    private func cancel() {
        showHoverDot(at: nil)
        _ = recognizer.cancel()
        fingerTimeline = FingerTimeline(); fingerMetrics.boundary()
        tool.interrupt()
        // Keep physical identities until lift. A resting palm cannot become a
        // fresh gesture after a mapping, geometry, or mode change.
        penSuppressed = pencilTouch != nil
        model.send(.reset)
    }
    private func toolChanged(from previous: InputTool.Mode) {
        guard tool.mode != previous else { return }
        showHoverDot(at: nil)
        _ = recognizer.cancel()
        fingerTimeline = FingerTimeline(); fingerMetrics.boundary()
        model.send(.reset)
        model.reportPencilMode(tool.mode == .pencil)
        accessibilityLabel = tool.mode == .pencil ? "Pencil input surface" : "Trackpad input surface"
    }
    private func finger(_ touch: UITouch) -> Finger {
        let key = ObjectIdentifier(touch)
        if ids[key] == nil { nextID += 1; ids[key] = nextID }
        let point = touch.location(in: self)
        return Finger(id: ids[key]!, x: point.x, y: point.y)
    }
    private func outputs(_ values: [GestureOutput], time: Double = 0) {
        for value in values { model.send(value.action, x: value.x, y: value.y, time: time, count: value.count) }
    }
    private func pen(_ action: InputAction, touch: UITouch) {
        guard activeArea.width > 0, activeArea.height > 0 else { return }
        let point = touch.location(in: self)
        model.send(action, x: min(max((point.x - activeArea.minX) / activeArea.width, 0), 1),
                   y: min(max((point.y - activeArea.minY) / activeArea.height, 0), 1), time: touch.timestamp)
    }
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard model.connected else { return }
        if let touch = touches.first(where: { $0.type == .pencil }), pencilTouch == nil {
            let previous = tool.mode
            tool.beginPencil(); toolChanged(from: previous)
            pencilTouch = touch
            showHoverDot(at: nil)
            penSuppressed = !activeArea.contains(touch.location(in: self))
            if !penSuppressed { pen(.penDown, touch: touch) }
        }
        let fingers = touches.filter { $0.type == .direct }.map(finger)
        if !fingers.isEmpty {
            let previous = tool.mode
            let accepted = Set(tool.beginFingers(fingers.map(\.id)))
            toolChanged(from: previous)
            let fresh = fingers.filter { accepted.contains($0.id) }
            if !fresh.isEmpty {
                let time = event?.timestamp ?? ProcessInfo.processInfo.systemUptime
                fingerTimeline.boundary(at: time); fingerMetrics.boundary()
                let current = (event?.allTouches ?? []).compactMap { touch -> Finger? in
                    guard touch.type == .direct, let id = ids[ObjectIdentifier(touch)], tool.accepts(id),
                          touch.phase != .ended, touch.phase != .cancelled else { return nil }
                    let point = touch.location(in: self)
                    return Finger(id: id, x: point.x, y: point.y)
                }
                outputs(recognizer.begin(fresh, time: time, current: current), time: time)
            }
        }
    }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard model.connected else { return }
        if let touch = pencilTouch, touches.contains(touch), !penSuppressed {
            for sample in event?.coalescedTouches(for: touch) ?? [touch] { pen(.penMove, touch: sample) }
        }
        let started = ProcessInfo.processInfo.systemUptime
        var samples: [TimedFinger] = []
        for touch in touches where touch.type == .direct {
            guard let id = ids[ObjectIdentifier(touch)], tool.accepts(id) else { continue }
            let history = event?.coalescedTouches(for: touch) ?? []
            // Coalesced objects are sample snapshots, not new contacts. The
            // original touch owns their ID. Preserve UIKit's capture timestamps.
            for sample in history {
                let point = sample.location(in: self)
                samples.append(TimedFinger(Finger(id: id, x: point.x, y: point.y), time: sample.timestamp))
            }
            if !history.contains(where: { $0.timestamp == touch.timestamp }) {
                let point = touch.location(in: self)
                samples.append(TimedFinger(Finger(id: id, x: point.x, y: point.y), time: touch.timestamp))
            }
        }
        guard !samples.isEmpty else { return }
        let frames = fingerTimeline.frames(samples)
        for frame in frames { outputs(recognizer.move(frame.fingers, time: frame.time), time: frame.time) }
        fingerMetrics.record(callbackTime: started, rawSamples: samples.count, frameTimes: frames.map(\.time),
                             processingSeconds: ProcessInfo.processInfo.systemUptime - started)
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        if let touch = pencilTouch, touches.contains(touch) {
            model.send(.penUp, time: touch.timestamp)
            pencilTouch = nil; penSuppressed = false; tool.endPencil()
        }
        let fingers = touches.filter { $0.type == .direct }.map(finger)
        let accepted = fingers.filter { tool.accepts($0.id) }
        if !accepted.isEmpty { outputs(recognizer.end(accepted, time: event?.timestamp ?? 0), time: event?.timestamp ?? 0) }
        if !accepted.isEmpty {
            fingerTimeline.boundary(at: event?.timestamp ?? ProcessInfo.processInfo.systemUptime)
            fingerMetrics.boundary(); saveFingerMetrics()
        }
        tool.endFingers(fingers.map(\.id))
        for touch in touches { ids.removeValue(forKey: ObjectIdentifier(touch)) }
    }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        cancel()
        if let touch = pencilTouch, touches.contains(touch) {
            pencilTouch = nil; penSuppressed = false; tool.endPencil()
        }
        let fingers = touches.filter { $0.type == .direct }.map(finger)
        tool.endFingers(fingers.map(\.id))
        for touch in touches { ids.removeValue(forKey: ObjectIdentifier(touch)) }
    }
    @objc private func hovered(_ gesture: UIHoverGestureRecognizer) {
        let inRange = gesture.state == .began || gesture.state == .changed
        let previous = tool.mode
        tool.hover(inRange); toolChanged(from: previous)
        guard model.connected, inRange, pencilTouch == nil else { showHoverDot(at: nil); return }
        let point = gesture.location(in: self)
        guard activeArea.width > 0, activeArea.height > 0, activeArea.contains(point) else { showHoverDot(at: nil); return }
        showHoverDot(at: point, distance: gesture.zOffset)
        model.send(.penHover, x: (point.x - activeArea.minX) / activeArea.width, y: (point.y - activeArea.minY) / activeArea.height,
                   time: ProcessInfo.processInfo.systemUptime)
    }
    private func saveFingerMetrics() {
        let now = ProcessInfo.processInfo.systemUptime
        guard now - lastMetricsSave >= 1 else { return }
        lastMetricsSave = now
        let metrics = fingerMetrics
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("finger-input-diagnostics.json")
        // Sorting, JSON encoding, and disk I/O never run in the input callback.
        metricsWriter.async {
            do {
                let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                encoder.dateEncodingStrategy = .iso8601
                try encoder.encode(metrics.snapshot).write(to: url, options: .atomic)
            } catch { NSLog("Finger diagnostics: %@", error.localizedDescription) }
        }
    }
    private func showHoverDot(at point: CGPoint?, distance: CGFloat = 0) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if let point, UIPencilInteraction.prefersHoverToolPreview {
            hoverDot.position = point
            hoverDot.opacity = Float(0.9 - 0.55 * min(max(distance, 0), 1))
            hoverDot.isHidden = false
        } else {
            hoverDot.isHidden = true
        }
        CATransaction.commit()
    }
    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { showHoverDot(at: nil) }
    }
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze) {
        guard model.pencilMode, model.connected, squeeze.phase == .ended else { return }
        if model.displayCount > 1 { penSuppressed = pencilTouch != nil }
        model.send(.nextDisplay, time: squeeze.timestamp)
    }
}
