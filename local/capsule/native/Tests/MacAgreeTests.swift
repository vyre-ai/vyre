// capsule-suite: macAgreeSuite
// The Mac's agreement key (Host/MacAgree.swift) with a memory store: made on first use, one 65-byte point, the same ECDH secret the peer computes, nothing for a bad point, and a Mac with no Secure
// Enclave still gets a (software) key.

import CryptoKit
import Foundation

private func agreeFake(enclave: Bool = false) -> MacAgree {
    let a = MacAgree(store: MemoryEnclaveStore())
    a.hasSecureEnclave = { enclave }
    a.makeKey = { _ in MacAgree.softwareTag + P256.KeyAgreement.PrivateKey().rawRepresentation }
    return a
}

let macAgreeSuite = Suite("mac agree") { t in
    t.test("the key is made only when asked, is a 65-byte uncompressed point, and is the same after") {
        let a = agreeFake()
        t.eq(a.publicPoint(create: false), nil)
        let p = a.publicPoint(create: true)
        t.eq(p?.count, 65)
        t.eq(p?.first, 4)
        t.eq(a.publicPoint(create: false), p)
        t.eq(a.publicPoint(create: true), p)
    }

    t.test("agree gives the 32-byte secret the peer computes with this key's point, in both directions") {
        let a = agreeFake()
        guard let mine = a.publicPoint(create: true) else { return t.ok(false, "a point") }
        let peer = P256.KeyAgreement.PrivateKey()
        guard let ours = a.agree(epk: peer.publicKey.x963Representation) else { return t.ok(false, "a secret") }
        t.eq(ours.count, 32)
        guard let pub = try? P256.KeyAgreement.PublicKey(x963Representation: mine), let theirs = try? peer.sharedSecretFromKeyAgreement(with: pub) else { return t.ok(false, "the peer's side") }
        t.eq(ours, theirs.withUnsafeBytes { Data($0) })
    }

    t.test("a point that is not a raw uncompressed P-256 point is refused, and so is any call with no key") {
        let a = agreeFake()
        let peer = P256.KeyAgreement.PrivateKey().publicKey
        t.eq(a.agree(epk: peer.x963Representation), nil, "no key yet")
        _ = a.publicPoint(create: true)
        t.eq(a.agree(epk: Data()), nil)
        t.eq(a.agree(epk: peer.compressedRepresentation), nil, "compressed")
        t.eq(a.agree(epk: Data(repeating: 4, count: 65)), nil, "not on the curve")
        t.ok(a.agree(epk: peer.x963Representation) != nil)
    }

    t.test("a Mac whose enclave will not make a key falls back to a software one, and forgetting takes it away") {
        let a = agreeFake(enclave: true)
        a.makeKey = { enclave in enclave ? nil : MacAgree.softwareTag + P256.KeyAgreement.PrivateKey().rawRepresentation }
        t.ok(a.publicPoint(create: true) != nil, "software fallback")
        a.forget()
        t.eq(a.publicPoint(create: false), nil)
    }

    t.test("the page's bridge carries the two agreement calls") {
        MainActor.assumeIsolated { for piece in ["agree.public", "agree.agree", "agreePublic", "agree: function"] { t.ok(VyreAppWindow.bridgeSource.contains(piece), piece) } }
    }
}
