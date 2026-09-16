// WVE-80 capability prototype. Compiled only into explicitly enabled builds.
#if WEAVE_CLIENT_BROWSER_PROTOTYPE
import Foundation
import Observation
import SwiftUI
import WebKit
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@available(macOS 26.0, iOS 26.0, *)
@MainActor
private final class ProbeMessages: NSObject, WKScriptMessageHandler {
    weak var model: ClientBrowserModel?
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        // Passive, bounded fixture reporting; never a native command dispatcher.
        guard let value = message.body as? String, value.utf8.count < 16384 else { return }
        model?.emit(["kind": "fixture", "value": value])
    }
}

@available(macOS 26.0, iOS 26.0, *)
@MainActor @Observable
private final class ProbeDownload: Identifiable {
    let id = UUID().uuidString
    var transfer: WKDownload?
    var name = "Download"
    var destination: URL?
    var state = "downloading"
    var bytes: Int64 = 0
    var failure = ""
    init(_ transfer: WKDownload) { self.transfer = transfer }
    var snapshot: [String: Any] {
        ["id": id, "name": name, "state": state, "bytes": transfer?.progress.completedUnitCount ?? bytes,
         "total": transfer?.progress.totalUnitCount ?? bytes, "path": destination?.path ?? "", "error": failure]
    }
    func cancel() {
        guard let transfer else { return }
        bytes = transfer.progress.completedUnitCount
        self.transfer = nil; state = "cancelled"
        transfer.delegate = nil
        transfer.cancel { _ in }
    }
}

@available(macOS 26.0, iOS 26.0, *)
@MainActor
private struct BrowserPrompt {
    enum Kind { case alert, confirm, text, media }
    let kind: Kind
    let title: String
    let message: String
    let answer: @MainActor (String?) -> Void
}

