import CryptoKit
import Foundation

/// RFC 7636 proof key. The hive's OAuth provider requires S256 for public
/// clients (a native app can't keep a client secret).
public struct PKCE: Sendable {
    public let verifier: String
    public let challenge: String

    public init() {
        self.init(verifier: Self.randomURLSafe(bytes: 32))
    }

    public init(verifier: String) {
        self.verifier = verifier
        self.challenge = Self.base64url(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    static func randomURLSafe(bytes count: Int) -> String {
        var rng = SystemRandomNumberGenerator()
        return base64url(Data((0..<count).map { _ in UInt8.random(in: .min ... .max, using: &rng) }))
    }

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
