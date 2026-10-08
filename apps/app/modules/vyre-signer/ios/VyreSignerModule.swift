// The person session's keys on iOS (ADR 0027 section 3a): P-256 in the Secure Enclave, made by
// SecKeyCreateRandomKey and never exportable. The application tag is the alias.
//
//   vyre.person  .privateKeyUsage; signs every request's x-vyre-proof
//   vyre.human   .privateKeyUsage + .biometryCurrentSet; each signature asks for Face ID or
//                Touch ID, and a change to the enrolled biometrics retires the key
//
// sign() returns the DER signature (ecdsaSignatureMessageX962SHA256) as base64url; the JS side
// converts it to P1363. The simulator has no Secure Enclave: there, and only there, the key is a
// software keychain key, and info() says secureHardware false.

import DeviceCheck
import ExpoModulesCore
import LocalAuthentication
import Security

struct EnsureOptions: Record {
  @Field var biometric: Bool = false
}

struct SignOptions: Record {
  @Field var prompt: String? = nil
}

final class SignerException: GenericException<(code: String, message: String)> {
  override var code: String { param.code }
  override var reason: String { param.message }
}

private let personAlias = "vyre.person"
private let agreeAlias = "vyre.agree"

private func b64url(_ data: Data) -> String {
  data.base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}

private func fromB64url(_ s: String) -> Data? {
  var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  while t.count % 4 != 0 { t += "=" }
  return Data(base64Encoded: t)
}

private func fail(_ code: String, _ message: String) -> SignerException {
  SignerException((code: code, message: message))
}

private func describe(_ error: Unmanaged<CFError>?) -> String {
  guard let e = error?.takeRetainedValue() else { return "unknown error" }
  return (e as Error).localizedDescription
}

private var inSimulator: Bool {
  #if targetEnvironment(simulator)
  return true
  #else
  return false
  #endif
}

private func tag(_ alias: String) -> Data { Data(alias.utf8) }

private func findKey(_ alias: String, context: LAContext? = nil) -> SecKey? {
  var query: [String: Any] = [
    kSecClass as String: kSecClassKey,
    kSecAttrApplicationTag as String: tag(alias),
    kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
    kSecReturnRef as String: true,
  ]
  if let context { query[kSecUseAuthenticationContext as String] = context }
  var item: CFTypeRef?
  guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let item else { return nil }
  return (item as! SecKey)
}

private func makeKey(_ alias: String, biometric: Bool) throws -> SecKey {
  var flags: SecAccessControlCreateFlags = []
  if !inSimulator { flags.insert(.privateKeyUsage) }
  if biometric { flags.insert(.biometryCurrentSet) }
  var acError: Unmanaged<CFError>?
  guard let access = SecAccessControlCreateWithFlags(
    kCFAllocatorDefault, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, flags, &acError
  ) else {
    throw fail("ERR_KEYGEN", "access control: \(describe(acError))")
  }
  var attributes: [String: Any] = [
    kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
    kSecAttrKeySizeInBits as String: 256,
    kSecPrivateKeyAttrs as String: [
      kSecAttrIsPermanent as String: true,
      kSecAttrApplicationTag as String: tag(alias),
      kSecAttrAccessControl as String: access,
    ] as [String: Any],
  ]
  #if !targetEnvironment(simulator)
  attributes[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave
  #endif
  var error: Unmanaged<CFError>?
  guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
    let why = describe(error)
    if biometric { throw fail("ERR_NO_BIOMETRICS", "a biometric key needs Face ID or Touch ID set up: \(why)") }
    throw fail("ERR_KEYGEN", why)
  }
  return key
}

/** x and y of a key's public half: the external form is 0x04 || X || Y. */
private func coordinates(_ key: SecKey) throws -> [String: String] {
  guard let pub = SecKeyCopyPublicKey(key) else { throw fail("ERR_NO_KEY", "the key has no public half") }
  var error: Unmanaged<CFError>?
  guard let raw = SecKeyCopyExternalRepresentation(pub, &error) as Data?, raw.count == 65, raw.first == 0x04 else {
    throw fail("ERR_NO_KEY", "the public key is not an uncompressed P-256 point: \(describe(error))")
  }
  return ["x": b64url(raw.subdata(in: 1..<33)), "y": b64url(raw.subdata(in: 33..<65))]
}

