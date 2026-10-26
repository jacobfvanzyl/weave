// The native terminal's view (WVE-153), brought back from e30f6e93
// (product/alpha/ios/App/App/NativeTerminalPlugin.swift) by way of the WVE-150 spike: a text view
// for UIKit's keyboard, selection and accessibility, which libghostty-vt's screen draws over.
import GameController
import UIKit

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

/// Esc, Ctrl, Tab and the arrows above the software keyboard, which has none of them, and a key
/// that hides the keyboard, which the iPhone's lacks. Ctrl applies to the next key, from the bar or
/// the keyboard. Arrows repeat while held.
final class TerminalKeyBar: UIInputView {
    var onKey: ((String) -> Void)?
    var onHide: (() -> Void)?
    var control = false { didSet { update() } }
    private let controlButton = UIButton(type: .system)
    private var repeating: Timer?

    init() {
        super.init(frame: CGRect(x: 0, y: 0, width: 320, height: 44), inputViewStyle: .keyboard)
        allowsSelfSizing = true
        let stack = UIStackView()
        stack.axis = .horizontal
        stack.distribution = .fillEqually
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: safeAreaLayoutGuide.leadingAnchor, constant: 6),
            stack.trailingAnchor.constraint(equalTo: safeAreaLayoutGuide.trailingAnchor, constant: -6),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 5),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -5),
            heightAnchor.constraint(equalToConstant: 44)
        ])
        let keys: [(String, String, String)] = [
            ("esc", "Escape", "Escape"), ("ctrl", "", "Control"), ("tab", "Tab", "Tab"),
            ("←", "ArrowLeft", "Left"), ("↓", "ArrowDown", "Down"), ("↑", "ArrowUp", "Up"), ("→", "ArrowRight", "Right")
        ]
        for (title, key, label) in keys {
            let button = key.isEmpty ? controlButton : UIButton(type: .system)
            var configuration = UIButton.Configuration.gray()
            configuration.title = title
            configuration.cornerStyle = .medium
            configuration.contentInsets = NSDirectionalEdgeInsets(top: 2, leading: 2, bottom: 2, trailing: 2)
            button.configuration = configuration
            button.accessibilityLabel = label
            if key.isEmpty {
                button.addAction(UIAction { [weak self] _ in self?.control.toggle() }, for: .touchUpInside)
            } else {
                button.addAction(UIAction { [weak self] _ in self?.press(key, repeats: key.hasPrefix("Arrow")) }, for: .touchDown)
                for event: UIControl.Event in [.touchUpInside, .touchUpOutside, .touchCancel] {
                    button.addAction(UIAction { [weak self] _ in self?.repeating?.invalidate() }, for: event)
                }
            }
            stack.addArrangedSubview(button)
        }
        let hide = UIButton(type: .system)
        var configuration = UIButton.Configuration.gray()
        configuration.image = UIImage(systemName: "keyboard.chevron.compact.down")
        configuration.cornerStyle = .medium
        hide.configuration = configuration
        hide.accessibilityLabel = "Hide keyboard"
        hide.addAction(UIAction { [weak self] _ in self?.onHide?() }, for: .touchUpInside)
        stack.addArrangedSubview(hide)
        update()
    }
    required init?(coder: NSCoder) { fatalError("Not a storyboard view") }

    private func press(_ key: String, repeats: Bool) {
        onKey?(key)
        repeating?.invalidate()
        guard repeats else { return }
        repeating = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: false) { [weak self] _ in
            self?.repeating = Timer.scheduledTimer(withTimeInterval: 0.07, repeats: true) { [weak self] _ in self?.onKey?(key) }
        }
    }

    private func update() {
        controlButton.configuration?.baseBackgroundColor = control ? tintColor : nil
        controlButton.configuration?.baseForegroundColor = control ? .white : nil
        controlButton.accessibilityTraits = control ? [.button, .selected] : .button
    }
}

