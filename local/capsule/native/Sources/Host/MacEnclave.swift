// MacEnclave: the Secure Enclave key of this Mac's device entry on the identity chain (NK-2), the way a phone's entry has one. It is a P-256 key made in the Secure Enclave with
// .userPresence (Touch ID, or the Mac's password where there is no reader), so the private key never leaves the enclave and every signature needs the person. The entry names its public
// point (`enclave`), and from then on every change to who speaks for the name that this Mac signs carries this key's signature too (`esig`): reading the Keychain seed alone changes nothing.
//
// A Mac with no Secure Enclave has no such key: `publicPoint` is nil, and its entry stays an Ed25519 key that signs alone. A software P-256 key would claim a hardware guarantee it does not give.
// This is a key of its own, kept in its own Keychain item: the Capsule's presence key (Presence.swift) is enrolled with vyred, and re-enrolling it must never change a name's entry.

import CryptoKit
import Foundation
import LocalAuthentication
import Security

/// The Keychain item holding this key's opaque handle (useless off this Mac's enclave, and unusable without the person).
final class KeychainEnclaveStore: PresenceKeyStore {
    static let service = "sh.vyre.identity.enclave"
    let account: String
    init(home: String) { account = "enclave:" + home }
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
        q[kSecAttrLabel as String] = "Vyre identity Secure Enclave key"
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }
    func delete() { SecItemDelete(query as CFDictionary) }
}

final class MemoryEnclaveStore: PresenceKeyStore, @unchecked Sendable {
    private var handle: Data?
    func loadHandle() -> Data? { handle }
    func save(_ h: Data) -> Bool { handle = h; return true }
    func delete() { handle = nil }
}

final class MacEnclave: @unchecked Sendable {
    let store: PresenceKeyStore
    /// Whether this Mac has a Secure Enclave (a fake in tests).
    var hasSecureEnclave: () -> Bool = { SecureEnclave.isAvailable }
    /// Makes the key and its handle (a software key in tests).
    var makeKey: (Bool) -> (handle: Data, der: Data)? = { CapsulePresence.makeDeviceKey(secureEnclave: $0) }
    /// The key behind a handle, unlocked with an authenticated context.
    var keyOf: (Data, LAContext) -> CapsuleSigningKey? = { CapsulePresence.signingKey(handle: $0, context: $1) }
    /// Asks the person (Touch ID, or the Mac's password) for this one signature; false when they decline. A fake in tests.
    var authenticate: (LAContext, String) async -> Bool = { context, reason in
        await withCheckedContinuation { cont in
            let policy: LAPolicy = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) ? .deviceOwnerAuthenticationWithBiometrics : .deviceOwnerAuthentication
            context.evaluatePolicy(policy, localizedReason: reason) { ok, _ in cont.resume(returning: ok) }
        }
    }

    init(store: PresenceKeyStore) { self.store = store }

    /// The key's public point, raw uncompressed (65 bytes, leading 0x04): the `enclave` field of the device entry. nil on a Mac with no Secure Enclave, when `create` is false and there is
    /// no key yet, or when the Keychain would not keep a new one. The key is made the first time it is asked for with `create`.
    func publicPoint(create: Bool) -> Data? {
        guard hasSecureEnclave() else { return nil }
        if let h = store.loadHandle(), let k = keyOf(h, LAContext()) { return k.publicKey.x963Representation }
        guard create, let made = makeKey(true), store.save(made.handle) else { return nil }
        guard let k = keyOf(made.handle, LAContext()) else { return nil }
        return k.publicKey.x963Representation
    }

    /// The raw 64-byte signature (r then s) of `message`, after the person says yes to `reason`. nil when there is no key or they decline. (The chain wants the low-s form; the page makes it.)
    func sign(_ message: Data, reason: String) async -> Data? {
        guard let h = store.loadHandle() else { return nil }
        let context = LAContext()
        context.localizedCancelTitle = "Not now"
        defer { context.invalidate() }
        guard await authenticate(context, reason) else { return nil }
        guard let k = keyOf(h, context), let sig = try? k.signature(for: message) else { return nil }
        return sig.rawRepresentation
    }

    func forget() { store.delete() }
}
