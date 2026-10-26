import UIKit
import Capacitor

// The web view paints over the native terminals beneath it (`NativeTerminalPlugin`). Touches over
// a terminal's exposed region go to it; elsewhere, and over overlays, WebKit's hit testing holds.
private final class WeaveSurfaceContainer: UIView {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard self.point(inside: point, with: event) else { return nil }
        for case let terminal as TerminalView in subviews.reversed() {
            guard !terminal.isHidden, !terminal.inputBlocked else { continue }
            let local = terminal.convert(point, from: self)
            if let hit = terminal.hitTest(local, with: event) { return hit }
        }
        return super.hitTest(point, with: event)
    }
}

final class WeaveBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(DeviceKeyPlugin())
        bridge?.registerPluginInstance(NativeTerminalPlugin())
        guard let webView else { return }
        // Capacitor's root view is the web view; a container lets it follow the keyboard below,
        // with the native terminals beneath it.
        let container = WeaveSurfaceContainer(frame: webView.frame)
        container.backgroundColor = UIColor(red: 30 / 255, green: 30 / 255, blue: 46 / 255, alpha: 1)
        view = container
        container.addSubview(webView)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        // The app lays out by device, not window width: a narrow iPad window keeps the sidebar.
        let idiom = UIDevice.current.userInterfaceIdiom == .phone ? "phone" : "pad"
        let script = "document.documentElement.dataset.deviceIdiom = '\(idiom)';"
        webView.configuration.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        webView.evaluateJavaScript(script, completionHandler: nil)
#if DEBUG
        // A debug build opens the fixture scenario named at launch, such as
        // `xcrun simctl launch <device> com.veezee.weave --mock running`, as `?mock=` does in a browser.
        let arguments = ProcessInfo.processInfo.arguments
        if let index = arguments.firstIndex(of: "--mock"), arguments.indices.contains(index + 1),
           arguments[index + 1].range(of: #"^[a-z-]+$"#, options: .regularExpression) != nil {
            let mock = "history.replaceState(null, '', '?mock=\(arguments[index + 1])');"
            webView.configuration.userContentController.addUserScript(WKUserScript(source: mock, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        // And `--terminal-stream <ws url> <ticket>` opens that terminal's stream over the whole
        // window, without the web view, for checking the native terminal (`scripts/terminal-check.ts`).
        if let index = arguments.firstIndex(of: "--terminal-stream"), arguments.indices.contains(index + 2),
           let url = URL(string: arguments[index + 1]), let renderer = WeaveTerminalRenderer(fontSize: 13) {
            let terminal = TerminalView(terminal: renderer)
            terminal.inputBlocked = false
            terminal.frame = container.bounds
            terminal.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            container.addSubview(terminal)
            let ticket = arguments[index + 2]
            DispatchQueue.main.async {
                let grid = renderer.grid(forViewportSize: terminal.bounds.size)
                let stream = TerminalStream(url: url, ticket: ticket, grid: (Int(grid.width), Int(grid.height)), renderer: renderer)
                stream.onScreen = { [weak terminal] in terminal?.setNeedsDisplay() }
                stream.onMessage = { message in NSLog("weave-terminal-check %@", String(describing: message["kind"] ?? "")) }
                stream.onClose = { code, reason in NSLog("weave-terminal-check closed %d %@", code, reason) }
                terminal.stream = stream
                stream.start()
            }
        }
#endif
        if #available(iOS 26.0, *) {
            webView.cornerConfiguration = .corners(radius: .containerConcentric(minimum: 0))
        }
        // One native owner for keyboard and rotation geometry. The app follows the resulting
        // viewport; Capacitor's notification resize is disabled. With the keyboard dismissed,
        // the web view reaches the window's bottom edge.
        if #available(iOS 17.0, *) {
            view.keyboardLayoutGuide.usesBottomSafeArea = false
        }
        webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor)
        ])
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = WeaveBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
