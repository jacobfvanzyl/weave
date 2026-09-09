import XCTest

final class AlphaUITests: XCTestCase {
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
        XCTAssertTrue(terminal.waitForExistence(timeout: 10))
        terminal.tap()
        terminal.typeText("\u{15}printf 'WEAVE_NATIVE_PASTE_OK\\n'\n")
        wait("native-neovim")
        terminal.tap()
        terminal.typeText("nvim -u NONE -i NONE")
        terminal.typeText("\n")
        wait("native-neovim-input")
        terminal.typeText("iWEAVE_NEOVIM_INPUT")
        wait("passed")
        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(terminal.waitForExistence(timeout: 10))
        let portrait = XCTAttachment(screenshot: app.screenshot())
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
        let keyboard = XCTAttachment(screenshot: app.screenshot())
        keyboard.name = "iPad composer keyboard"
        keyboard.lifetime = .keepAlways
        add(keyboard)
    }
}
