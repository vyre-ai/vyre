// capsule-suite: presenceSuite
// The Capsule's presence proof (ADR 0004, method capsule): the canonical input and its hash as
// core/presence computes them, the signed header, SPKI for enrolment, and the rule that no proof
// is attempted under tests. No keychain and no Touch ID: a memory key store.

import CryptoKit
import Foundation

final class MemoryKeyStore: PresenceKeyStore {
    var handle: Data?
    func loadHandle() -> Data? { handle }
    func save(_ handle: Data) -> Bool { self.handle = handle; return true }
    func delete() { handle = nil }
}

/// A key that never signs, so header() can be checked without a real Secure Enclave refusal.
struct RefusingKey: CapsuleSigningKey {
    let publicKey = P256.Signing.PrivateKey().publicKey
    func signature(for data: Data) throws -> P256.Signing.ECDSASignature { throw CocoaError(.coderReadCorrupt) }
}

import LocalAuthentication

/// A Mac with no fingerprint reader: biometrics cannot be evaluated, the Mac's password can.
final class NoBiometryContext: LAContext, @unchecked Sendable {
    override func canEvaluatePolicy(_ policy: LAPolicy, error: NSErrorPointer) -> Bool { policy == .deviceOwnerAuthentication }
}

let presenceSuite = Suite("presence") { t in
    t.test("canonical JSON matches core/presence: keys sorted at every depth, no spaces, JSON.stringify strings and numbers") {
        let input: [String: Any] = ["id": "h1", "edits": ["to": ["dana@harlowlegal.example"], "subject": "Menu \"v2\"\n", "body": "é ok"], "n": 3, "x": 0.5, "ok": true]
        t.eq(PresenceCanonical.encode(input),
             #"{"edits":{"body":"é ok","subject":"Menu \"v2\"\n","to":["dana@harlowlegal.example"]},"id":"h1","n":3,"ok":true,"x":0.5}"#)
        t.eq(PresenceCanonical.encode(["b": NSNull(), "a": [1, 2.25, "\u{01}"]]), #"{"a":[1,2.25,"\u0001"],"b":null}"#)
    }

    t.test("the header is capsule key ts nonce sig over the bound message, and the signature checks out") {
        // An ordinary in-memory P-256 key: same CapsuleSigningKey shape as the real Secure
        // Enclave key production code uses, but needs no hardware, keychain or Touch ID, so this
        // checks the signed header and its ES256/DER signature on every machine, CI included.
        let key = P256.Signing.PrivateKey()
        let input: [String: Any] = ["id": "h1"]
        let h = CapsulePresence.header(tool: "gate.approve", input: input, key: key, keyId: "k1", ts: 1_800_000_000_000, nonce: "nonce12345") ?? ""
        t.ok(h.hasPrefix("capsule key=k1 ts=1800000000000 nonce=nonce12345 sig="), h)
        let sigText = String(h.split(separator: "=").last ?? "")
        var b64 = sigText.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        let msg = "vyre-presence-v1\ngate.approve\n\(PresenceCanonical.hash(input))\n1800000000000\nnonce12345"
        let sigData = Data(base64Encoded: b64).flatMap { try? P256.Signing.ECDSASignature(derRepresentation: $0) }
        t.ok(sigData.map { key.publicKey.isValidSignature($0, for: Data(msg.utf8)) } ?? false, "signature verifies")
        t.eq(key.publicKey.derRepresentation.count, 91, "SPKI DER for a P-256 public key is 91 bytes")
        // VYRE_PRESENCE_VECTOR=<file>: write a signed call for core/presence to check in Node.
        if let f = ProcessInfo.processInfo.environment["VYRE_PRESENCE_VECTOR"] {
            let hard: [String: Any] = ["id": "h1", "edits": ["subject": "Menu \"v2\"\n", "to": ["dana@harlowlegal.example"], "body": "é ok\u{01}"], "n": 3, "x": 0.5, "ok": true]
            let hh = CapsulePresence.header(tool: "gate.approve", input: hard, key: key, keyId: "k1", ts: 1_800_000_000_000, nonce: "nonce12345") ?? ""
            let v: [String: Any] = ["tool": "gate.approve", "input": hard, "header": hh, "public_key": PresenceCanonical.b64url(key.publicKey.derRepresentation), "alg": -7,
                                    "canonical": PresenceCanonical.encode(hard), "hash": PresenceCanonical.hash(hard)]
            try? JSONSerialization.data(withJSONObject: v).write(to: URL(fileURLWithPath: f))
        }
    }

    t.test("header: a key that fails to sign gives nil, never a header with an empty sig") {
        t.eq(CapsulePresence.header(tool: "gate.approve", input: ["id": "h1"], key: RefusingKey(), keyId: "k1", ts: 1_800_000_000_000), nil)
    }

    t.test("a Mac with no Secure Enclave and no Touch ID still makes a key, kept as a tagged software handle") {
        let fake = FakeVyred(name: "presence-nobio")
        fake.tool("presence.enroll") { _ in ["id": "k7", "kind": "capsule"] }
        t.ok(fake.start())
        let out: (String?, Data?, String?)? = t.wait {
            let (p, store) = await MainActor.run { () -> (CapsulePresence, MemoryKeyStore) in
                let store = MemoryKeyStore()
                let p = CapsulePresence(home: vyScratch("presence-nobio"), vyred: VyredClient(socket: fake.socket), store: store)
                p.hasSecureEnclave = { false }
                p.makeContext = { NoBiometryContext() }
                return (p, store)
            }
            let why = await p.enroll()
            return (why, await MainActor.run { store.handle }, await MainActor.run { p.enrolled?.id })
        }
        t.eq(out?.0, nil)
        t.eq(out?.2, "k7")
        t.ok(out?.1?.starts(with: CapsulePresence.softwareTag) == true)
        fake.stop()
    }

    t.test("the stored software handle signs a proof that verifies with the enrolled public key") {
        let made = CapsulePresence.makeDeviceKey(secureEnclave: false)
        t.ok(made != nil)
        guard let made, let key = CapsulePresence.signingKey(handle: made.handle, context: NoBiometryContext()) else { t.ok(false, "no key"); return }
        let h = CapsulePresence.header(tool: "gate.approve", input: ["id": "h1"], key: key, keyId: "k1", ts: 1_800_000_000_000, nonce: "n1") ?? ""
        let sig = h.split(separator: "=").last.map(String.init) ?? ""
        var b64 = sig.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        let pub = try? P256.Signing.PublicKey(derRepresentation: made.der)
        let ecdsa = Data(base64Encoded: b64).flatMap { try? P256.Signing.ECDSASignature(derRepresentation: $0) }
        let msg = "vyre-presence-v1\ngate.approve\n\(PresenceCanonical.hash(["id": "h1"]))\n1800000000000\nn1"
        t.ok(pub != nil && ecdsa != nil && pub!.isValidSignature(ecdsa!, for: Data(msg.utf8)))
        t.eq(CapsulePresence.signingKey(handle: Data([1, 2, 3]), context: NoBiometryContext()) == nil, true, "a foreign handle is no key")
    }

    // CapsulePin.swift: presence.capsule.pin, signed with this same enrolled key. ownCdhash()
    // reads this test binary's own real code signature (real Security.framework, no fake, no
    // dialog needed); the full sign-and-call happy path needs VYRE_TEST_DIALOGS=1 to get past
    // dialogsAllowed(), which only the lead sets, so it is covered by the existing "under tests
    // no proof is attempted" test above (pinSelf() calls the same proof()) rather than repeated here.
    t.test("ownCdhash: this test binary's own real cdhash, lower-case hex") {
        let h = CapsulePresence.ownCdhash()
        t.ok((h?.count ?? 0) >= 40, "at least a sha1-length hex string: \(h ?? "nil")")
        t.ok(h.map { $0.allSatisfy { $0.isHexDigit && !$0.isUppercase } } ?? false, h ?? "nil")
    }

    t.test("pinSelf: under tests, dialogsAllowed() is false, so no proof and no call to vyred") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        var called = 0
        v.tool("presence.capsule.pin") { _ in called += 1; return ["pinned": true] }
        let out: Int? = t.wait {
            let p = await MainActor.run { CapsulePresence(home: vyScratch("pin1"), vyred: VyredClient(socket: v.socket)) }
            await p.pinSelf()
            return called
        }
        t.eq(out, 0)
    }

    t.test("pinSelf: already pinned this process's own cdhash -- no proof attempted either") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        var called = 0
        v.tool("presence.capsule.pin") { _ in called += 1; return ["pinned": true] }
        let out: Int? = t.wait {
            let p = await MainActor.run { () -> CapsulePresence in
                let p = CapsulePresence(home: vyScratch("pin2"), vyred: VyredClient(socket: v.socket))
                p.pinnedCdhash = CapsulePresence.ownCdhash()
                return p
            }
            await p.pinSelf()
            return called
        }
        t.eq(out, 0, "the cache alone stops it; a real device could reconnect all day without re-asking")
    }

    t.test("under tests no proof is attempted: no key made, no ask shown, and it says why") {
        let out: (String, Bool, Bool)? = t.wait {
            let (p, store, asked) = await MainActor.run { () -> (CapsulePresence, MemoryKeyStore, () -> Bool) in
                let store = MemoryKeyStore()
                let p = CapsulePresence(home: vyScratch("presence2"), vyred: VyredClient(socket: vyScratch("p") + "/none.sock"), store: store)
                var asked = false
                p.ask = { _ in asked = true; return true }
                return (p, store, { asked })
            }
            let r = await p.proof(tool: "gate.approve", input: ["id": "h1"])
            let why: String = { if case .failure(let f) = r { return f.message }; return "proved" }()
            return (why, await MainActor.run { store.handle == nil }, await MainActor.run { asked() })
        }
        t.eq(out?.0, "Proving you are here is off under tests.")
        t.eq(out?.1, true)
        t.eq(out?.2, false)
    }
}
