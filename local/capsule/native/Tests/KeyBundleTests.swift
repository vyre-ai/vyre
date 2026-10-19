// capsule-suite: keyBundleSuite
// The Mac's keys in one Keychain item (Host/KeyBundle.swift), with a memory backing in place of the Keychain: read once per launch however many keys are asked for, kept across a new
// launch, moved in from the four older items once, taken away on request, and a bundle that is not one reads as no keys. The Keychain backing is not run here.

import CryptoKit
import Foundation

/// The four older items as a memory fake: what each held, and whether it was taken away.
private final class OldItems: @unchecked Sendable {
    var held: [KeyBundle.Slot: Data]
    var loads = 0
    var deleted: Set<KeyBundle.Slot> = []
    init(_ held: [KeyBundle.Slot: Data]) { self.held = held }
    var legacy: [KeyBundle.Slot: KeyBundle.Legacy] {
        Dictionary(uniqueKeysWithValues: KeyBundle.Slot.allCases.map { slot in
            (slot, KeyBundle.Legacy(load: { self.loads += 1; return self.deleted.contains(slot) ? nil : self.held[slot] }, delete: { self.deleted.insert(slot) }))
        })
    }
}

/// A Keychain that will not keep anything.
private final class RefusingBacking: KeyBundleBacking, @unchecked Sendable {
    func read() -> Data? { nil }
    func write(_ data: Data) -> Bool { false }
    func delete() {}
}

private let seed = Data(repeating: 7, count: 32)
private let handle = Data("SW1:".utf8) + Data(repeating: 3, count: 32)

