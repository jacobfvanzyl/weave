import AppKit
import WebKit

private final class AlphaAppSchemeHandler: NSObject, WKURLSchemeHandler {
    private let resourceRoot: URL?

    init(resourceRoot: URL?) {
        self.resourceRoot = resourceRoot?.standardizedFileURL
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard
            let requestURL = urlSchemeTask.request.url,
            requestURL.host == "app",
            let resourceRoot
        else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }

        let requestedPath = requestURL.path == "/" ? "index.html" : String(requestURL.path.dropFirst())
        let resourceURL = resourceRoot.appendingPathComponent(requestedPath).standardizedFileURL
        let rootPath = resourceRoot.path.hasSuffix("/") ? resourceRoot.path : resourceRoot.path + "/"
        guard resourceURL.path.hasPrefix(rootPath), let data = try? Data(contentsOf: resourceURL) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }

        let response = URLResponse(
            url: requestURL,
            mimeType: Self.mimeType(for: resourceURL.pathExtension),
            expectedContentLength: data.count,
            textEncodingName: Self.isText(resourceURL.pathExtension) ? "utf-8" : nil
        )
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private static func mimeType(for pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "html": "text/html"
        case "css": "text/css"
        case "js": "text/javascript"
        case "json": "application/json"
        case "svg": "image/svg+xml"
        case "png": "image/png"
        case "jpg", "jpeg": "image/jpeg"
        case "webp": "image/webp"
        case "woff2": "font/woff2"
        default: "application/octet-stream"
        }
    }

    private static func isText(_ pathExtension: String) -> Bool {
        ["html", "css", "js", "json", "svg"].contains(pathExtension.lowercased())
    }
}
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var delegate: WKScriptMessageHandler?

    init(delegate: WKScriptMessageHandler) {
        self.delegate = delegate
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        delegate?.userContentController(userContentController, didReceive: message)
    }
}

private final class AlphaBrowserTab {
    let id: String
    let generation: Int
    let webView: WKWebView
    var error: String?
    var notice: String?
    var stateObservations: [NSKeyValueObservation] = []

    init(id: String = UUID().uuidString, generation: Int, webView: WKWebView) {
        self.id = id
        self.generation = generation
        self.webView = webView
    }
}