public class VyreSignerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("VyreSigner")

    // The agreement key (ECDH, no prompt per use): a P-256 key in the Secure Enclave (a software Keychain key in the simulator, the same API), no biometry flag, usable while the phone is unlocked.
    // `agree(epk)` is the 32-byte shared secret, the raw X coordinate; HKDF and AES-GCM stay portable code in the app (lib/keywrap.js). Its public point goes in the identity entry as `agree`.
    AsyncFunction("agreePublic") { (create: Bool) throws -> String in
      var found = findKey(agreeAlias)
      if found == nil && create { found = try makeKey(agreeAlias, biometric: false) }
      guard let key = found else { throw fail("ERR_NO_KEY", "there is no agreement key") }
      guard let pub = SecKeyCopyPublicKey(key) else { throw fail("ERR_NO_KEY", "the key has no public half") }
      var error: Unmanaged<CFError>?
      guard let raw = SecKeyCopyExternalRepresentation(pub, &error) as Data?, raw.count == 65, raw.first == 0x04 else { throw fail("ERR_NO_KEY", "the public key is not an uncompressed P-256 point: \(describe(error))") }
      return b64url(raw)
    }

    AsyncFunction("agree") { (epk: String) throws -> String in
      guard let point = fromB64url(epk), point.count == 65, point.first == 0x04 else { throw fail("ERR_INPUT", "that is not a public key") }
      guard let key = findKey(agreeAlias) else { throw fail("ERR_NO_KEY", "there is no agreement key") }
      var error: Unmanaged<CFError>?
      let attrs: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeyClass as String: kSecAttrKeyClassPublic, kSecAttrKeySizeInBits as String: 256]
      guard let peer = SecKeyCreateWithData(point as CFData, attrs as CFDictionary, &error) else { throw fail("ERR_INPUT", "that is not a public key") }
      guard let secret = SecKeyCopyKeyExchangeResult(key, .ecdhKeyExchangeStandard, peer, [:] as CFDictionary, &error) as Data?, secret.count == 32 else { throw fail("ERR_AGREE", "the key could not open that: \(describe(error))") }
      return b64url(secret)
    }

    AsyncFunction("ensureKey") { (alias: String, options: EnsureOptions) throws -> [String: String] in
      let key = try findKey(alias) ?? makeKey(alias, biometric: options.biometric)
      return try coordinates(key)
    }

    // Off the main queue: a biometric key blocks in SecKeyCreateSignature while the system prompt
    // is up.
    AsyncFunction("sign") { (alias: String, message: String, options: SignOptions) throws -> String in
      let context = LAContext()
      if let prompt = options.prompt { context.localizedReason = prompt }
      guard let key = findKey(alias, context: context) else {
        throw fail("ERR_NO_KEY", "no key \(alias); call ensureKey first")
      }
      var error: Unmanaged<CFError>?
      guard let sig = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, Data(message.utf8) as CFData, &error) as Data? else {
        let e = error?.takeRetainedValue()
        let ns = e.map { $0 as Error as NSError }
        if let ns, ns.domain == LAErrorDomain, ns.code == LAError.userCancel.rawValue || ns.code == LAError.appCancel.rawValue || ns.code == LAError.systemCancel.rawValue {
          throw fail("ERR_CANCELED", ns.localizedDescription)
        }
        if let ns, ns.code == Int(errSecUserCanceled) {
          throw fail("ERR_CANCELED", ns.localizedDescription)
        }
        throw fail("ERR_SIGN", ns?.localizedDescription ?? "the signature failed")
      }
      return b64url(sig)
    }

    // One Face ID for a group: the person is asked once (one LAContext, evaluated with biometrics), then every message is signed with the same authenticated context, so the system does not
    // ask again for the second and third signature. The context is closed to further prompts after the one, so a signature that would need another fails instead of asking twice.
    // Runs off the main queue like sign: the evaluation blocks until the person answers.
    AsyncFunction("signMany") { (alias: String, messages: [String], options: SignOptions) throws -> [String] in
      // The count in the Face ID reason is written here, never taken from JS: a page that says "Approve 1 item" cannot get ten signed. The JS prompt may follow it.
      if messages.isEmpty || messages.count > 20 { throw fail("ERR_INPUT", "a group is 1 to 20 items") }
      let context = LAContext()
      defer { context.invalidate() }
      let count = "Approve \(messages.count) item\(messages.count == 1 ? "" : "s")"
      let reason = options.prompt.map { "\(count): \($0.prefix(80))" } ?? count
      context.localizedReason = reason
      var evalError: Error?
      let done = DispatchSemaphore(value: 0)
      context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { ok, err in
        if !ok { evalError = err ?? NSError(domain: LAErrorDomain, code: LAError.authenticationFailed.rawValue) }
        done.signal()
      }
      done.wait()
      if let ns = evalError.map({ $0 as NSError }) {
        if ns.domain == LAErrorDomain, ns.code == LAError.userCancel.rawValue || ns.code == LAError.appCancel.rawValue || ns.code == LAError.systemCancel.rawValue { throw fail("ERR_CANCELED", ns.localizedDescription) }
        throw fail("ERR_BIOMETRIC", ns.localizedDescription)
      }
      context.interactionNotAllowed = true
      guard let key = findKey(alias, context: context) else {
        throw fail("ERR_NO_KEY", "no key \(alias); call ensureKey first")
      }
      var out: [String] = []
      for message in messages {
        var error: Unmanaged<CFError>?
        guard let sig = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, Data(message.utf8) as CFData, &error) as Data? else {
          let ns = error?.takeRetainedValue().map { $0 as Error as NSError }
          if let ns, ns.code == Int(errSecUserCanceled) { throw fail("ERR_CANCELED", ns.localizedDescription) }
          throw fail("ERR_SIGN", ns?.localizedDescription ?? "the signature failed")
        }
        out.append(b64url(sig))
      }
      return out
    }

    AsyncFunction("deleteKey") { (alias: String) -> Bool in
      let query: [String: Any] = [
        kSecClass as String: kSecClassKey,
        kSecAttrApplicationTag as String: tag(alias),
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      ]
      return SecItemDelete(query as CFDictionary) == errSecSuccess
    }

    // Apple App Attest (vault's verifier checks these in the sealing process). The key lives in the Secure Enclave and is made by the OS; JS keeps only its id.
    // Not available in the simulator or on a device without the capability: appAttestSupported() says so and the others reject with ERR_APPATTEST.
    AsyncFunction("appAttestSupported") { () -> Bool in
      DCAppAttestService.shared.isSupported
    }

    AsyncFunction("appAttestGenerateKey") { (promise: Promise) in
      guard DCAppAttestService.shared.isSupported else { return promise.reject(fail("ERR_APPATTEST", "App Attest is not supported here")) }
      DCAppAttestService.shared.generateKey { keyId, error in
        if let keyId { promise.resolve(keyId) } else { promise.reject(fail("ERR_APPATTEST", error?.localizedDescription ?? "generateKey failed")) }
      }
    }

    // clientDataHash is the 32 byte SHA-256, base64url. Returns the CBOR attestation object, base64url.
    AsyncFunction("appAttestAttest") { (keyId: String, clientDataHash: String, promise: Promise) in
      guard let hash = fromB64url(clientDataHash) else { return promise.reject(fail("ERR_INPUT", "clientDataHash is not base64url")) }
      DCAppAttestService.shared.attestKey(keyId, clientDataHash: hash) { object, error in
        if let object { promise.resolve(b64url(object)) } else { promise.reject(fail("ERR_APPATTEST", error?.localizedDescription ?? "attestKey failed")) }
      }
    }

    // An assertion over clientDataHash (SHA-256 of the proof bytes, base64url). The counter inside it rises with every call. Returns the CBOR assertion, base64url.
    AsyncFunction("appAttestAssert") { (keyId: String, clientDataHash: String, promise: Promise) in
      guard let hash = fromB64url(clientDataHash) else { return promise.reject(fail("ERR_INPUT", "clientDataHash is not base64url")) }
      DCAppAttestService.shared.generateAssertion(keyId, clientDataHash: hash) { object, error in
        if let object { promise.resolve(b64url(object)) } else { promise.reject(fail("ERR_APPATTEST", error?.localizedDescription ?? "generateAssertion failed")) }
      }
    }

    Function("info") { () -> [String: Any] in
      let has = findKey(personAlias) != nil
      let level = inSimulator ? (has ? "software" : "none") : (has ? "secure-enclave" : "none")
      return ["strongBox": false, "secureHardware": !inSimulator, "level": level]
    }

    Function("randomBytes") { (n: Int) throws -> String in
      guard n >= 1 && n <= 1024 else { throw fail("ERR_INPUT", "randomBytes takes 1 to 1024") }
      var bytes = [UInt8](repeating: 0, count: n)
      guard SecRandomCopyBytes(kSecRandomDefault, n, &bytes) == errSecSuccess else {
        throw fail("ERR_RANDOM", "the system random source failed")
      }
      return b64url(Data(bytes))
    }
  }
}
