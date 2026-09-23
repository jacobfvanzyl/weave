import TrackpadCore
import SwiftUI

@main
struct TrackpadMobileApp: App {
    @StateObject private var model = MobileModel()
    @Environment(\.scenePhase) private var phase
    @State private var showConnection = false
    // 128 × 80 mm, the 13-inch Air's trackpad proportions. See UI acceptance notes.
    private let surfaceAspect = 1.6
    var body: some Scene {
        WindowGroup {
            NavigationStack {
                GeometryReader { geometry in
                    // Preserve the ratio in unusually short windows (e.g. iPhone
                    // landscape); otherwise the input surface uses the full width.
                    let width = min(geometry.size.width, max(0, geometry.size.height) * surfaceAspect)
                    TouchSurface(model: model)
                        .frame(width: width, height: width / surfaceAspect)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                .ignoresSafeArea(.container, edges: .bottom)
                .background(Color(red: 0.035, green: 0.05, blue: 0.065))
                .navigationTitle("")
                .navigationBarTitleDisplayMode(.inline)
                .toolbarBackground(.hidden, for: .navigationBar)
                .toolbar {
                    // Native bar placement reserves room for iPad window controls.
                    ToolbarItem(placement: .topBarLeading) {
                        Button { showConnection = true } label: {
                            HStack(spacing: 8) {
                                Circle().fill(model.connected ? Color.mint : Color.orange).frame(width: 7, height: 7)
                                Label("USB", systemImage: "cable.connector").font(.subheadline.weight(.medium))
                            }
                        }
                        .accessibilityLabel("USB connection")
                        .accessibilityValue(model.status)
                        .popover(isPresented: $showConnection) {
                            VStack(alignment: .leading, spacing: 12) {
                                Text(model.status)
                                if model.automaticPaused { Button("Reconnect") { model.resumeConnection(); showConnection = false } }
                                if let display = model.display { Label(display.name, systemImage: "display") }
                            }.font(.callout).padding(20)
                                .presentationCompactAdaptation(.popover)
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        if model.connected {
                            Button { model.disconnect() } label: {
                                Image(systemName: "xmark")
                            }.accessibilityLabel("Disconnect").accessibilityIdentifier("trackpad.disconnect")
                        }
                    }
                }
                .tint(.secondary)
            }
            .preferredColorScheme(.dark)
            .alert("Pair with \(model.approval ?? "Mac")?", isPresented: Binding(get: { model.approval != nil }, set: { if !$0 && model.approval != nil { model.disconnect() } })) {
                Button("Pair and connect") { model.approve() }
                Button("Cancel", role: .cancel) { model.disconnect() }
            } message: { Text("Allow this Mac to reconnect automatically and start control whenever this app is open over USB. You can pause or disconnect at any time.") }
            .onAppear { model.start() }
            .onChange(of: phase) { _, value in if value == .active { model.start() } else { model.stop() } }
        }
    }
}
