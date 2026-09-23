import TrackpadCore
import SwiftUI

@main
struct TrackpadMacApp: App {
    @StateObject private var model = MacModel()
    var body: some Scene {
        WindowGroup("Trackpad") {
            VStack(alignment: .leading, spacing: 20) {
                Label("Trackpad", systemImage: "hand.draw.fill").font(.largeTitle.bold())
                Text(model.status).foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                if !model.connected {
                    HStack {
                        ForEach(model.devices) { device in
                            Button("Connect \(model.deviceLabel(device))") { Task { await model.connect(device) } }.disabled(model.busy)
                        }
                        Button("Refresh USB") { Task { await model.refresh() } }.disabled(model.busy)
                    }
                    Text("Paired USB devices reconnect and start control when their app opens. Connect a new device once to pair it.").font(.callout).fixedSize(horizontal: false, vertical: true)
                } else {
                    LabeledContent("Pencil display", value: model.selectedName)
                    Toggle("Enable Mac control", isOn: Binding(get: { model.controlEnabled }, set: { model.enableControl($0) }))
                        .disabled(!model.canEnableControl)
                    HStack {
                        Button("Release input") { model.enableControl(false) }
                        Button("Disconnect", role: .destructive) { model.disconnect() }
                    }
                }
                if model.pairedCount > 0 {
                    HStack {
                        Text("\(model.pairedCount) paired \(model.pairedCount == 1 ? "device" : "devices")").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        if model.automaticPaused {
                            Button("Resume automatic connections") { model.resumeAutomaticConnections() }
                        }
                        Menu("Pairing") {
                            ForEach(model.devices) { device in
                                Button("Forget \(model.deviceLabel(device))") { model.forgetDevice(device) }
                            }
                        }
                    }
                }
                if !model.trusted {
                    Button("Allow Accessibility…") { model.requestAccessibility() }
                    Text("macOS requires Accessibility permission for Trackpad to move the pointer and click. The USB link can be tested without it.").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                Divider()
                VStack(alignment: .leading, spacing: 12) {
                    Text("Motion").font(.headline)
                    HStack {
                        Text("Pointer speed").frame(width: 100, alignment: .leading)
                        Slider(value: Binding(get: { model.motion.pointerSpeed }, set: { value in model.updateMotion { $0.pointerSpeed = value } }), in: 0.25...3)
                        Text(model.motion.pointerSpeed.formatted(.number.precision(.fractionLength(1))) + "×").monospacedDigit().frame(width: 40)
                    }
                    Toggle("Pointer acceleration", isOn: Binding(get: { model.motion.acceleration }, set: { value in model.updateMotion { $0.acceleration = value } }))
                    HStack {
                        Text("Scroll speed").frame(width: 100, alignment: .leading)
                        Slider(value: Binding(get: { model.motion.scrollSpeed }, set: { value in model.updateMotion { $0.scrollSpeed = value } }), in: 0.25...3)
                        Text(model.motion.scrollSpeed.formatted(.number.precision(.fractionLength(1))) + "×").monospacedDigit().frame(width: 40)
                    }
                    Toggle("Natural scrolling", isOn: Binding(get: { model.motion.naturalScrolling }, set: { value in model.updateMotion { $0.naturalScrolling = value } }))
                    Toggle("Scroll momentum", isOn: Binding(get: { model.motion.momentum }, set: { value in model.updateMotion { $0.momentum = value } }))
                    HStack {
                        MotionTestButton()
                        Button("Reset motion") { model.updateMotion { $0 = MotionSettings() } }
                    }
                    Text("These settings apply to finger input. Pencil mapping stays absolute.").font(.caption).foregroundStyle(.secondary)
                }
                Divider()
                HStack(spacing: 30) {
                    metric("Received", model.received)
                    metric("Posted", model.posted)
                    metric("Heartbeats", model.heartbeats)
                }
                Text("USB preview · Wi-Fi is still in development.").font(.caption).foregroundStyle(.secondary)
            }
            .padding(28).frame(width: 480)
        }.windowResizability(.contentSize)
        Window("Motion test", id: "motion-test") {
            MotionTestPanel()
        }.defaultSize(width: 850, height: 650)
        MenuBarExtra("Trackpad", systemImage: model.connected ? "hand.draw.fill" : "hand.draw") {
            Text(model.status)
            Button("Release input and disconnect") { model.disconnect() }.keyboardShortcut(".")
            Button("Quit Trackpad") { model.disconnect(); NSApplication.shared.terminate(nil) }
        }
    }
    private func metric(_ title: String, _ value: Int) -> some View {
        VStack(alignment: .leading) { Text(value.formatted()).font(.title2.monospacedDigit()); Text(title).font(.caption).foregroundStyle(.secondary) }
    }
}
