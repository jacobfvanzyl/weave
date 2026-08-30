import Foundation
import WebKit

let alphaBrowserDefaultURL = "https://example.com"

@MainActor
enum AlphaBrowserControlPolicy {
    static let maximumElements = 200
    static let maximumTextCharacters = 65_536
    static let contentWorld = WKContentWorld.world(name: "weave.browser.control")
}

let alphaBrowserMediaPolicySource = """
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

let alphaBrowserHumanInputSource = """
(() => {
  const notify = event => {
    if (event.isTrusted) webkit.messageHandlers.alphaBrowserHumanInput.postMessage({});
  };
  addEventListener('pointerdown', notify, true);
  addEventListener('keydown', notify, true);
})();
"""

let alphaBrowserControlSource = """
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
const candidateElements = () => [...document.querySelectorAll('a,button,input:not([type="password"]):not([type="file"]),textarea,select,[role],[tabindex]')]
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
  } else throw new Error('INVALID_TARGET');
  await waitFor(command.expect);
} else if (command.kind === 'see') {
  await waitFor(command.wait);
} else throw new Error('INVALID_TARGET');
const viewId = crypto.randomUUID();
const elements = candidateElements().map((element, index) => describe(element, `${viewId}:${index}`));
const warnings = document.querySelector('iframe') ? ['Cross-origin frame contents are not exposed.'] : [];
return { id: viewId, text: String(document.body?.innerText || '').slice(0, 65536), elements, warnings };
"""

struct AlphaBrowserControlFailure: Error {
    let code: String
    let message: String
}

@MainActor
final class AlphaBrowserControlEngine {
    private(set) var controlRevision = 0
    private var viewId: String?
    private var elements: [String: [String: Any]] = [:]
    private var tasks: [String: Task<Void, Never>] = [:]

    func interrupt() {
        controlRevision += 1
        invalidate()
        for task in tasks.values { task.cancel() }
    }

    func reset() {
        for task in tasks.values { task.cancel() }
        tasks.removeAll()
        controlRevision = 0
        invalidate()
    }

    func invalidate() {
        viewId = nil
        elements.removeAll()
    }

    func cancel(requestId: String) {
        tasks[requestId]?.cancel()
    }

    func start(
        request: [String: Any],
        browser: WKWebView,
        tabId: String,
        generation: Int,
        navigate: @escaping (String) -> Void,
        screenshot: @escaping (WKWebView) async throws -> Data?,
        completion: @escaping ([String: Any]) -> Void
    ) {
        let requestId = request["requestId"] as? String ?? "unknown"
        guard let address = request["address"] as? [String: Any] else {
            completion(failure(requestId, "CONTROL_INTERRUPTED", "Browser control is unavailable."))
            return
        }
        guard address["tabId"] as? String == tabId,
              (request["generation"] as? NSNumber)?.intValue == generation else {
            completion(failure(requestId, "STALE_TAB", "The controlled browser tab changed."))
            return
        }
        guard (request["expectedControlRevision"] as? NSNumber)?.intValue == controlRevision else {
            completion(failure(requestId, "CONTROL_INTERRUPTED", "A person took over the browser."))
            return
        }
        let command = request["command"] as? [String: Any]
        var expectedTarget: Any = NSNull()
        if command?["kind"] as? String == "act" {
            guard command?["viewId"] as? String == viewId else {
                completion(failure(requestId, "STALE_VIEW", "The browser view is stale."))
                return
            }
            if let action = command?["action"] as? [String: Any], let target = action["target"] as? String {
                guard let descriptor = elements[target] else {
                    completion(failure(requestId, "INVALID_TARGET", "The browser target is no longer available."))
                    return
                }
                expectedTarget = descriptor
            }
        }
        tasks[requestId]?.cancel()
        tasks[requestId] = Task { @MainActor [weak self, weak browser] in
            guard let self, let browser else { return }
            defer { self.tasks[requestId] = nil }
            do {
                if command?["kind"] as? String == "see", let url = command?["url"] as? String {
                    navigate(url)
                    let deadline = ISO8601DateFormatter().date(from: request["deadlineAt"] as? String ?? "") ?? Date()
                    while browser.isLoading && Date() < deadline {
                        try await Task.sleep(nanoseconds: 50_000_000)
                    }
                    if browser.isLoading { throw AlphaBrowserControlFailure(code: "TIMEOUT", message: "Browser navigation timed out.") }
                }
                try Task.checkCancellation()
                let projection = try await browser.callAsyncJavaScript(
                    alphaBrowserControlSource,
                    arguments: [
                        "request": request,
                        "previousViewId": self.viewId ?? NSNull(),
                        "expectedTarget": expectedTarget,
                    ],
                    in: nil,
                    contentWorld: AlphaBrowserControlPolicy.contentWorld
                )
                try Task.checkCancellation()
                guard var view = projection as? [String: Any],
                      let nextViewId = view["id"] as? String,
                      let nextElements = view["elements"] as? [[String: Any]] else {
                    throw AlphaBrowserControlFailure(code: "CONTROL_INTERRUPTED", message: "Browser projection was invalid.")
                }
                self.viewId = nextViewId
                self.elements = Dictionary(uniqueKeysWithValues: nextElements.compactMap { element in
                    (element["ref"] as? String).map { ($0, element) }
                })
                view["tabId"] = tabId
                view["generation"] = generation
                view["controlRevision"] = self.controlRevision
                view["url"] = browser.url?.absoluteString ?? alphaBrowserDefaultURL
                view["title"] = browser.title ?? ""
                view["loading"] = browser.isLoading
                view["viewport"] = ["width": Int(browser.bounds.width), "height": Int(browser.bounds.height)]
                if command?["screenshot"] as? Bool == true, let data = try await screenshot(browser) {
                    view["screenshot"] = ["mimeType": "image/png", "data": data.base64EncodedString()]
                }
                try Task.checkCancellation()
                completion([
                    "requestId": requestId,
                    "result": [
                        "requestId": requestId,
                        "leaseId": request["leaseId"] as? String ?? "",
                        "address": address,
                        "view": view,
                    ],
                ])
            } catch {
                let mapped = self.failure(for: error)
                completion(self.failure(requestId, mapped.code, mapped.message))
            }
        }
    }

    private func failure(for error: Error) -> AlphaBrowserControlFailure {
        if error is CancellationError || Task.isCancelled {
            return AlphaBrowserControlFailure(code: "CANCELLED", message: "Browser control was cancelled.")
        }
        if let failure = error as? AlphaBrowserControlFailure { return failure }
        let nativeError = error as NSError
        let message = nativeError.userInfo["WKJavaScriptExceptionMessage"] as? String ?? nativeError.localizedDescription
        if message.contains("STALE_VIEW") { return AlphaBrowserControlFailure(code: "STALE_VIEW", message: "The browser view is stale.") }
        if message.contains("INVALID_TARGET") { return AlphaBrowserControlFailure(code: "INVALID_TARGET", message: "The browser target is no longer available.") }
        if message.contains("WAIT_TIMEOUT") { return AlphaBrowserControlFailure(code: "TIMEOUT", message: "The browser condition timed out.") }
        return AlphaBrowserControlFailure(code: "CONTROL_INTERRUPTED", message: message)
    }

    private func failure(_ requestId: String, _ code: String, _ message: String) -> [String: Any] {
        ["requestId": requestId, "error": ["code": code, "message": message]]
    }
}
