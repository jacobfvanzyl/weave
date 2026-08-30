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
private let alphaBrowserHumanInputSource = """
(() => {
  const notify = event => {
    if (event.isTrusted) webkit.messageHandlers.alphaBrowserHumanInput.postMessage({});
  };
  addEventListener('pointerdown', notify, true);
  addEventListener('keydown', notify, true);
})();
"""
private let alphaBrowserControlSource = """
const command = request.command;
const visible = element => {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
};
const describe = (element, ref) => {
  const role = element.getAttribute('role') || ({A:'link',BUTTON:'button',INPUT:'textbox',TEXTAREA:'textbox',SELECT:'combobox'}[element.tagName] || 'control');
  const name = element.getAttribute('aria-label') || element.getAttribute('title') || element.innerText || element.placeholder || '';
  return { ref, role, name: String(name).trim().slice(0, 300), disabled: Boolean(element.disabled), ...('checked' in element ? {checked:Boolean(element.checked)} : {}) };
};
const candidateElements = () => [...document.querySelectorAll('a,button,input,textarea,select,[role],[tabindex]')]
  .filter(visible).slice(0, 200);
const waitFor = async condition => {
  if (!condition) return;
  const deadline = Date.parse(request.deadlineAt);
  while (Date.now() < deadline) {
    if (condition.kind === 'text' && document.body?.innerText.includes(condition.text)) return;
    if (condition.kind === 'url' && location.href.includes(condition.includes)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('WAIT_TIMEOUT');
};
if (command.kind === 'act') {
  if (command.viewId !== previousViewId) throw new Error('STALE_VIEW');
  const action = command.action;
  if (action.kind === 'click' || action.kind === 'fill') {
    const prefix = `${command.viewId}:`;
    const index = action.target.startsWith(prefix) ? Number(action.target.slice(prefix.length)) : -1;
    const target = Number.isSafeInteger(index) && index >= 0 ? candidateElements()[index] : undefined;
    const actual = target ? describe(target, action.target) : undefined;
    const matchesExpected = actual && expectedTarget &&
      actual.ref === expectedTarget.ref && actual.role === expectedTarget.role &&
      actual.name === expectedTarget.name && Boolean(actual.disabled) === Boolean(expectedTarget.disabled) &&
      (actual.checked ?? null) === (expectedTarget.checked ?? null);
    if (!target || !target.isConnected || !visible(target) || !matchesExpected) throw new Error('INVALID_TARGET');
    if (action.kind === 'click') target.click();
    else {
      if (!('value' in target) || target.type === 'password' || target.type === 'file') throw new Error('INVALID_TARGET');
      target.focus(); target.value = action.text;
      target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: action.text }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } else if (action.kind === 'key') {
    const target = document.activeElement || document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: action.key, bubbles: true }));
    target.dispatchEvent(new KeyboardEvent('keyup', { key: action.key, bubbles: true }));
  } else if (action.kind === 'scroll') {
    const distance = action.amount === 'small' ? 160 : innerHeight * 0.8;
    scrollBy({ top: action.direction === 'up' ? -distance : distance, behavior: 'instant' });
  }
  await waitFor(command.expect);
} else {
  await waitFor(command.wait);
}
const viewId = crypto.randomUUID();
const elements = candidateElements().map((element, index) => describe(element, `${viewId}:${index}`));
return { id: viewId, text: String(document.body?.innerText || '').slice(0, 65536), elements, warnings: [] };
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
    private var browserTabId = UUID().uuidString
    private var browserGeneration = 0
    private var controlRevision = 0
    private var browserControlViewId: String?
    private var browserControlElements: [String: [String: Any]] = [:]

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
        if message.name == "alphaBrowserHumanInput" {
            controlRevision += 1
            browserControlViewId = nil
            browserControlElements.removeAll()
            emitBrowserState()
            return
        }
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
            resetBrowser()
        case "control":
            if let request = command["request"] as? [String: Any] { executeBrowserControl(request) }
        case "control.cancel":
            break
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
        let replacement = WKWebView(frame: .zero, configuration: configuration)
        replacement.navigationDelegate = self
        replacement.uiDelegate = self
        replacement.isHidden = true
        replacement.isOpaque = true
        replacement.backgroundColor = .white
        replacement.scrollView.contentInsetAdjustmentBehavior = .never
        browser = replacement
        browserTabId = UUID().uuidString
        browserGeneration += 1
        controlRevision = 0
        browserControlViewId = nil
        browserControlElements.removeAll()
        shell.addSubview(replacement)
        browserError = nil
        browserNotice = nil
        if loadDefault { navigate(to: alphaBrowserDefaultURL) }
    }

    private func resetBrowser() {
        let dataStore = browser?.configuration.websiteDataStore
        dataStore?.removeData(
            ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
            modifiedSince: .distantPast
        ) { [weak self] in
            DispatchQueue.main.async {
                self?.installFreshBrowser(loadDefault: true)
                self?.layoutBrowser()
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
            "url": browser?.url?.absoluteString ?? alphaBrowserDefaultURL,
            "title": browser?.title ?? "",
            "loading": browser?.isLoading ?? false,
            "canGoBack": browser?.canGoBack ?? false,
            "canGoForward": browser?.canGoForward ?? false,
            "tabId": browserTabId,
            "generation": browserGeneration,
            "controlRevision": controlRevision,
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

    private func executeBrowserControl(_ request: [String: Any]) {
        let requestId = request["requestId"] as? String ?? "unknown"
        guard let browser, let address = request["address"] as? [String: Any] else {
            dispatchControlFailure(requestId: requestId, code: "CONTROL_INTERRUPTED", message: "Browser control is unavailable.")
            return
        }
        guard address["tabId"] as? String == browserTabId,
              (request["generation"] as? NSNumber)?.intValue == browserGeneration else {
            dispatchControlFailure(requestId: requestId, code: "STALE_TAB", message: "The controlled browser tab changed.")
            return
        }
        guard (request["expectedControlRevision"] as? NSNumber)?.intValue == controlRevision else {
            dispatchControlFailure(requestId: requestId, code: "CONTROL_INTERRUPTED", message: "A person took over the browser.")
            return
        }
        let command = request["command"] as? [String: Any]
        var expectedTarget: Any = NSNull()
        if command?["kind"] as? String == "act" {
            guard command?["viewId"] as? String == browserControlViewId else {
                dispatchControlFailure(requestId: requestId, code: "STALE_VIEW", message: "The browser view is stale.")
                return
            }
            if let action = command?["action"] as? [String: Any],
               let target = action["target"] as? String {
                guard let descriptor = browserControlElements[target] else {
                    dispatchControlFailure(requestId: requestId, code: "INVALID_TARGET", message: "The browser target is no longer available.")
                    return
                }
                expectedTarget = descriptor
            }
        }
        Task { @MainActor [weak self] in
            guard let self else { return }
            if let command = request["command"] as? [String: Any], command["kind"] as? String == "see",
               let url = command["url"] as? String {
                self.navigate(to: url)
                while browser.isLoading && Date() < (ISO8601DateFormatter().date(from: request["deadlineAt"] as? String ?? "") ?? Date()) {
                    try? await Task.sleep(nanoseconds: 50_000_000)
                }
            }
            do {
                let projection = try await browser.callAsyncJavaScript(
                    alphaBrowserControlSource,
                    arguments: [
                        "request": request,
                        "previousViewId": self.browserControlViewId ?? NSNull(),
                        "expectedTarget": expectedTarget,
                    ],
                    in: nil,
                    contentWorld: .world(name: "weave.browser.control")
                )
                guard var view = projection as? [String: Any] else { throw NSError(domain: "BrowserControl", code: 1) }
                guard let viewId = view["id"] as? String,
                      let elements = view["elements"] as? [[String: Any]] else {
                    throw NSError(domain: "BrowserControl", code: 2)
                }
                self.browserControlViewId = viewId
                self.browserControlElements = Dictionary(uniqueKeysWithValues: elements.compactMap { element in
                    (element["ref"] as? String).map { ($0, element) }
                })
                view["tabId"] = self.browserTabId
                view["generation"] = self.browserGeneration
                view["controlRevision"] = self.controlRevision
                view["url"] = browser.url?.absoluteString ?? alphaBrowserDefaultURL
                view["title"] = browser.title ?? ""
                view["loading"] = browser.isLoading
                view["viewport"] = ["width": Int(browser.bounds.width), "height": Int(browser.bounds.height)]
                if let command = request["command"] as? [String: Any], command["screenshot"] as? Bool == true {
                    let image = try await browser.takeSnapshot(configuration: nil)
                    if let data = image.pngData() {
                        view["screenshot"] = ["mimeType": "image/png", "data": data.base64EncodedString()]
                    }
                }
                let result: [String: Any] = [
                    "requestId": requestId,
                    "leaseId": request["leaseId"] as? String ?? "",
                    "address": address,
                    "view": view,
                ]
                self.dispatchControlResult(requestId: requestId, result: result)
            } catch {
                let failure = self.browserControlFailure(error)
                self.dispatchControlFailure(requestId: requestId, code: failure.code, message: failure.message)
            }
        }
    }

    private func dispatchControlResult(requestId: String, result: [String: Any]) {
        dispatchControlEvent(["requestId": requestId, "result": result])
    }

    private func browserControlFailure(_ error: Error) -> (code: String, message: String) {
        let nativeError = error as NSError
        let message = nativeError.userInfo["WKJavaScriptExceptionMessage"] as? String ?? nativeError.localizedDescription
        if message.contains("STALE_VIEW") { return ("STALE_VIEW", "The browser view is stale.") }
        if message.contains("INVALID_TARGET") { return ("INVALID_TARGET", "The browser target is no longer available.") }
        if message.contains("WAIT_TIMEOUT") { return ("TIMEOUT", "The browser condition timed out.") }
        return ("CONTROL_INTERRUPTED", message)
    }

    private func dispatchControlFailure(requestId: String, code: String, message: String) {
        dispatchControlEvent(["requestId": requestId, "error": ["code": code, "message": message]])
    }

    private func dispatchControlEvent(_ detail: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: detail),
              let json = String(data: data, encoding: .utf8) else { return }
        shell?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('weave:alpha-browser-control-result',{detail:\(json)}))")
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if webView === browser {
            browserControlViewId = nil
            browserControlElements.removeAll()
            emitBrowserState()
        }
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
            if browser?.isHidden == false && (browser?.frame.width ?? 0) > 100 { break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        let surfaceWidth = (try? await shell?.evaluateJavaScript(
            "document.querySelector('[data-slot=\"browser-surface-slot\"]')?.getBoundingClientRect().width || 0"
        )) as? Double ?? 0
        let surfaceHeight = (try? await shell?.evaluateJavaScript(
            "document.querySelector('[data-slot=\"browser-surface-slot\"]')?.getBoundingClientRect().height || 0"
        )) as? Double ?? 0
        let slotPresented = browser?.isHidden == false
            && (browser?.frame.width ?? 0) > 100
            && (browser?.frame.height ?? 0) > 100
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
        let fixtureLoaded = await evaluateAcceptanceBool(
            "document.body.dataset.fixture === 'alpha-browser-acceptance'"
        )
        let controlSnapshotCaptured = await evaluateAcceptanceBool("""
            ['control-input', 'control-apply', 'control-result', 'control-bottom']
              .every((id) => Boolean(document.getElementById(id)))
            """)
        let controlTypeSucceeded = await evaluateAcceptanceBool("""
            (() => {
              const input = document.querySelector('#control-input');
              input.focus();
              input.value = 'native-probe';
              input.dispatchEvent(new Event('input', { bubbles: true }));
              return input.value === 'native-probe' && document.activeElement === input;
            })()
            """)
        let controlKeySucceeded = await evaluateAcceptanceBool("""
            (() => {
              const input = document.querySelector('#control-input');
              input.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', bubbles: true, cancelable: true
              }));
              return input.dataset.lastKey === 'Enter';
            })()
            """)
        _ = await evaluateAcceptanceBool(
            "document.querySelector('#control-apply')?.click(); true"
        )
        var controlClickAndWaitSucceeded = false
        for _ in 0..<100 {
            controlClickAndWaitSucceeded = await evaluateAcceptanceBool(
                "document.querySelector('#control-result')?.textContent === 'control:applied:native-probe:key:Enter'"
            )
            if controlClickAndWaitSucceeded { break }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        let controlScrollSucceeded = await evaluateAcceptanceBool("""
            (() => {
              document.querySelector('#control-bottom')?.scrollIntoView();
              return window.scrollY > 0;
            })()
            """)
        let cookieSetURL = URL(string: "/cookie/set", relativeTo: baseURL)!.absoluteURL
        navigate(to: cookieSetURL.absoluteString)
        await waitForAcceptanceLoad()
        let cookieAvailableBeforeReset = await evaluateAcceptanceBool(
            "JSON.parse(document.body.textContent).present === true"
        )
        let browserBeforeReset = browser
        _ = try? await shell?.evaluateJavaScript(
            "document.querySelector('[aria-label=\"Reset Browser Session\"]')?.click(); true"
        )
        for _ in 0..<100 {
            if browser !== browserBeforeReset { break }
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
            "nativeControlProbeSucceeded": controlSnapshotCaptured
                && controlTypeSucceeded
                && controlKeySucceeded
                && controlClickAndWaitSucceeded
                && controlScrollSucceeded,
            "slotPresented": slotPresented,
            "nativeFrameHeight": browser?.frame.height ?? 0,
            "nativeFrameWidth": browser?.frame.width ?? 0,
            "surfaceHeight": surfaceHeight,
            "surfaceWidth": surfaceWidth,
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
