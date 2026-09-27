// Tests for the pure half (Shared/AutofillCore.swift). XCTest, no host app, no device: the
// VyreAutofillCoreTests target compiles AutofillCore.swift into the test bundle itself.
// Sample world only: alex, Harlow Legal, Northwind Bakery, *.harlow.test.

import XCTest

final class AutofillCoreTests: XCTestCase {

  // MARK: origins

  func testDomainBecomesHttpsOrigin() {
    XCTAssertEqual(AutofillCore.origin(serviceIdentifier: "portal.harlow.test", kind: .domain), "https://portal.harlow.test")
    XCTAssertEqual(AutofillCore.origin(serviceIdentifier: " Portal.Harlow.Test. ", kind: .domain), "https://portal.harlow.test")
    XCTAssertNil(AutofillCore.origin(serviceIdentifier: "portal.harlow.test:8443", kind: .domain))
    XCTAssertNil(AutofillCore.origin(serviceIdentifier: "portal.harlow.test/login", kind: .domain))
    XCTAssertNil(AutofillCore.origin(serviceIdentifier: "", kind: .domain))
    XCTAssertNil(AutofillCore.origin(serviceIdentifier: "-bad.harlow.test", kind: .domain))
  }

  func testURLBecomesItsExactOrigin() {
    XCTAssertEqual(AutofillCore.origin(serviceIdentifier: "https://portal.harlow.test/login?next=%2F#top", kind: .url), "https://portal.harlow.test")
    XCTAssertEqual(AutofillCore.origin(serviceIdentifier: "https://portal.harlow.test:443/", kind: .url), "https://portal.harlow.test")
    XCTAssertEqual(AutofillCore.origin(serviceIdentifier: "https://portal.harlow.test:8443/x", kind: .url), "https://portal.harlow.test:8443")
    XCTAssertEqual(AutofillCore.origin(serviceIdentifier: "orders.northwind.test/cart", kind: .url), "https://orders.northwind.test")
  }

  func testNoSuffixWideningAndLookalikesStayThemselves() {
    // A lookalike keeps its own full host: the server then finds no login for it.
    XCTAssertEqual(AutofillCore.origin(serviceIdentifier: "https://harlow.test.northwind.test/", kind: .url), "https://harlow.test.northwind.test")
    XCTAssertEqual(AutofillCore.origin(serviceIdentifier: "https://login.harlow.test/", kind: .url), "https://login.harlow.test")
    XCTAssertNotEqual(AutofillCore.origin(serviceIdentifier: "https://login.harlow.test/", kind: .url), "https://harlow.test")
  }

  func testRefusedIdentifiers() {
    XCTAssertNil(AutofillCore.origin(serviceIdentifier: "http://portal.harlow.test/", kind: .url), "plain http is never filled")
    XCTAssertNil(AutofillCore.origin(serviceIdentifier: "ftp://portal.harlow.test/", kind: .url))
    XCTAssertNil(AutofillCore.origin(serviceIdentifier: "https://alex@portal.harlow.test/", kind: .url), "user info")
    XCTAssertNil(AutofillCore.origin(serviceIdentifier: "https://[::1]/", kind: .url))
    XCTAssertNil(AutofillCore.origin(serviceIdentifier: "https://portal.harlow.test:0/", kind: .url))
    XCTAssertNil(AutofillCore.origin(serviceIdentifier: "https://portal.harlow.test:99999/", kind: .url))
    XCTAssertNil(AutofillCore.origin(serviceIdentifier: "https://portal_harlow.test/", kind: .url))
  }

  func testOriginsDeduplicates() {
    let o = AutofillCore.origins([("portal.harlow.test", .domain), ("https://portal.harlow.test/a", .url), ("http://x.harlow.test", .url), ("orders.northwind.test", .domain)])
    XCTAssertEqual(o, ["https://portal.harlow.test", "https://orders.northwind.test"])
  }

  // MARK: identities

