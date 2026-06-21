import Capacitor
import PencilKit
import UIKit
import WebKit

@objc(WeaveBridgeViewController)
class WeaveBridgeViewController: CAPBridgeViewController, UIPencilInteractionDelegate, PKToolPickerObserver {
    private let doubleSqueezeMaximumInterval: TimeInterval = 0.55
    private let doubleSqueezePaletteDelay: TimeInterval = 0.35
    private let doubleSqueezeTapCancellationInterval: TimeInterval = 0.45
    private let minimumCompletedSqueezeDuration: TimeInterval = 0.45
    private var applePencilInteraction: UIPencilInteraction?
    private var applePencilToolPicker: PKToolPicker?
    private var lastCompletedSqueezeTimestamp: TimeInterval?
    private var lastTapTimestamp: TimeInterval?
    private var currentSqueezeStartedTimestamp: TimeInterval?
    private var pendingDoubleSqueezeTimestamp: TimeInterval?
    private var pendingDoubleSqueezeWorkItem: DispatchWorkItem?

    override func viewDidLoad() {
        super.viewDidLoad()
        installApplePencilInteraction()
    }

    deinit {
        pendingDoubleSqueezeWorkItem?.cancel()
        applePencilToolPicker?.removeObserver(self)
    }

    private func installApplePencilInteraction() {
        guard #available(iOS 17.5, *) else { return }
        guard applePencilInteraction == nil else { return }

        let interaction = UIPencilInteraction(delegate: self)
        webView?.addInteraction(interaction)
        applePencilInteraction = interaction
    }