@available(macOS 26.0, iOS 26.0, *)
@MainActor @Observable
private final class ClientBrowserModel: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    let identity = UUID().uuidString
    let page: WKWebView
    var paneKey: String?
    var address: String
    var committedAddress = ""
    var addressFocusRequest = 0
    var editingAddress = false
    var title = ""
    var loading = false
    var canGoBack = false
    var canGoForward = false
    var error: String?
    var downloads: [ProbeDownload] = []
    var prompt: BrowserPrompt?
    var promptText = ""
    var showFilePicker = false
    var fileMultiple = false
    var fileDirectories = false
    private var fileReply: (@MainActor ([URL]?) -> Void)?
    private var fileAccess: [URL] = []
    private var event: (@MainActor (NSDictionary) -> Void)?
    private var bufferedEvents: [NSDictionary] = []
    private var observations: [NSKeyValueObservation] = []
    private var closed = false
    private var downloadPolicyInterruptions = 0

    init(address: String?, configuration: WKWebViewConfiguration? = nil, paneKey: String? = nil) {
        self.paneKey = paneKey
        let saved = paneKey.flatMap { UserDefaults.standard.dictionary(forKey: "weave.client-browser.panes")?[$0] as? [String: String] }
        self.address = saved?["url"] ?? address ?? "about:blank"
        let config = configuration ?? WKWebViewConfiguration()
        if configuration == nil {
            if paneKey != nil {
                let profileId = saved?["profileId"].flatMap(UUID.init(uuidString:)) ?? UserDefaults.standard.string(forKey: "weave.client-browser.default-profile").flatMap(UUID.init(uuidString:)) ?? UUID()
                UserDefaults.standard.set(profileId.uuidString, forKey: "weave.client-browser.default-profile")
                config.websiteDataStore = WKWebsiteDataStore(forIdentifier: profileId)
            } else { config.websiteDataStore = .nonPersistent() }
        }
#if os(macOS)
        config.preferences.tabFocusesLinks = true
#endif
        config.preferences.isElementFullscreenEnabled = true
        // Keep WebKit's supplied popup configuration and relationship. Only the
        // prototype's passive script-message endpoint needs a fresh owner.
        config.userContentController = WKUserContentController()
        let messages = ProbeMessages()
        config.userContentController.add(messages, name: "weaveClientBrowserProbe")
        page = WKWebView(frame: .zero, configuration: config)
        super.init()
        messages.model = self
        page.navigationDelegate = self; page.uiDelegate = self
        page.allowsBackForwardNavigationGestures = true
        page.isInspectable = true
        observations = [page.observe(\.url, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.refresh() }
        }, page.observe(\.title, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.refresh() }
        }, page.observe(\.isLoading, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.refresh() }
        }]
        if address != nil { navigate() }
    }
    func connect(_ event: @escaping @MainActor (NSDictionary) -> Void) {
        self.event = event
        // Let the shell register the adopted surface before delivering early
        // about:blank/opener messages that arrived during popup construction.
        Task { @MainActor [weak self] in
            guard let self, !closed else { return }
            let pending = bufferedEvents; bufferedEvents.removeAll()
            for value in pending { self.event?(value) }
        }
    }
    func emit(_ value: NSDictionary) {
        guard !closed else { return }
        if let event { event(value) }
        else { bufferedEvents.append(value); if bufferedEvents.count > 100 { bufferedEvents.removeFirst() } }
    }
    private func refresh() {
        guard !closed else { return }
        title = page.title ?? ""; loading = page.isLoading
        canGoBack = page.canGoBack; canGoForward = page.canGoForward
        // The current history item remains committed during provisional loads
        // and also follows same-document navigation such as history.pushState.
        if let url = page.backForwardList.currentItem?.url.absoluteString { recordCommittedAddress(url) }
    }
    private func recordCommittedAddress(_ url: String) {
        committedAddress = url
        if !editingAddress { address = url }
        checkpoint()
    }
    func navigate() {
        guard let url = URL(string: address), ["http", "https", "about"].contains(url.scheme?.lowercased() ?? "") else {
            error = "Enter an HTTP or HTTPS address."; return
        }
        error = nil; page.load(URLRequest(url: url))
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        emit(["kind": "navigation-action", "newWindow": action.targetFrame == nil,
              "download": action.shouldPerformDownload, "method": action.request.httpMethod ?? "GET"])
        if action.shouldPerformDownload { downloadPolicyInterruptions += 1 }
        decisionHandler(action.shouldPerformDownload ? .download : .allow)
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void) {
        let attachment = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().hasPrefix("attachment") == true
        emit(["kind": "navigation-response", "mime": response.response.mimeType ?? "", "attachment": attachment])
        if attachment || !response.canShowMIMEType { downloadPolicyInterruptions += 1 }
        decisionHandler(attachment || !response.canShowMIMEType ? .download : .allow)
    }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { if let url = webView.url?.absoluteString { recordCommittedAddress(url) } }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { if let url = webView.url?.absoluteString { recordCommittedAddress(url) }; refresh(); emit(["kind": "loaded"]) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) { failed(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { failed(error) }
    private func failed(_ error: any Error) {
        let failure = error as NSError
        guard !(failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled) else { return }
        // WebKit's policy interruption is expected only after our own decision
        // to transfer a navigation to WKDownload. Preserve unrelated failures.
        if failure.domain == "WebKitErrorDomain", failure.code == 102, downloadPolicyInterruptions > 0 {
            downloadPolicyInterruptions -= 1; refresh(); return
        }
        self.error = error.localizedDescription; emit(["kind": "error", "message": error.localizedDescription, "domain": failure.domain, "code": failure.code]); refresh()
    }
    private func origin(_ frame: WKFrameInfo) -> String {
        let origin = frame.securityOrigin
        return "\(origin.protocol)://\(origin.host)" + (origin.port == 0 ? "" : ":\(origin.port)")
    }
    private func presentPrompt(_ value: BrowserPrompt) {
        guard prompt == nil, !closed else { value.answer(nil); return }
        prompt = value
    }
    func answerPrompt(_ allow: Bool) {
        let current = prompt; prompt = nil
        current?.answer(allow ? promptText : nil)
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable () -> Void) {
        presentPrompt(.init(kind: .alert, title: origin(frame), message: message, answer: { _ in completionHandler() }))
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (Bool) -> Void) {
        presentPrompt(.init(kind: .confirm, title: origin(frame), message: message, answer: { completionHandler($0 != nil) }))
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt text: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (String?) -> Void) {
        guard prompt == nil else { completionHandler(nil); return }
        promptText = defaultText ?? ""
        presentPrompt(.init(kind: .text, title: origin(frame), message: text, answer: completionHandler))
    }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void) {
        let requested = type == .camera ? "camera" : type == .microphone ? "microphone" : "camera and microphone"
        emit(["kind": "media-permission-request", "origin": self.origin(frame), "requested": requested])
        presentPrompt(.init(kind: .media, title: self.origin(frame), message: "Allow this website to use your \(requested)?", answer: { [weak self] answer in
            self?.emit(["kind": "media-permission-decision", "allowed": answer != nil])
            decisionHandler(answer == nil ? .deny : .grant)
        }))
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void) {
        guard fileReply == nil, !closed else { completionHandler(nil); return }
        fileMultiple = parameters.allowsMultipleSelection; fileDirectories = parameters.allowsDirectories
        fileReply = completionHandler; showFilePicker = true
        emit(["kind": "file-input-request", "origin": origin(frame)])
    }
    func finishFileInput(_ result: Result<[URL], Error>) {
        let reply = fileReply; fileReply = nil; showFilePicker = false
        guard reply != nil else { return }
        switch result {
        case .success(let urls):
            for url in urls where url.startAccessingSecurityScopedResource() { fileAccess.append(url) }
            reply?(urls); emit(["kind": "file-input-selected", "count": urls.count])
        case .failure: reply?(nil); emit(["kind": "file-input-cancelled"])
        }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        error = "The webpage process stopped. Reload to recover."; emit(["kind": "process-terminated"])
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let (token, child) = ClientBrowserPrototype.reservePopup(owner: identity, configuration: configuration) else { return nil }
        emit(["kind": "popup-created", "popupToken": token, "method": action.request.httpMethod ?? "GET"])
        // Do not replay action.request: WebKit loads it in this exact view,
        // preserving POST bodies, opener and initially-blank window semantics.
        return child.page
    }
    func webViewDidClose(_ webView: WKWebView) { emit(["kind": "page-close"]) }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { attach(download) }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { attach(download) }
    private func attach(_ download: WKDownload) {
        guard !closed, downloads.filter({ $0.transfer != nil }).count < 8 else { download.cancel { _ in }; return }
        if downloads.count >= 20 { downloads.removeAll { $0.transfer == nil } }
        downloads.append(ProbeDownload(download)); download.delegate = self
        emit(["kind": "download-started"])
    }
    private func record(_ download: WKDownload) -> ProbeDownload? { downloads.first { $0.transfer === download } }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping @MainActor @Sendable (URL?) -> Void) {
        guard let record = record(download) else { completionHandler(nil); return }
        // Disposable capability destination. Production destination selection,
        // sharing and app-wide download ownership belong to the next milestone.
#if os(macOS)
        let base = FileManager.default.temporaryDirectory
#else
        let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
#endif
        let directory = base.appendingPathComponent("WeaveClientBrowserPrototypeDownloads").appendingPathComponent(record.id)
        let name = (suggestedFilename as NSString).lastPathComponent
        record.name = name.isEmpty || name == "." || name == ".." ? "download" : String(name.prefix(180))
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            record.destination = directory.appendingPathComponent(record.name)
            emit(["kind": "download-destination", "download": record.snapshot])
            completionHandler(record.destination)
        } catch { record.failure = error.localizedDescription; record.state = "failed"; completionHandler(nil) }
    }
    func downloadDidFinish(_ download: WKDownload) {
        guard let record = record(download) else { return }
        record.bytes = (try? record.destination?.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? download.progress.completedUnitCount
        record.state = "complete"; record.transfer = nil; download.delegate = nil
        emit(["kind": "download-complete", "download": record.snapshot])
    }
    func download(_ download: WKDownload, didFailWithError error: any Error, resumeData: Data?) {
        guard let record = record(download) else { return }
        record.bytes = download.progress.completedUnitCount; record.failure = error.localizedDescription
        record.state = "failed"; record.transfer = nil; download.delegate = nil
        emit(["kind": "download-failed", "download": record.snapshot])
    }
    func checkpoint() {
        guard let paneKey, let profileId = page.configuration.websiteDataStore.identifier else { return }
        var records = UserDefaults.standard.dictionary(forKey: "weave.client-browser.panes") ?? [:]
        let record = ["url": committedAddress.isEmpty ? address : committedAddress, "profileId": profileId.uuidString]
        if let previous = records[paneKey] as? [String: String], previous == record { return }
        records[paneKey] = record
        UserDefaults.standard.set(records, forKey: "weave.client-browser.panes")
    }
    func close() {
        checkpoint()
        guard !closed else { return }; closed = true
        answerPrompt(false)
        fileReply?(nil); fileReply = nil; showFilePicker = false
        for url in fileAccess { url.stopAccessingSecurityScopedResource() }; fileAccess.removeAll()
        ClientBrowserPrototype.discardPendingPopups(owner: identity)
        for record in downloads { record.cancel() }
        observations.removeAll(); page.stopLoading()
        page.navigationDelegate = nil; page.uiDelegate = nil
        page.configuration.userContentController.removeScriptMessageHandler(forName: "weaveClientBrowserProbe")
        event = nil; bufferedEvents.removeAll()
    }
}

