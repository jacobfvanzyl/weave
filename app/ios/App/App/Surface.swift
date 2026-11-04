// A Surface (WVE-183): a display the iPhone is connected to, through AirPlay mirroring or a cable,
// where the app shows the open thread while the iPhone keeps its composer. Since iOS 27 the app
// asks for the display's scene with a scene accessory (`WeaveBridgeViewController`); before, the
// system offers it (`AppDelegate`). The Surface is a second web view on the app's own bundle,
// without a bridge, which talks to no Host: the app's web view sends what it shows through the
// `Surface` plugin, and `SurfaceRelay` carries the messages both ways.
import Capacitor
import UIKit
import WebKit

/** Joins the app's web view, through its plugin, to the Surface's web view, while one is up. */
final class SurfaceRelay {
    static let shared = SurfaceRelay()

    weak var plugin: SurfacePlugin?
    fileprivate weak var surface: SurfaceSceneDelegate?
    /** A display is connected that a Surface can show on. */
    private(set) var available = false
    /** Unless the person turned it off, handing the display back to mirroring. */
    private(set) var enabled = true
    /** The Surface's page is up and has asked for what to show. */
    private var ready = false
    /** Turns the scene accessory on and off, on iOS 27. */
    var onEnabled: ((Bool) -> Void)?

    var status: [String: Any] {
        ["available": available, "enabled": enabled, "connected": available && enabled && ready]
    }

    func setAvailable(_ value: Bool) {
        guard value != available else { return }
        available = value
        if !value { ready = false }
        statusChanged()
    }

    func setEnabled(_ value: Bool) {
        guard value != enabled else { return }
        enabled = value
        onEnabled?(value)
        // Before iOS 27 the scene stays, hidden, and its page with it, ready again once shown.
        surface?.setShown(value)
        statusChanged()
    }

    fileprivate func connected(_ delegate: SurfaceSceneDelegate) {
        surface = delegate
        delegate.setShown(enabled)
        setAvailable(true)
    }

    fileprivate func disconnected(_ delegate: SurfaceSceneDelegate) {
        guard surface === delegate else { return }
        surface = nil
        ready = false
        // iOS 27's accessory says for itself when a display is there; before, the scene is the display.
        if #unavailable(iOS 27.0) { available = false }
        statusChanged()
    }

    /** From the app's web view. */
    func toSurface(_ message: String) {
        guard enabled, ready else { return }
        surface?.deliver(message)
    }

    /** From the Surface's web view. Its `ready` connects it. */
    fileprivate func fromSurface(_ message: String) {
        let kind = ((try? JSONSerialization.jsonObject(with: Data(message.utf8))) as? [String: Any])?["kind"] as? String
        if !ready, kind == "ready" {
            ready = true
            statusChanged()
        }
        plugin?.notifyListeners("message", data: ["message": message])
    }

    private func statusChanged() {
        plugin?.notifyListeners("status", data: status)
    }
}

@objc(SurfacePlugin)
final class SurfacePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "SurfacePlugin"
    let jsName = "Surface"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setEnabled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setLandscape", returnType: CAPPluginReturnPromise)
    ]

    override func load() {
        SurfaceRelay.shared.plugin = self
    }

    @objc func status(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(SurfaceRelay.shared.status) }
    }

    @objc func send(_ call: CAPPluginCall) {
        guard let message = call.getString("message") else { call.reject("Nothing to send."); return }
        DispatchQueue.main.async {
            SurfaceRelay.shared.toSurface(message)
            call.resolve()
        }
    }

    @objc func setEnabled(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? true
        DispatchQueue.main.async {
            SurfaceRelay.shared.setEnabled(enabled)
            call.resolve()
        }
    }

    @objc func setLandscape(_ call: CAPPluginCall) {
        let allowed = call.getBool("allowed") ?? false
        DispatchQueue.main.async {
            (self.bridge?.viewController as? WeaveBridgeViewController)?.landscapeAllowed = allowed
            call.resolve()
        }
    }
}

/** Keeps the web view's message handler from holding the scene delegate. */
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: SurfaceSceneDelegate?
    init(_ target: SurfaceSceneDelegate) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? String else { return }
        target?.received(body)
    }
}

/** The display's scene: a window with the Surface's web view, which takes no input. */
final class SurfaceSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var webView: WKWebView?
    private var assets: WebViewAssetHandler?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene, let page = Bundle.main.url(forResource: "public", withExtension: nil) else { return }
        let window = UIWindow(windowScene: windowScene)
        let root = UIViewController()
        root.view.backgroundColor = UIColor(red: 30 / 255, green: 30 / 255, blue: 46 / 255, alpha: 1)
        window.rootViewController = root

        let configuration = WKWebViewConfiguration()
        // Nothing of the app's storage: what the Surface shows, it's sent.
        configuration.websiteDataStore = .nonPersistent()
        let assets = WebViewAssetHandler(router: CapacitorRouter())
        assets.setAssetPath(page.path)
        configuration.setURLSchemeHandler(assets, forURLScheme: "capacitor")
        self.assets = assets
        configuration.userContentController.add(WeakMessageHandler(self), name: "surface")
        let webView = WKWebView(frame: root.view.bounds, configuration: configuration)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
#if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
#endif
        root.view.addSubview(webView)
        if let url = URL(string: "capacitor://localhost/?surface") { webView.load(URLRequest(url: url)) }
        self.webView = webView
        self.window = window
        SurfaceRelay.shared.connected(self)
    }

    /** A hidden window hands the display back to mirroring. */
    func setShown(_ shown: Bool) {
        window?.isHidden = !shown
    }

    func deliver(_ message: String) {
        webView?.callAsyncJavaScript("window.weaveSurface?.receive(message)", arguments: ["message": message], in: nil, in: .page, completionHandler: nil)
    }

    fileprivate func received(_ message: String) {
        SurfaceRelay.shared.fromSurface(message)
    }

    func sceneDidDisconnect(_ scene: UIScene) {
        SurfaceRelay.shared.disconnected(self)
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "surface")
        webView = nil
        window = nil
    }
}
