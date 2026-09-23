import AppKit
import SwiftUI

struct MotionTestButton: View {
    @Environment(\.openWindow) private var openWindow
    var body: some View { Button("Open motion test") { openWindow(id: "motion-test") } }
}

struct MotionTestPanel: View {
    @StateObject private var trace = MotionTrace()
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Compare the built-in trackpad with your iPad or iPhone on this native scroll view.").font(.headline)
            Text("Try slow targeting, fast travel, diagonal scrolling, a flick, and a touch to stop momentum.").foregroundStyle(.secondary)
            HStack {
                Button(trace.recording ? "Stop and save recording" : "Record local input") { trace.toggle() }
                if let url = trace.savedURL { Button("Show recording") { NSWorkspace.shared.activateFileViewerSelecting([url]) } }
                Text(trace.status).font(.caption).foregroundStyle(.secondary)
            }
            Text("Recording includes only pointer and scroll events inside the grid. No keystrokes.").font(.caption).foregroundStyle(.secondary)
            MotionTestView(trace: trace)
        }.padding(20).frame(minWidth: 650, minHeight: 500)
        .onDisappear { trace.stop() }
    }
}

@MainActor
final class MotionTrace: ObservableObject {
    @Published private(set) var recording = false
    @Published private(set) var status = "Not recording"
    @Published private(set) var savedURL: URL?
    private var samples: [[String: Any]] = []
    private var lastReport = 0.0
    func toggle() {
        if recording { stop(); return }
        samples = []; savedURL = nil; recording = true; status = "Recording…"; lastReport = 0
    }
    func record(_ event: NSEvent) {
        guard recording else { return }
        let isScroll = event.type == .scrollWheel
        samples.append([
            "time": event.timestamp, "type": String(describing: event.type),
            "source": event.cgEvent?.getIntegerValueField(.eventSourceUserData) == MacInputPoster.sourceTag ? "weave" : "reference-or-other",
            "x": event.locationInWindow.x, "y": event.locationInWindow.y,
            "deltaX": isScroll ? event.scrollingDeltaX : event.deltaX,
            "deltaY": isScroll ? event.scrollingDeltaY : event.deltaY,
            "phase": isScroll ? event.phase.rawValue : 0,
            "momentumPhase": isScroll ? event.momentumPhase.rawValue : 0,
            "precise": isScroll && event.hasPreciseScrollingDeltas
        ])
        if event.timestamp - lastReport > 0.25 { status = "\(samples.count) events"; lastReport = event.timestamp }
        if samples.count >= 10_000 { stop() }
    }
    func stop() {
        guard recording else { return }; recording = false
        do {
            let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("WeaveTrackpad/MotionTraces")
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent("motion-\(UUID().uuidString).json")
            let object: [String: Any] = ["createdAt": ISO8601DateFormatter().string(from: Date()),
                "os": ProcessInfo.processInfo.operatingSystemVersionString,
                "doubleClickInterval": NSEvent.doubleClickInterval,
                "displays": NSScreen.screens.map { ["name": $0.localizedName, "maximumFramesPerSecond": $0.maximumFramesPerSecond] as [String: Any] },
                "events": samples]
            try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]).write(to: url, options: .atomic)
            savedURL = url; status = "Saved \(samples.count) events"
        } catch { status = "Could not save: \(error.localizedDescription)" }
    }
}

struct MotionTestView: NSViewRepresentable {
    let trace: MotionTrace
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = MotionTestScrollView()
        scroll.trace = trace
        scroll.hasVerticalScroller = true; scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = true
        let document = MotionTestDocument(frame: NSRect(x: 0, y: 0, width: 2000, height: 2400))
        document.trace = trace
        scroll.documentView = document
        return scroll
    }
    func updateNSView(_ view: NSScrollView, context: Context) {}
}

private final class MotionTestScrollView: NSScrollView {
    weak var trace: MotionTrace?
    override func scrollWheel(with event: NSEvent) { trace?.record(event); super.scrollWheel(with: event) }
}

private final class MotionTestDocument: NSView {
    weak var trace: MotionTrace?
    private var pointerTracking: NSTrackingArea?
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let pointerTracking { removeTrackingArea(pointerTracking) }
        let area = NSTrackingArea(rect: .zero, options: [.activeInKeyWindow, .mouseMoved, .inVisibleRect], owner: self)
        addTrackingArea(area); pointerTracking = area
    }
    override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); window?.acceptsMouseMovedEvents = true }
    override func mouseMoved(with event: NSEvent) { trace?.record(event) }
    override var isFlipped: Bool { true }
    private var target = NSPoint(x: 240, y: 240)
    private var dragOffset: NSPoint?
    private var feedback = "Click or double-click the blue target; double-tap and hold to drag it."
    override func draw(_ dirtyRect: NSRect) {
        NSColor.textBackgroundColor.setFill(); dirtyRect.fill()
        NSColor.separatorColor.setStroke()
        let grid = NSBezierPath(); grid.lineWidth = 0.5
        for x in stride(from: 0, through: 2000, by: 80) { grid.move(to: NSPoint(x: x, y: 0)); grid.line(to: NSPoint(x: x, y: 2400)) }
        for y in stride(from: 0, through: 2400, by: 80) { grid.move(to: NSPoint(x: 0, y: y)); grid.line(to: NSPoint(x: 2000, y: y)) }
        grid.stroke()
        let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 16), .foregroundColor: NSColor.labelColor]
        (feedback as NSString).draw(at: NSPoint(x: 24, y: 24), withAttributes: attributes)
        for y in stride(from: 400, through: 2000, by: 400) {
            ("\(y) pt · Scroll vertically, horizontally, or diagonally" as NSString).draw(at: NSPoint(x: 24, y: y + 24), withAttributes: attributes)
        }
        NSColor.systemBlue.setFill()
        NSBezierPath(ovalIn: NSRect(x: target.x - 22, y: target.y - 22, width: 44, height: 44)).fill()
        NSColor.white.setStroke()
        let cross = NSBezierPath()
        cross.move(to: NSPoint(x: target.x - 8, y: target.y)); cross.line(to: NSPoint(x: target.x + 8, y: target.y))
        cross.move(to: NSPoint(x: target.x, y: target.y - 8)); cross.line(to: NSPoint(x: target.x, y: target.y + 8)); cross.stroke()
    }
    override func mouseDown(with event: NSEvent) {
        trace?.record(event)
        let point = convert(event.locationInWindow, from: nil)
        let hit = hypot(point.x - target.x, point.y - target.y) <= 22
        dragOffset = hit ? NSPoint(x: target.x - point.x, y: target.y - point.y) : nil
        feedback = "\(hit ? "Target hit" : "Miss") · click count \(event.clickCount) · (\(Int(point.x)), \(Int(point.y)))"
        needsDisplay = true
    }
    override func mouseDragged(with event: NSEvent) {
        trace?.record(event)
        guard let offset = dragOffset else { return }
        let point = convert(event.locationInWindow, from: nil)
        target = NSPoint(x: point.x + offset.x, y: point.y + offset.y)
        needsDisplay = true
    }
    override func mouseUp(with event: NSEvent) { trace?.record(event); dragOffset = nil }
    override func rightMouseDown(with event: NSEvent) { trace?.record(event); feedback = "Right click received"; needsDisplay = true }
}
