import XCTest

final class AlphaUITests: XCTestCase {
    // Exercise the installed profile without creating or terminating Host work.
    func testOverlayLayeringAndPhoneNavigation() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        let toggle = app.descendants(matching: .any).matching(identifier: "Toggle threads").firstMatch
        XCTAssertTrue(toggle.waitForExistence(timeout: 30))
        let phone = UIDevice.current.userInterfaceIdiom == .phone
        if phone { toggle.tap() }
        let terminalRow = app.switches.matching(NSPredicate(format: "label BEGINSWITH 'Terminal '")).firstMatch
        XCTAssertTrue(terminalRow.waitForExistence(timeout: 30), "A connected workspace terminal is needed for native layering acceptance")
        terminalRow.tap()
        let terminal = app.textViews["Terminal input"].firstMatch
        XCTAssertTrue(terminal.waitForExistence(timeout: 15))
        if phone {
            XCTAssertFalse(app.keyboards.firstMatch.exists, "Pane navigation opened the software keyboard")
            XCTAssertFalse(app.buttons["Split right"].exists)
            XCUIDevice.shared.orientation = .landscapeLeft
            XCTAssertLessThan(app.frame.width, app.frame.height, "iPhone must retain portrait layout")
        }
        func capture(_ name: String) {
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
        }
        capture("WVE-78 terminal")
        if phone {
            let openSidebar = app.descendants(matching: .any).matching(identifier: "Toggle threads").firstMatch
            XCTAssertLessThan(openSidebar.frame.minY, 44, "Sidebar navigation belongs in the notch rail")
            XCTAssertGreaterThanOrEqual(openSidebar.frame.minX, 20, "Sidebar button must clear the rounded screen corner")
            openSidebar.tap()
            capture("WVE-78 sidebar over terminal")
            let closeSidebar = app.buttons["Close sidebar"]
            XCTAssertTrue(closeSidebar.isHittable)
            XCTAssertLessThanOrEqual(closeSidebar.frame.maxX, app.frame.width - 20, "Close button must clear the rounded screen corner")
            closeSidebar.tap()
            XCTAssertTrue(terminal.waitForExistence(timeout: 5))
            openSidebar.tap()
        }
        app.buttons["Connections"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Configured Hosts"].waitForExistence(timeout: 5) || app.buttons["Pair and Connect"].exists)
        capture("WVE-78 modal over terminal")
        app.buttons["Close"].firstMatch.tap()
        if phone, app.buttons["Close sidebar"].firstMatch.isHittable { app.buttons["Close sidebar"].firstMatch.tap() }
        if phone { XCTAssertFalse(app.keyboards.firstMatch.exists) }
        XCTAssertTrue(terminal.waitForExistence(timeout: 10))
        capture("WVE-78 terminal restored")
    }

