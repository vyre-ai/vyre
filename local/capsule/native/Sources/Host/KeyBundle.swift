// KeyBundle: every key this Mac holds for one Vyre home, in ONE Keychain item. The identity key's seed, the Secure Enclave key's handle, the key-agreement key's handle and the Capsule's
// presence key's handle used to be four items, and an app signed ad hoc (no Developer ID yet) is a new program to the Keychain with every build: each item asked the person once, so a fresh
// build asked up to four times. One item asks once, and the bundle is read once per launch and held in memory (never written to disk), so "Always Allow" answers it for good.
// With Developer ID signing a data-protection keychain and an access group would ask nothing at all; this changes none of that (IR-33, SPEC-0.3.0 item 1.10).
//
// What is in the bundle is what was in the four items, no more: the seed is key material, the three handles are opaque (the Secure Enclave's own bytes, or a software key's with its tag). The
// bundle is a small JSON object, `{ "v": 1, "seed": <base64>, "enclave": <base64>, "agree": <base64>, "presence": <base64> }`, each field present only when that key exists.
//
// An older install has the four separate items. The first read finds no bundle, reads those once (the one prompt each of them always cost), writes the bundle, and takes the old items away, so
// from then on the bundle is the only copy. `forget` takes both away.
//
// The Keychain itself is a protocol (`KeyBundleBacking`) so the Swift tests run the bundle with a memory backing; the Keychain one is not run under the tests.

import Foundation
import Security

/// Where the one item lives.
protocol KeyBundleBacking: AnyObject {
    /// The item's bytes, or nil when there is none.
    func read() -> Data?
    /// Replace the item. false when the Keychain would not keep it.
    @discardableResult func write(_ data: Data) -> Bool
    func delete()
}

/// The login Keychain: one generic-password item per Vyre home.
final class KeychainBundleBacking: KeyBundleBacking {
    static let service = "sh.vyre.keys"
    let account: String
    init(home: String) { account = "bundle:" + home }

    private var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service, kSecAttrAccount as String: account] }

    func read() -> Data? {
        var q = query
        q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return d
    }

    @discardableResult func write(_ data: Data) -> Bool {
        SecItemDelete(query as CFDictionary)
        var q = query
        q[kSecValueData as String] = data
        q[kSecAttrLabel as String] = "Vyre keys"
        q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        if status == errSecSuccess { return true }
        VyreAppWindow.log("key bundle save: OSStatus \(status)")
        // An app signed ad hoc carries no keychain entitlement, so macOS refuses the "this device only" class (errSecMissingEntitlement); the login Keychain still keeps the item on this Mac.
        guard status == errSecMissingEntitlement else { return false }
        q.removeValue(forKey: kSecAttrAccessible as String)
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }

    func delete() { SecItemDelete(query as CFDictionary) }
}

/// A backing in memory (tests); counts its reads so a test can say "once".
final class MemoryBundleBacking: KeyBundleBacking, @unchecked Sendable {
    private var data: Data?
    private(set) var reads = 0
    private(set) var writes = 0
    func read() -> Data? { reads += 1; return data }
    @discardableResult func write(_ d: Data) -> Bool { writes += 1; data = d; return true }
    func delete() { data = nil }
}

final class KeyBundle: @unchecked Sendable {
    /// The four keys, by the name each has in the bundle.
    enum Slot: String, CaseIterable {
        case seed, enclave, agree, presence
    }

    /// One of the old separate items, read once to move it into the bundle and then taken away.
    struct Legacy {
        let load: () -> Data?
        let delete: () -> Void
    }

    private let backing: KeyBundleBacking
    private let legacy: [Slot: Legacy]
    private let lock = NSLock()
    /// The bundle as read this launch. nil until the first use.
    private var held: [Slot: Data]?

    init(backing: KeyBundleBacking, legacy: [Slot: Legacy] = [:]) {
        self.backing = backing
        self.legacy = legacy
    }

