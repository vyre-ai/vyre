// capsule-suite: macEnclaveSuite
// The Mac's Secure Enclave identity key (Host/MacEnclave.swift), with a software P-256 key standing in for the enclave and a yes or no standing in for Touch ID: no key without an enclave,
// made once and the same after, a 65-byte point, a raw signature that verifies, and no signature when the person says no.

import CryptoKit
import Foundation
import LocalAuthentication

private func fake(enclave: Bool = true, yes: Bool = true) -> MacEnclave {
    let e = MacEnclave(store: MemoryEnclaveStore())
    e.hasSecureEnclave = { enclave }
    e.makeKey = { _ in let k = P256.Signing.PrivateKey(); return (Data("SW1:".utf8) + k.rawRepresentation, k.publicKey.derRepresentation) }
    e.keyOf = { handle, _ in try? P256.Signing.PrivateKey(rawRepresentation: handle.dropFirst(4)) }
    e.authenticate = { _, _ in yes }
    return e
}

let macEnclaveSuite = Suite("mac enclave") { t in
    t.test("a Mac with no Secure Enclave has no enclave key, and never makes a software one") {
        let e = fake(enclave: false)
        t.eq(e.publicPoint(create: true), nil)
        t.eq(e.store.loadHandle(), nil)
    }

    t.test("the key is made only when asked, is one 65-byte uncompressed point, and is the same after") {
        let e = fake()
        t.eq(e.publicPoint(create: false), nil)
        let a = e.publicPoint(create: true)
        t.eq(a?.count, 65)
        t.eq(a?.first, 4)
        t.eq(e.publicPoint(create: false), a)
        t.eq(e.publicPoint(create: true), a)
    }

    t.test("a signature is the raw 64 bytes and verifies under the point; a different message does not") {
        let e = fake()
        guard let pt = e.publicPoint(create: true), let pub = try? P256.Signing.PublicKey(x963Representation: pt) else { return t.ok(false, "a point") }
        let m = Data("a list change".utf8)
        guard let sig = t.wait({ await e.sign(m, reason: "Approve") }).flatMap({ $0 }) else { return t.ok(false, "a signature") }
        t.eq(sig.count, 64)
        guard let ecdsa = try? P256.Signing.ECDSASignature(rawRepresentation: sig) else { return t.ok(false, "raw form") }
        t.ok(pub.isValidSignature(ecdsa, for: m))
        t.ok(!pub.isValidSignature(ecdsa, for: Data("another".utf8)))
    }

    t.test("no is no signature, and no key is no signature") {
        let no = fake(yes: false)
        _ = no.publicPoint(create: true)
        t.eq(t.wait({ await no.sign(Data("x".utf8), reason: "Approve") }).flatMap({ $0 }), nil)
        let none = fake()
        t.eq(t.wait({ await none.sign(Data("x".utf8), reason: "Approve") }).flatMap({ $0 }), nil)
    }

    t.test("the page's bridge carries the two enclave calls") {
        MainActor.assumeIsolated {
            for piece in ["enclave.public", "enclave.sign", "enclavePublic", "enclaveSign", "presence.key", "presenceKey"] { t.ok(VyreAppWindow.bridgeSource.contains(piece), piece) }
        }
    }
}
