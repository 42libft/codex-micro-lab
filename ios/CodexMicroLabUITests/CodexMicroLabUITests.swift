import XCTest

final class CodexMicroLabUITests: XCTestCase {
    func testPairingScreenKeepsTheFirstActionObvious() {
        let app = XCUIApplication()
        app.launchArguments = ["UITEST_UNPAIRED"]
        app.launch()

        XCTAssertTrue(app.buttons["pairingScanButton"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["pairingManualButton"].exists)
        XCTAssertFalse(app.staticTexts["AG00"].exists)
    }

    func testConnectedCockpitShowsMeaningAndHidesProtocolIDs() {
        let app = XCUIApplication()
        app.launchArguments = ["UITEST_PAIRED"]
        app.launch()

        XCTAssertTrue(app.buttons["settingsButton"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["agent-0"].exists)
        XCTAssertTrue(app.buttons["agent-1"].exists)
        XCTAssertTrue(app.buttons["direction-up"].exists)
        XCTAssertTrue(app.buttons["direction-right"].exists)
        XCTAssertTrue(app.buttons["textInputButton"].exists)
        XCTAssertTrue(app.buttons["voiceInputButton"].exists)
        XCTAssertTrue(app.buttons["voiceComposerButton"].exists)
        for key in ["ACT06", "ACT07", "ACT08", "ACT09", "ACT11", "ACT12"] {
            XCTAssertTrue(app.buttons["command-\(key)"].exists)
        }
        XCTAssertFalse(app.staticTexts["AG00"].exists)
        XCTAssertFalse(app.staticTexts["ACT06"].exists)

        app.buttons["settingsButton"].tap()
        XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["settingsAuthoritativeNote"].waitForExistence(timeout: 3))
    }

    func testRecoveringCockpitKeepsRecoveryStateAccessible() {
        let app = XCUIApplication()
        app.launchArguments = ["UITEST_RECOVERING"]
        app.launch()

        XCTAssertTrue(app.buttons["settingsButton"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["connectionStatus"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["direction-up"].exists)
        XCTAssertTrue(app.buttons["textInputButton"].exists)
    }

    func testCockpitPrimaryControlsAcceptThumbAndComposerActions() {
        let app = XCUIApplication()
        app.launchArguments = ["UITEST_PAIRED"]
        app.launch()

        XCTAssertTrue(app.buttons["agent-0"].waitForExistence(timeout: 5))
        app.buttons["agent-1"].tap()
        // Direction buttons expose the same accessibility action as the
        // circular drag surface, so VoiceOver and UI automation exercise the
        // same input path as a thumb flick.
        app.buttons["direction-up"].tap()
        app.buttons["textInputButton"].tap()
        XCTAssertTrue(app.textViews.firstMatch.waitForExistence(timeout: 3))
    }
}