let keyBundleSuite = Suite("key bundle") { t in
    t.test("however many keys are asked for, the Keychain is read once in a launch") {
        let backing = MemoryBundleBacking()
        let first = KeyBundle(backing: backing)
        t.ok(first.set(.seed, seed))
        t.ok(first.set(.enclave, handle))
        t.ok(first.set(.agree, handle))
        t.ok(first.set(.presence, handle))
        t.ok(first.set(.relay, handle))
        let before = backing.reads
        let next = KeyBundle(backing: backing)
        for slot in KeyBundle.Slot.allCases { t.ok(next.get(slot) != nil, slot.rawValue) }
        for _ in 0..<10 { for slot in KeyBundle.Slot.allCases { _ = next.get(slot) } }
        t.eq(backing.reads - before, 1, "one read for a whole launch")
    }

    t.test("what is kept is the same after a new launch, and each key is its own") {
        let backing = MemoryBundleBacking()
        let a = KeyBundle(backing: backing)
        t.ok(a.set(.seed, seed))
        t.ok(a.set(.agree, handle))
        let b = KeyBundle(backing: backing)
        t.eq(b.get(.seed), seed)
        t.eq(b.get(.agree), handle)
        t.eq(b.get(.enclave), nil)
        t.eq(b.get(.presence), nil)
    }

    t.test("taking one key away leaves the others, and the item goes with the last one") {
        let backing = MemoryBundleBacking()
        let a = KeyBundle(backing: backing)
        t.ok(a.set(.seed, seed))
        t.ok(a.set(.enclave, handle))
        a.remove(.seed)
        t.eq(KeyBundle(backing: backing).get(.seed), nil)
        t.eq(KeyBundle(backing: backing).get(.enclave), handle)
        a.remove(.enclave)
        t.eq(backing.read(), nil, "no keys, no item")
    }

    t.test("the four older items are read once, kept in the bundle and taken away") {
        let old = OldItems([.seed: seed, .enclave: handle, .agree: handle, .presence: handle])
        let backing = MemoryBundleBacking()
        let a = KeyBundle(backing: backing, legacy: old.legacy)
        t.eq(a.get(.seed), seed)
        t.eq(a.get(.presence), handle)
        t.eq(backing.writes, 1, "the bundle was written once")
        t.eq(old.deleted.count, 4, "every older item was taken away")
        let loadsAfterMove = old.loads
        let b = KeyBundle(backing: backing, legacy: old.legacy)
        t.eq(b.get(.enclave), handle)
        t.eq(old.loads, loadsAfterMove, "a bundle that exists is the only place read")
    }

    t.test("an older install with only some of the items moves what it has") {
        let old = OldItems([.seed: seed])
        let backing = MemoryBundleBacking()
        let a = KeyBundle(backing: backing, legacy: old.legacy)
        t.eq(a.get(.seed), seed)
        t.eq(a.get(.enclave), nil)
        t.eq(old.deleted, [.seed])
    }

    t.test("nothing anywhere is no keys, and nothing is written for it") {
        let backing = MemoryBundleBacking()
        let a = KeyBundle(backing: backing, legacy: OldItems([:]).legacy)
        t.eq(a.get(.seed), nil)
        t.eq(backing.writes, 0)
    }

    t.test("forgetting takes the bundle and any older item away") {
        let old = OldItems([.seed: seed, .agree: handle])
        let backing = MemoryBundleBacking()
        let a = KeyBundle(backing: backing, legacy: old.legacy)
        t.ok(a.set(.presence, handle))
        a.forgetAll()
        t.eq(a.get(.seed), nil)
        t.eq(backing.read(), nil)
        // the stand-in lists an older item for every slot, so every one of them is taken away (the relay slot has no older item in the real Keychain; the stand-in asks the same of all)
        t.eq(old.deleted.count, KeyBundle.Slot.allCases.count)
    }

    t.test("bytes that are not a bundle of this version read as no keys") {
        for junk in [Data(), Data("not json".utf8), Data("{\"v\":2,\"seed\":\"AAAA\"}".utf8), Data("[1,2]".utf8)] {
            let backing = MemoryBundleBacking()
            backing.write(junk)
            t.eq(KeyBundle(backing: backing).get(.seed), nil)
        }
        t.eq(KeyBundle.decode(KeyBundle.encode([.seed: seed, .agree: handle])), [.seed: seed, .agree: handle])
    }

    t.test("a Keychain that will not keep a key means the key is not held either") {
        let a = KeyBundle(backing: RefusingBacking())
        t.ok(!a.set(.seed, seed))
        t.eq(a.get(.seed), nil)
    }

    t.test("the identity key over the bundle: made once, the same after a new launch, gone when forgotten") {
        let backing = MemoryBundleBacking()
        let id = MacIdentity(store: BundleSeedStore(bundle: KeyBundle(backing: backing)))
        let pub = id.publicKey(create: true)
        t.eq(pub?.count, 32)
        let again = MacIdentity(store: BundleSeedStore(bundle: KeyBundle(backing: backing)))
        t.eq(again.publicKey(create: false), pub)
        t.ok(again.sign(Data("x".utf8)) != nil)
        again.forget()
        t.ok(!MacIdentity(store: BundleSeedStore(bundle: KeyBundle(backing: backing))).has)
    }

    t.test("a seed that is not 32 bytes is not a key") {
        let bundle = KeyBundle(backing: MemoryBundleBacking())
        t.ok(bundle.set(.seed, Data(repeating: 1, count: 31)))
        t.eq(BundleSeedStore(bundle: bundle).load(), nil)
    }

    t.test("the handle stores for the enclave, agreement and presence keys are separate slots of one bundle") {
        let bundle = KeyBundle(backing: MemoryBundleBacking())
        let enclave = BundleHandleStore(bundle: bundle, slot: .enclave), agree = BundleHandleStore(bundle: bundle, slot: .agree), presence = BundleHandleStore(bundle: bundle, slot: .presence)
        t.ok(enclave.save(Data("E".utf8)))
        t.ok(agree.save(Data("A".utf8)))
        t.eq(enclave.loadHandle(), Data("E".utf8))
        t.eq(agree.loadHandle(), Data("A".utf8))
        t.eq(presence.loadHandle(), nil)
        agree.delete()
        t.eq(agree.loadHandle(), nil)
        t.eq(enclave.loadHandle(), Data("E".utf8))
    }

    // The Keychain backing with SecItemAdd and SecItemUpdate faked: how a write falls back on an ad-hoc-signed app. (SecItemDelete is the real one, on a test service and an account no one has.)
    func fakeBacking(_ add: @escaping (String?) -> OSStatus, update: @escaping () -> OSStatus = { errSecSuccess }) -> (KeychainBundleBacking, () -> [String]) {
        let b = KeychainBundleBacking(home: "test-" + UUID().uuidString, service: "sh.vyre.keys.test")
        var tried: [String] = []
        b.addItem = { q in let cls = (q[kSecAttrAccessible as String] as! CFString?).map { $0 as String }; tried.append(cls ?? "none"); return add(cls) }
        b.updateItem = { _, _ in tried.append("update"); return update() }
        return (b, { tried })
    }

    t.test("an ad-hoc app: the this-device-only class is refused (errSecMissingEntitlement), so the item goes to the login Keychain with the next class, and nothing is reported") {
        let (b, tried) = fakeBacking { cls in cls == (kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String) ? errSecMissingEntitlement : errSecSuccess }
        t.ok(b.write(Data("x".utf8)))
        t.eq(tried(), [kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String, kSecAttrAccessibleAfterFirstUnlock as String], "the stronger class first, the fallback only on refusal")
        t.eq(b.lastError, nil)
    }

    t.test("a signed app keeps using the stronger class: no fallback is tried when it works") {
        let (b, tried) = fakeBacking { _ in errSecSuccess }
        t.ok(b.write(Data("x".utf8)))
        t.eq(tried(), [kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String])
    }

    t.test("an item an earlier build left is written over in place, not given up on") {
        let (b, tried) = fakeBacking { cls in cls == (kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String) ? errSecMissingEntitlement : errSecDuplicateItem }
        t.ok(b.write(Data("x".utf8)))
        t.eq(tried(), [kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String, kSecAttrAccessibleAfterFirstUnlock as String, "update"])
    }

    t.test("when every class is refused, the write fails with the Keychain's reason, and the bundle says it") {
        let (b, tried) = fakeBacking { _ in errSecMissingEntitlement }
        t.ok(!b.write(Data("x".utf8)))
        t.eq(tried().count, 3, "all three classes were tried")
        t.ok(b.lastError?.contains("OSStatus -34018") == true, b.lastError ?? "no reason")
        let bundle = KeyBundle(backing: b)
        t.ok(!bundle.set(.agree, handle))
        t.ok(bundle.lastError?.hasPrefix("the Keychain said") == true)
        let agree = MacAgree(store: BundleHandleStore(bundle: bundle, slot: .agree))
        agree.hasSecureEnclave = { false }
        t.eq(agree.publicPoint(create: true), nil)
        t.ok(agree.lastError?.contains("OSStatus -34018") == true, "the agreement key carries the reason to the page: \(agree.lastError ?? "none")")
    }

    // The real login Keychain, from this test binary, which is signed ad hoc with no entitlements (as the app is until it has a Developer ID): proof that the fallback keeps a key there.
    // Only on CI (GitHub's macOS runner), never on a person's Mac; an item of its own, taken away after.
    t.test("on CI: the real Keychain keeps a bundle for an ad-hoc binary with no entitlements, and gives it back") {
        let env = ProcessInfo.processInfo.environment
        guard env["GITHUB_ACTIONS"] == "true" else { FileHandle.standardError.write(Data("# key bundle: real Keychain test runs on CI only\n".utf8)); return }
        let b = KeychainBundleBacking(home: "ci-" + UUID().uuidString, service: "sh.vyre.keys.ci-test")
        var used = "none"
        b.addItem = { q in
            let s = SecItemAdd(q as CFDictionary, nil)
            if s == errSecSuccess { used = (q[kSecAttrAccessible as String] as! CFString?).map { $0 as String } ?? "login keychain default" }
            FileHandle.standardError.write(Data("# key bundle: SecItemAdd \((q[kSecAttrAccessible as String] as! CFString?).map { $0 as String } ?? "no class") -> OSStatus \(s)\n".utf8))
            return s
        }
        defer { b.delete() }
        let bundle = KeyBundle(backing: b)
        let agree = MacAgree(store: BundleHandleStore(bundle: bundle, slot: .agree))
        agree.hasSecureEnclave = { false }
        let point = agree.publicPoint(create: true)
        FileHandle.standardError.write(Data("# key bundle: kept with class \(used); lastError \(agree.lastError ?? "none")\n".utf8))
        t.eq(point?.count, 65, "the agreement key was kept: \(agree.lastError ?? "")")
        // a new launch reads it back from the Keychain itself
        let again = MacAgree(store: BundleHandleStore(bundle: KeyBundle(backing: KeychainBundleBacking(home: String(b.account.dropFirst("bundle:".count)), service: "sh.vyre.keys.ci-test")), slot: .agree))
        t.eq(again.publicPoint(create: false), point, "the same key after a new launch")
    }

    t.test("the app keeps all four keys in the one bundle") {
        let app = (try? String(contentsOfFile: #filePath.replacingOccurrences(of: "Tests/KeyBundleTests.swift", with: "Sources/Host/App.swift"), encoding: .utf8)) ?? ""
        for piece in ["KeyBundle.keychain(home: home)", "BundleSeedStore(bundle: keys)", "BundleHandleStore(bundle: keys, slot: .enclave)", "BundleHandleStore(bundle: keys, slot: .agree)", "BundleHandleStore(bundle: keys, slot: .presence)"] {
            t.ok(app.contains(piece), piece)
        }
        t.ok(!app.contains("KeychainSeedStore(home") && !app.contains("KeychainEnclaveStore(home") && !app.contains("KeychainAgreeStore(home"), "no separate item is opened by the app any more")
    }

    t.test("the page is told why the agreement key was not kept, never a bare refusal") {
        let window = (try? String(contentsOfFile: #filePath.replacingOccurrences(of: "Tests/KeyBundleTests.swift", with: "Sources/Host/VyreAppWindow.swift"), encoding: .utf8)) ?? ""
        t.ok(window.contains("This Mac could not keep its chat key: \\(agreement?.lastError"), "agree.public replies with the reason")
        t.ok(!window.contains("This Mac has no agreement key.\"]"), "the old reason-less reply is gone")
    }
}
