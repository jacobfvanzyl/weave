import Capacitor
import UIKit

@objc(NativeBrowserPlugin)
final class NativeBrowserPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "NativeBrowserPlugin"
    let jsName = "NativeBrowser"
    let pluginMethods = ["create", "connect", "control", "layout", "close"].compactMap { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }
    private var surfaces: [String: WeaveBrowserSurface] = [:]
    @objc func create(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.surfaces.count < 16, let web = self.bridge?.webView, let parent = web.superview else { call.reject("Browser container is unavailable"); return }
            let id = UUID().uuidString
            let surface = WeaveBrowserSurface(event: { [weak self] event in
                var payload = event as? [String: Any] ?? [:]; payload["surfaceId"] = id
                self?.notifyListeners("event", data: payload)
            })
            self.surfaces[id] = surface
            parent.insertSubview(surface.view, belowSubview: web)
            call.resolve(["surfaceId": id])
        }
    }
    private func withSurface(_ call: CAPPluginCall, _ action: @escaping (WeaveBrowserSurface) -> Void) {
        DispatchQueue.main.async {
            guard let id = call.getString("surfaceId"), let surface = self.surfaces[id] else { call.reject("Browser surface is unavailable"); return }
            action(surface)
        }
    }
    @objc func connect(_ call: CAPPluginCall) {
        withSurface(call) { surface in
            guard let url = call.getString("url"), url.count <= 8192 else { call.reject("Invalid Browser address"); return }
            surface.connect(url); call.resolve()
        }
    }
    @objc func control(_ call: CAPPluginCall) {
        withSurface(call) { surface in
            guard let json = call.getString("json"), json.utf8.count <= 65536 else { call.reject("Invalid Browser control message"); return }
            surface.sendControl(json); call.resolve()
        }
    }
    @objc func layout(_ call: CAPPluginCall) {
        withSurface(call) { surface in
            guard let web = self.bridge?.webView, let parent = web.superview,
                  let x = call.getDouble("x"), let y = call.getDouble("y"), let width = call.getDouble("width"), let height = call.getDouble("height"),
                  let dim = call.getDouble("dim"), [x,y,width,height,dim].allSatisfy({ $0.isFinite }), width >= 0, height >= 0 else { call.reject("Invalid Browser geometry"); return }
            let frame = CGRect(x:x, y:y, width:width, height:height).intersection(web.bounds)
            surface.layout(web.convert(frame.isNull ? .zero : frame, to:parent), visible:call.getBool("visible") ?? false, dim:dim)
            call.resolve()
        }
    }
    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let id = call.getString("surfaceId"), let surface = self.surfaces.removeValue(forKey:id) { surface.close() }
            call.resolve()
        }
    }
    deinit { for surface in surfaces.values { surface.close() } }
}
