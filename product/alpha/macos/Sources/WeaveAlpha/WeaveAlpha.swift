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
            resetBrowser()
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

    private func resetBrowser() {
        let dataStore = browser?.configuration.websiteDataStore
        dataStore?.removeData(
            ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
            modifiedSince: .distantPast
        ) { [weak self] in
            DispatchQueue.main.async {
                self?.installFreshBrowser(loadDefault: true)
                self?.applyLastBrowserFrame()
                self?.browser?.isHidden = false
            }
        }
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

#if DEBUG
private struct BrowserAcceptanceOptions {
    let alphaURL: URL
    let fixtureURL: URL
    let reportURL: URL
    let screenshotURL: URL
    let dock: String
    let restartStage: String?

    static func parse(_ arguments: [String]) -> BrowserAcceptanceOptions? {
        func value(after flag: String) -> String? {
            guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else {
                return nil
            }
            return arguments[index + 1]
        }
        guard
            let alphaValue = value(after: "--acceptance-alpha-url"),
            let alphaURL = URL(string: alphaValue),
            let fixtureValue = value(after: "--acceptance-fixture-url"),
            let fixtureURL = URL(string: fixtureValue),
            let reportPath = value(after: "--acceptance-report"),
            let screenshotPath = value(after: "--acceptance-screenshot")
        else { return nil }
        return BrowserAcceptanceOptions(
            alphaURL: alphaURL,
            fixtureURL: fixtureURL,
            reportURL: URL(fileURLWithPath: reportPath),
            screenshotURL: URL(fileURLWithPath: screenshotPath),
            dock: value(after: "--acceptance-dock") == "bottom" ? "bottom" : "right",
            restartStage: value(after: "--acceptance-restart-stage")
        )
    }
}

private struct BrowserRestartAcceptanceReport: Encodable {
    let browserDataStoreIsNonPersistent: Bool
    let cookieAbsent: Bool
    let cookiePresent: Bool
    let stage: String
}

private struct BrowserAcceptanceReport: Encodable {
    let alphaLoaded: Bool
    let browserDataStoreIsNonPersistent: Bool
    let browserPaneMounted: Bool
    let controlClickAndWaitSucceeded: Bool
    let controlKeySucceeded: Bool
    let controlScrollSucceeded: Bool
    let controlSnapshotCaptured: Bool
    let controlTypeSucceeded: Bool
    let cookieAvailableBeforeReset: Bool
    let cookieClearedByReset: Bool
    let downloadNoticeReportedToShell: Bool
    let downloadWasBlocked: Bool
    let fixtureLoaded: Bool
    let frameEmbeddingWasDenied: Bool
    let historyBackReturnedHome: Bool
    let historyForwardReturnedPage2: Bool
    let navigatedToPage2: Bool
    let mediaCaptureWasDenied: Bool
    let mediaPolicyReportedToShell: Bool
    let popupNoticeReportedToShell: Bool
    let popupStayedInVisibleSession: Bool
    let reloadRecoveredSessionState: Bool
    let resetClearedHistory: Bool
    let screenshotWritten: Bool
    let shellHistoryStateMatchedBrowser: Bool
    let stopCancelledSlowNavigation: Bool
    let unreachableFailureReportedToShell: Bool
    let unreachableRecoverySucceeded: Bool
    let uploadPolicyReportedToShell: Bool
    let browserHidden: Bool
    let slotHeight: Double
    let slotMatchesSurface: Bool
    let slotPresented: Bool
    let slotOrientation: String
    let slotWidth: Double
    let surfaceHeight: Double
    let surfaceWidth: Double
    let webViewsAreDistinct: Bool
}

private extension BrowserHostController {
    func loadAlphaForAcceptance(at url: URL) {
        shell.load(URLRequest(url: url))
    }

    func evaluateShellBool(_ script: String) async -> Bool {
        (try? await shell.evaluateJavaScript(script)) as? Bool ?? false
    }

    func evaluateShellNumber(_ script: String) async -> Double {
        (try? await shell.evaluateJavaScript(script)) as? Double ?? 0
    }

    func evaluateBrowserBool(_ script: String) async -> Bool {
        guard let browser else { return false }
        return (try? await browser.evaluateJavaScript(script)) as? Bool ?? false
    }

    func waitForBrowserLoad() async {
        for _ in 0..<100 {
            if browser?.isLoading != true { return }
            try? await Task.sleep(for: .milliseconds(100))
        }
    }

    func waitForBrowserPath(_ path: String) async -> Bool {
        for _ in 0..<100 {
            if browser?.url?.path == path && browser?.isLoading != true { return true }
            try? await Task.sleep(for: .milliseconds(100))
        }
        return false
    }

    func waitForShellBool(_ script: String) async -> Bool {
        for _ in 0..<100 {
            if await evaluateShellBool(script) { return true }
            try? await Task.sleep(for: .milliseconds(100))
        }
        return false
    }

    func waitForBrowserBool(_ script: String) async -> Bool {
        for _ in 0..<100 {
            if await evaluateBrowserBool(script) { return true }
            try? await Task.sleep(for: .milliseconds(100))
        }
        return false
    }

    func writePNG(of view: NSView?, to url: URL) -> Bool {
        guard let view else { return false }
        let bounds = view.bounds
        guard let representation = view.bitmapImageRepForCachingDisplay(in: bounds) else {
            return false
        }
        view.cacheDisplay(in: bounds, to: representation)
        guard let data = representation.representation(using: .png, properties: [:]) else {
            return false
        }
        do {
            try data.write(to: url, options: .atomic)
            return true
        } catch {
            return false
        }
    }

    func runRestartAcceptance(_ options: BrowserAcceptanceOptions, stage: String) async {
        let path = stage == "seed" ? "/cookie/set" : "/cookie/read"
        let url = URL(string: path, relativeTo: options.fixtureURL)!.absoluteURL.absoluteString
        navigate(to: url)
        await waitForBrowserLoad()
        let cookiePresent = await evaluateBrowserBool(
            "JSON.parse(document.body.textContent).present === true"
        )
        let cookieAbsent = await evaluateBrowserBool(
            "JSON.parse(document.body.textContent).present === false"
        )
        let report = BrowserRestartAcceptanceReport(
            browserDataStoreIsNonPersistent: browser?.configuration.websiteDataStore
                !== WKWebsiteDataStore.default(),
            cookieAbsent: cookieAbsent,
            cookiePresent: cookiePresent,
            stage: stage
        )
        if let data = try? JSONEncoder().encode(report) {
            try? data.write(to: options.reportURL, options: .atomic)
        }
        NSApplication.shared.terminate(nil)
    }

    func runAcceptance(_ options: BrowserAcceptanceOptions) async {
        var alphaLoaded = false
        for _ in 0..<100 {
            alphaLoaded = await evaluateShellBool(
                "Boolean(document.querySelector('[aria-label=\"Show Browser Pane\"]'))"
            )
            if alphaLoaded { break }
            try? await Task.sleep(for: .milliseconds(100))
        }
        if options.dock == "bottom" {
            _ = await evaluateShellBool("""
                (() => {
                  const key = 'weave.alpha.docks.v3';
                  const state = JSON.parse(localStorage.getItem(key) || '{}');
                  state.schemaVersion = 3;
                  state.panelPosition = { terminal: 'bottom', browser: 'bottom', project: 'right' };
                  state.projectOpen = false;
                  state.browserOpen = true;
                  state.terminalOpenByScope ||= {};
                  state.activePanelByDock = { bottom: 'browser', right: null };
                  state.rememberedSize ||= { bottom: 32, right: 24 };
                  localStorage.setItem(key, JSON.stringify(state));
                  location.reload();
                  return true;
                })()
                """)
        } else {
            _ = await evaluateShellBool(
                "document.querySelector('[aria-label=\"Show Browser Pane\"]')?.click(); true"
            )
        }
        for _ in 0..<100 {
            if browser?.isHidden == false && (browser?.frame.width ?? 0) > 100 { break }
            try? await Task.sleep(for: .milliseconds(100))
        }
        if let restartStage = options.restartStage {
            await runRestartAcceptance(options, stage: restartStage)
            return
        }
        navigate(to: options.fixtureURL.absoluteString)
        await waitForBrowserLoad()
        let frame = browser?.frame ?? .zero
        let browserPaneMounted = await evaluateShellBool(
            "Boolean(document.querySelector('[data-slot=\"browser-surface-slot\"]'))"
        )
        let surfaceWidth = await evaluateShellNumber(
            "document.querySelector('[data-slot=\"browser-surface-slot\"]')?.getBoundingClientRect().width || 0"
        )
        let surfaceHeight = await evaluateShellNumber(
            "document.querySelector('[data-slot=\"browser-surface-slot\"]')?.getBoundingClientRect().height || 0"
        )
        let slotPresented = browser?.isHidden == false && frame.width > 100 && frame.height > 100
        let slotMatchesSurface = browserPaneMounted
            && abs(frame.width - surfaceWidth) < 1
            && abs(frame.height - surfaceHeight) < 1
        let fixtureLoaded = await evaluateBrowserBool(
            "document.body.dataset.fixture === 'alpha-browser-acceptance'"
        )
        _ = await evaluateBrowserBool(
            "document.querySelector('a[href=\"/page-2?source=fixture\"]')?.click(); true"
        )
        let navigatedToPage2 = await waitForBrowserPath("/page-2")
        let shellBackStateMatched = await waitForShellBool("""
            (() => {
              const address = document.querySelector('[aria-label="Browser address"]');
              const back = document.querySelector('[aria-label="Back"]');
              return address?.value.includes('/page-2?source=fixture') && back?.disabled === false;
            })()
            """)
        _ = await evaluateShellBool(
            "document.querySelector('[aria-label=\"Back\"]')?.click(); true"
        )
        let historyBackReturnedHome = await waitForBrowserPath("/")
        let shellForwardStateMatched = await waitForShellBool(
            "document.querySelector('[aria-label=\"Forward\"]')?.disabled === false"
        )
        _ = await evaluateShellBool(
            "document.querySelector('[aria-label=\"Forward\"]')?.click(); true"
        )
        let historyForwardReturnedPage2 = await waitForBrowserPath("/page-2")
        navigate(to: options.fixtureURL.absoluteString)
        _ = await waitForBrowserPath("/")
        _ = await evaluateBrowserBool(
            "sessionStorage.setItem('alpha-browser-acceptance-reload', 'present'); true"
        )
        _ = await evaluateShellBool(
            "document.querySelector('[aria-label=\"Reload\"]')?.click(); true"
        )
        await waitForBrowserLoad()
        let reloadRecoveredSessionState = await evaluateBrowserBool("""
            document.body.dataset.fixture === 'alpha-browser-acceptance'
              && sessionStorage.getItem('alpha-browser-acceptance-reload') === 'present'
            """)
        let slowURL = URL(string: "/slow?ms=5000", relativeTo: options.fixtureURL)!
            .absoluteURL.absoluteString
        navigate(to: slowURL)
        let stopControlBecameVisible = await waitForShellBool(
            "Boolean(document.querySelector('[aria-label=\"Stop Loading\"]'))"
        )
        _ = await evaluateShellBool(
            "document.querySelector('[aria-label=\"Stop Loading\"]')?.click(); true"
        )
        for _ in 0..<100 {
            if browser?.isLoading != true { break }
            try? await Task.sleep(for: .milliseconds(50))
        }
        let stopCancelledSlowNavigation = stopControlBecameVisible && browser?.isLoading == false
        navigate(to: "https://alpha-browser-acceptance.invalid/")
        for _ in 0..<100 {
            if browserError?.isEmpty == false { break }
            try? await Task.sleep(for: .milliseconds(100))
        }
        let shellPresentedNavigationError = await waitForShellBool(
            "Boolean(document.querySelector('[role=\"alert\"]')?.textContent.trim())"
        )
        let unreachableFailureReportedToShell = browserError?.isEmpty == false
            && shellPresentedNavigationError
        navigate(to: options.fixtureURL.absoluteString)
        _ = await waitForBrowserPath("/")
        let fixtureLoadedAfterFailure = await evaluateBrowserBool(
            "document.body.dataset.fixture === 'alpha-browser-acceptance'"
        )
        let unreachableRecoverySucceeded = browserError == nil && fixtureLoadedAfterFailure
        _ = await evaluateBrowserBool(
            "document.querySelector('a[target=\"_blank\"]')?.click(); true"
        )
        let popupStayedInVisibleSession = await waitForBrowserPath("/popup")
        let popupNoticeReportedToShell = await waitForShellBool(
            "document.querySelector('[role=\"status\"]')?.textContent.includes('current Browser session') === true"
        )
        navigate(to: options.fixtureURL.absoluteString)
        _ = await waitForBrowserPath("/")
        _ = await evaluateBrowserBool(
            "document.querySelector('a[download]')?.click(); true"
        )
        let downloadNoticeReportedToShell = await waitForShellBool(
            "document.querySelector('[role=\"status\"]')?.textContent.includes('Downloads are unavailable') === true"
        )
        let downloadWasBlocked = browser?.url?.path == "/"
        let uploadPolicyReportedToShell = await evaluateShellBool(
            "document.querySelector('[data-slot=\"browser-policy\"]')?.textContent.includes('Upload: system picker') === true"
        )
        _ = await evaluateBrowserBool(
            "document.querySelector('#request-camera')?.click(); true"
        )
        let mediaCaptureWasDenied = await waitForBrowserBool(
            "document.querySelector('#fixture-state')?.textContent.startsWith('permission:camera:denied:') === true"
        )
        let mediaPolicyReportedToShell = await evaluateShellBool(
            "document.querySelector('[data-slot=\"browser-policy\"]')?.textContent.includes('Camera/mic: off') === true"
        )
        try? await Task.sleep(for: .milliseconds(500))
        let frameEmbeddingWasDenied = await evaluateBrowserBool(
            "document.body.dataset.deniedFrameRendered !== 'true'"
        )
        let controlSnapshotCaptured = await evaluateBrowserBool("""
            ['control-input', 'control-apply', 'control-result', 'control-bottom']
              .every((id) => Boolean(document.getElementById(id)))
            """)
        let controlTypeSucceeded = await evaluateBrowserBool("""
            (() => {
              const input = document.querySelector('#control-input');
              input.focus();
              input.value = 'native-probe';
              input.dispatchEvent(new Event('input', { bubbles: true }));
              return input.value === 'native-probe' && document.activeElement === input;
            })()
            """)
        let controlKeySucceeded = await evaluateBrowserBool("""
            (() => {
              const input = document.querySelector('#control-input');
              input.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', bubbles: true, cancelable: true
              }));
              return input.dataset.lastKey === 'Enter';
            })()
            """)
        _ = await evaluateBrowserBool(
            "document.querySelector('#control-apply')?.click(); true"
        )
        let controlClickAndWaitSucceeded = await waitForBrowserBool(
            "document.querySelector('#control-result')?.textContent === 'control:applied:native-probe:key:Enter'"
        )
        let controlScrollSucceeded = await evaluateBrowserBool("""
            (() => {
              document.querySelector('#control-bottom')?.scrollIntoView();
              return window.scrollY > 0;
            })()
            """)
        let cookieSetURL = URL(string: "/cookie/set", relativeTo: options.fixtureURL)!
            .absoluteURL.absoluteString
        navigate(to: cookieSetURL)
        await waitForBrowserLoad()
        let cookieAvailableBeforeReset = await evaluateBrowserBool(
            "JSON.parse(document.body.textContent).present === true"
        )
        _ = await evaluateShellBool(
            "document.querySelector('[aria-label=\"Reset Browser Session\"]')?.click(); true"
        )
        for _ in 0..<100 {
            if browser?.url?.host == "example.com" { break }
            try? await Task.sleep(for: .milliseconds(100))
        }
        let resetClearedHistory = browser?.canGoBack == false && browser?.canGoForward == false
        let cookieReadURL = URL(string: "/cookie/read", relativeTo: options.fixtureURL)!
            .absoluteURL.absoluteString
        navigate(to: cookieReadURL)
        await waitForBrowserLoad()
        let cookieClearedByReset = await evaluateBrowserBool(
            "JSON.parse(document.body.textContent).present === false"
        )
        navigate(to: options.fixtureURL.absoluteString)
        _ = await waitForBrowserPath("/")
        let screenshotWritten = writePNG(of: view.window?.contentView, to: options.screenshotURL)
        let report = BrowserAcceptanceReport(
            alphaLoaded: alphaLoaded,
            browserDataStoreIsNonPersistent: browser?.configuration.websiteDataStore
                !== WKWebsiteDataStore.default(),
            browserPaneMounted: browserPaneMounted,
            controlClickAndWaitSucceeded: controlClickAndWaitSucceeded,
            controlKeySucceeded: controlKeySucceeded,
            controlScrollSucceeded: controlScrollSucceeded,
            controlSnapshotCaptured: controlSnapshotCaptured,
            controlTypeSucceeded: controlTypeSucceeded,
            cookieAvailableBeforeReset: cookieAvailableBeforeReset,
            cookieClearedByReset: cookieClearedByReset,
            downloadNoticeReportedToShell: downloadNoticeReportedToShell,
            downloadWasBlocked: downloadWasBlocked,
            fixtureLoaded: fixtureLoaded,
            frameEmbeddingWasDenied: frameEmbeddingWasDenied,
            historyBackReturnedHome: historyBackReturnedHome,
            historyForwardReturnedPage2: historyForwardReturnedPage2,
            navigatedToPage2: navigatedToPage2,
            mediaCaptureWasDenied: mediaCaptureWasDenied,
            mediaPolicyReportedToShell: mediaPolicyReportedToShell,
            popupNoticeReportedToShell: popupNoticeReportedToShell,
            popupStayedInVisibleSession: popupStayedInVisibleSession,
            reloadRecoveredSessionState: reloadRecoveredSessionState,
            resetClearedHistory: resetClearedHistory,
            screenshotWritten: screenshotWritten,
            shellHistoryStateMatchedBrowser: shellBackStateMatched && shellForwardStateMatched,
            stopCancelledSlowNavigation: stopCancelledSlowNavigation,
            unreachableFailureReportedToShell: unreachableFailureReportedToShell,
            unreachableRecoverySucceeded: unreachableRecoverySucceeded,
            uploadPolicyReportedToShell: uploadPolicyReportedToShell,
            browserHidden: browser?.isHidden ?? true,
            slotHeight: frame.height,
            slotMatchesSurface: slotMatchesSurface,
            slotPresented: slotPresented,
            slotOrientation: frame.width > frame.height * 1.5 ? "bottom" : "right",
            slotWidth: frame.width,
            surfaceHeight: surfaceHeight,
            surfaceWidth: surfaceWidth,
            webViewsAreDistinct: browser.map { $0 !== shell } ?? false
        )
        if let data = try? JSONEncoder().encode(report) {
            try? data.write(to: options.reportURL, options: .atomic)
        }
        NSApplication.shared.terminate(nil)
    }
}
#endif


@MainActor
private final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var controller: BrowserHostController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let controller = BrowserHostController()
#if DEBUG
        let acceptance = BrowserAcceptanceOptions.parse(CommandLine.arguments)
#endif
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1400, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Weave Alpha"
        window.contentViewController = controller
        window.minSize = NSSize(width: 900, height: 600)
        window.setContentSize(NSSize(width: 1400, height: 900))
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.controller = controller
        self.window = window
#if DEBUG
        if let acceptance {
            controller.loadAlphaForAcceptance(at: acceptance.alphaURL)
            Task { @MainActor in await controller.runAcceptance(acceptance) }
        } else {
            controller.loadAlpha()
        }
#else
        controller.loadAlpha()
#endif
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
