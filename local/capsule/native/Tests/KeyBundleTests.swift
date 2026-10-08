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
        t.eq(old.deleted.count, 4)
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

    t.test("the app keeps all four keys in the one bundle") {
        let app = (try? String(contentsOfFile: #filePath.replacingOccurrences(of: "Tests/KeyBundleTests.swift", with: "Sources/Host/App.swift"), encoding: .utf8)) ?? ""
        for piece in ["KeyBundle.keychain(home: home)", "BundleSeedStore(bundle: keys)", "BundleHandleStore(bundle: keys, slot: .enclave)", "BundleHandleStore(bundle: keys, slot: .agree)", "BundleHandleStore(bundle: keys, slot: .presence)"] {
            t.ok(app.contains(piece), piece)
        }
        t.ok(!app.contains("KeychainSeedStore(home") && !app.contains("KeychainEnclaveStore(home") && !app.contains("KeychainAgreeStore(home"), "no separate item is opened by the app any more")
    }
}