@available(macOS 26.0, iOS 26.0, *)
private struct NativeWebPage: View {
    let page: WKWebView
    var paneKey: String?
    var body: some View { WebPageRepresentable(page: page) }
}
#if os(macOS)
@available(macOS 26.0, *)
private struct WebPageRepresentable: NSViewRepresentable {
    let page: WKWebView
    var paneKey: String?
    func makeNSView(context: Context) -> WKWebView { page }
    func updateNSView(_ view: WKWebView, context: Context) {}
}
#else
@available(iOS 26.0, *)
private struct WebPageRepresentable: UIViewRepresentable {
    let page: WKWebView
    var paneKey: String?
    func makeUIView(context: Context) -> WKWebView { page }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
#endif

@available(macOS 26.0, iOS 26.0, *)
private struct ClientBrowserContent: View {
    @Bindable var model: ClientBrowserModel
    @FocusState private var addressFocused: Bool
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button { model.page.goBack() } label: { Image(systemName: "chevron.left") }
                    .disabled(!model.canGoBack).accessibilityLabel("Back")
                Button { model.page.goForward() } label: { Image(systemName: "chevron.right") }
                    .disabled(!model.canGoForward).accessibilityLabel("Forward")
                TextField("Address", text: $model.address)
                    .textFieldStyle(.roundedBorder).focused($addressFocused)
                    .accessibilityIdentifier("ClientBrowserAddress")
                    .onSubmit { addressFocused = false; model.navigate() }
                Button { model.loading ? model.page.stopLoading() : { _ = model.page.reload() }() } label: { Image(systemName: model.loading ? "xmark" : "arrow.clockwise") }
                    .accessibilityLabel(model.loading ? "Stop" : "Reload")
            }.padding(8)
            if let error = model.error { Text(error).font(.caption).foregroundStyle(.red).padding(4) }
            NativeWebPage(page: model.page)
            if !model.downloads.isEmpty {
                TimelineView(.periodic(from: .now, by: 0.3)) { _ in
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(model.downloads.suffix(3)) { record in
                            HStack {
                                Text("\(record.name): \(record.state) (\(record.transfer?.progress.completedUnitCount ?? record.bytes) bytes)")
                                    .font(.caption).lineLimit(1)
                                if record.transfer != nil { Button("Cancel") { record.cancel(); model.emit(["kind": "download-cancelled", "download": record.snapshot]) } }
                            }
                        }
                    }.padding(6)
                }
            }
        }.background(.background)
        .alert(model.prompt?.title ?? "Website", isPresented: Binding(get: { model.prompt != nil }, set: { if !$0 { model.answerPrompt(false) } })) {
            if model.prompt?.kind == .text { TextField("Response", text: $model.promptText) }
            Button(model.prompt?.kind == .media ? "Allow" : "OK") { model.answerPrompt(true) }
            if model.prompt?.kind != .alert { Button(model.prompt?.kind == .media ? "Deny" : "Cancel", role: .cancel) { model.answerPrompt(false) } }
        } message: { Text(model.prompt?.message ?? "") }
        .fileImporter(isPresented: $model.showFilePicker, allowedContentTypes: model.fileDirectories ? [.folder] : [.item], allowsMultipleSelection: model.fileMultiple) { model.finishFileInput($0) }
        .onChange(of: model.addressFocusRequest) { _, _ in addressFocused = true }
        .onChange(of: addressFocused) { _, focused in model.editingAddress = focused }
    }
}

