import Foundation
import Security

/// Credentials at rest: one generic-password item in the data-protection
/// keychain, readable after first unlock, never synced or migrated to another
/// device (a refresh token is a bearer for the whole hive).
///
/// macOS exception: a Mac build signed without a provisioning profile (no
/// `application-identifier` entitlement — a local dev build, or a fork with no
/// team) is refused by the data-protection keychain with errSecMissingEntitlement.
/// There the item falls back to the login keychain: still encrypted at rest and
/// ACL'd to this app's signature, just not data-protection classed.
public struct KeychainStore: Sendable {
    public let service: String
    public let account: String
    /// Set when the Watch (or an extension) needs to share the item.
    public let accessGroup: String?

    public init(service: String, account: String = "credentials", accessGroup: String? = nil) {
        self.service = service
        self.account = account
        self.accessGroup = accessGroup
    }

    private func query(dataProtection: Bool) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if dataProtection {
            q[kSecUseDataProtectionKeychain as String] = true
            if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        }
        return q
    }

    /// Data-protection first; the login keychain only where the platform has one.
    private var stores: [Bool] {
        #if os(macOS)
        return [true, false]
        #else
        return [true]
        #endif
    }

    public func load() -> Credentials? {
        for dp in stores {
            var q = query(dataProtection: dp)
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            var out: CFTypeRef?
            if SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data {
                return try? JSONDecoder().decode(Credentials.self, from: data)
            }
        }
        return nil
    }

    public func save(_ credentials: Credentials) throws {
        let data = try JSONEncoder().encode(credentials)
        var status = errSecMissingEntitlement
        for dp in stores {
            var attrs: [String: Any] = [kSecValueData as String: data]
            if dp { attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly }
            let base = query(dataProtection: dp)
            status = SecItemUpdate(base as CFDictionary, attrs as CFDictionary)
            if status == errSecItemNotFound {
                status = SecItemAdd(base.merging(attrs) { $1 } as CFDictionary, nil)
            }
            if status != errSecMissingEntitlement { break }
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func delete() {
        for dp in stores { SecItemDelete(query(dataProtection: dp) as CFDictionary) }
    }
}

public struct KeychainError: LocalizedError, Sendable {
    public let status: OSStatus
    public var errorDescription: String? {
        "Keychain error \(status): \(SecCopyErrorMessageString(status, nil) as String? ?? "unknown")"
    }
}
