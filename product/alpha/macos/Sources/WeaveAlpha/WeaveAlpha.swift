import AppKit
import WebKit

private let defaultBrowserURL = "https://example.com"
private let mediaPolicySource = """
(() => {
  const deny = () => Promise.reject(
    new DOMException('Blocked by Alpha Browser policy.', 'NotAllowedError')
  );
  if (globalThis.MediaDevices?.prototype) {
    try {
      Object.defineProperty(globalThis.MediaDevices.prototype, 'getUserMedia', {
        configurable: false,
        writable: false,
        value: deny
      });
      return;
    } catch {}
  }
  const media = navigator.mediaDevices;
  if (media) {
    try {
      Object.defineProperty(media, 'getUserMedia', {
        configurable: false,
        writable: false,
        value: deny
      });
      return;
    } catch {}
  }
  try {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: false,
      value: { getUserMedia: deny }
    });
  } catch {}
})();
"""

private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var delegate: WKScriptMessageHandler?

    init(delegate: WKScriptMessageHandler) {
        self.delegate = delegate
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        delegate?.userContentController(userContentController, didReceive: message)
    }
}

@MainActor
private final class BrowserHostController: NSViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private let root = NSView()
    private let shell: WKWebView
    private var browser: WKWebView?
    private var lastBrowserFrame = NSRect.zero
    private var browserError: String?
    private var browserNotice: String?

    override init(nibName nibNameOrNil: NSNib.Name?, bundle nibBundleOrNil: Bundle?) {
        let configuration = WKWebViewConfiguration()
        shell = WKWebView(frame: .zero, configuration: configuration)
        super.init(nibName: nibNameOrNil, bundle: nibBundleOrNil)
        shell.configuration.userContentController.add(
            WeakMessageHandler(delegate: self),
            name: "alphaBrowser"
        )
    }

    required init?(coder: NSCoder) { nil }

    override func loadView() {
        root.wantsLayer = true
        root.layer?.backgroundColor = NSColor.black.cgColor
        root.addSubview(shell)
        shell.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            shell.topAnchor.constraint(equalTo: root.topAnchor),
            shell.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            shell.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            shell.bottomAnchor.constraint(equalTo: root.bottomAnchor),
        ])
        shell.navigationDelegate = self
        view = root
    }

    override func viewDidLayout() {
        super.viewDidLayout()
        applyLastBrowserFrame()
    }

    func loadAlpha() {
        guard
            let resourceRoot = Bundle.main.resourceURL,
            let indexURL = Bundle.main.url(
                forResource: "index",
                withExtension: "html",
                subdirectory: "public"
            )
        else {
            shell.loadHTMLString(
                "<main style='font:16px system-ui;padding:32px'>Alpha application resources are missing.</main>",
                baseURL: nil
            )
            return
        }
        shell.loadFileURL(indexURL, allowingReadAccessTo: resourceRoot)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard
            message.name == "alphaBrowser",
            let command = message.body as? [String: Any],
            let type = command["type"] as? String
        else { return }

        switch type {
        case "status":
            emitBrowserState()
        case "present":
            guard
                let frame = command["frame"] as? [String: Any],
                let x = number(frame["x"]),
                let y = number(frame["y"]),
                let width = number(frame["width"]),
                let height = number(frame["height"]),
                x.isFinite,
                y.isFinite,
                width.isFinite,
                height.isFinite,
                width >= 0,
                height >= 0
            else { return }
            presentBrowser(cssFrame: NSRect(x: x, y: y, width: width, height: height))
        case "hide":
            browser?.isHidden = true
        case "navigate":
            if let value = command["url"] as? String { navigate(to: value) }
        case "back":
            if browser?.canGoBack == true { browser?.goBack() }
        case "forward":
            if browser?.canGoForward == true { browser?.goForward() }
        case "reload":
            browser?.reload()
        case "stop":
            browser?.stopLoading()
            emitBrowserState()
        case "reset":
            installFreshBrowser(loadDefault: true)
            applyLastBrowserFrame()
            browser?.isHidden = false
        default:
            break
        }
    }

    private func number(_ value: Any?) -> CGFloat? {
        (value as? NSNumber).map { CGFloat(truncating: $0) }
    }

    private func presentBrowser(cssFrame: NSRect) {
        if browser == nil { installFreshBrowser(loadDefault: true) }
        lastBrowserFrame = cssFrame
        applyLastBrowserFrame()
        browser?.isHidden = false
        if browser?.superview == nil, let browser {
            root.addSubview(browser, positioned: .above, relativeTo: shell)
        }
        emitBrowserState()
    }

    private func applyLastBrowserFrame() {
        guard let browser else { return }
        browser.frame = NSRect(
            x: lastBrowserFrame.minX,
            y: root.bounds.height - lastBrowserFrame.minY - lastBrowserFrame.height,
            width: max(0, lastBrowserFrame.width),
            height: max(0, lastBrowserFrame.height)
        ).intersection(root.bounds)
    }

    private func installFreshBrowser(loadDefault: Bool) {
        browser?.stopLoading()
        browser?.navigationDelegate = nil
        browser?.uiDelegate = nil
        browser?.removeFromSuperview()

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.addUserScript(WKUserScript(
            source: mediaPolicySource,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false,
            in: .page
        ))
        let replacement = WKWebView(frame: .zero, configuration: configuration)
        replacement.navigationDelegate = self
        replacement.uiDelegate = self
        replacement.isHidden = true
        browser = replacement
        root.addSubview(replacement, positioned: .above, relativeTo: shell)
        browserError = nil
        browserNotice = nil
        if loadDefault { navigate(to: defaultBrowserURL) }
    }

    private func navigate(to rawValue: String) {
        if browser == nil { installFreshBrowser(loadDefault: false) }
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let candidate = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard
            let url = URL(string: candidate),
            let scheme = url.scheme?.lowercased(),
            scheme == "http" || scheme == "https"
        else {
            browserError = "Invalid web URL: \(rawValue)"
            browserNotice = nil
            emitBrowserState()
            return
        }
        browserError = nil
        browserNotice = nil
        browser?.load(URLRequest(url: url))
        emitBrowserState()
    }

    private func emitBrowserState() {
        DispatchQueue.main.async { [weak self] in
            self?.dispatchBrowserState()
        }
    }

    private func dispatchBrowserState() {
        var state: [String: Any] = [
            "supported": true,
            "url": browser?.url?.absoluteString ?? defaultBrowserURL,
            "title": browser?.title ?? "",
            "loading": browser?.isLoading ?? false,
            "canGoBack": browser?.canGoBack ?? false,
            "canGoForward": browser?.canGoForward ?? false,
            "policy": [
                "popups": "same-session",
                "uploads": "system-picker",
                "downloads": "unavailable",
                "mediaPermissions": "denied",
                "otherPermissions": "webkit-default",
            ],
        ]
        if let browserNotice { state["notice"] = browserNotice }
        if let browserError { state["error"] = browserError }
        guard
            let data = try? JSONSerialization.data(withJSONObject: state),
            let json = String(data: data, encoding: .utf8)
        else { return }
        shell.evaluateJavaScript(
            "window.dispatchEvent(new CustomEvent('weave:alpha-browser-state',{detail:\(json)}))"
        )
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if webView === browser { emitBrowserState() }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
        guard webView === browser else {
            decisionHandler(.allow)
            return
        }
        if navigationAction.shouldPerformDownload {
            reportUnsupportedDownload()
            decisionHandler(.cancel)
            return
        }
        if let url = navigationAction.request.url, !isAllowedWebURL(url) {
            browserError = "Unsupported URL scheme: \(url.scheme ?? "unknown")"
            browserNotice = nil
            emitBrowserState()
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void
    ) {
        guard webView === browser else {
            decisionHandler(.allow)
            return
        }
        let disposition = (navigationResponse.response as? HTTPURLResponse)?
            .value(forHTTPHeaderField: "Content-Disposition")?
            .lowercased()
        if disposition?.contains("attachment") == true {
            reportUnsupportedDownload()
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView === browser {
            browserError = nil
            emitBrowserState()
        }
    }

    func webView(_ webView: WKWebView, didReceiveServerRedirectForProvisionalNavigation navigation: WKNavigation!) {
        if webView === browser { emitBrowserState() }
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        if webView === browser { emitBrowserState() }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        navigationFailed(in: webView, error: error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        navigationFailed(in: webView, error: error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if webView === browser {
            browserError = "The browser content process stopped. Reload to continue."
            emitBrowserState()
        }
    }

    private func navigationFailed(in webView: WKWebView, error: Error) {
        let failure = error as NSError
        if failure.code == NSURLErrorCancelled { return }
        if webView === browser {
            browserError = error.localizedDescription
            print("Alpha Browser navigation error: \(failure.domain) \(failure.code) \(error.localizedDescription)")
            emitBrowserState()
        } else {
            print("Alpha navigation failed: \(error)")
        }
    }

    private func isAllowedWebURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https"
    }

    private func reportUnsupportedDownload() {
        browserError = nil
        browserNotice = "Downloads are unavailable in Alpha Browser."
        emitBrowserState()
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if webView === browser,
           navigationAction.targetFrame == nil,
           let requestURL = navigationAction.request.url {
            guard isAllowedWebURL(requestURL) else {
                browserError = "Unsupported URL scheme: \(requestURL.scheme ?? "unknown")"
                browserNotice = nil
                emitBrowserState()
                return nil
            }
            browserError = nil
            browserNotice = "Opened popup in the current Browser session."
            webView.load(URLRequest(url: requestURL))
            emitBrowserState()
        }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void
    ) {
        guard webView === browser else {
            completionHandler(nil)
            return
        }
        browserError = nil
        browserNotice = "Choose files with the macOS system picker."
        emitBrowserState()
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.begin { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void
    ) {
        if webView === browser {
            browserError = nil
            browserNotice = "Camera and microphone access is denied in Alpha Browser."
            emitBrowserState()
        }
        decisionHandler(.deny)
    }
}


@MainActor
private final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var controller: BrowserHostController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let controller = BrowserHostController()
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Weave Alpha"
        window.contentViewController = controller
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.controller = controller
        self.window = window
        controller.loadAlpha()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

@main
private enum WeaveAlpha {
    static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.setActivationPolicy(.regular)
        application.delegate = delegate
        application.run()
    }
}
