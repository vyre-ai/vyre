// MacIdentity: this Mac's identity key, for claiming and recovering a name in the Mac app's window. The key is Ed25519, the same kind every device of a name holds. Its seed lives in
// the login Keychain (this device only) and never reaches the page: the page asks for the public key and for signatures over the bytes of a chain operation, and Swift signs
// (CryptoKit's Curve25519). A Mac key signs a list change alone: the chain asks for a second, Secure Enclave signature only of an entry that names one (a phone's), and
// the Mac's own hardware-held proof is a later item (the PI-1 ruling).
//
// The seed store is a protocol so the Swift tests run the key with a memory store; the Keychain one is not run under the tests.

import CryptoKit
import Foundation
import Security

protocol IdentitySeedStore {
    func load() -> Data?
    @discardableResult func save(_ seed: Data) -> Bool
    func delete()
}

/// One Keychain item per Vyre home: the 32-byte seed, readable only on this Mac and only while it is unlocked.
struct KeychainSeedStore: IdentitySeedStore {
    static let service = "sh.vyre.identity"
    let account: String
    init(home: String) { account = "seed:" + home }

    private var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service, kSecAttrAccount as String: account] }

    func load() -> Data? {
        var q = query
        q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data, d.count == 32 else { return nil }
        return d
    }

    @discardableResult func save(_ seed: Data) -> Bool {
        SecItemDelete(query as CFDictionary)
        var q = query
        q[kSecValueData as String] = seed
        q[kSecAttrLabel as String] = "Vyre identity key"
        q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        if status == errSecSuccess { return true }
        VyreAppWindow.log("identity seed save: OSStatus \(status)")
        // An app signed ad hoc (no Developer ID yet) carries no keychain entitlement, so macOS refuses the "this device only" class (errSecMissingEntitlement).
        // The login Keychain still keeps the seed on this Mac, readable only while it is unlocked; a signed build takes the first path.
        guard status == errSecMissingEntitlement else { return false }
        q.removeValue(forKey: kSecAttrAccessible as String)
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }

    func delete() { SecItemDelete(query as CFDictionary) }
}

/// A seed kept in memory (tests).
final class MemorySeedStore: IdentitySeedStore, @unchecked Sendable {
    private var seed: Data?
    func load() -> Data? { seed }
    @discardableResult func save(_ s: Data) -> Bool { seed = s; return true }
    func delete() { seed = nil }
}

struct MacIdentity {
    let store: IdentitySeedStore

    /// The 32-byte public key. With `create`, a missing key is made (and kept) first; without it a missing key is nil. nil too when the Keychain would not keep a new one.
    func publicKey(create: Bool) -> Data? {
        if let seed = store.load(), let k = try? Curve25519.Signing.PrivateKey(rawRepresentation: seed) { return k.publicKey.rawRepresentation }
        guard create else { return nil }
        let k = Curve25519.Signing.PrivateKey()
        guard store.save(k.rawRepresentation) else { return nil }
        return k.publicKey.rawRepresentation
    }

    /// The 64-byte Ed25519 signature of `message`, or nil when there is no key.
    func sign(_ message: Data) -> Data? {
        guard let seed = store.load(), let k = try? Curve25519.Signing.PrivateKey(rawRepresentation: seed), let sig = try? k.signature(for: message) else { return nil }
        return sig
    }

    var has: Bool { store.load() != nil }
    func forget() { store.delete() }

    static func b64url(_ d: Data) -> String { d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    static func unb64url(_ s: String) -> Data? {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t)
    }
}
