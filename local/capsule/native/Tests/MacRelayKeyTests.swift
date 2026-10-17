// capsule-suite: macRelayKeySuite
// The Mac app's relay device key (Host/MacRelayKey.swift): made only when asked, kept in the key bundle so the same key is there after a restart (the WKWebView's IndexedDB kept nothing, and the
// app's servers stopped knowing it), the X25519 secret the peer computes, nothing for a bad peer key, and the bridge's two calls.

import CryptoKit
import Foundation

let macRelayKeySuite = Suite("mac relay key") { t in
    t.test("the key is made only when asked, is 32 bytes, and is the same after") {
        let k = MacRelayKey(store: MemoryEnclaveStore())
        t.eq(k.publicKey(create: false), nil)
        let p = k.publicKey(create: true)
        t.eq(p?.count, 32)
        t.eq(k.publicKey(create: false), p)
        t.eq(k.publicKey(create: true), p)
    }

    t.test("the key survives a restart: a new launch reads the same key from the bundle's Keychain item") {
        let backing = MemoryBundleBacking()
        let first = MacRelayKey(store: BundleHandleStore(bundle: KeyBundle(backing: backing), slot: .relay))
        guard let before = first.publicKey(create: true) else { return t.ok(false, "a key") }
        let peer = Curve25519.KeyAgreement.PrivateKey()
        let secret = first.dh(peer: peer.publicKey.rawRepresentation)
        let relaunched = MacRelayKey(store: BundleHandleStore(bundle: KeyBundle(backing: backing), slot: .relay))
        t.eq(relaunched.publicKey(create: false), before, "the same public key after the restart")
        t.eq(relaunched.dh(peer: peer.publicKey.rawRepresentation), secret, "and the same key behind it")
    }

    t.test("dh gives the 32-byte secret the peer computes with this key's public key") {
        let k = MacRelayKey(store: MemoryEnclaveStore())
        guard let mine = k.publicKey(create: true) else { return t.ok(false, "a key") }
        let peer = Curve25519.KeyAgreement.PrivateKey()
        guard let ours = k.dh(peer: peer.publicKey.rawRepresentation) else { return t.ok(false, "a secret") }
        t.eq(ours.count, 32)
        guard let pub = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: mine), let theirs = try? peer.sharedSecretFromKeyAgreement(with: pub) else { return t.ok(false, "the peer's side") }
        t.eq(ours, theirs.withUnsafeBytes { Data($0) })
    }

    t.test("no key, or a peer key that is not 32 bytes, gives nothing; forgetting takes the key away") {
        let k = MacRelayKey(store: MemoryEnclaveStore())
        let peer = Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation
        t.eq(k.dh(peer: peer), nil, "no key yet")
        _ = k.publicKey(create: true)
        t.eq(k.dh(peer: Data()), nil)
        t.eq(k.dh(peer: Data(repeating: 1, count: 31)), nil)
        t.ok(k.dh(peer: peer) != nil)
        k.forget()
        t.eq(k.publicKey(create: false), nil)
    }

    t.test("the page's bridge carries the two relay key calls, and nothing that hands the key out") {
        MainActor.assumeIsolated {
            for piece in ["relay.public", "relay.dh", "relayKey:"] { t.ok(VyreAppWindow.bridgeSource.contains(piece), piece) }
            t.ok(!VyreAppWindow.bridgeSource.contains("relay.private"), "no call reads the private key")
        }
    }
}