    /// The Keychain bundle for a home, moving the four older items in on first use.
    static func keychain(home: String) -> KeyBundle {
        let seed = KeychainSeedStore(home: home), enclave = KeychainEnclaveStore(home: home), agree = KeychainAgreeStore(home: home), presence = KeychainKeyStore(home: home)
        return KeyBundle(backing: KeychainBundleBacking(home: home), legacy: [
            .seed: Legacy(load: { seed.load() }, delete: { seed.delete() }),
            .enclave: Legacy(load: { enclave.loadHandle() }, delete: { enclave.delete() }),
            .agree: Legacy(load: { agree.loadHandle() }, delete: { agree.delete() }),
            .presence: Legacy(load: { presence.loadHandle() }, delete: { presence.delete() }),
        ])
    }

    // MARK: reading and writing

    /// The bytes of one key, or nil. The first call of the launch reads the Keychain (once); every later call answers from memory.
    func get(_ slot: Slot) -> Data? {
        lock.lock(); defer { lock.unlock() }
        return loaded()[slot]
    }

    /// Keep one key. The whole bundle is written again; false when the Keychain would not keep it (the key is then not held either, so nothing claims a key that was not kept).
    @discardableResult func set(_ slot: Slot, _ data: Data) -> Bool {
        lock.lock(); defer { lock.unlock() }
        var all = loaded()
        all[slot] = data
        guard backing.write(Self.encode(all)) else { return false }
        held = all
        return true
    }

    /// Take one key away. The bundle goes with its last key.
    func remove(_ slot: Slot) {
        lock.lock(); defer { lock.unlock() }
        var all = loaded()
        guard all[slot] != nil else { return }
        all[slot] = nil
        if all.isEmpty { backing.delete() } else { _ = backing.write(Self.encode(all)) }
        held = all
    }

    /// Take every key away, the bundle and any older separate item too.
    func forgetAll() {
        lock.lock(); defer { lock.unlock() }
        backing.delete()
        for (_, l) in legacy { l.delete() }
        held = [:]
    }

    // MARK: the first read

    /// The held bundle, read now if this is the first use. Callers hold the lock.
    private func loaded() -> [Slot: Data] {
        if let h = held { return h }
        var all: [Slot: Data] = [:]
        if let raw = backing.read() {
            all = Self.decode(raw)
        } else {
            // No bundle: an older install keeps the four separate items. Read what is there, keep it in a bundle, and take the old copies away.
            for slot in Slot.allCases { if let d = legacy[slot]?.load(), !d.isEmpty { all[slot] = d } }
            if !all.isEmpty, backing.write(Self.encode(all)) { for slot in all.keys { legacy[slot]?.delete() } }
        }
        held = all
        return all
    }

    // MARK: the bytes of the item

    static func encode(_ all: [Slot: Data]) -> Data {
        var o: [String: Any] = ["v": 1]
        for (slot, d) in all { o[slot.rawValue] = d.base64EncodedString() }
        return (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])) ?? Data()
    }

    /// The keys in the bytes; anything that is not a bundle of this version reads as no keys at all.
    static func decode(_ raw: Data) -> [Slot: Data] {
        guard let o = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any], (o["v"] as? Int) == 1 else { return [:] }
        var out: [Slot: Data] = [:]
        for slot in Slot.allCases { if let s = o[slot.rawValue] as? String, let d = Data(base64Encoded: s), !d.isEmpty { out[slot] = d } }
        return out
    }
}

/// The identity seed as a slot of the bundle: 32 bytes, nothing else.
struct BundleSeedStore: IdentitySeedStore {
    let bundle: KeyBundle
    func load() -> Data? { guard let d = bundle.get(.seed), d.count == 32 else { return nil }; return d }
    @discardableResult func save(_ seed: Data) -> Bool { bundle.set(.seed, seed) }
    func delete() { bundle.remove(.seed) }
}

/// A key's opaque handle as a slot of the bundle: the Secure Enclave key, the key-agreement key or the presence key.
final class BundleHandleStore: PresenceKeyStore {
    let bundle: KeyBundle
    let slot: KeyBundle.Slot
    init(bundle: KeyBundle, slot: KeyBundle.Slot) { self.bundle = bundle; self.slot = slot }
    func loadHandle() -> Data? { bundle.get(slot) }
    func save(_ handle: Data) -> Bool { bundle.set(slot, handle) }
    func delete() { bundle.remove(slot) }
}
