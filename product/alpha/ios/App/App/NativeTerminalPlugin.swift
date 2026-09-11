import Capacitor
import UIKit
import WebKit

private final class TerminalPointerRecognizer: UIGestureRecognizer {
    private let report: (CGPoint, UInt, UInt, UInt) -> Void
    private var button: UInt = 1
    init(report: @escaping (CGPoint, UInt, UInt, UInt) -> Void) { self.report = report; super.init(target: nil, action: nil) }
    private func send(_ touches: Set<UITouch>, _ event: UIEvent, _ action: UInt) {
        guard let touch = touches.first else { return }
        let flags = event.modifierFlags
        let modifiers: UInt = (flags.contains(.shift) ? 1 : 0) | (flags.contains(.control) ? 2 : 0) | (flags.contains(.alternate) ? 4 : 0)
        report(touch.location(in: view), button, action, modifiers)
    }
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        if event.modifierFlags.contains(.shift) { state = .failed; return }
        button = event.buttonMask.contains(.secondary) ? 2 : 1
        state = .began; send(touches, event, 0)
    }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) { state = .changed; send(touches, event, 2) }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) { send(touches, event, 1); state = .ended }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { send(touches, event, 1); state = .cancelled }
}

private final class GhosttyTerminalTextView: UITextView {
    let terminal: WeaveTerminalRenderer
    var sendInput: ((String) -> Void)?
    var resized: ((Int, Int) -> Void)?
    var didFocus: (() -> Void)?
    private var updatingFrame = false
    private var panRemainder: CGFloat = 0
    private var composition: String?
    private var heldKeys: [Int: (String, UInt)] = [:]
    private var pointer: TerminalPointerRecognizer?

