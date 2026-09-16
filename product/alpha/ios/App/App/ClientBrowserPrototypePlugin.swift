#if WEAVE_CLIENT_BROWSER_PROTOTYPE
import Capacitor
import UIKit

@available(iOS 26.0, *)
@objc(ClientBrowserPrototypePlugin)
final class ClientBrowserPrototypePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "ClientBrowserPrototypePlugin"
    let jsName = "ClientBrowserPrototype"
    let pluginMethods = ["create", "adopt", "layout", "snapshot", "focus", "list", "close"].compactMap { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }
    private var surfaces: [String: ClientBrowserPrototype] = [:]
    private var shellLoading: NSKeyValueObservation?
    override func load() {
        shellLoading = bridge?.webView?.observe(\.isLoading, options: [.new]) { [weak self] web, _ in
            guard web.isLoading else { return }
            DispatchQueue.main.async { for surface in self?.surfaces.values ?? Dictionary<String, ClientBrowserPrototype>().values { surface.present(x: 0, y: 0, width: 0, height: 0, visible: false, blocked: true) } }
        }
    }
    private var paneKeys: [String: String] = [:]
    @objc func create(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let key = call.getString("paneKey")
            if let key, let id = self.paneKeys.first(where: { $0.value == key })?.key { call.resolve(["surfaceId": id]); return }
            guard key == nil || (key!.count > 0 && key!.count < 1024) else { call.reject("Invalid Client Browser pane key"); return }
            guard self.surfaces.count < 128, let parent = self.bridge?.viewController,
                  let address = call.getString("address"), address.count <= 16384,
                  let url = URL(string: address), (address == "about:blank" || ["http", "https"].contains(url.scheme?.lowercased() ?? "")) else { call.reject("Invalid browser address or container"); return }
            let id = UUID().uuidString
            let handler: @MainActor (NSDictionary) -> Void = { [weak self] event in
                guard self?.surfaces[id] != nil else { return }
                var payload = event as? [String: Any] ?? [:]
                payload["surfaceId"] = id
                self?.notifyListeners("event", data: payload)
            }
            let surface = key.map { ClientBrowserPrototype(address: address, paneKey: $0, event: handler) } ?? ClientBrowserPrototype(address: address, event: handler)
            self.paneKeys[id] = key
            self.surfaces[id] = surface
            surface.attach(to: parent)
            call.resolve(["surfaceId": id])
        }
    }
    @objc func adopt(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let key = call.getString("paneKey")
            if let key, let id = self.paneKeys.first(where: { $0.value == key })?.key { call.resolve(["surfaceId": id]); return }
            guard key == nil || (key!.count > 0 && key!.count < 1024) else { call.reject("Invalid Client Browser pane key"); return }
            guard self.surfaces.count < 128, let parent = self.bridge?.viewController,
                  let token = call.getString("popupToken"), token.count < 128 else { call.reject("Invalid popup"); return }
            let id = UUID().uuidString
            guard let surface = ClientBrowserPrototype.adoptPopup(token, event: { [weak self] event in
                guard self?.surfaces[id] != nil else { return }
                var payload = event as? [String: Any] ?? [:]; payload["surfaceId"] = id
                self?.notifyListeners("event", data: payload)
            }) else { call.reject("Popup expired or already adopted"); return }
            if let key { surface.bindPane(key); self.paneKeys[id] = key }
            self.surfaces[id] = surface; surface.attach(to: parent); call.resolve(["surfaceId": id])
        }
    }
    @objc func layout(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let id = call.getString("surfaceId"), self.surfaces[id] == nil, call.getBool("visible") == false { call.resolve(); return }
            guard let id = call.getString("surfaceId"), let surface = self.surfaces[id], let web = self.bridge?.webView,
                  let parent = surface.view.superview,
                  let x = call.getDouble("x"), let y = call.getDouble("y"), let width = call.getDouble("width"), let height = call.getDouble("height"),
                  [x,y,width,height].allSatisfy({ $0.isFinite }), width >= 0, height >= 0 else { call.reject("Invalid browser geometry"); return }
            let rect = web.convert(CGRect(x:x,y:y,width:width,height:height).intersection(web.bounds), to:parent)
            let safe = rect.isNull ? CGRect.zero : rect
            let blocked = call.getBool("blocked") ?? true
            surface.present(x:safe.minX,y:safe.minY,width:safe.width,height:safe.height,visible:(call.getBool("visible") ?? false) && !blocked,blocked:blocked)
            call.resolve()
        }
    }
    @objc func snapshot(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let id = call.getString("surfaceId"), let surface = self.surfaces[id] else { call.resolve(["closed": true, "pageIdentity": "", "url": "", "title": "", "loading": false, "width": 0, "height": 0, "hidden": true, "error": "", "renderer": "SwiftUI/WKWebView"]); return }
            call.resolve(surface.snapshot() as? [String:Any] ?? [:])
        }
    }
    @objc func list(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(["panes": self.paneKeys.map { ["surfaceId": $0.key, "paneKey": $0.value] }]) }
    }
    @objc func focus(_ call: CAPPluginCall) {
        DispatchQueue.main.async { if let id = call.getString("surfaceId") { self.surfaces[id]?.focusPage() }; call.resolve() }
    }
    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let id = call.getString("surfaceId"), let surface = self.surfaces.removeValue(forKey:id) { surface.close(); self.paneKeys.removeValue(forKey: id) }
            call.resolve()
        }
    }
}
#endif