  func testPlanUsernames() {
    let list = AutofillCore.IdentityList(identities: [
      .init(name: "harlow-portal", kind: "login", sites: ["https://portal.harlow.test", "http://old.harlow.test", "https://portal.harlow.test"], apps: ["android:sh.northwind.orders@" + String(repeating: "ab", count: 32)], user: "alex"),
      .init(name: "northwind-orders", kind: "login", sites: ["https://orders.northwind.test:8443"], user: "", totp: true),
      .init(name: "harlow-test-alex-harlow-test", kind: "passkey", user: "alex@harlow.test", rp: "harlow.test", credential: "AQID", userHandle: "BAUG"),
      .init(name: "card", kind: "card"),
    ], users: "usernames")
    XCTAssertEqual(AutofillCore.plan(list), [
      .password(site: "https://portal.harlow.test", user: "alex", record: "harlow-portal"),
      .password(site: "https://orders.northwind.test:8443", user: "northwind-orders", record: "northwind-orders"),
      .oneTimeCode(site: "https://orders.northwind.test:8443", label: "northwind-orders", record: "northwind-orders"),
      .passkey(rpId: "harlow.test", userName: "alex@harlow.test", credentialID: [1, 2, 3], userHandle: [4, 5, 6], record: "harlow-test-alex-harlow-test"),
    ])
  }

  func testPlanNamesOnlyHidesUsernamesForPasskeysToo() {
    let list = AutofillCore.IdentityList(identities: [
      .init(name: "harlow-portal", kind: "login", sites: ["https://portal.harlow.test"], user: "alex"),
      .init(name: "harlow-pk", kind: "passkey", user: "alex@harlow.test", rp: "harlow.test", credential: "AQID"),
    ], users: "names")
    XCTAssertEqual(AutofillCore.plan(list), [
      .password(site: "https://portal.harlow.test", user: "harlow-portal", record: "harlow-portal"),
      .passkey(rpId: "harlow.test", userName: "harlow-pk", credentialID: [1, 2, 3], userHandle: [], record: "harlow-pk"),
    ])
    // A reply with no `users` is treated as names only.
    XCTAssertTrue(AutofillCore.IdentityList(identities: [], users: nil).namesOnly)
  }

  func testPlanSkipsBadPasskeys() {
    let list = AutofillCore.IdentityList(identities: [
      .init(name: "a", kind: "passkey", rp: "https://harlow.test", credential: "AQID"),
      .init(name: "b", kind: "passkey", rp: "harlow.test", credential: "not base64!"),
      .init(name: "c", kind: "passkey", rp: "harlow.test"),
    ], users: "usernames")
    XCTAssertEqual(AutofillCore.plan(list), [])
  }

  func testAllowList() {
    XCTAssertTrue(AutofillCore.allowed(credential: "AQID", allow: []))
    XCTAssertTrue(AutofillCore.allowed(credential: "AQID", allow: [[9], [1, 2, 3]]))
    XCTAssertFalse(AutofillCore.allowed(credential: "AQID", allow: [[1, 2]]))
  }

  // MARK: challenge

  func testChallengeMessage() {
    let nonce = "q1w2e3r4t5y6u7i8o9p0-_AbCdEfGhIj"
    XCTAssertEqual(AutofillCore.unlockMessage(nonce), "vyre:fill-unlock:v1:" + nonce)
    XCTAssertEqual(AutofillCore.messageToSign(challenge: nonce, message: "vyre:fill-unlock:v1:" + nonce), "vyre:fill-unlock:v1:" + nonce)
    XCTAssertNil(AutofillCore.messageToSign(challenge: nonce, message: "vyre:fill-unlock:v2:" + nonce))
    XCTAssertNil(AutofillCore.messageToSign(challenge: nonce, message: "something else to sign"))
    XCTAssertNil(AutofillCore.messageToSign(challenge: "short", message: "vyre:fill-unlock:v1:short"))
    XCTAssertNil(AutofillCore.messageToSign(challenge: "has space in it 0123", message: "vyre:fill-unlock:v1:has space in it 0123"))
    XCTAssertNil(AutofillCore.messageToSign(challenge: nil, message: nil))
  }

