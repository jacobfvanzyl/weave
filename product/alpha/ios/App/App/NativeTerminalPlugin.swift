import Capacitor
import UIKit
import WebKit

private final class GhosttyTerminalTextView: UITextView {
    let terminal: WeaveTerminalRenderer
    var sendInput: ((String) -> Void)?
    var resized: ((Int, Int) -> Void)?
    var didFocus: (() -> Void)?
    private var updatingFrame = false
    private var panRemainder: CGFloat = 0

    init(terminal: WeaveTerminalRenderer) {
        self.terminal = terminal
        super.init(frame: .zero, textContainer: nil)
        backgroundColor = UIColor(red: 30/255, green: 30/255, blue: 46/255, alpha: 1)
        font = UIFont(name: "Menlo-Regular", size: 13)
        textColor = .clear // TextKit keeps selection/accessibility; CoreText draws glyphs.
        textContainerInset = UIEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
        textContainer.lineFragmentPadding = 0
        isScrollEnabled = false
        autocorrectionType = .no
        autocapitalizationType = .none
        spellCheckingType = .no
        smartQuotesType = .no
        smartDashesType = .no
        smartInsertDeleteType = .no
        accessibilityLabel = "Terminal input"
        terminal.writeInput = { [weak self] data in self?.sendInput?(data.base64EncodedString()) }
        let pan = UIPanGestureRecognizer(target: self, action: #selector(scrollTerminal(_:)))
        pan.minimumNumberOfTouches = 2
        addGestureRecognizer(pan)
    }
    required init?(coder: NSCoder) { fatalError("Not a storyboard view") }
    override var canBecomeFirstResponder: Bool { true }
    override func becomeFirstResponder() -> Bool {
        let focused = super.becomeFirstResponder()
        if focused { didFocus?() }
        return focused
    }
    override func caretRect(for position: UITextPosition) -> CGRect { .zero }
    override func draw(_ rect: CGRect) {
        if let context = UIGraphicsGetCurrentContext() { terminal.draw(in: context, size: bounds.size) }
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        let previous = (terminal.columns, terminal.rows)
        if terminal.resize(to: bounds.size), previous != (terminal.columns, terminal.rows) {
            refreshText()
            resized?(Int(terminal.columns), Int(terminal.rows))
        }
    }
    func consume(_ data: Data, reset: Bool, cols: Int = 0, rows: Int = 0) -> Bool {
        guard (reset && cols > 0 ? terminal.restore(data, columns: UInt(cols), rows: UInt(rows)) : terminal.consume(data, reset: reset)) else { return false }
        refreshText()
        return true
    }
    private func refreshText() {
        guard !updatingFrame else { return }
        updatingFrame = true
        // TextKit supplies native selection, copy and accessibility; libghostty
        // owns the screen/cursor and CoreText owns all visible terminal drawing.
        let visible = terminal.visibleText
        if markedTextRange == nil, text != visible {
            let selection = selectedRange
            text = visible
            let start = min(selection.location, (text as NSString).length)
            selectedRange = NSRange(location: start, length: min(selection.length, (text as NSString).length - start))
        }
        setNeedsDisplay()
        updatingFrame = false
    }
    private func input(_ value: String) {
        guard !terminal.readOnly else { return }
        var text = ""
        func flush() {
            if !text.isEmpty { _ = terminal.sendKey("Unidentified", text: text, modifiers: 0, action: 1); text = "" }
        }
        for scalar in value.unicodeScalars {
            if scalar.value < 32 || scalar.value == 127 {
                flush()
                let key: String
                var modifiers: UInt = 0
                switch scalar.value {
                case 10, 13: key = "Enter"
                case 9: key = "Tab"
                case 27: key = "Escape"
                case 127: key = "Backspace"
                case 0: key = "Space"; modifiers = 2
                case 28: key = "Backslash"; modifiers = 2
                case 29: key = "BracketRight"; modifiers = 2
                case 30: key = "Digit6"; modifiers = 2
                case 31: key = "Minus"; modifiers = 2
                default: key = "Key" + String(UnicodeScalar(scalar.value + 64)!); modifiers = 2
                }
                _ = terminal.sendKey(key, text: "", modifiers: modifiers, action: 1)
            } else { text.unicodeScalars.append(scalar) }
        }
        flush()
    }
    override func insertText(_ text: String) {
        input(text.replacingOccurrences(of: "\n", with: "\r"))
    }
    override func paste(_ sender: Any?) {
        if let text = UIPasteboard.general.string { _ = terminal.pasteText(text) }
    }
    override func deleteBackward() { input("\u{7f}") }
    override var keyCommands: [UIKeyCommand]? {
        if markedTextRange != nil { return super.keyCommands }
        let arrows = [UIKeyCommand.inputUpArrow, UIKeyCommand.inputDownArrow, UIKeyCommand.inputRightArrow, UIKeyCommand.inputLeftArrow, UIKeyCommand.inputEscape, "\t"]
        let modifierSets: [UIKeyModifierFlags] = [[], .shift, .control, .alternate, [.shift, .control], [.shift, .alternate]]
        let keys = arrows.flatMap { input in modifierSets.map { UIKeyCommand(input: input, modifierFlags: $0, action: #selector(terminalKey(_:))) } }
        let commands = keys + "abcdefghijklmnopqrstuvwxyz".map { UIKeyCommand(input: String($0), modifierFlags: .control, action: #selector(terminalKey(_:))) }
        commands.forEach { $0.wantsPriorityOverSystemBehavior = true }
        return commands
    }
    @objc private func terminalKey(_ key: UIKeyCommand) {
        guard let value = key.input else { return }
        let names = [UIKeyCommand.inputUpArrow: "ArrowUp", UIKeyCommand.inputDownArrow: "ArrowDown", UIKeyCommand.inputRightArrow: "ArrowRight", UIKeyCommand.inputLeftArrow: "ArrowLeft", UIKeyCommand.inputEscape: "Escape", "\t": "Tab"]
        let name = names[value] ?? "Key" + value.uppercased()
        let modifiers: UInt = (key.modifierFlags.contains(.shift) ? 1 : 0) | (key.modifierFlags.contains(.control) ? 2 : 0) | (key.modifierFlags.contains(.alternate) ? 4 : 0)
        _ = terminal.sendKey(name, text: names[value] == nil ? value : "", modifiers: modifiers, action: 1)
    }
    @objc private func scrollTerminal(_ recognizer: UIPanGestureRecognizer) {
        let movement = recognizer.translation(in: self).y
        recognizer.setTranslation(.zero, in: self)
        panRemainder -= movement
        let lines = Int(panRemainder / terminal.cellHeight)
        if lines != 0 { terminal.scrollLines(lines); panRemainder -= CGFloat(lines) * terminal.cellHeight; refreshText() }
    }
}

@objc(NativeTerminalPlugin)
final class NativeTerminalPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "NativeTerminalPlugin"
    let jsName = "NativeTerminal"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "create", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "layout", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "focus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "inspect", returnType: CAPPluginReturnPromise),
    ]
    private var navigationObservation: NSKeyValueObservation?
    override func load() {
        navigationObservation = bridge?.webView?.observe(\.isLoading, options: [.new]) { [weak self] web, _ in
            if web.isLoading { self?.closeAll() }
        }
    }
    private func closeAll() {
        for view in surfaces.values {
            view.sendInput = nil; view.terminal.writeInput = nil
            view.resignFirstResponder(); view.removeFromSuperview()
        }
        surfaces.removeAll()
    }
    deinit {
        let remaining = Array(surfaces.values)
        DispatchQueue.main.async { for view in remaining { view.resignFirstResponder(); view.removeFromSuperview() } }
    }
    private var surfaces: [String: GhosttyTerminalTextView] = [:]
    private func withSurface(_ call: CAPPluginCall, _ action: @escaping (GhosttyTerminalTextView) -> Void) {
        DispatchQueue.main.async {
            guard let id = call.getString("surfaceId"), let view = self.surfaces[id] else { call.reject("Native terminal surface is unavailable."); return }
            action(view)
        }
    }
    @objc func create(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.surfaces.count < 64, let parent = self.bridge?.webView?.superview else { call.reject("Native terminal container is unavailable."); return }
            let id = UUID().uuidString
            guard let terminal = WeaveTerminalRenderer.make() else { call.reject("Native terminal allocation failed."); return }
            let view = GhosttyTerminalTextView(terminal: terminal)
            view.isHidden = true
            view.terminal.readOnly = true
            view.sendInput = { [weak self] data in self?.notifyListeners("event", data: ["surfaceId": id, "kind": "input", "data": data]) }
            view.resized = { [weak self] cols, rows in self?.notifyListeners("event", data: ["surfaceId": id, "kind": "resize", "cols": cols, "rows": rows]) }
            view.didFocus = { [weak self] in self?.notifyListeners("event", data: ["surfaceId": id, "kind": "focus"]) }
            self.surfaces[id] = view
            parent.addSubview(view)
            call.resolve(["surfaceId": id, "renderer": "libghostty-vt-coretext"])
        }
    }
    @objc func layout(_ call: CAPPluginCall) {
        withSurface(call) { view in
            guard let web = self.bridge?.webView, let parent = web.superview,
                  let x = call.getDouble("x"), let y = call.getDouble("y"), let width = call.getDouble("width"), let height = call.getDouble("height"),
                  [x,y,width,height].allSatisfy({ $0.isFinite }), width >= 0, height >= 0 else { call.reject("Invalid native terminal geometry."); return }
            let rectangle = CGRect(x: x, y: y, width: width, height: height).intersection(web.bounds)
            if !rectangle.isEmpty && !rectangle.isNull { view.frame = web.convert(rectangle, to: parent) }
            view.isHidden = call.getBool("visible") != true || rectangle.isEmpty || rectangle.isNull
            let controlled = call.getBool("readOnly") != true
            if view.isHidden { view.resignFirstResponder() }
            view.terminal.readOnly = !controlled
            view.isEditable = controlled
            view.layoutIfNeeded()
            call.resolve(["cols": view.terminal.columns, "rows": view.terminal.rows])
        }
    }
    @objc func write(_ call: CAPPluginCall) {
        withSurface(call) { view in
            let cols = call.getInt("cols") ?? 0, rows = call.getInt("rows") ?? 0
            guard (cols == 0 && rows == 0) || (call.getBool("reset") == true && (2...500).contains(cols) && (2...300).contains(rows)) else { call.reject("Invalid terminal snapshot grid."); return }
            guard let encoded = call.getString("data"), encoded.count <= 3 * 1024 * 1024, let data = Data(base64Encoded: encoded), view.consume(data, reset: call.getBool("reset") == true, cols: cols, rows: rows) else { call.reject("Native terminal output could not be consumed."); return }
            call.resolve()
        }
    }
    @objc func focus(_ call: CAPPluginCall) { withSurface(call) { view in _ = view.becomeFirstResponder(); call.resolve() } }
    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let id = call.getString("surfaceId"), let view = self.surfaces.removeValue(forKey: id) { view.resignFirstResponder(); view.removeFromSuperview() }
            call.resolve()
        }
    }
    #if DEBUG
    // App-driven smoke only. XCTest remains responsible for real keyboard,
    // selection, rotation and accessibility acceptance on the physical iPad.
    func driveAcceptanceStage(_ stage: String) -> Bool {
        guard ["native-terminal", "native-neovim", "native-reattached-input", "native-neovim-input"].contains(stage) else { return false }
        guard let view = surfaces.values.first(where: { !$0.isHidden && !$0.terminal.readOnly }) else { return false }
        _ = view.becomeFirstResponder()
        switch stage {
        case "native-terminal":
            view.insertText("\u{15}")
            guard view.terminal.pasteText("printf 'WEAVE_NATIVE_PASTE_OK\\n'") else { return false }
            view.insertText("\n")
        case "native-neovim":
            view.insertText("nvim -u NONE -i NONE\n")
        case "native-reattached-input":
            guard view.terminal.pasteText("_REATTACHED") else { return false }
        case "native-neovim-input":
            view.insertText("i")
            guard view.terminal.pasteText("WEAVE_NEOVIM_INPUT") else { return false }
        default: return false
        }
        return true
    }
    #endif
    @objc func inspect(_ call: CAPPluginCall) {
        #if DEBUG
        withSurface(call) { view in call.resolve(["text": view.terminal.visibleText, "cols": view.terminal.columns, "rows": view.terminal.rows, "renderer": "libghostty-vt-coretext"]) }
        #else
        call.reject("Native terminal inspection is unavailable in this build.")
        #endif
    }
}
