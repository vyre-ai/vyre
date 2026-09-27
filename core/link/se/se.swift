// The Mac's Secure Enclave key for its box (ADR 0032 part 2c): a P-256 key the Secure Enclave holds
// and never releases, usable only with the person's Touch ID, Apple Watch or login password.
// vyred keeps the key's opaque handle (dataRepresentation), which works only on this Mac's Secure
// Enclave; a copy is useless elsewhere, and every signature here asks the person.
//
// Usage:
//   vyre-se create                  prints {"handle":"<base64>","spki":"<base64url SPKI DER>"}
//   vyre-se sign <reason> [timeout]  reads {"handle":"..","message":"<base64>"} on stdin and prints
//                                   the base64url DER ECDSA signature
// Exits 0 (ok), 1 (denied, cancelled or timed out) or 2 (unavailable, bad input).
import CryptoKit
import Foundation
import LocalAuthentication

func finish(_ text: String, _ code: Int32) -> Never {
    print(text)
    fflush(stdout)
    exit(code)
}

func b64url(_ d: Data) -> String {
    d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

guard SecureEnclave.isAvailable else { finish("unavailable", 2) }
let args = CommandLine.arguments
guard args.count > 1 else { finish("usage: vyre-se create | sign <reason> [timeout]", 2) }

if args[1] == "create" {
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &error) else {
        finish("unavailable", 2)
    }
    do {
        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
        let out: [String: String] = ["handle": key.dataRepresentation.base64EncodedString(), "spki": b64url(key.publicKey.derRepresentation)]
        let json = try JSONSerialization.data(withJSONObject: out)
        finish(String(data: json, encoding: .utf8) ?? "", 0)
    } catch {
        finish("unavailable", 2)
    }
}

if args[1] == "sign" {
    let reason = args.count > 2 && !args[2].isEmpty ? args[2] : "Vyre needs to confirm it is you."
    var timeout = 60.0
    if args.count > 3, let t = Double(args[3]), t > 0 { timeout = t }
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard let obj = try? JSONSerialization.jsonObject(with: input) as? [String: String],
          let handle = obj["handle"].flatMap({ Data(base64Encoded: $0) }),
          let message = obj["message"].flatMap({ Data(base64Encoded: $0) }) else { finish("bad input", 2) }
    let context = LAContext()
    context.localizedReason = reason
    final class Box: @unchecked Sendable { var sig: String?; var code: Int32 = 1 }
    let box = Box()
    let done = DispatchSemaphore(value: 0)
    DispatchQueue.global().async {
        do {
            let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: handle, authenticationContext: context)
            let s = try key.signature(for: message)
            box.sig = b64url(s.derRepresentation)
            box.code = 0
        } catch {
            box.code = 1
        }
        done.signal()
    }
    if done.wait(timeout: .now() + timeout) == .timedOut {
        context.invalidate()
        finish("denied", 1)
    }
    finish(box.sig ?? "denied", box.code)
}

finish("usage: vyre-se create | sign <reason> [timeout]", 2)