  // MARK: server address

  func testServerURL() {
    XCTAssertEqual(AutofillCore.serverURL("https://vault.harlow.test/"), "https://vault.harlow.test")
    XCTAssertEqual(AutofillCore.serverURL(" HTTPS://Vault.Harlow.Test:443/vyre/ "), "https://vault.harlow.test/vyre")
    XCTAssertEqual(AutofillCore.serverURL("https://vault.harlow.test:8443"), "https://vault.harlow.test:8443")
    XCTAssertEqual(AutofillCore.serverURL("http://127.0.0.1:7777"), "http://127.0.0.1:7777")
    XCTAssertNil(AutofillCore.serverURL("http://vault.harlow.test"))
    XCTAssertNil(AutofillCore.serverURL("http://localhost:7777"))
    XCTAssertNil(AutofillCore.serverURL("https://alex@vault.harlow.test"))
    XCTAssertNil(AutofillCore.serverURL("https://vault.harlow.test/?x=1"))
    XCTAssertNil(AutofillCore.serverURL("https://vault.harlow.test/#x"))
    XCTAssertNil(AutofillCore.serverURL("vault.harlow.test"))
    XCTAssertEqual(AutofillCore.routeURL("https://vault.harlow.test", "passkey.assert"), "https://vault.harlow.test/v1/fill/passkey.assert")
  }

  func testKeychainGroup() {
    XCTAssertEqual(AutofillCore.keychainGroup("ABCDE12345.sh.vyre.shared"), "ABCDE12345.sh.vyre.shared")
    XCTAssertNil(AutofillCore.keychainGroup("sh.vyre.shared"), "unsigned: the prefix did not expand")
    XCTAssertNil(AutofillCore.keychainGroup("$(AppIdentifierPrefix)sh.vyre.shared"))
    XCTAssertNil(AutofillCore.keychainGroup(nil))
  }

  // MARK: bytes and clock

  func testBase64url() {
    for n in 0..<40 {
      let bytes = (0..<n).map { UInt8(($0 * 37 + 11) & 255) }
      XCTAssertEqual(AutofillCore.base64urlDecode(AutofillCore.base64url(bytes)), bytes)
    }
    XCTAssertEqual(AutofillCore.base64url([0xfb, 0xff]), "-_8")
    XCTAssertEqual(AutofillCore.base64urlDecode("-_8"), [0xfb, 0xff])
    XCTAssertEqual(AutofillCore.base64urlDecode("+/8="), [0xfb, 0xff])
    XCTAssertNil(AutofillCore.base64urlDecode("A"))
    XCTAssertNil(AutofillCore.base64urlDecode("AB$D"))
  }

  func testSPKI() {
    let raw: [UInt8] = [0x04] + Array(repeating: 7, count: 64)
    let spki = AutofillCore.spki(fromX963: raw)
    XCTAssertEqual(spki?.count, 91)
    XCTAssertEqual(Array(spki!.prefix(26)), AutofillCore.p256SPKIPrefix)
    XCTAssertNil(AutofillCore.spki(fromX963: Array(raw.dropLast())))
    XCTAssertNil(AutofillCore.spki(fromX963: [0x02] + Array(repeating: 7, count: 64)))
  }

  func testSessionClock() {
    XCTAssertTrue(AutofillCore.isLive(expiresMs: 100_000, nowMs: 90_000))
    XCTAssertFalse(AutofillCore.isLive(expiresMs: 100_000, nowMs: 96_000), "inside the margin counts as closed")
    XCTAssertFalse(AutofillCore.isLive(expiresMs: 100_000, nowMs: 100_001))
  }

  func testSayUsesCodesOnly() {
    XCTAssertEqual(AutofillCore.say("session_expired"), "Unlock again.")
    XCTAssertEqual(AutofillCore.say("wrong_origin"), "No matching login in the vault.")
    XCTAssertEqual(AutofillCore.say("teapot"), "Something went wrong (teapot).")
  }
}