    init(terminal: WeaveTerminalRenderer) {
        self.terminal = terminal
        super.init(frame: .zero, textContainer: nil)
        backgroundColor = UIColor(red: 30/255, green: 30/255, blue: 46/255, alpha: 1)
        font = UIFont(name: terminal.fontName, size: 13)
        tintColor = UIColor(red: 180/255, green: 190/255, blue: 254/255, alpha: 1)
        textColor = .clear // TextKit keeps selection/accessibility; CoreText draws glyphs.
        textContainerInset = UIEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
        textContainer.lineFragmentPadding = 0
        isScrollEnabled = false
        clipsToBounds = true
        textContainer.widthTracksTextView = false
        textContainer.heightTracksTextView = false
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
        pan.allowedScrollTypesMask = .all
        addGestureRecognizer(pan)
        let pointer = TerminalPointerRecognizer { [weak self] point, button, action, modifiers in
            _ = self?.terminal.sendMouse(at: point, button: button, action: action, modifiers: modifiers)
        }
        pointer.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)]
        pointer.isEnabled = false
        addGestureRecognizer(pointer); self.pointer = pointer
        addGestureRecognizer(UIHoverGestureRecognizer(target: self, action: #selector(hoverTerminal(_:))))
    }
    required init?(coder: NSCoder) { fatalError("Not a storyboard view") }
    override var canBecomeFirstResponder: Bool { true }
    override var contentOffset: CGPoint {
        get { super.contentOffset }
        set { super.contentOffset = .zero }
    }
    override func setContentOffset(_ contentOffset: CGPoint, animated: Bool) {
        super.setContentOffset(.zero, animated: false)
    }
    override func becomeFirstResponder() -> Bool {
        let focused = super.becomeFirstResponder()
        if focused { didFocus?() }
        return focused
    }
    override func resignFirstResponder() -> Bool {
        for (_, key) in heldKeys { _ = terminal.sendKey(key.0, text: "", modifiers: key.1, action: 0) }
        heldKeys.removeAll()
        return super.resignFirstResponder()
    }
    override func caretRect(for position: UITextPosition) -> CGRect { .zero }
    override func firstRect(for range: UITextRange) -> CGRect { terminal.cursorRect }
    override func draw(_ rect: CGRect) {
        refreshText()
        if let context = UIGraphicsGetCurrentContext() { terminal.draw(in: context, size: bounds.size) }
        if let composition, !composition.isEmpty {
            (composition as NSString).draw(at: terminal.cursorRect.origin, withAttributes: [.font: font!, .foregroundColor: UIColor.label, .backgroundColor: UIColor.systemBackground, .underlineStyle: NSUnderlineStyle.single.rawValue])
        }
        if let context = UIGraphicsGetCurrentContext() { terminal.drawFocusBorder(in: context, size: bounds.size) }
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        // UIKit lays out the viewport; only a Host screen replaces the VT grid.
        if contentOffset != .zero { contentOffset = .zero }
    }

    func consume(_ data: Data, reset: Bool, cols: Int = 0, rows: Int = 0) -> Bool {
        guard (reset && cols > 0 ? terminal.restore(data, columns: UInt(cols), rows: UInt(rows)) : terminal.consume(data, reset: reset)) else { return false }
        setNeedsDisplay()
        return true
    }
    private func refreshText() {
        guard !updatingFrame else { return }
        updatingFrame = true
        // TextKit supplies native selection, copy and accessibility; libghostty
        // owns the screen/cursor and CoreText owns all visible terminal drawing.
        pointer?.isEnabled = terminal.mouseReporting
        textContainer.size = CGSize(width: CGFloat(terminal.columns) * terminal.cellWidth, height: CGFloat(terminal.rows) * terminal.cellHeight)
        let visible = terminal.visibleText
        if markedTextRange == nil, text != visible {
            let selection = selectedRange
            text = visible
            let start = min(selection.location, (text as NSString).length)
            selectedRange = NSRange(location: start, length: min(selection.length, (text as NSString).length - start))
        }
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
    override func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
        guard !terminal.readOnly else { return }
        composition = markedText
        super.setMarkedText(markedText, selectedRange: selectedRange)
        setNeedsDisplay()
    }
    override func unmarkText() {
        let committed = composition; composition = nil
        super.unmarkText()
        if let committed, !committed.isEmpty { input(committed) }
        refreshText()
    }
    override func insertText(_ text: String) {
        composition = nil
        if markedTextRange != nil { super.unmarkText() }
        input(text.replacingOccurrences(of: "\n", with: "\r"))
        refreshText()
    }
    override func copy(_ sender: Any?) {
        guard selectedRange.length > 0 else { return }
        UIPasteboard.general.string = terminal.text(forVisibleRange: selectedRange)
    }
    override func paste(_ sender: Any?) {
        if let text = UIPasteboard.general.string { _ = terminal.pasteText(text) }
    }
    override func deleteBackward() { input("\u{7f}") }
    private func modifiers(_ flags: UIKeyModifierFlags) -> UInt {
        (flags.contains(.shift) ? 1 : 0) | (flags.contains(.control) ? 2 : 0) | (flags.contains(.alternate) ? 4 : 0) | (flags.contains(.command) ? 8 : 0) | (flags.contains(.alphaShift) ? 16 : 0)
    }
    private func keyName(_ code: Int) -> String? {
        if (4...29).contains(code) { return "Key" + String(UnicodeScalar(code - 4 + 65)!) }
        if (30...38).contains(code) { return "Digit" + String(code - 29) }
        if (58...69).contains(code) { return "F" + String(code - 57) }
        if (104...115).contains(code) { return "F" + String(code - 91) }
        if (89...97).contains(code) { return "Numpad" + String(code - 88) }
        return [39:"Digit0",40:"Enter",41:"Escape",42:"Backspace",43:"Tab",44:"Space",45:"Minus",46:"Equal",47:"BracketLeft",48:"BracketRight",49:"Backslash",51:"Semicolon",52:"Quote",53:"Backquote",54:"Comma",55:"Period",56:"Slash",73:"Insert",74:"Home",75:"PageUp",76:"Delete",77:"End",78:"PageDown",79:"ArrowRight",80:"ArrowLeft",81:"ArrowDown",82:"ArrowUp",83:"NumLock",84:"NumpadDivide",85:"NumpadMultiply",86:"NumpadSubtract",87:"NumpadAdd",88:"NumpadEnter",98:"Numpad0",99:"NumpadDecimal"][code]
    }
    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var remaining = presses
        for press in presses {
            guard let key = press.key, let name = keyName(key.keyCode.rawValue), markedTextRange == nil, !key.modifierFlags.contains(.command) else { continue }
            let special = name.hasPrefix("Arrow") || name.hasPrefix("F") || name.hasPrefix("Numpad") || ["Enter","Escape","Backspace","Tab","Delete","Home","End","PageUp","PageDown","Insert"].contains(name)
            guard special || key.modifierFlags.contains(.control) else { continue }
            remaining.remove(press)
            guard !terminal.readOnly else { continue }
            let flags = modifiers(key.modifierFlags)
            let text = key.charactersIgnoringModifiers.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 || (0xF700...0xF8FF).contains($0.value) }) ? "" : key.charactersIgnoringModifiers
            _ = terminal.sendKey(name, text: text, modifiers: flags, action: heldKeys[key.keyCode.rawValue] == nil ? 1 : 2)
            heldKeys[key.keyCode.rawValue] = (name, flags)
        }
        if !remaining.isEmpty { super.pressesBegan(remaining, with: event) }
    }
    private func release(_ presses: Set<UIPress>) -> Set<UIPress> {
        var remaining = presses
        for press in presses {
            if let key = press.key, let held = heldKeys.removeValue(forKey: key.keyCode.rawValue) {
                _ = terminal.sendKey(held.0, text: "", modifiers: modifiers(key.modifierFlags), action: 0)
                remaining.remove(press)
            }
        }
        return remaining
    }
    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        let remaining = release(presses); if !remaining.isEmpty { super.pressesEnded(remaining, with: event) }
    }
    override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        let remaining = release(presses); if !remaining.isEmpty { super.pressesCancelled(remaining, with: event) }
    }
    @objc private func hoverTerminal(_ recognizer: UIHoverGestureRecognizer) {
        _ = terminal.sendMouse(at: recognizer.location(in: self), button: 0, action: 2, modifiers: modifiers(recognizer.modifierFlags))
    }
    @objc private func scrollTerminal(_ recognizer: UIPanGestureRecognizer) {
        let movement = recognizer.translation(in: self).y
        recognizer.setTranslation(.zero, in: self)
        panRemainder -= movement
        let lines = Int(panRemainder / terminal.cellHeight)
        if lines != 0, terminal.mouseReporting, !recognizer.modifierFlags.contains(.shift) {
            for _ in 0..<min(20, abs(lines)) { _ = terminal.sendMouse(at: recognizer.location(in: self), button: lines < 0 ? 4 : 5, action: 0, modifiers: modifiers(recognizer.modifierFlags)) }
            panRemainder -= CGFloat(lines) * terminal.cellHeight; return
        }
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
            call.resolve(["surfaceId": id, "renderer": "libghostty-vt-coretext", "codec": WeaveTerminalRenderer.codecIdentity()])
        }
    }
    @objc func layout(_ call: CAPPluginCall) {
        withSurface(call) { view in
            guard let web = self.bridge?.webView, let parent = web.superview,
                  let x = call.getDouble("x"), let y = call.getDouble("y"), let width = call.getDouble("width"), let height = call.getDouble("height"),
                  [x,y,width,height].allSatisfy({ $0.isFinite }), width >= 0, height >= 0 else { call.reject("Invalid native terminal geometry."); return }
            let border = call.getObject("focusBorder") ?? [:]
            let borderWidth = (border["width"] as? NSNumber)?.doubleValue ?? 0
            let borderRadius = (border["radius"] as? NSNumber)?.doubleValue ?? 0
            let borderRGB = (border["rgb"] as? NSNumber)?.doubleValue ?? 0
            guard [borderWidth, borderRadius, borderRGB].allSatisfy({ $0.isFinite }), (0...100).contains(borderWidth), (0...100).contains(borderRadius), (0...16777215).contains(borderRGB), borderRGB.rounded() == borderRGB else { call.reject("Invalid terminal border."); return }
            view.terminal.focusBorderWidth = borderWidth
            view.terminal.focusBorderRadius = borderRadius
            view.terminal.focusBorderRGB = UInt32(borderRGB)
            view.setNeedsDisplay()
            let rectangle = CGRect(x: x, y: y, width: width, height: height).intersection(web.bounds)
            if !rectangle.isEmpty && !rectangle.isNull { view.frame = web.convert(rectangle, to: parent) }
            view.isHidden = call.getBool("visible") != true || rectangle.isEmpty || rectangle.isNull
            let controlled = call.getBool("readOnly") != true
            if view.isHidden { view.resignFirstResponder() }
            view.terminal.readOnly = !controlled
            view.isEditable = controlled
            view.layoutIfNeeded()
            let grid = view.terminal.grid(forViewportSize: view.bounds.size)
            call.resolve(["cols": Int(grid.width), "rows": Int(grid.height)])
        }
    }
    @objc func write(_ call: CAPPluginCall) {
        withSurface(call) { view in
            let cols = call.getInt("cols") ?? 0, rows = call.getInt("rows") ?? 0
            guard (cols == 0 && rows == 0) || (call.getBool("reset") == true && (2...500).contains(cols) && (2...300).contains(rows)) else { call.reject("Invalid terminal snapshot grid."); return }
            guard let encoded = call.getString("data"), encoded.count <= 86 * 1024 * 1024, let data = Data(base64Encoded: encoded), (call.getBool("history") == true ? view.terminal.appendHistory(data) : view.consume(data, reset: call.getBool("reset") == true, cols: cols, rows: rows)) else { call.reject("Native terminal output could not be consumed."); return }
            view.setNeedsDisplay()
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
    // App-driven smoke only. XCTest adds synthetic typing/rotation coverage.
    // Physical keyboard and system IME acceptance remains attended.
    func driveAcceptanceStage(_ stage: String) -> Bool {
        guard ["native-terminal", "native-neovim", "native-reattached-input", "native-neovim-input", "native-composition"].contains(stage) else { return false }
        guard let view = surfaces.values.first(where: { !$0.isHidden && !$0.terminal.readOnly }) else { return false }
        _ = view.becomeFirstResponder()
        switch stage {
        case "native-terminal":
            view.insertText("\u{15}")
            guard view.terminal.pasteText("printf 'WEAVE_NATIVE_PASTE_OK\\n'") else { return false }
            view.insertText("\n")
        case "native-neovim":
            view.insertText("nvim -u NONE -i NONE\n")
        case "native-composition":
            let writer = view.terminal.writeInput
            var premature = false
            view.terminal.writeInput = { _ in premature = true }
            view.setMarkedText("界é", selectedRange: NSRange(location: 3, length: 0))
            view.terminal.writeInput = writer
            guard !premature else { return false }
            view.insertText("界é")
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
