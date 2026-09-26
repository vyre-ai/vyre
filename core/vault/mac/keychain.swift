// keychain: the vault's keychain helper (ADR 0006 finding 1). vyred writes and reads the
// device key through this binary instead of /usr/bin/security, so the item's access list trusts
// only this helper: `security find-generic-password -w` from any other process gets a system
// prompt instead of the key. One JSON request on stdin, one JSON line back on stdout. The
// secret is only ever in stdin and stdout, never an argument.
//
//   {"op":"write","service":"..","account":"..","keychain":"<path>"?,"secret":".."} -> {"ok":true}
//   {"op":"read","service":"..","account":"..","keychain":"<path>"?}  -> {"ok":true,"secret":".."|null}
//   {"op":"delete","service":"..","account":"..","keychain":"<path>"?} -> {"ok":true,"deleted":B}
//
// `write` replaces an existing item (delete, then add), so the access list is always ours.
// The file-based keychain APIs used here (SecAccess, SecTrustedApplication, SecKeychainOpen)
// are deprecated but still work, and they are the only way to set a per-item app list.
// No dialog is ever asked for: user interaction is turned off, so a refusal is an error code.

import Foundation
import Security

func reply(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func fail(_ code: String, _ message: String, _ status: OSStatus = 0) -> Never {
    reply(["ok": false, "code": code, "message": message, "status": Int(status)])
    exit(1)
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let line = String(data: input, encoding: .utf8)?.split(separator: "\n").first,
      let req = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
      let op = req["op"] as? String,
      let service = req["service"] as? String, !service.isEmpty,
      let account = req["account"] as? String, !account.isEmpty else {
    fail("bad_request", "expected one JSON request with op, service and account on stdin")
}

SecKeychainSetUserInteractionAllowed(false)

var keychainRef: SecKeychain? = nil
if let path = req["keychain"] as? String, !path.isEmpty {
    let st = SecKeychainOpen(path, &keychainRef)
    if st != errSecSuccess { fail("keychain", "could not open the keychain", st) }
}

func base() -> [String: Any] {
    var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                            kSecAttrService as String: service,
                            kSecAttrAccount as String: account]
    if let kc = keychainRef { q[kSecMatchSearchList as String] = [kc] }
    return q
}

func remove() -> Bool {
    var q = base()
    if let kc = keychainRef { q.removeValue(forKey: kSecMatchSearchList as String); q[kSecUseKeychain as String] = kc }
    var st = SecItemDelete(q as CFDictionary)
    if st == errSecItemNotFound, keychainRef != nil {
        st = SecItemDelete(base() as CFDictionary)
    }
    if st == errSecSuccess { return true }
    if st == errSecItemNotFound { return false }
    fail("delete", "could not remove the keychain item", st)
}

switch op {
case "write":
    guard let secret = req["secret"] as? String, !secret.isEmpty else { fail("bad_request", "write needs a secret") }
    _ = remove()
    var me: SecTrustedApplication? = nil
    var st = SecTrustedApplicationCreateFromPath(nil, &me)
    guard st == errSecSuccess, let app = me else { fail("trusted_app", "could not name this helper as a trusted application", st) }
    var access: SecAccess? = nil
    st = SecAccessCreate("Vyre vault" as CFString, [app] as CFArray, &access)
    guard st == errSecSuccess, let acc = access else { fail("access", "could not make the access list", st) }
    var add: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                              kSecAttrService as String: service,
                              kSecAttrAccount as String: account,
                              kSecAttrLabel as String: service,
                              kSecValueData as String: Data(secret.utf8),
                              kSecAttrAccess as String: acc]
    if let kc = keychainRef { add[kSecUseKeychain as String] = kc }
    st = SecItemAdd(add as CFDictionary, nil)
    if st != errSecSuccess { fail("write", "could not write the keychain item", st) }
    reply(["ok": true])

case "read":
    var q = base()
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef? = nil
    let st = SecItemCopyMatching(q as CFDictionary, &out)
    if st == errSecItemNotFound { reply(["ok": true, "secret": NSNull()]); break }
    if st != errSecSuccess { fail("read", "could not read the keychain item", st) }
    guard let data = out as? Data, let s = String(data: data, encoding: .utf8) else { fail("read", "the keychain item is not text") }
    reply(["ok": true, "secret": s])

case "delete":
    reply(["ok": true, "deleted": remove()])

default:
    fail("bad_request", "unknown op")
}
