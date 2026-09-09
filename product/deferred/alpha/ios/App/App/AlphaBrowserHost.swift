import UIKit
import WebKit

private final class WeakAlphaBrowserMessageHandler: NSObject, WKScriptMessageHandler {
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

final class AlphaBrowserHost: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private weak var shell: WKWebView?
    private let browserDataStore = WKWebsiteDataStore.nonPersistent()
    private var browserTabs: [AlphaBrowserTab] = []
    private var selectedBrowserTabId: String?
    private var recentBrowserTabIds: [String] = []
    private var lastBrowserFrame = CGRect.zero
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
        guard let shell else { return }
        browserTabs.forEach { $0.webView.frame = lastBrowserFrame.intersection(shell.bounds) }
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
            presentBrowser(cssFrame: CGRect(x: x, y: y, width: width, height: height))
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
                UIApplication.shared.open(url)
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

    private func presentBrowser(cssFrame: CGRect) {
        browserPresentationRequested = true
        if browser == nil && !browserResetInProgress { _ = createBrowserTab(select: true) }
        lastBrowserFrame = cssFrame
        layoutBrowser()
        showSelectedBrowser()
#if DEBUG
        print("AlphaBrowserHost: presenting frame \(cssFrame)")
#endif
        emitBrowserState()
    }