#if !os(macOS)
@available(iOS 26.0, *)
@MainActor private final class ClientBrowserTouchObserver: UIGestureRecognizer {
    private let activated: () -> Void
    init(_ activated: @escaping () -> Void) { self.activated = activated; super.init(target: nil, action: nil) }
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) { activated(); state = .failed }
}
#endif

/// Objective-C facade used by both hosts. SwiftUI redraws never create a page.
@available(macOS 26.0, iOS 26.0, *)
@objc(WVClientBrowserPrototype)
@MainActor public final class ClientBrowserPrototype: NSObject {
    private static var pending: [String: (owner: String, model: ClientBrowserModel)] = [:]
    fileprivate static func reservePopup(owner: String, configuration: WKWebViewConfiguration) -> (String, ClientBrowserModel)? {
        guard pending.count < 6 else { return nil }
        let token = UUID().uuidString, child = ClientBrowserModel(address: nil, configuration: configuration)
        pending[token] = (owner, child)
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(15))
            if let expired = pending.removeValue(forKey: token) { expired.model.close() }
        }
        return (token, child)
    }
    fileprivate static func discardPendingPopups(owner: String) {
        let tokens = pending.filter { $0.value.owner == owner }.map(\.key)
        for token in tokens { pending.removeValue(forKey: token)?.model.close() }
    }
    @objc public static func adoptPopup(_ token: String, event: @escaping @MainActor (NSDictionary) -> Void) -> ClientBrowserPrototype? {
        guard let child = pending.removeValue(forKey: token) else { return nil }
        return ClientBrowserPrototype(model: child.model, event: event)
    }
    private let model: ClientBrowserModel
    private var requestedVisible = false
    private var requestedBlocked = false
