// DeviceKey: this device's P-256 key for opening a fill window (ADR 0028, decision 5).
//
// Made at pairing, in the Secure Enclave, with SecAccessControl [.privateKeyUsage,
// .biometryCurrentSet]: every signature needs Face ID or Touch ID, and enrolling a new face or
// finger makes the key unusable, so the device must pair again. The key sits in the shared
// keychain access group, so the host app makes it and the AutoFill extension signs with it.
//
// The key signs one thing only: vyred's unlock message, `vyre:fill-unlock:v1:<challenge>`,
// checked by AutofillCore.messageToSign before the prompt is shown.
//
// The simulator has no Secure Enclave. There the key is a software key in the keychain behind
// the same biometric flag, so the flow can be exercised in CI; a device build never takes that path.

import Foundation
import LocalAuthentication
import Security

public enum DeviceKey {
  static let tag = Data("sh.vyre.autofill.devicekey".utf8)

  /// Make a new key, replacing any old one, and return its public key as SPKI DER, base64url.
  public static func create(accessGroup: String?) throws -> String {
    delete(accessGroup: accessGroup)
    var err: Unmanaged<CFError>?
    #if targetEnvironment(simulator)
    let flags: SecAccessControlCreateFlags = [.biometryCurrentSet]
    #else
    let flags: SecAccessControlCreateFlags = [.privateKeyUsage, .biometryCurrentSet]
    #endif
    guard let access = SecAccessControlCreateWithFlags(kCFAllocatorDefault, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, flags, &err) else {
      throw FillError("keygen")
    }
    let privateAttrs: [String: Any] = [
      kSecAttrIsPermanent as String: true,
      kSecAttrApplicationTag as String: tag,
      kSecAttrAccessControl as String: access,
    ]
    var attrs: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecPrivateKeyAttrs as String: privateAttrs,
      kSecUseDataProtectionKeychain as String: true,
    ]
    #if !targetEnvironment(simulator)
    attrs[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave
    #endif
    if let g = accessGroup { attrs[kSecAttrAccessGroup as String] = g }
    guard let key = SecKeyCreateRandomKey(attrs as CFDictionary, &err),
          let pub = SecKeyCopyPublicKey(key),
          let raw = SecKeyCopyExternalRepresentation(pub, &err) as Data?,
          let spki = AutofillCore.spki(fromX963: [UInt8](raw)) else {
      throw FillError("keygen")
    }
    return AutofillCore.base64url(spki)
  }

  /// Whether a device key exists. Does not prompt.
  public static func exists(accessGroup: String?) -> Bool {
    let ctx = LAContext()
    ctx.interactionNotAllowed = true
    var q = query(accessGroup: accessGroup)
    q[kSecUseAuthenticationContext as String] = ctx
    q[kSecReturnAttributes as String] = true
    let status = SecItemCopyMatching(q as CFDictionary, nil)
    return status == errSecSuccess || status == errSecInteractionNotAllowed
  }

  @discardableResult
  public static func delete(accessGroup: String?) -> Bool {
    SecItemDelete(query(accessGroup: accessGroup) as CFDictionary) == errSecSuccess
  }

  /// Sign vyred's unlock message after the system biometric prompt. Refuses (bad_challenge)
  /// anything that is not exactly `vyre:fill-unlock:v1:<challenge>`, before any prompt.
  /// Returns the ECDSA P-256 SHA-256 signature, DER, base64url.
  public static func signUnlock(challenge: String, message: String, reason: String, accessGroup: String?) async throws -> String {
    guard let m = AutofillCore.messageToSign(challenge: challenge, message: message) else { throw FillError("bad_challenge") }
    let ctx = LAContext()
    ctx.localizedCancelTitle = "Cancel"
    var authErr: NSError?
    guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &authErr) else { throw FillError("no_biometrics") }
    do {
      _ = try await ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
    } catch {
      throw FillError("cancelled")
    }
    var q = query(accessGroup: accessGroup)
    q[kSecReturnRef as String] = true
    q[kSecUseAuthenticationContext as String] = ctx
    var item: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &item)
    guard status == errSecSuccess, let found = item, CFGetTypeID(found) == SecKeyGetTypeID() else { throw FillError("no_key") }
    let key = found as! SecKey
    guard SecKeyIsAlgorithmSupported(key, .sign, .ecdsaSignatureMessageX962SHA256) else { throw FillError("no_key") }
    var err: Unmanaged<CFError>?
    guard let sig = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, Data(m.utf8) as CFData, &err) as Data? else {
      throw FillError("cancelled")
    }
    return AutofillCore.base64url([UInt8](sig))
  }

  private static func query(accessGroup: String?) -> [String: Any] {
    var q: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
      kSecAttrApplicationTag as String: tag,
      kSecUseDataProtectionKeychain as String: true,
    ]
    if let g = accessGroup { q[kSecAttrAccessGroup as String] = g }
    return q
  }
}
