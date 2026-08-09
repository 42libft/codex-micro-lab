import CoreGraphics
import Foundation

/// Pure input rules shared by the cockpit and its unit tests. Keeping the
/// threshold and release inventory outside the view prevents a UI refactor
/// from accidentally reintroducing a stuck press or a diagonal ambiguity.
enum MicroDirection: String, CaseIterable {
    case up, right, down, left
}

enum MicroInputSafety {
    static let releaseKeys = ["ACT06", "ACT07", "ACT08", "ACT09", "ACT10", "ACT11", "ACT12"] + (0..<6).map { "AG0\($0)" }

    static func direction(dx: CGFloat, dy: CGFloat, distance: CGFloat, maxDistance: CGFloat, threshold: CGFloat = 0.45) -> MicroDirection? {
        guard maxDistance > 0, distance / maxDistance >= threshold else { return nil }
        if abs(dx) > abs(dy) { return dx > 0 ? .right : .left }
        return dy > 0 ? .down : .up
    }
}

struct PairingPayload: Identifiable {
    let id = UUID()
    let version: Int
    let token: String
    let hosts: [String]
    let port: Int

    init(qrCode: String) throws {
        guard let components = URLComponents(string: qrCode),
              components.scheme?.lowercased() == "codexmicro",
              components.host?.lowercased() == "pair",
              components.path.isEmpty,
              components.user == nil,
              components.password == nil,
              components.port == nil,
              components.query == nil,
              let fragment = components.fragment,
              !fragment.isEmpty,
              fragment.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil else {
            throw PairingValidationError.invalidURL
        }

        var base64 = fragment.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let remainder = base64.count % 4
        guard remainder != 1 else { throw PairingValidationError.invalidPayload }
        if remainder > 0 { base64 += String(repeating: "=", count: 4 - remainder) }
        guard let data = Data(base64Encoded: base64),
              let envelope = try? JSONDecoder().decode(PairingEnvelope.self, from: data) else {
            throw PairingValidationError.invalidPayload
        }
        guard envelope.version == 1 else { throw PairingValidationError.unsupportedVersion }
        guard Self.isValidToken(envelope.token) else { throw PairingValidationError.invalidToken }
        guard (1024...65535).contains(envelope.port) else { throw PairingValidationError.invalidPort }
        guard !envelope.hosts.isEmpty, envelope.hosts.count <= 8, envelope.hosts.allSatisfy(Self.isAllowedPairingHost) else {
            throw PairingValidationError.invalidHost
        }

        self.version = envelope.version
        self.token = envelope.token.lowercased()
        self.hosts = Array(NSOrderedSet(array: envelope.hosts)) as? [String] ?? envelope.hosts
        self.port = envelope.port
    }

    static func isValidToken(_ value: String) -> Bool {
        value.range(of: #"^[0-9A-Fa-f]{32}$"#, options: .regularExpression) != nil
    }

    static func isAllowedPairingHost(_ host: String) -> Bool {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4,
              parts.allSatisfy({ !$0.isEmpty && $0.count <= 3 && $0.allSatisfy(\.isNumber) }),
              let a = Int(parts[0]), let b = Int(parts[1]), let c = Int(parts[2]), let d = Int(parts[3]),
              [a, b, c, d].allSatisfy({ (0...255).contains($0) }) else { return false }
        return a == 10
            || (a == 172 && (16...31).contains(b))
            || (a == 192 && b == 168)
            || (a == 169 && b == 254)
            || (a == 192 && b == 0 && c == 0 && d <= 7)
    }

    var confirmationSummary: String {
        "接続先: \(hosts.joined(separator: ", "))\nポート: \(port)\nこの接続はTLS暗号化されません。信頼できるローカルネットワークでのみ続行してください。"
    }
}

enum PairingValidationError: LocalizedError {
    case invalidURL, invalidPayload, unsupportedVersion, invalidToken, invalidHost, invalidPort

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "codexmicro://pair 形式のQRだけを使用できます。"
        case .invalidPayload: return "QRのペアリング情報を読み取れません。"
        case .unsupportedVersion: return "このQRのバージョンには対応していません。"
        case .invalidToken: return "ペアリングトークンの形式が正しくありません。"
        case .invalidHost: return "接続先は許可されたローカルIPv4ではありません。"
        case .invalidPort: return "接続ポートが許可範囲外です。"
        }
    }
}

private struct PairingEnvelope: Decodable {
    let version: Int
    let token: String
    let hosts: [String]
    let port: Int
}
