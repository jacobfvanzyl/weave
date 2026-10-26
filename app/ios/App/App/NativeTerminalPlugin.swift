// The native terminals beneath the web view (ADR 0022, WVE-153), after e30f6e93
// (product/alpha/ios/App/App/NativeTerminalPlugin.swift) by way of the WVE-150 spike. The web view
// lays each one out over a transparent element of its own, and gives it the stream's address and
// ticket; the stream's bytes stay here.
import Capacitor
import UIKit
import WebKit

@objc(NativeTerminalPlugin)
final class NativeTerminalPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "NativeTerminalPlugin"
    let jsName = "NativeTerminal"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "create", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "layout", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "attach", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "detach", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setFontSize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "focus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "blur", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "inspect", returnType: CAPPluginReturnPromise)
    ]
    private var surfaces: [String: TerminalView] = [:]
    private var navigationObservation: NSKeyValueObservation?

    override func load() {
        // A reload starts the web view over, with none of its terminals.
        navigationObservation = bridge?.webView?.observe(\.isLoading, options: [.new]) { [weak self] web, _ in
            if web.isLoading { DispatchQueue.main.async { self?.closeAll() } }
        }
    }

    private func closeAll() {
        for view in surfaces.values { remove(view) }
        surfaces.removeAll()
    }

    private func remove(_ view: TerminalView) {
        view.stream?.stop()
        view.stream = nil
        _ = view.resignFirstResponder()
        view.removeFromSuperview()
    }

    private func event(_ id: String, _ data: [String: Any]) {
        var data = data
        data["surfaceId"] = id
        notifyListeners("event", data: data)
    }

    private func withSurface(_ call: CAPPluginCall, _ action: @escaping (String, TerminalView) -> Void) {
        DispatchQueue.main.async {
            guard let id = call.getString("surfaceId"), let view = self.surfaces[id] else { call.reject("The terminal's view is gone."); return }
            action(id, view)
        }
    }

    private func grid(_ view: TerminalView) -> TerminalStream.Size {
        let grid = view.terminal.grid(forViewportSize: view.bounds.size)
        return (Int(grid.width), Int(grid.height))
    }

    @objc func create(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.surfaces.count < 64, let web = self.bridge?.webView, let parent = web.superview else { call.reject("There's nowhere to put a terminal."); return }
            guard let terminal = WeaveTerminalRenderer(fontSize: CGFloat(call.getDouble("fontSize") ?? 13)) else { call.reject("The terminal couldn't start."); return }
            let id = UUID().uuidString
            let view = TerminalView(terminal: terminal)
            view.isHidden = true
            view.didFocus = { [weak self] in self?.event(id, ["kind": "focus"]) }
            view.didBlur = { [weak self] in self?.event(id, ["kind": "blur"]) }
            self.surfaces[id] = view
            parent.insertSubview(view, belowSubview: web)
            call.resolve(["surfaceId": id, "codec": WeaveTerminalRenderer.codec()])
        }
    }

    @objc func layout(_ call: CAPPluginCall) {
        withSurface(call) { _, view in
            guard let web = self.bridge?.webView, let parent = web.superview,
                  let x = call.getDouble("x"), let y = call.getDouble("y"), let width = call.getDouble("width"), let height = call.getDouble("height"),
                  [x, y, width, height].allSatisfy({ $0.isFinite }), width >= 0, height >= 0 else { call.reject("The terminal's place isn't valid."); return }
            let rectangle = CGRect(x: x, y: y, width: width, height: height).intersection(web.bounds)
            if !rectangle.isEmpty && !rectangle.isNull { view.frame = web.convert(rectangle, to: parent) }
            view.isHidden = call.getBool("visible") != true || rectangle.isEmpty || rectangle.isNull
            view.inputBlocked = call.getBool("inputBlocked") ?? true
            view.accessibilityElementsHidden = view.inputBlocked || view.isHidden
            if view.isHidden || view.inputBlocked { _ = view.resignFirstResponder() }
            view.setNeedsDisplay()
            view.layoutIfNeeded()
            let grid = self.grid(view)
            if !view.isHidden { view.stream?.resize(to: grid) }
            call.resolve(["cols": grid.cols, "rows": grid.rows])
        }
    }

    /// Opens the terminal's stream, `url` being the Host's WebSocket and `ticket` one
    /// `terminals/attach` gave this device. A stream already open is closed first.
    @objc func attach(_ call: CAPPluginCall) {
        withSurface(call) { id, view in
            guard let address = call.getString("url"), let url = URL(string: address), ["ws", "wss"].contains(url.scheme ?? ""),
                  let ticket = call.getString("ticket"), !ticket.isEmpty else { call.reject("The stream needs the Host's address and a ticket."); return }
            view.stream?.stop()
            let stream = TerminalStream(url: url, ticket: ticket, grid: self.grid(view), renderer: view.terminal)
            stream.onScreen = { [weak view] in view?.setNeedsDisplay() }
            stream.onMessage = { [weak self] message in self?.event(id, message) }
            stream.onClose = { [weak self, weak view, weak stream] code, reason in
                if let view, let stream, view.stream === stream { view.stream = nil }
                self?.event(id, ["kind": "closed", "code": code, "reason": reason])
            }
            view.stream = stream
            stream.start()
            call.resolve()
        }
    }

    @objc func detach(_ call: CAPPluginCall) {
        withSurface(call) { _, view in
            view.stream?.stop()
            view.stream = nil
            call.resolve()
        }
    }

    @objc func setFontSize(_ call: CAPPluginCall) {
        withSurface(call) { _, view in
            guard let size = call.getDouble("fontSize"), size.isFinite else { call.reject("A font size is a number of points."); return }
            view.setFontSize(CGFloat(size))
            let grid = self.grid(view)
            view.stream?.resize(to: grid)
            call.resolve(["cols": grid.cols, "rows": grid.rows, "fontSize": view.terminal.fontSize])
        }
    }

    @objc func focus(_ call: CAPPluginCall) {
        withSurface(call) { _, view in
            guard !view.isHidden, !view.inputBlocked, view.window != nil, view.becomeFirstResponder() else { call.reject("The terminal can't take the keyboard now."); return }
            call.resolve()
        }
    }

    @objc func blur(_ call: CAPPluginCall) {
        withSurface(call) { _, view in
            _ = view.resignFirstResponder()
            call.resolve()
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let id = call.getString("surfaceId"), let view = self.surfaces.removeValue(forKey: id) { self.remove(view) }
            call.resolve()
        }
    }

    /// Debug builds: the screen as text, for checks.
    @objc func inspect(_ call: CAPPluginCall) {
        #if DEBUG
        withSurface(call) { _, view in
            call.resolve(["text": view.terminal.visibleText, "cols": view.terminal.columns, "rows": view.terminal.rows, "fontSize": view.terminal.fontSize, "codec": WeaveTerminalRenderer.codec(), "attached": view.stream != nil])
        }
        #else
        call.reject("Inspecting a terminal is for debug builds.")
        #endif
    }
}
