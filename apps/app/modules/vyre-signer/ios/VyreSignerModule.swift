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

private func b64url(_ data: Data) -> String {
  data.base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
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

    AsyncFunction("deleteKey") { (alias: String) -> Bool in
      let query: [String: Any] = [
        kSecClass as String: kSecClassKey,
        kSecAttrApplicationTag as String: tag(alias),
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      ]
      return SecItemDelete(query as CFDictionary) == errSecSuccess
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