final class TerminalView: UITextView {
    var inputBlocked = true
    let terminal: WeaveTerminalRenderer
    var stream: TerminalStream?
    var didFocus: (() -> Void)?
    var didBlur: (() -> Void)?
    private var updatingFrame = false
    private var panRemainder: CGFloat = 0
    private var composition: String?
    private var heldKeys: [Int: (String, UInt)] = [:]
    private var pointer: TerminalPointerRecognizer?
    private let keyBar = TerminalKeyBar()
    private var keyboardObservers: [NSObjectProtocol] = []

    init(terminal: WeaveTerminalRenderer) {
        self.terminal = terminal
        super.init(frame: .zero, textContainer: nil)
        backgroundColor = UIColor(red: 30/255, green: 30/255, blue: 46/255, alpha: 1)
        font = UIFont(name: terminal.fontName, size: terminal.fontSize)
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
        keyboardAppearance = .dark
        accessibilityLabel = "Terminal"
        terminal.writeInput = { [weak self] data in self?.stream?.send(input: data) }
        keyBar.onKey = { [weak self] key in self?.barKey(key) }
        // Tapping the terminal brings the keyboard back.
        keyBar.onHide = { [weak self] in _ = self?.resignFirstResponder() }
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
        updateKeyBar()
        for name in [Notification.Name.GCKeyboardDidConnect, .GCKeyboardDidDisconnect] {
            keyboardObservers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.updateKeyBar() })
        }
    }
    required init?(coder: NSCoder) { fatalError("Not a storyboard view") }
    deinit { for observer in keyboardObservers { NotificationCenter.default.removeObserver(observer) } }

    /// The key bar rides the software keyboard; an iPad with a hardware keyboard has the keys.
    private func updateKeyBar() {
        let hardware = UIDevice.current.userInterfaceIdiom == .pad && GCKeyboard.coalesced != nil
        let bar: UIView? = hardware ? nil : keyBar
        guard inputAccessoryView !== bar else { return }
        inputAccessoryView = bar
        if isFirstResponder { reloadInputViews() }
    }

    /// Ctrl from the key bar applies once.
    private func takeControl() -> UInt {
        guard keyBar.control else { return 0 }
        keyBar.control = false
        return 2
    }
    private func barKey(_ key: String) {
        let modifiers = takeControl()
        _ = terminal.sendKey(key, text: "", modifiers: modifiers, action: 1)
        _ = terminal.sendKey(key, text: "", modifiers: modifiers, action: 0)
    }

    func setFontSize(_ size: CGFloat) {
        terminal.fontSize = size
        font = UIFont(name: terminal.fontName, size: terminal.fontSize)
        setNeedsDisplay()
    }

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
        keyBar.control = false
        let resigned = super.resignFirstResponder()
        if resigned { didBlur?() }
        return resigned
    }
    override func caretRect(for position: UITextPosition) -> CGRect { .zero }
    override func firstRect(for range: UITextRange) -> CGRect { terminal.cursorRect }
    override func draw(_ rect: CGRect) {
        refreshText()
        if let context = UIGraphicsGetCurrentContext() { terminal.draw(in: context, size: bounds.size) }
        if let composition, !composition.isEmpty, let font {
            (composition as NSString).draw(at: terminal.cursorRect.origin, withAttributes: [.font: font, .foregroundColor: UIColor.label, .backgroundColor: UIColor.systemBackground, .underlineStyle: NSUnderlineStyle.single.rawValue])
        }
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        // UIKit lays out the view; the terminal's grid is the Host's.
        if contentOffset != .zero { contentOffset = .zero }
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
        _ = terminal.sendText(value, modifiers: takeControl())
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
        if (4...29).contains(code) { return "Key" + String(UnicodeScalar(UInt8(code - 4 + 65))) }
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
            // iOS names special keys in their characters ("UIKeyInputLeftArrow"), so a special key
            // carries no text: libghostty encodes it from its name alone.
            let text = special || key.charactersIgnoringModifiers.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 || (0xF700...0xF8FF).contains($0.value) }) ? "" : key.charactersIgnoringModifiers
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
        if lines != 0 { terminal.scrollLines(lines); panRemainder -= CGFloat(lines) * terminal.cellHeight; refreshText(); setNeedsDisplay() }
    }
}