@MainActor
private final class BrowserHostController: NSViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private let root = NSView()
    private let appSchemeHandler: AlphaAppSchemeHandler
    private let shell: WKWebView
    private let browserDataStore = WKWebsiteDataStore.nonPersistent()
    private var browserTabs: [AlphaBrowserTab] = []
    private var selectedBrowserTabId: String?
    private var recentBrowserTabIds: [String] = []
    private var lastBrowserFrame = NSRect.zero
    private var browserPresentationRequested = false
    private var browserResetInProgress = false
    private var nextBrowserGeneration = 0
    private let browserControl = AlphaBrowserControlEngine()

    private var selectedBrowserTab: AlphaBrowserTab? {
        browserTabs.first { $0.id == selectedBrowserTabId }
    }
    private var browser: WKWebView? { selectedBrowserTab?.webView }
    private var browserError: String? {
        get { selectedBrowserTab?.error }
        set { selectedBrowserTab?.error = newValue }
    }
    private var browserNotice: String? {
        get { selectedBrowserTab?.notice }
        set { selectedBrowserTab?.notice = newValue }
    }
    private var browserTabId: String { selectedBrowserTab?.id ?? "" }
    private var browserGeneration: Int { selectedBrowserTab?.generation ?? nextBrowserGeneration }

    override init(nibName nibNameOrNil: NSNib.Name?, bundle nibBundleOrNil: Bundle?) {
        let configuration = WKWebViewConfiguration()
        let appSchemeHandler = AlphaAppSchemeHandler(
            resourceRoot: Bundle.main.resourceURL?.appendingPathComponent("public", isDirectory: true)
        )
        configuration.setURLSchemeHandler(appSchemeHandler, forURLScheme: "weave")
        self.appSchemeHandler = appSchemeHandler
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
            Bundle.main.url(
                forResource: "index",
                withExtension: "html",
                subdirectory: "public"
            ) != nil,
            let indexURL = URL(string: "weave://app/index.html")
        else {
            shell.loadHTMLString(
                "<main style='font:16px system-ui;padding:32px'>Alpha application resources are missing.</main>",
                baseURL: nil
            )
            return
        }
        shell.load(URLRequest(url: indexURL))
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "alphaBrowserHumanInput" {
            browserControl.interrupt()
            if let input = message.body as? [String: Any], input["kind"] as? String == "shortcut" {
                dispatchHumanShortcut(input)
            }
            emitBrowserState()
            return
        }
        guard
            message.name == "alphaBrowser",
            let command = message.body as? [String: Any],
            let type = command["type"] as? String
        else { return }

        if browserResetInProgress,
           !["status", "present", "hide", "open.external", "control.cancel"].contains(type) {
            emitBrowserState()
            return
        }

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
            browserPresentationRequested = false
            browserTabs.forEach { $0.webView.isHidden = true }
        case "tab.new":
            _ = createBrowserTab(after: selectedBrowserTabId, select: true)
            showSelectedBrowser()
            emitBrowserState()
        case "tab.select":
            if let tabId = command["tabId"] as? String { selectBrowserTab(tabId) }
        case "tab.close":
            if let tabId = command["tabId"] as? String { closeBrowserTab(tabId) }
        case "navigate":
            if let value = command["url"] as? String {
                navigate(to: value, tabId: command["tabId"] as? String)
            }
        case "back":
            let target = browser(for: command["tabId"] as? String)
            if target?.canGoBack == true { target?.goBack() }
        case "forward":
            let target = browser(for: command["tabId"] as? String)
            if target?.canGoForward == true { target?.goForward() }
        case "reload":
            browser(for: command["tabId"] as? String)?.reload()
        case "stop":
            browser(for: command["tabId"] as? String)?.stopLoading()
            emitBrowserState()
        case "open.external":
            if let value = command["url"] as? String, let url = URL(string: value) {
                NSWorkspace.shared.open(url)
            }
        case "reset":
            resetBrowser()
        case "control":
            if let request = command["request"] as? [String: Any] { executeBrowserControl(request) }
        case "control.cancel":
            if let requestId = command["requestId"] as? String { browserControl.cancel(requestId: requestId) }
        default:
            break
        }
    }

    private func number(_ value: Any?) -> CGFloat? {
        (value as? NSNumber).map { CGFloat(truncating: $0) }
    }

    private func presentBrowser(cssFrame: NSRect) {
        browserPresentationRequested = true
        if browser == nil && !browserResetInProgress { _ = createBrowserTab(select: true) }
        lastBrowserFrame = cssFrame
        applyLastBrowserFrame()
        showSelectedBrowser()
        emitBrowserState()
    }

    private func applyLastBrowserFrame() {
        let frame = NSRect(
            x: lastBrowserFrame.minX,
            y: root.bounds.height - lastBrowserFrame.minY - lastBrowserFrame.height,
            width: max(0, lastBrowserFrame.width),
            height: max(0, lastBrowserFrame.height)
        ).intersection(root.bounds)
        browserTabs.forEach { $0.webView.frame = frame }
    }

    @discardableResult
    private func createBrowserTab(
        after tabId: String? = nil,
        configuration suppliedConfiguration: WKWebViewConfiguration? = nil,
        select: Bool
    ) -> AlphaBrowserTab {
        let configuration = suppliedConfiguration ?? WKWebViewConfiguration()
        configuration.websiteDataStore = browserDataStore
        if suppliedConfiguration == nil {
            configuration.userContentController.addUserScript(WKUserScript(
                source: alphaBrowserMediaPolicySource,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: false,
                in: .page
            ))
            configuration.userContentController.addUserScript(WKUserScript(
                source: alphaBrowserHumanInputSource,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: false,
                in: .page
            ))
            configuration.userContentController.add(
                WeakMessageHandler(delegate: self),
                name: "alphaBrowserHumanInput"
            )
        }
        let replacement = WKWebView(frame: .zero, configuration: configuration)
        replacement.navigationDelegate = self
        replacement.uiDelegate = self
        replacement.isHidden = true
        nextBrowserGeneration += 1
        let tab = AlphaBrowserTab(generation: nextBrowserGeneration, webView: replacement)
        let insertion = tabId.flatMap { id in browserTabs.firstIndex { $0.id == id } }.map { $0 + 1 }
            ?? browserTabs.endIndex
        browserTabs.insert(tab, at: insertion)
        observeBrowserState(of: tab)
        root.addSubview(replacement, positioned: .above, relativeTo: shell)
        if select {
            selectedBrowserTabId = tab.id
            recordRecentTab(tab.id)
            browserControl.reset()
        }
        applyLastBrowserFrame()
        return tab
    }

    private func observeBrowserState(of tab: AlphaBrowserTab) {
        let stateChanged: @Sendable () -> Void = { [weak self] in
            Task { @MainActor [weak self] in self?.emitBrowserState() }
        }
        tab.stateObservations = [
            tab.webView.observe(\.title, options: [.new]) { _, _ in stateChanged() },
            tab.webView.observe(\.url, options: [.new]) { _, _ in stateChanged() },
            tab.webView.observe(\.canGoBack, options: [.new]) { _, _ in stateChanged() },
            tab.webView.observe(\.canGoForward, options: [.new]) { _, _ in stateChanged() },
            tab.webView.observe(\.isLoading, options: [.new]) { _, _ in stateChanged() },
        ]
    }

    private func browser(for tabId: String?) -> WKWebView? {
        guard let tabId else { return browser }
        return browserTabs.first { $0.id == tabId }?.webView
    }

    private func tab(for webView: WKWebView) -> AlphaBrowserTab? {
        browserTabs.first { $0.webView === webView }
    }

    private func recordRecentTab(_ tabId: String) {
        recentBrowserTabIds.removeAll { $0 == tabId }
        recentBrowserTabIds.append(tabId)
    }

    private func showSelectedBrowser() {
        for tab in browserTabs {
            tab.webView.isHidden = !browserPresentationRequested ||
                tab.id != selectedBrowserTabId || tab.webView.url == nil
        }
    }

    private func selectBrowserTab(_ tabId: String) {
        guard browserTabs.contains(where: { $0.id == tabId }) else { return }
        selectedBrowserTabId = tabId
        recordRecentTab(tabId)
        browserControl.reset()
        showSelectedBrowser()
        emitBrowserState()
    }

    private func closeBrowserTab(_ tabId: String) {
        guard let index = browserTabs.firstIndex(where: { $0.id == tabId }) else { return }
        let wasSelected = selectedBrowserTabId == tabId
        let removed = browserTabs.remove(at: index)
        removed.webView.stopLoading()
        removed.webView.navigationDelegate = nil
        removed.webView.uiDelegate = nil
        removed.webView.removeFromSuperview()
        recentBrowserTabIds.removeAll { $0 == tabId }
        if browserTabs.isEmpty {
            selectedBrowserTabId = nil
            _ = createBrowserTab(select: true)
        } else if wasSelected {
            selectedBrowserTabId = recentBrowserTabIds.last(where: { recent in
                browserTabs.contains { $0.id == recent }
            }) ?? browserTabs[min(index, browserTabs.count - 1)].id
            if let selectedBrowserTabId { recordRecentTab(selectedBrowserTabId) }
        }
        browserControl.reset()
        showSelectedBrowser()
        emitBrowserState()
    }

    private func resetBrowser() {
        guard !browserResetInProgress else { return }
        browserResetInProgress = true
        browserTabs.forEach { tab in
            tab.webView.stopLoading()
            tab.webView.navigationDelegate = nil
            tab.webView.uiDelegate = nil
            tab.webView.removeFromSuperview()
        }
        browserTabs.removeAll()
        selectedBrowserTabId = nil
        recentBrowserTabIds.removeAll()
        browserControl.reset()
        emitBrowserState()
        browserDataStore.removeData(
            ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
            modifiedSince: .distantPast
        ) { [weak self] in
            DispatchQueue.main.async {
                self?.browserResetInProgress = false
                _ = self?.createBrowserTab(select: true)
                self?.applyLastBrowserFrame()
                self?.showSelectedBrowser()
                self?.emitBrowserState()
            }
        }
    }

    private func navigate(to rawValue: String, tabId: String? = nil) {
        if browserTabs.isEmpty { _ = createBrowserTab(select: true) }
        guard let targetTab = tabId.flatMap({ id in browserTabs.first { $0.id == id } }) ?? selectedBrowserTab else {
            return
        }
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let candidate = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard
            let url = URL(string: candidate),
            let scheme = url.scheme?.lowercased(),
            scheme == "http" || scheme == "https"
        else {
            targetTab.error = "Invalid web URL: \(rawValue)"
            targetTab.notice = nil
            emitBrowserState()
            return
        }
        targetTab.error = nil
        targetTab.notice = nil
        targetTab.webView.isHidden = !browserPresentationRequested || targetTab.id != selectedBrowserTabId
        targetTab.webView.load(URLRequest(url: url))
        emitBrowserState()
    }

    private func emitBrowserState() {
        DispatchQueue.main.async { [weak self] in
            self?.dispatchBrowserState()
        }
    }

    private func dispatchBrowserState() {
        let tabs = browserTabs.map { tab -> [String: Any] in
            var state: [String: Any] = [
                "id": tab.id,
                "url": tab.webView.url?.absoluteString ?? "",
                "title": tab.webView.title ?? "",
                "loading": tab.webView.isLoading,
                "canGoBack": tab.webView.canGoBack,
                "canGoForward": tab.webView.canGoForward,
                "generation": tab.generation,
                "controlRevision": browserControl.controlRevision,
            ]
            if let notice = tab.notice { state["notice"] = notice }
            if let error = tab.error { state["error"] = error }
            return state
        }
        let state: [String: Any] = [
            "supported": true,
            "tabs": tabs,
            "selectedTabId": selectedBrowserTabId ?? "",
            "policy": [
                "popups": "new-tab",
                "uploads": "system-picker",
                "downloads": "unavailable",
                "mediaPermissions": "denied",
                "otherPermissions": "webkit-default",
            ],
        ]
        guard
            let data = try? JSONSerialization.data(withJSONObject: state),
            let json = String(data: data, encoding: .utf8)
        else { return }
        shell.evaluateJavaScript(
            "window.dispatchEvent(new CustomEvent('weave:alpha-browser-state',{detail:\(json)}))"
        )
    }

    private func executeBrowserControl(_ request: [String: Any]) {
        guard let browser else {
            let requestId = request["requestId"] as? String ?? "unknown"
            dispatchControlEvent([
                "requestId": requestId,
                "error": ["code": "CONTROL_INTERRUPTED", "message": "Browser control is unavailable."],
            ])
            return
        }
        browserControl.start(
            request: request,
            browser: browser,
            tabId: browserTabId,
            generation: browserGeneration,
            navigate: { [weak self] url in self?.navigate(to: url) },
            screenshot: { webView in
                let image = try await webView.takeSnapshot(configuration: nil)
                guard let tiff = image.tiffRepresentation,
                      let representation = NSBitmapImageRep(data: tiff) else { return nil }
                return representation.representation(using: .png, properties: [:])
            },
            completion: { [weak self] detail in self?.dispatchControlEvent(detail) }
        )
    }

    private func dispatchControlEvent(_ detail: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: detail),
              let json = String(data: data, encoding: .utf8) else { return }
        shell.evaluateJavaScript("window.dispatchEvent(new CustomEvent('weave:alpha-browser-control-result',{detail:\(json)}))")
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if webView === browser { browserControl.invalidate() }
        if let tab = tab(for: webView) {
            tab.notice = nil
            showSelectedBrowser()
            emitBrowserState()
        }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
        guard let tab = tab(for: webView) else {
            decisionHandler(.allow)
            return
        }
        if navigationAction.shouldPerformDownload {
            reportUnsupportedDownload(in: tab)
            decisionHandler(.cancel)
            return
        }
        let isTopLevel = navigationAction.targetFrame?.isMainFrame ?? true
        if isTopLevel, let url = navigationAction.request.url, !isAllowedWebURL(url) {
            dispatchExternalRequest(url)
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
        guard let tab = tab(for: webView) else {
            decisionHandler(.allow)
            return
        }
        let disposition = (navigationResponse.response as? HTTPURLResponse)?
            .value(forHTTPHeaderField: "Content-Disposition")?
            .lowercased()
        if disposition?.contains("attachment") == true {
            reportUnsupportedDownload(in: tab)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let tab = tab(for: webView) {
            tab.error = nil
            emitBrowserState()
        }
    }

    func webView(_ webView: WKWebView, didReceiveServerRedirectForProvisionalNavigation navigation: WKNavigation!) {
        if tab(for: webView) != nil { emitBrowserState() }
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        if tab(for: webView) != nil { emitBrowserState() }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        navigationFailed(in: webView, error: error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        navigationFailed(in: webView, error: error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if let tab = tab(for: webView) {
            tab.error = "The browser content process stopped. Reload to continue."
            emitBrowserState()
        }
    }

    private func navigationFailed(in webView: WKWebView, error: Error) {
        let failure = error as NSError
        if failure.code == NSURLErrorCancelled { return }
        if let tab = tab(for: webView) {
            tab.error = error.localizedDescription
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

    private func reportUnsupportedDownload(in tab: AlphaBrowserTab) {
        tab.error = nil
        tab.notice = "Downloads are unavailable in Alpha Browser."
        emitBrowserState()
    }

    private func dispatchExternalRequest(_ url: URL) {
        guard let data = try? JSONSerialization.data(withJSONObject: url.absoluteString),
              let json = String(data: data, encoding: .utf8) else { return }
        shell.evaluateJavaScript(
            "window.dispatchEvent(new CustomEvent('weave:alpha-browser-open-external',{detail:\(json)}))"
        )
    }

    private func dispatchHumanShortcut(_ shortcut: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: shortcut),
              let json = String(data: data, encoding: .utf8) else { return }
        shell.evaluateJavaScript("""
            (() => {
              const value = \(json);
              window.dispatchEvent(new KeyboardEvent('keydown', value));
            })()
            """)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let sourceTab = tab(for: webView),
           navigationAction.targetFrame == nil,
           let requestURL = navigationAction.request.url {
            guard isAllowedWebURL(requestURL) else {
                dispatchExternalRequest(requestURL)
                return nil
            }
            sourceTab.error = nil
            sourceTab.notice = nil
            let popup = createBrowserTab(
                after: sourceTab.id,
                configuration: configuration,
                select: true
            )
            showSelectedBrowser()
            emitBrowserState()
            return popup.webView
        }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void
    ) {
        guard let tab = tab(for: webView) else {
            completionHandler(nil)
            return
        }
        tab.error = nil
        tab.notice = "Choose files with the macOS system picker."
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
        if let tab = tab(for: webView) {
            tab.error = nil
            tab.notice = "Camera and microphone access is denied in Alpha Browser."
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
    let multiTabLifecycleSucceeded: Bool
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
    let slotX: Double
    let slotY: Double
    let surfaceHeight: Double
    let surfaceWidth: Double
    let surfaceX: Double
    let surfaceY: Double
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
            if browser != nil && (browser?.frame.width ?? 0) > 100 { break }
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
        let surfaceX = await evaluateShellNumber(
            "document.querySelector('[data-slot=\"browser-surface-slot\"]')?.getBoundingClientRect().x || 0"
        )
        let surfaceY = await evaluateShellNumber(
            "document.querySelector('[data-slot=\"browser-surface-slot\"]')?.getBoundingClientRect().y || 0"
        )
        let slotPresented = browser?.isHidden == false && frame.width > 100 && frame.height > 100
        let expectedNativeY = root.bounds.height - surfaceY - surfaceHeight
        let slotMatchesSurface = browserPaneMounted
            && abs(frame.width - surfaceWidth) < 1
            && abs(frame.height - surfaceHeight) < 1
            && abs(frame.minX - surfaceX) < 1
            && abs(frame.minY - expectedNativeY) < 1
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
        let popupSourceTabId = selectedBrowserTabId
        let popupTabCount = browserTabs.count
        _ = await evaluateBrowserBool(
            "document.querySelector('a[target=\"_blank\"]')?.click(); true"
        )
        let popupStayedInVisibleSession = await waitForBrowserPath("/popup")
            && browserTabs.count == popupTabCount + 1
            && selectedBrowserTabId != popupSourceTabId
            && browserTabs.first(where: { $0.id == popupSourceTabId })?.webView.url?.path == "/"
        let popupNoticeReportedToShell = await waitForShellBool(
            "document.querySelectorAll('[role=\"tab\"]').length >= 2"
        )
        let popupTabId = selectedBrowserTabId
        let tabsShareProfile = browserTabs.allSatisfy {
            $0.webView.configuration.websiteDataStore === browserDataStore
        }
        if let popupSourceTabId { selectBrowserTab(popupSourceTabId) }
        if let popupTabId { selectBrowserTab(popupTabId); closeBrowserTab(popupTabId) }
        let multiTabLifecycleSucceeded = popupStayedInVisibleSession
            && tabsShareProfile
            && selectedBrowserTabId == popupSourceTabId
            && browserTabs.count == popupTabCount
        _ = await evaluateBrowserBool(
            "document.querySelector('a[download]')?.click(); true"
        )
        let downloadNoticeReportedToShell = await waitForShellBool(
            "document.querySelector('[role=\"status\"]')?.textContent.includes('Downloads are unavailable') === true"
        )
        let downloadWasBlocked = browser?.url?.path == "/"
        _ = await evaluateShellBool(
            "document.querySelector('[aria-label=\"Browser Options\"]')?.click(); true"
        )
        let uploadPolicyReportedToShell = await waitForShellBool(
            "document.body.textContent.includes('Uploads use the system picker') === true"
        )
        let mediaPolicyReportedToShell = await waitForShellBool(
            "document.body.textContent.includes('Downloads and camera/microphone are unavailable') === true"
        )
        _ = await evaluateShellBool(
            "document.querySelector('[aria-label=\"Browser Options\"]')?.click(); true"
        )
        _ = await evaluateBrowserBool(
            "document.querySelector('#request-camera')?.click(); true"
        )
        let mediaCaptureWasDenied = await waitForBrowserBool(
            "document.querySelector('#fixture-state')?.textContent.startsWith('permission:camera:denied:') === true"
        )
        try? await Task.sleep(for: .milliseconds(500))
        let frameEmbeddingWasDenied = await evaluateBrowserBool(
            "document.body.dataset.deniedFrameRendered !== 'true'"
        )
        let cookieSetURL = URL(string: "/cookie/set", relativeTo: options.fixtureURL)!
            .absoluteURL.absoluteString
        navigate(to: cookieSetURL)
        await waitForBrowserLoad()
        let cookieAvailableBeforeReset = await evaluateBrowserBool(
            "JSON.parse(document.body.textContent).present === true"
        )
        let browserBeforeReset = browser
        resetBrowser()
        for _ in 0..<100 {
            if let browser, browser !== browserBeforeReset { break }
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
            multiTabLifecycleSucceeded: multiTabLifecycleSucceeded,
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
            slotX: frame.minX,
            slotY: frame.minY,
            surfaceHeight: surfaceHeight,
            surfaceWidth: surfaceWidth,
            surfaceX: surfaceX,
            surfaceY: surfaceY,
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
