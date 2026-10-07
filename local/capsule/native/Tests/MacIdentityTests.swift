// capsule-suite: macIdentitySuite
// The Mac's identity key (Host/MacIdentity.swift) with a memory store: made once, the same public key after, signatures that verify, nothing without a key, and forgotten on request.
// The page's bridge names the four calls. The Keychain store is not run here.

import CryptoKit
import Foundation

let macIdentitySuite = Suite("mac identity") { t in
    t.test("a key is made only when asked, and is the same key every time after") {
        let id = MacIdentity(store: MemorySeedStore())
        t.eq(id.publicKey(create: false), nil)
        t.ok(!id.has)
        let a = id.publicKey(create: true)
        t.eq(a?.count, 32)
        t.eq(id.publicKey(create: false), a)
        t.eq(id.publicKey(create: true), a)
        t.ok(id.has)
    }

    t.test("a signature verifies under the public key, and a different message does not") {
        let id = MacIdentity(store: MemorySeedStore())
        guard let pub = id.publicKey(create: true), let key = try? Curve25519.Signing.PublicKey(rawRepresentation: pub) else { return t.ok(false, "a public key") }
        let m = Data("a chain operation".utf8)
        guard let sig = id.sign(m) else { return t.ok(false, "a signature") }
        t.eq(sig.count, 64)
        t.ok(key.isValidSignature(sig, for: m))
        t.ok(!key.isValidSignature(sig, for: Data("another".utf8)))
    }

    t.test("no key means no signature, and forgetting takes the key away") {
        let id = MacIdentity(store: MemorySeedStore())
        t.eq(id.sign(Data("x".utf8)), nil)
        _ = id.publicKey(create: true)
        id.forget()
        t.ok(!id.has)
        t.eq(id.sign(Data("x".utf8)), nil)
    }

    t.test("keys are base64url without padding, and read back") {
        let d = Data([0xfb, 0xff, 0xfe, 0x01])
        t.eq(MacIdentity.b64url(d), "-__-AQ")
        t.eq(MacIdentity.unb64url("-__-AQ"), d)
    }

    t.test("the page's bridge carries the four identity calls") {
        MainActor.assumeIsolated {
            for piece in ["identity.public", "identity.sign", "identity.has", "identity.forget", "identity: {", "setup.server", "makeServer"] { t.ok(VyreAppWindow.bridgeSource.contains(piece), piece) }
        }
    }
}

// capsule-suite: zoneHeaderSuite
// Every call from Lumen says which time zone this Mac is in (x-vyre-zone), in the IANA name, so vyred reads times in it and a model call's time line carries it.
let zoneHeaderSuite = Suite("zone header") { t in
    t.test("a request carries this Mac's IANA zone, and nothing that could end a header line") {
        let head = String(decoding: VyHTTP.requestBytes("GET", "/v1/health", body: nil), as: UTF8.self)
        let line = head.components(separatedBy: "\r\n").first { $0.hasPrefix("x-vyre-zone: ") }
        t.ok(line != nil, "the header is there")
        let zone = String((line ?? "").dropFirst("x-vyre-zone: ".count))
        t.ok(!zone.isEmpty && zone.allSatisfy { $0.isLetter || $0.isNumber || "/_+-".contains($0) }, "a plain zone name: \(zone)")
        t.eq(zone, TimeZone.autoupdatingCurrent.identifier)
    }
}
