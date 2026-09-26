import Foundation
import Security

/// Generic-password items in the Keychain: the device key's blob, the box address, the push key.
/// Nothing else is kept there (ADR 0018 section 6). Items shared with the notification extension
/// go in the app's shared keychain group when the build is signed with a team; an unsigned
/// simulator build has no groups, and the items stay in the app's own.
enum Keychain {
    static let service = "sh.vyre.app"

    /// "<team prefix>sh.vyre.app.shared", found from an item's own access group, or nil unsigned.
    static let sharedGroup: String? = {
        let probe = "sh.vyre.app.group-probe"
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: probe,
                                kSecAttrAccount as String: probe, kSecReturnAttributes as String: true]
        var out: CFTypeRef?
        var status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound {
            let add: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: probe,
                                      kSecAttrAccount as String: probe, kSecValueData as String: Data(),
                                      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                                      kSecReturnAttributes as String: true]
            status = SecItemAdd(add as CFDictionary, &out)
        }
        guard status == errSecSuccess, let attrs = out as? [String: Any], let group = attrs[kSecAttrAccessGroup as String] as? String,
              let dot = group.firstIndex(of: ".") else { return nil }
        let prefix = group[..<dot]
        // An unsigned build reports a group without a real team prefix; "test" or the bundle id.
        guard prefix.count == 10, prefix.allSatisfy({ $0.isUppercase || $0.isNumber }) else { return nil }
        return String(prefix) + ".sh.vyre.app.shared"
    }()

    enum Access { case whenUnlocked, afterFirstUnlock }

    static func set(_ data: Data, for account: String, shared: Bool = false, access: Access = .whenUnlocked) throws {
        var q = base(account, shared: shared)
        SecItemDelete(q as CFDictionary)
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = access == .whenUnlocked ? kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            : kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    static func get(_ account: String, shared: Bool = false) -> Data? {
        var q = base(account, shared: shared)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    static func delete(_ account: String, shared: Bool = false) {
        SecItemDelete(base(account, shared: shared) as CFDictionary)
    }

    private static func base(_ account: String, shared: Bool) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: account]
        if shared, let g = sharedGroup { q[kSecAttrAccessGroup as String] = g }
        return q
    }
}

struct KeychainError: Error, LocalizedError {
    let status: OSStatus
    var errorDescription: String? { "The Keychain refused (\(status))." }
}
