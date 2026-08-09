import XCTest
@testable import CodexMicroLab

final class MicroInputSafetyTests: XCTestCase {
    func testDeadZoneCancelsWithoutSending() {
        XCTAssertNil(MicroInputSafety.direction(dx: 10, dy: 0, distance: 10, maxDistance: 100))
    }

    func testCardinalDirectionUsesTheDominantAxis() {
        XCTAssertEqual(MicroInputSafety.direction(dx: 80, dy: 20, distance: 80, maxDistance: 80), .right)
        XCTAssertEqual(MicroInputSafety.direction(dx: -80, dy: 20, distance: 80, maxDistance: 80), .left)
        XCTAssertEqual(MicroInputSafety.direction(dx: 20, dy: -80, distance: 80, maxDistance: 80), .up)
        XCTAssertEqual(MicroInputSafety.direction(dx: 20, dy: 80, distance: 80, maxDistance: 80), .down)
    }

    func testReleaseInventoryContainsEveryPhysicalHoldKey() {
        XCTAssertEqual(Set(MicroInputSafety.releaseKeys).count, 13)
        XCTAssertTrue(MicroInputSafety.releaseKeys.contains("ACT10"))
        XCTAssertTrue(MicroInputSafety.releaseKeys.contains("AG05"))
    }

    func testPairingQRRequiresTheExactSchemeAndValidatesEveryField() throws {
        let token = "0123456789abcdef0123456789abcdef"
        let qr = try pairingQR(version: 1, token: token, hosts: ["192.168.1.20", "169.254.2.3", "10.123.45.67"], port: 47831)
        let payload = try PairingPayload(qrCode: qr)
        XCTAssertEqual(payload.version, 1)
        XCTAssertEqual(payload.token, token)
        XCTAssertEqual(payload.hosts, ["192.168.1.20", "169.254.2.3", "10.123.45.67"])
        XCTAssertEqual(payload.port, 47831)
        XCTAssertFalse(payload.confirmationSummary.contains(token))
    }

    func testPairingQRRejectsRawAndArbitraryValues() throws {
        let token = "0123456789abcdef0123456789abcdef"
        XCTAssertThrowsError(try PairingPayload(qrCode: token))
        XCTAssertThrowsError(try PairingPayload(qrCode: "https://example.com/pair"))
        XCTAssertThrowsError(try PairingPayload(qrCode: "codexmicro://pair?token=\(token)"))
        XCTAssertThrowsError(try PairingPayload(qrCode: pairingQR(version: 2, token: token, hosts: ["192.168.1.2"], port: 47831)))
        XCTAssertThrowsError(try PairingPayload(qrCode: pairingQR(version: 1, token: "short", hosts: ["192.168.1.2"], port: 47831)))
        XCTAssertThrowsError(try PairingPayload(qrCode: pairingQR(version: 1, token: token, hosts: ["8.8.8.8"], port: 47831)))
        XCTAssertThrowsError(try PairingPayload(qrCode: pairingQR(version: 1, token: token, hosts: ["192.0.0.9"], port: 47831)))
        XCTAssertThrowsError(try PairingPayload(qrCode: pairingQR(version: 1, token: token, hosts: ["192.168.1.2"], port: 80)))
    }

    private func pairingQR(version: Int, token: String, hosts: [String], port: Int) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: ["version": version, "token": token, "hosts": hosts, "port": port])
        return "codexmicro://pair#" + data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