    @available(iOS 17.5, *)
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveTap tap: UIPencilInteraction.Tap) {
        lastTapTimestamp = tap.timestamp
        cancelPendingDoubleSqueezePaletteIfNeeded(near: tap.timestamp)
        if let completedTimestamp = lastCompletedSqueezeTimestamp,
           abs(completedTimestamp - tap.timestamp) <= doubleSqueezeTapCancellationInterval {
            lastCompletedSqueezeTimestamp = nil
        }

        var detail: [String: Any] = [
            "preferredAction": preferredActionName(UIPencilInteraction.preferredTapAction),
            "timestamp": tap.timestamp
        ]
        if let hoverPose = hoverPosePayload(tap.hoverPose) {
            detail["hoverPose"] = hoverPose
        }
        dispatchApplePencilEvent("weave:apple-pencil:tap", detail: detail)
    }

    @available(iOS 17.5, *)
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze) {
        let preferredAction = UIPencilInteraction.preferredSqueezeAction
        if squeeze.phase == .began {
            currentSqueezeStartedTimestamp = squeeze.timestamp
        }

        let isDoubleSqueeze = preferredAction != .ignore
            && squeeze.phase == .began
            && !isNearRecentTap(squeeze.timestamp)
            && consumeDoubleSqueezeIfNeeded(at: squeeze.timestamp)

        var detail: [String: Any] = [
            "phase": squeezePhaseName(squeeze.phase),
            "preferredAction": preferredActionName(preferredAction),
            "timestamp": squeeze.timestamp
        ]
        if isDoubleSqueeze {
            detail["isDoubleSqueeze"] = true
            scheduleApplePencilToolPicker(for: squeeze.timestamp)
        }
        if let hoverPose = hoverPosePayload(squeeze.hoverPose) {
            detail["hoverPose"] = hoverPose
        }
        if squeeze.phase == .ended || squeeze.phase == .cancelled {
            if shouldRecordCompletedSqueeze(at: squeeze.timestamp) {
                lastCompletedSqueezeTimestamp = squeeze.timestamp
            } else {
                lastCompletedSqueezeTimestamp = nil
            }
            currentSqueezeStartedTimestamp = nil
        }
        dispatchApplePencilEvent("weave:apple-pencil:squeeze", detail: detail)
    }

    func toolPickerVisibilityDidChange(_ toolPicker: PKToolPicker) {
        dispatchApplePencilEvent("weave:apple-pencil:palette", detail: [
            "visible": toolPicker.isVisible
        ])
    }

    @available(iOS 17.5, *)
    private func squeezePhaseName(_ phase: UIPencilInteraction.Phase) -> String {
        switch phase {
        case .began:
            return "began"
        case .changed:
            return "changed"
        case .ended:
            return "ended"
        case .cancelled:
            return "cancelled"
        @unknown default:
            return "unknown"
        }
    }

    @available(iOS 17.5, *)
    private func preferredActionName(_ action: UIPencilPreferredAction) -> String {
        switch action {
        case .ignore:
            return "ignore"
        case .switchEraser:
            return "switchEraser"
        case .switchPrevious:
            return "switchPrevious"
        case .showColorPalette:
            return "showColorPalette"
        case .showInkAttributes:
            return "showInkAttributes"
        case .showContextualPalette:
            return "showContextualPalette"
        case .runSystemShortcut:
            return "runSystemShortcut"
        @unknown default:
            return "unknown"
        }
    }

    @available(iOS 17.5, *)
    private func hoverPosePayload(_ hoverPose: UIPencilHoverPose?) -> [String: Any]? {
        guard let hoverPose else { return nil }

        return [
            "x": hoverPose.location.x,
            "y": hoverPose.location.y,
            "zOffset": hoverPose.zOffset,
            "altitudeAngle": hoverPose.altitudeAngle,
            "azimuthAngle": hoverPose.azimuthAngle,
            "azimuthUnitVector": [
                "dx": hoverPose.azimuthUnitVector.dx,
                "dy": hoverPose.azimuthUnitVector.dy
            ],
            "rollAngle": hoverPose.rollAngle
        ]
    }

    private func showApplePencilToolPicker() {
        DispatchQueue.main.async { [weak self] in
            guard let self, let webView = self.webView else { return }

            let toolPicker = self.applePencilToolPicker ?? self.makeApplePencilToolPicker()
            self.applePencilToolPicker = toolPicker
            webView.becomeFirstResponder()
            toolPicker.setVisible(true, forFirstResponder: webView)
            self.dispatchApplePencilEvent("weave:apple-pencil:palette", detail: [
                "visible": true
            ])
        }
    }

    private func scheduleApplePencilToolPicker(for timestamp: TimeInterval) {
        pendingDoubleSqueezeWorkItem?.cancel()
        pendingDoubleSqueezeTimestamp = timestamp

        let workItem = DispatchWorkItem { [weak self] in
            guard let self else { return }
            guard self.pendingDoubleSqueezeTimestamp == timestamp else { return }
            self.pendingDoubleSqueezeTimestamp = nil
            self.pendingDoubleSqueezeWorkItem = nil
            guard !self.isNearRecentTap(timestamp) else { return }
            self.showApplePencilToolPicker()
        }

        pendingDoubleSqueezeWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + doubleSqueezePaletteDelay, execute: workItem)
    }

    private func cancelPendingDoubleSqueezePaletteIfNeeded(near timestamp: TimeInterval) {
        guard let pendingTimestamp = pendingDoubleSqueezeTimestamp else { return }
        guard abs(pendingTimestamp - timestamp) <= doubleSqueezeTapCancellationInterval else { return }

        pendingDoubleSqueezeWorkItem?.cancel()
        pendingDoubleSqueezeWorkItem = nil
        pendingDoubleSqueezeTimestamp = nil
    }

    private func makeApplePencilToolPicker() -> PKToolPicker {
        let toolPicker = PKToolPicker()
        toolPicker.stateAutosaveName = "WeaveApplePencilToolPicker"
        toolPicker.showsDrawingPolicyControls = false
        toolPicker.addObserver(self)
        return toolPicker
    }

    @available(iOS 17.5, *)
    private func consumeDoubleSqueezeIfNeeded(at timestamp: TimeInterval) -> Bool {
        guard let previousTimestamp = lastCompletedSqueezeTimestamp else { return false }
        guard timestamp - previousTimestamp <= doubleSqueezeMaximumInterval else { return false }
        lastCompletedSqueezeTimestamp = nil
        return true
    }

    private func isNearRecentTap(_ timestamp: TimeInterval) -> Bool {
        guard let lastTapTimestamp else { return false }
        return abs(timestamp - lastTapTimestamp) <= doubleSqueezeTapCancellationInterval
    }

    private func shouldRecordCompletedSqueeze(at timestamp: TimeInterval) -> Bool {
        guard !isNearRecentTap(timestamp) else { return false }
        guard let currentSqueezeStartedTimestamp else { return false }
        return timestamp - currentSqueezeStartedTimestamp >= minimumCompletedSqueezeDuration
    }

    private func dispatchApplePencilEvent(_ eventName: String, detail: [String: Any]) {
        guard let eventNameJSON = jsonLiteral(eventName) else { return }

        guard JSONSerialization.isValidJSONObject(detail),
              let data = try? JSONSerialization.data(withJSONObject: detail),
              let detailJSON = String(data: data, encoding: .utf8) else {
            return
        }

        let script = "window.dispatchEvent(new CustomEvent(\(eventNameJSON), { detail: \(detailJSON) }));"

        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(script)
        }
    }

    private func jsonLiteral(_ value: String) -> String? {
        guard JSONSerialization.isValidJSONObject([value]),
              let data = try? JSONSerialization.data(withJSONObject: [value]),
              let json = String(data: data, encoding: .utf8) else {
            return nil
        }

        return String(json.dropFirst().dropLast())
    }
}
