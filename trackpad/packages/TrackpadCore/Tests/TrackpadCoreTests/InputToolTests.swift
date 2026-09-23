import XCTest
@testable import TrackpadCore

final class InputToolTests: XCTestCase {
    func testHoverTakesOverAndFreshFingerReturnsAfterLeavingRange() {
        var tool = InputTool()
        XCTAssertEqual(tool.beginFingers([1]), [1])
        tool.hover(true)
        XCTAssertEqual(tool.mode, .pencil)
        XCTAssertFalse(tool.accepts(1))
        tool.endFingers([1])
        XCTAssertTrue(tool.beginFingers([2]).isEmpty)
        tool.hover(false)
        XCTAssertFalse(tool.accepts(2))
        XCTAssertEqual(tool.mode, .pencil)
        tool.endFingers([2])
        XCTAssertEqual(tool.beginFingers([3]), [3])
        XCTAssertEqual(tool.mode, .finger)
    }
    func testPencilContactWorksWithoutHoverAndPalmCannotStealStroke() {
        var tool = InputTool()
        tool.beginPencil()
        XCTAssertEqual(tool.mode, .pencil)
        tool.hover(false) // UIKit may end hover on contact.
        XCTAssertTrue(tool.beginFingers([1]).isEmpty)
        tool.endPencil()
        // A lingering palm is not retroactively recognized after Pencil lift.
        XCTAssertTrue(tool.beginFingers([2]).isEmpty)
        tool.endFingers([1, 2])
        XCTAssertEqual(tool.beginFingers([3]), [3])
    }
    func testMappingInterruptionRequiresExistingContactsToLift() {
        var tool = InputTool()
        _ = tool.beginFingers([1, 2])
        tool.interrupt()
        XCTAssertFalse(tool.accepts(1)); XCTAssertFalse(tool.accepts(2))
        XCTAssertTrue(tool.beginFingers([3]).isEmpty)
        tool.endFingers([1, 2, 3])
        XCTAssertEqual(tool.beginFingers([4, 5]), [4, 5])
    }
    func testInterruptionDoesNotForgetPhysicalPencilContact() {
        var tool = InputTool()
        tool.beginPencil(); tool.interrupt()
        XCTAssertTrue(tool.pencilDown)
        XCTAssertTrue(tool.beginFingers([1]).isEmpty)
        tool.endFingers([1]); tool.endPencil()
        XCTAssertEqual(tool.beginFingers([2]), [2])
    }
}
