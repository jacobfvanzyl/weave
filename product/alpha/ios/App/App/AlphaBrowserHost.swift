import UIKit
import WebKit

private let alphaBrowserDefaultURL = "https://example.com"
private let alphaBrowserMediaPolicySource = """
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

private final class WeakAlphaBrowserMessageHandler: NSObject, WKScriptMessageHandler {
    weak var delegate: WKScriptMessageHandler?

    init(delegate: WKScriptMessageHandler) {
        self.delegate = delegate
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        delegate?.userContentController(userContentController, didReceive: message)
    }
}

final class AlphaBrowserHost: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private weak var shell: WKWebView?
    private var browser: WKWebView?
    private var lastBrowserFrame = CGRect.zero
    private var browserError: String?
    private var browserNotice: String?

    init(shell: WKWebView) {
        self.shell = shell
        super.init()
        shell.configuration.userContentController.add(
            WeakAlphaBrowserMessageHandler(delegate: self),
            name: "alphaBrowser"
        )
#if DEBUG
        print("AlphaBrowserHost: bridge installed")
#endif
    }

    deinit {
        shell?.configuration.userContentController.removeScriptMessageHandler(forName: "alphaBrowser")
    }

    func layoutBrowser() {
        guard let shell, let browser else { return }
        browser.frame = lastBrowserFrame.intersection(shell.bounds)
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
            presentBrowser(cssFrame: CGRect(x: x, y: y, width: width, height: height))
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
            layoutBrowser()
            browser?.isHidden = false
        default:
            break
        }
    }

    private func number(_ value: Any?) -> CGFloat? {
        (value as? NSNumber).map { CGFloat(truncating: $0) }
    }

    private func presentBrowser(cssFrame: CGRect) {
        if browser == nil { installFreshBrowser(loadDefault: true) }
        lastBrowserFrame = cssFrame
        layoutBrowser()
        browser?.isHidden = false
#if DEBUG
        print("AlphaBrowserHost: presenting frame \(cssFrame)")
#endif
        emitBrowserState()
    }

    private func installFreshBrowser(loadDefault: Bool) {
        browser?.stopLoading()
        browser?.navigationDelegate = nil
        browser?.uiDelegate = nil
        browser?.removeFromSuperview()

        guard let shell else { return }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.allowsInlineMediaPlayback = true
        configuration.userContentController.addUserScript(WKUserScript(
            source: alphaBrowserMediaPolicySource,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false,
            in: .page
        ))
        let replacement = WKWebView(frame: .zero, configuration: configuration)
        replacement.navigationDelegate = self
        replacement.uiDelegate = self
        replacement.isHidden = true
        replacement.isOpaque = true
        replacement.backgroundColor = .white
        replacement.scrollView.contentInsetAdjustmentBehavior = .never
        browser = replacement
        shell.addSubview(replacement)
        browserError = nil
        browserNotice = nil
        if loadDefault { navigate(to: alphaBrowserDefaultURL) }
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
            "url": browser?.url?.absoluteString ?? alphaBrowserDefaultURL,
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
        shell?.evaluateJavaScript(
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

    func webView(_ webView: WKWebView, didReceiveServerRedirectForProvisionalNavigation navigation: WKNavigation!) {
        if webView === browser { emitBrowserState() }
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        if webView === browser { emitBrowserState() }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView === browser {
            browserError = nil
#if DEBUG
            print("AlphaBrowserHost: loaded \(webView.url?.absoluteString ?? alphaBrowserDefaultURL)")
#endif
            emitBrowserState()
        }
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
        if (error as NSError).code == NSURLErrorCancelled { return }
        if webView === browser {
            browserError = error.localizedDescription
#if DEBUG
            print("AlphaBrowserHost: navigation failed: \(error.localizedDescription)")
#endif
            emitBrowserState()
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