#if os(macOS)
    private let hosting: NSHostingView<ClientBrowserContent>
    @objc public var view: NSView { hosting }
#else
    private let hosting: UIHostingController<ClientBrowserContent>
    private var touchObserver: ClientBrowserTouchObserver?
    @objc public var view: UIView { hosting.view }
    @objc public func attach(to parent: UIViewController) {
        parent.addChild(hosting); parent.view.addSubview(hosting.view); hosting.didMove(toParent: parent)
    }
#endif
    @objc public convenience init(address: String, event: @escaping @MainActor (NSDictionary) -> Void) {
        self.init(model: ClientBrowserModel(address: address), event: event)
    }
    @objc public convenience init(address: String, paneKey: String, event: @escaping @MainActor (NSDictionary) -> Void) {
        self.init(model: ClientBrowserModel(address: address, paneKey: paneKey), event: event)
    }
    @objc public func bindPane(_ key: String) {
        model.paneKey = key
        // An adopted popup can commit before SwiftUI starts observing changes.
        if !model.committedAddress.isEmpty { model.address = model.committedAddress }
        model.checkpoint()
    }
    @objc public func activate() { model.emit(["kind": "focused"]) }
    @objc public func focusPage() {
#if os(macOS)
        view.window?.makeFirstResponder(model.page)
#endif
        // iPad selection alone must not request the software keyboard.
    }
    private init(model: ClientBrowserModel, event: @escaping @MainActor (NSDictionary) -> Void) {
        self.model = model
#if os(macOS)
        hosting = NSHostingView(rootView: ClientBrowserContent(model: model)); hosting.sizingOptions = []
#else
        hosting = UIHostingController(rootView: ClientBrowserContent(model: model)); hosting.safeAreaRegions = []; hosting.view.backgroundColor = .clear
#endif
        super.init(); view.isHidden = true; model.connect(event)
#if os(macOS)
        view.setAccessibilityIdentifier("ClientBrowserSurface")
#else
        view.accessibilityIdentifier = "ClientBrowserSurface"
        let observer = ClientBrowserTouchObserver { [weak self] in self?.activate() }
        observer.cancelsTouchesInView = false; observer.delaysTouchesBegan = false; observer.delaysTouchesEnded = false
        view.addGestureRecognizer(observer); touchObserver = observer
#endif
    }
    @objc public func present(x: Double, y: Double, width: Double, height: Double, visible: Bool, blocked: Bool) {
        requestedVisible = visible; requestedBlocked = blocked
        view.frame = CGRect(x: x, y: y, width: width, height: height)
        view.isHidden = !visible || blocked || width < 1 || height < 1
#if !os(macOS)
        view.isUserInteractionEnabled = !blocked
#endif
    }
#if os(macOS)
    @objc public func ownsFocus() -> Bool {
        guard !view.isHidden, let responder = view.window?.firstResponder as? NSView else { return false }
        return responder === view || responder.isDescendant(of: view)
    }
    @objc public func focusAddress() { model.addressFocusRequest += 1 }
#endif
    @objc public func snapshot() -> NSDictionary {
        model.checkpoint()
#if os(macOS)
        let focused = ownsFocus()
#else
        func containsResponder(_ view: UIView) -> Bool { view.isFirstResponder || view.subviews.contains(where: containsResponder) }
        let focused = !view.isHidden && containsResponder(view)
#endif
        return ["focused": focused, "pageIdentity": model.identity, "url": model.page.url?.absoluteString ?? "", "title": model.page.title ?? "",
         "loading": model.page.isLoading, "backCount": model.page.backForwardList.backList.count,
         "width": view.frame.width, "height": view.frame.height, "hidden": view.isHidden, "requestedVisible": requestedVisible, "requestedBlocked": requestedBlocked,
         "downloads": model.downloads.map(\.snapshot), "error": model.error ?? "", "renderer": "SwiftUI/WKWebView"]
    }
    @objc public func close() {
        model.close()
#if !os(macOS)
        hosting.willMove(toParent: nil)
#endif
        view.removeFromSuperview()
#if !os(macOS)
        hosting.removeFromParent()
#endif
    }
}
#endif
