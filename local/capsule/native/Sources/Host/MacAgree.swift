// MacAgree: this Mac's agreement key, the key another device wraps a chat key (or the identity home) to. P-256, ECDH only: `agree(epk)` is the 32-byte shared secret (the raw X coordinate) between this
// key and a peer's point, and everything after is portable code in the page (HKDF-SHA256, AES-256-GCM: lib/keywrap.js). The private key never leaves: in the Secure Enclave where this Mac has
// one, otherwise a software key kept in the login Keychain (this device only), the same fallback the signing keys have. There is NO prompt per use: opening a chat is not one of the yes moments (the
// user's no-nagging rule), so the key is usable while the Mac is unlocked. Its public point goes in this device's identity entry as `agree`.
//
// A key of its own, kept in its own Keychain item, apart from the Secure Enclave signing key (MacEnclave.swift): a signing key cannot do ECDH.

import CryptoKit
import Foundation
import Security

/// What the page needs of a P-256 key-agreement key: true of the Secure Enclave's and of an ordinary in-memory key (which tests and the software fallback use).
protocol AgreementKey {
    var publicKey: P256.KeyAgreement.PublicKey { get }
    func sharedSecretFromKeyAgreement(with publicKeyShare: P256.KeyAgreement.PublicKey) throws -> SharedSecret
}
extension SecureEnclave.P256.KeyAgreement.PrivateKey: AgreementKey {}
extension P256.KeyAgreement.PrivateKey: AgreementKey {}

final class KeychainAgreeStore: PresenceKeyStore {
    static let service = "sh.vyre.identity.agree"
    let account: String
    init(home: String) { account = "agree:" + home }
    private var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service, kSecAttrAccount as String: account] }
    func loadHandle() -> Data? {
        var q = query
        q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return d
    }
    func save(_ handle: Data) -> Bool {
        delete()
        var q = query
        q[kSecValueData as String] = handle
        q[kSecAttrLabel as String] = "Vyre agreement key"
        q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }
    func delete() { SecItemDelete(query as CFDictionary) }
}

final class MacAgree: @unchecked Sendable {
    let store: PresenceKeyStore
    /// Whether this Mac has a Secure Enclave (a fake in tests).
    var hasSecureEnclave: () -> Bool = { SecureEnclave.isAvailable }
    /// A software key's handle starts with this; a Secure Enclave handle is the enclave's own bytes.
    static let softwareTag = Data("SW1:".utf8)
    /// Makes a key and its handle: in the enclave when asked and available (no biometry flag: the private key is usable while the Mac is unlocked), else software.
    var makeKey: (Bool) -> Data? = { enclave in
        if enclave {
            var err: Unmanaged<CFError>?
            guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage], &err),
                  let key = try? SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access) else { return nil }
            return key.dataRepresentation
        }
        return MacAgree.softwareTag + P256.KeyAgreement.PrivateKey().rawRepresentation
    }
    /// The key behind a stored handle, either kind.
    var keyOf: (Data) -> AgreementKey? = { handle in
        if handle.starts(with: MacAgree.softwareTag) { return try? P256.KeyAgreement.PrivateKey(rawRepresentation: handle.dropFirst(MacAgree.softwareTag.count)) }
        return try? SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: handle)
    }

    init(store: PresenceKeyStore) { self.store = store }

    /// The raw uncompressed point (65 bytes, 0x04, X, Y). Made on first use with `create`; nil when there is no key and `create` is false, or the Keychain would not keep one.
    func publicPoint(create: Bool) -> Data? {
        if let h = store.loadHandle(), let k = keyOf(h) { return k.publicKey.x963Representation }
        guard create else { return nil }
        guard let handle = makeKey(hasSecureEnclave()) ?? makeKey(false), store.save(handle), let k = keyOf(handle) else { return nil }
        return k.publicKey.x963Representation
    }

    /// The 32-byte shared secret with the peer's raw uncompressed point `epk` (anything else is refused before the key is touched). nil when there is no key.
    func agree(epk: Data) -> Data? {
        guard epk.count == 65, epk.first == 0x04, let peer = try? P256.KeyAgreement.PublicKey(x963Representation: epk) else { return nil }
        guard let h = store.loadHandle(), let k = keyOf(h), let shared = try? k.sharedSecretFromKeyAgreement(with: peer) else { return nil }
        return shared.withUnsafeBytes { Data($0) }
    }

    func forget() { store.delete() }
}
