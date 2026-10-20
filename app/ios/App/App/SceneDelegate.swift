import UIKit
import Capacitor

final class WeaveBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(DeviceKeyPlugin())
        guard let webView else { return }
        // Capacitor's root view is the web view; a container lets it follow the keyboard below.
        let container = UIView(frame: webView.frame)
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