    func testSoftwareKeyboardDismissalPreservesPaneSelection() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--host-acceptance"]
        XCUIDevice.shared.orientation = .landscapeRight
        app.launch()
        defer {
            app.buttons["Connections"].tap()
            let fixture = app.buttons["Forget WVE-77 iPad acceptance"]
            if fixture.waitForExistence(timeout: 5) {
                fixture.tap(); app.buttons["Forget Host"].tap()
                XCTAssertTrue(fixture.waitForNonExistence(timeout: 10))
            }
        }
        let stage = app.staticTexts["AcceptanceStage"]
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == 'native-terminal' OR label == 'failed'"), object: stage)], timeout: 90), .completed)
        XCTAssertEqual(stage.label, "native-terminal")
        let terminal = app.textViews["Terminal input"].firstMatch
        let keyboard = app.keyboards.firstMatch
        func dismissKeyboard() {
            XCTAssertTrue(keyboard.waitForExistence(timeout: 10))
            keyboard.buttons["Hide keyboard"].tap()
            XCTAssertTrue(keyboard.waitForNonExistence(timeout: 5))
            // Catch the delayed native blur -> web focus-restoration loop.
            sleep(2)
            XCTAssertFalse(keyboard.exists, "The keyboard reopened without a pane selection")
        }
        terminal.tap(); dismissKeyboard()
        terminal.tap(); XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        app.buttons["Restore terminal"].tap()
        let composer = app.textViews["Message agent"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap(); dismissKeyboard()
        app.buttons["Collapse WVE-77 iPad acceptance"].tap()
        sleep(1); XCTAssertFalse(keyboard.exists)
        composer.tap(); XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Keyboard resumed by selecting composer"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    func testHostTerminalAndKeyboardAcrossOrientations() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--host-acceptance"]
        XCUIDevice.shared.orientation = .landscapeRight
        app.launch()
        let stage = app.staticTexts["AcceptanceStage"]
        func wait(_ value: String, timeout: TimeInterval = 90) {
            let result = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@ OR label == 'failed'", value), object: stage)], timeout: timeout)
            XCTAssertEqual(result, .completed, "Expected acceptance stage \(value); got \(stage.label)")
            XCTAssertEqual(stage.label, value)
        }
        wait("native-terminal")
        let terminal = app.textViews["Terminal input"]
        for _ in 0..<8 {
            XCTAssertTrue(terminal.waitForExistence(timeout: 10))
            terminal.tap()
            terminal.typeText("\u{15}printf 'WEAVE_NATIVE_PASTE_OK\\n'\n")
            wait("native-neovim")
            terminal.tap()
            terminal.typeText("nvim -u NONE -i NONE")
            terminal.typeText("\n")
            wait("native-neovim-input")
            terminal.typeText("iWEAVE_NEOVIM_INPUT")
            let next = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label IN %@", ["passed", "failed", "native-terminal", "native-reattached-input"]), object: stage)
            XCTAssertEqual(XCTWaiter.wait(for: [next], timeout: 120), .completed)
            XCTAssertNotEqual(stage.label, "failed")
            if stage.label == "native-reattached-input" {
                terminal.tap()
                terminal.typeText("_REATTACHED")
                let restored = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label IN %@", ["passed", "failed", "native-terminal"]), object: stage)
                XCTAssertEqual(XCTWaiter.wait(for: [restored], timeout: 90), .completed)
                XCTAssertNotEqual(stage.label, "failed")
            }
            if stage.label == "passed" { break }
        }
        XCTAssertEqual(stage.label, "passed")
        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(terminal.waitForExistence(timeout: 10))
        let portrait = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        portrait.name = "iPad portrait terminal"
        portrait.lifetime = .keepAlways
        add(portrait)
        XCUIDevice.shared.orientation = .landscapeLeft
        let composer = app.textViews["Message agent"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        let visibleComposer = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let keyboard = app.keyboards.firstMatch
            return composer.isHittable && (!keyboard.exists || composer.frame.maxY <= keyboard.frame.minY)
        }, object: composer)
        XCTAssertEqual(XCTWaiter.wait(for: [visibleComposer], timeout: 10), .completed)
        composer.tap()
        // WebKit can update the editable accessibility element after rotation.
        // Resolve it again after the keyboard transition before native typing.
        sleep(1)
        app.textViews["Message agent"].tap()
        composer.typeText("iPad keyboard acceptance")
        XCTAssertTrue((composer.value as? String)?.contains("iPad keyboard acceptance") == true)
        let keyboard = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        keyboard.name = "iPad composer keyboard"
        keyboard.lifetime = .keepAlways
        add(keyboard)
        // The fixture Host is disposable; retain the user's real connections.
        app.buttons["Settings"].tap()
        let forgetFixture = app.descendants(matching: .any)["Forget iPad acceptance"]
        if forgetFixture.waitForExistence(timeout: 5) {
            forgetFixture.tap()
            app.buttons["Forget Host"].tap()
            XCTAssertTrue(forgetFixture.waitForNonExistence(timeout: 10))
        }
    }
}
