import CryptoKit
import XCTest
@testable import Vyre

final class DeviceKeyTests: XCTestCase {
    func testSPKIMatchesCryptoKitAndKeyId() throws {
        let k = P256.Signing.PrivateKey()
        let spki = DeviceKey.spki(x963: k.publicKey.x963Representation)
        XCTAssertEqual(spki, k.publicKey.derRepresentation, "hand-built SPKI DER is what CryptoKit writes")
        XCTAssertEqual(spki.count, 91)
        let id = DeviceKey.keyId(spki: spki)
        XCTAssertEqual(id.count, 22)
        XCTAssertEqual(id, String(Data(SHA256.hash(data: spki)).base64URL.prefix(22)))
    }

    func testHeaderSignsTheCapsuleMessage() async throws {
        let raw = P256.Signing.PrivateKey()
        let key = try DeviceKey(backing: .software(raw.rawRepresentation))
        let input: JSON = ["id": "a1b2c3d4e5f6a7b8c9", "edited": ["subject": "Re: Intake form rebuild"]]
        let now = Date(timeIntervalSince1970: 1_790_000_000.123)
        let header = try await key.header(tool: "gate.approve", input: input, reason: "Send email to Dana Reyes", now: now)
        let parts = header.split(separator: " ")
        XCTAssertEqual(parts.first, "device")
        var f: [String: String] = [:]
        for p in parts.dropFirst() { let kv = p.split(separator: "=", maxSplits: 1); f[String(kv[0])] = String(kv[1]) }
        XCTAssertEqual(Set(f.keys), ["key", "ts", "nonce", "sig"])
        XCTAssertEqual(f["key"], key.id)
        XCTAssertEqual(f["ts"], "1790000000123")
        XCTAssertNotNil(f["nonce"]!.range(of: "^[A-Za-z0-9_-]{8,128}$", options: .regularExpression))
        let msg = "vyre-presence-v1\ngate.approve\n\(Canonical.inputHash(input))\n1790000000123\n\(f["nonce"]!)"
        let sig = try P256.Signing.ECDSASignature(derRepresentation: XCTUnwrap(Data(base64URL: f["sig"]!)))
        XCTAssertTrue(raw.publicKey.isValidSignature(sig, for: Data(msg.utf8)))
    }

    func testNoncesDiffer() {
        XCTAssertNotEqual(DeviceKey.nonce(), DeviceKey.nonce())
    }

    func testSessionsExpireWhenIdle() async {
        let s = PresenceSessions()
        let t0 = Date()
        await s.set(.init(id: "s1", secret: "x", expires: t0.addingTimeInterval(1800), idle: 300, used: t0))
        let a = await s.current(now: t0.addingTimeInterval(200))
        XCTAssertEqual(a?.id, "s1")
        let b = await s.current(now: t0.addingTimeInterval(200 + 301))
        XCTAssertNil(b)
    }
}

final class SignInTests: XCTestCase {
    func testURLCarriesKeyInFragment() throws {
        let key = try DeviceKey(backing: .software(P256.Signing.PrivateKey().rawRepresentation))
        let url = SignIn.url(address: BoxAddress("alex.vyre.run")!, key: key, name: "alex's iPhone")
        XCTAssertEqual(url.scheme, "https")
        XCTAssertEqual(url.host, "alex.vyre.run")
        XCTAssertEqual(url.path, "/onboard/device")
        XCTAssertNil(url.query)
        let frag = try XCTUnwrap(URLComponents(string: "x:?" + (url.fragment ?? ""))?.queryItems)
        XCTAssertEqual(frag.first { $0.name == "k" }?.value, key.spki.base64URL)
        XCTAssertEqual(frag.first { $0.name == "n" }?.value, "alex's iPhone")
        XCTAssertEqual(frag.first { $0.name == "r" }?.value, "vyre")
    }

    func testCallback() {
        XCTAssertEqual(SignIn.parse(callback: URL(string: "vyre://enrolled?id=AbC_12")!), .enrolled("AbC_12"))
        XCTAssertEqual(SignIn.parse(callback: URL(string: "vyre://enrolled?error=No%20passkey")!), .refused("No passkey"))
        XCTAssertNil(SignIn.parse(callback: URL(string: "vyre://threads/abc")!))
        XCTAssertNil(SignIn.parse(callback: URL(string: "https://enrolled?id=x")!))
    }

    func testEnrollWithCodeSendsDeviceKind() async throws {
        Stub.reset([Stub.json(#"{"data":{"id":"KID","kind":"device","name":"iPhone","created":1}}"#)])
        let client = VyreClient(address: BoxAddress("https://alex.vyre.run")!, signer: nil, session: Stub.session())
        let key = try DeviceKey(backing: .software(P256.Signing.PrivateKey().rawRepresentation))
        let id = try await SignIn.enroll(client: client, key: key, name: "iPhone", code: "ABCD2345")
        XCTAssertEqual(id, "KID")
        let body = try JSON.parse(Stub.bodies[0])
        XCTAssertEqual(body["kind"].string, "device")
        XCTAssertEqual(body["alg"].int, -7)
        XCTAssertEqual(body["public_key"].string, key.spki.base64URL)
        XCTAssertEqual(Stub.requests[0].value(forHTTPHeaderField: "x-vyre-presence"), "code code=ABCD2345")
    }
}