    @discardableResult
    private func createBrowserTab(
        after tabId: String? = nil,
        configuration suppliedConfiguration: WKWebViewConfiguration? = nil,
        select: Bool
    ) -> AlphaBrowserTab? {
        guard let shell else { return nil }
        let configuration = suppliedConfiguration ?? WKWebViewConfiguration()
        configuration.websiteDataStore = browserDataStore
        configuration.allowsInlineMediaPlayback = true
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
                WeakAlphaBrowserMessageHandler(delegate: self),
                name: "alphaBrowserHumanInput"
            )
        }
        let replacement = WKWebView(frame: .zero, configuration: configuration)
        replacement.navigationDelegate = self
        replacement.uiDelegate = self
        replacement.isHidden = true
        replacement.isOpaque = true
        replacement.backgroundColor = .white
        replacement.scrollView.contentInsetAdjustmentBehavior = .never
        nextBrowserGeneration += 1
        let tab = AlphaBrowserTab(generation: nextBrowserGeneration, webView: replacement)
        let insertion = tabId.flatMap { id in browserTabs.firstIndex { $0.id == id } }.map { $0 + 1 }
            ?? browserTabs.endIndex
        browserTabs.insert(tab, at: insertion)
        observeBrowserState(of: tab)
        shell.addSubview(replacement)
        if select {
            selectedBrowserTabId = tab.id
            recordRecentTab(tab.id)
            browserControl.reset()
        }
        layoutBrowser()
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
                self?.layoutBrowser()
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
        shell?.evaluateJavaScript(
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
                return image.pngData()
            },
            completion: { [weak self] detail in self?.dispatchControlEvent(detail) }
        )
    }

    private func dispatchControlEvent(_ detail: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: detail),
              let json = String(data: data, encoding: .utf8) else { return }
        shell?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('weave:alpha-browser-control-result',{detail:\(json)}))")
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

    func webView(_ webView: WKWebView, didReceiveServerRedirectForProvisionalNavigation navigation: WKNavigation!) {
        if tab(for: webView) != nil { emitBrowserState() }
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        if tab(for: webView) != nil { emitBrowserState() }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let tab = tab(for: webView) {
            tab.error = nil
#if DEBUG
            print("AlphaBrowserHost: loaded \(webView.url?.absoluteString ?? "blank tab")")
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
        if let tab = tab(for: webView) {
            tab.error = "The browser content process stopped. Reload to continue."
            emitBrowserState()
        }
    }

    private func navigationFailed(in webView: WKWebView, error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        if let tab = tab(for: webView) {
            tab.error = error.localizedDescription
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

    private func reportUnsupportedDownload(in tab: AlphaBrowserTab) {
        tab.error = nil
        tab.notice = "Downloads are unavailable in Alpha Browser."
        emitBrowserState()
    }

    private func dispatchExternalRequest(_ url: URL) {
        guard let data = try? JSONSerialization.data(withJSONObject: url.absoluteString),
              let json = String(data: data, encoding: .utf8) else { return }
        shell?.evaluateJavaScript(
            "window.dispatchEvent(new CustomEvent('weave:alpha-browser-open-external',{detail:\(json)}))"
        )
    }

    private func dispatchHumanShortcut(_ shortcut: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: shortcut),
              let json = String(data: data, encoding: .utf8) else { return }
        shell?.evaluateJavaScript("""
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
            return popup?.webView
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
        if let tab = tab(for: webView) {
            tab.error = nil
            tab.notice = "Camera and microphone access is denied in Alpha Browser."
            emitBrowserState()
        }
        decisionHandler(.deny)
    }
}

#if DEBUG
extension AlphaBrowserHost {
    @MainActor
    func runAcceptance(baseURL: URL, stage: String) async -> [String: Any] {
        for _ in 0..<100 {
            let alphaLoaded = (try? await shell?.evaluateJavaScript(
                "Boolean(document.querySelector('[aria-label=\"Show Browser Pane\"]'))"
            )) as? Bool ?? false
            if alphaLoaded { break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        _ = try? await shell?.evaluateJavaScript("""
            (() => {
              const key = 'weave.alpha.docks.v3';
              const state = JSON.parse(localStorage.getItem(key) || '{}');
              state.schemaVersion = 3;
              state.panelPosition = { terminal: 'bottom', browser: 'right', project: 'right' };
              state.projectOpen = false;
              state.browserOpen = true;
              state.terminalOpenByScope ||= {};
              state.activePanelByDock = { bottom: null, right: 'browser' };
              state.rememberedSize ||= { bottom: 32, right: 24 };
              localStorage.setItem(key, JSON.stringify(state));
              location.reload();
              return true;
            })()
            """)
        var requestedOpen = false
        var requestedThread = false
        for _ in 0..<100 {
            let surfaceMounted = (try? await shell?.evaluateJavaScript(
                "Boolean(document.querySelector('[data-slot=\"browser-surface-slot\"]'))"
            )) as? Bool ?? false
            if surfaceMounted { break }
            if !requestedOpen {
                let showControlEnabled = (try? await shell?.evaluateJavaScript(
                    "document.querySelector('[aria-label=\"Show Browser Pane\"]')?.disabled === false"
                )) as? Bool ?? false
                if showControlEnabled {
                    _ = try? await shell?.evaluateJavaScript(
                        "document.querySelector('[aria-label=\"Show Browser Pane\"]')?.click(); true"
                    )
                    requestedOpen = true
                } else if !requestedThread {
                    let selectedThread = (try? await shell?.evaluateJavaScript("""
                        (() => {
                          const thread = document.querySelector(
                            '[data-sidebar="content"] [data-sidebar="menu-button"]:not([aria-label])'
                          );
                          thread?.click();
                          return Boolean(thread);
                        })()
                        """)) as? Bool ?? false
                    requestedThread = selectedThread
                }
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        for _ in 0..<100 {
            if browser != nil && (browser?.frame.width ?? 0) > 100 { break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        var slotPresented = false
        if stage == "seed" || stage == "verify" {
            let path = stage == "seed" ? "/cookie/set" : "/cookie/read"
            let url = URL(string: path, relativeTo: baseURL)!.absoluteURL
            navigate(to: url.absoluteString)
            await waitForAcceptanceLoad()
            return [
                "browserDataStoreIsNonPersistent": browser?.configuration.websiteDataStore
                    !== WKWebsiteDataStore.default(),
                "cookieAbsent": await evaluateAcceptanceBool(
                    "JSON.parse(document.body.textContent).present === false"
                ),
                "cookiePresent": await evaluateAcceptanceBool(
                    "JSON.parse(document.body.textContent).present === true"
                ),
                "stage": stage,
            ]
        }
        navigate(to: baseURL.absoluteString)
        await waitForAcceptanceLoad()
        try? await Task.sleep(nanoseconds: 250_000_000)
        let surfaceWidth = (try? await shell?.evaluateJavaScript(
            "document.querySelector('[data-slot=\"browser-surface-slot\"]')?.getBoundingClientRect().width || 0"
        )) as? Double ?? 0
        let surfaceHeight = (try? await shell?.evaluateJavaScript(
            "document.querySelector('[data-slot=\"browser-surface-slot\"]')?.getBoundingClientRect().height || 0"
        )) as? Double ?? 0
        let surfaceX = (try? await shell?.evaluateJavaScript(
            "document.querySelector('[data-slot=\"browser-surface-slot\"]')?.getBoundingClientRect().x || 0"
        )) as? Double ?? 0
        let surfaceY = (try? await shell?.evaluateJavaScript(
            "document.querySelector('[data-slot=\"browser-surface-slot\"]')?.getBoundingClientRect().y || 0"
        )) as? Double ?? 0
        let slotFrame = browser?.frame ?? .zero
        slotPresented = browser?.isHidden == false
            && slotFrame.width > 100
            && slotFrame.height > 100
        let slotMatchesSurface = abs(slotFrame.width - surfaceWidth) < 1
            && abs(slotFrame.height - surfaceHeight) < 1
            && abs(slotFrame.minX - surfaceX) < 1
            && abs(slotFrame.minY - surfaceY) < 1
        let fixtureLoaded = await evaluateAcceptanceBool(
            "document.body.dataset.fixture === 'alpha-browser-acceptance'"
        )
        let firstTabId = selectedBrowserTabId
        let firstBrowser = browser
        let sourceTabIndex = firstTabId.flatMap { id in browserTabs.firstIndex { $0.id == id } }
        let initialTabCount = browserTabs.count
        _ = await evaluateAcceptanceBool(
            "document.querySelector('a[target=\"_blank\"]')?.click(); true"
        )
        for _ in 0..<100 {
            if browserTabs.count == initialTabCount + 1,
               selectedBrowserTabId != firstTabId,
               browser?.url?.path == "/popup",
               browser?.isLoading != true {
                break
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        let popupTab = selectedBrowserTab
        let popupTabIndex = popupTab.flatMap { popup in browserTabs.firstIndex { $0.id == popup.id } }
        let popupTabCreated = browserTabs.count == initialTabCount + 1
        let popupTabSelected = popupTab?.id != firstTabId
            && popupTab?.id == selectedBrowserTabId
        let popupTabAdjacent = popupTabIndex == sourceTabIndex.map { $0 + 1 }
        let popupSourcePreserved = firstBrowser?.url?.path == "/"
        let inactiveTabHidden = firstBrowser?.isHidden == true
        let popupLoaded = popupTab?.webView.url?.path == "/popup"
            && popupTab?.webView.isHidden == false
        let tabsShareProfile = browserTabs.allSatisfy {
            $0.webView.configuration.websiteDataStore === browserDataStore
        }
        if let popupTab { closeBrowserTab(popupTab.id) }
        let popupCloseRestoredSource = selectedBrowserTabId == firstTabId
            && browserTabs.count == initialTabCount
        let multiTabLifecycleSucceeded = popupTabCreated
            && popupTabSelected
            && popupTabAdjacent
            && popupSourcePreserved
            && inactiveTabHidden
            && popupLoaded
            && tabsShareProfile
            && popupCloseRestoredSource
        let cookieSetURL = URL(string: "/cookie/set", relativeTo: baseURL)!.absoluteURL
        navigate(to: cookieSetURL.absoluteString)
        await waitForAcceptanceLoad()
        let cookieAvailableBeforeReset = await evaluateAcceptanceBool(
            "JSON.parse(document.body.textContent).present === true"
        )
        let browserBeforeReset = browser
        resetBrowser()
        for _ in 0..<100 {
            if let browser, browser !== browserBeforeReset { break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        let cookieReadURL = URL(string: "/cookie/read", relativeTo: baseURL)!.absoluteURL
        navigate(to: cookieReadURL.absoluteString)
        await waitForAcceptanceLoad()
        let cookieClearedByReset = await evaluateAcceptanceBool(
            "JSON.parse(document.body.textContent).present === false"
        )
        navigate(to: baseURL.absoluteString)
        await waitForAcceptanceLoad()
        return [
            "browserDataStoreIsNonPersistent": browser?.configuration.websiteDataStore
                !== WKWebsiteDataStore.default(),
            "cookieAvailableBeforeReset": cookieAvailableBeforeReset,
            "cookieClearedByReset": cookieClearedByReset,
            "fixtureLoaded": fixtureLoaded,
            "multiTabLifecycleSucceeded": multiTabLifecycleSucceeded,
            "popupCloseRestoredSource": popupCloseRestoredSource,
            "popupLoaded": popupLoaded,
            "popupSourcePreserved": popupSourcePreserved,
            "popupTabAdjacent": popupTabAdjacent,
            "popupTabCreated": popupTabCreated,
            "popupTabSelected": popupTabSelected,
            "inactiveTabHidden": inactiveTabHidden,
            "tabsShareProfile": tabsShareProfile,
            "slotPresented": slotPresented,
            "slotMatchesSurface": slotMatchesSurface,
            "nativeFrameHeight": slotFrame.height,
            "nativeFrameWidth": slotFrame.width,
            "nativeFrameX": slotFrame.minX,
            "nativeFrameY": slotFrame.minY,
            "surfaceHeight": surfaceHeight,
            "surfaceWidth": surfaceWidth,
            "surfaceX": surfaceX,
            "surfaceY": surfaceY,
        ]
    }

    @MainActor
    private func waitForAcceptanceLoad() async {
        for _ in 0..<100 {
            if browser?.isLoading != true { return }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    @MainActor
    private func evaluateAcceptanceBool(_ script: String) async -> Bool {
        guard let browser else { return false }
        return (try? await browser.evaluateJavaScript(script)) as? Bool ?? false
    }
}
#endif
