// enclave: the vault's Secure Enclave helper, for Touch ID unlock of the personal vault
// (ADR 0006, decision 2). vyred starts it, writes one JSON request on stdin and reads one JSON
// line back on stdout. Nothing sensitive is ever an argument.
//
//   {"op":"available"}                              -> {"ok":true,"available":B}
//   {"op":"create"}                                 -> {"ok":true,"blob":"<b64>","pub":"<b64 x963>"}
//   {"op":"derive","blob":"..","peerPub":"..","reason":".."}
//                                                   -> {"ok":true,"shared":"<b64>"}
//   {"op":"auth","reason":".."}                     -> {"ok":true}  presence: Touch ID or the
//                                                      Mac's password, with the reason shown
//
// `create` makes a P-256 key-agreement key inside the Secure Enclave with
// [.privateKeyUsage, .biometryCurrentSet]: the private key never leaves the enclave, every use
// needs a fingerprint enrolled now (a new fingerprint kills it), and the blob it returns is
// only a handle this Mac's enclave can use. `derive` evaluates an LAContext with the reason,
// hands that context to the key, and does ECDH with the peer's public key.
//
// Errors come back as {"ok":false,"code":"...","message":"..."} with fixed words and the
// OSStatus, never with request data.

import CryptoKit
import Foundation
import LocalAuthentication
import Security

func reply(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func fail(_ code: String, _ message: String) -> Never {
    reply(["ok": false, "code": code, "message": message])
    exit(1)
}

func describe(_ error: Error) -> String {
    let ns = error as NSError
    return "\(ns.domain) \(ns.code)"
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let line = String(data: input, encoding: .utf8)?.split(separator: "\n").first,
      let req = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
      let op = req["op"] as? String else {
    fail("bad_request", "expected one JSON request on stdin")
}

switch op {
case "available":
    reply(["ok": true, "available": SecureEnclave.isAvailable])

case "create":
    guard SecureEnclave.isAvailable else { fail("unavailable", "this Mac has no Secure Enclave") }
    var cfErr: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                                                       [.privateKeyUsage, .biometryCurrentSet], &cfErr) else {
        fail("access_control", "could not make the access control")
    }
    do {
        let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access)
        reply(["ok": true, "blob": key.dataRepresentation.base64EncodedString(),
               "pub": key.publicKey.x963Representation.base64EncodedString()])
    } catch {
        fail("create_failed", "the Secure Enclave refused to make a key: \(describe(error))")
    }

case "derive":
    guard let blobB64 = req["blob"] as? String, let blob = Data(base64Encoded: blobB64),
          let peerB64 = req["peerPub"] as? String, let peerData = Data(base64Encoded: peerB64),
          let reason = req["reason"] as? String, !reason.isEmpty else {
        fail("bad_request", "derive needs blob, peerPub and reason")
    }
    let context = LAContext()
    context.localizedReason = String(reason.prefix(200))
    let sem = DispatchSemaphore(value: 0)
    var allowed = false
    var laError = ""
    context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: String(reason.prefix(200))) { ok, err in
        allowed = ok
        if let err = err { laError = describe(err) }
        sem.signal()
    }
    sem.wait()
    guard allowed else { fail("refused", "Touch ID was not confirmed: \(laError)") }
    do {
        let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: blob, authenticationContext: context)
        let peer = try P256.KeyAgreement.PublicKey(x963Representation: peerData)
        let secret = try key.sharedSecretFromKeyAgreement(with: peer)
        let bytes = secret.withUnsafeBytes { Data($0) }
        reply(["ok": true, "shared": bytes.base64EncodedString()])
    } catch {
        fail("derive_failed", "the Secure Enclave key did not open: \(describe(error))")
    }

case "auth":
    guard let reason = req["reason"] as? String, !reason.isEmpty else { fail("bad_request", "auth needs a reason") }
    let context = LAContext()
    let sem = DispatchSemaphore(value: 0)
    var allowed = false
    var laError = ""
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: String(reason.prefix(200))) { ok, err in
        allowed = ok
        if let err = err { laError = describe(err) }
        sem.signal()
    }
    sem.wait()
    guard allowed else { fail("refused", "the person did not confirm: \(laError)") }
    reply(["ok": true])

default:
    fail("bad_request", "unknown op")
}
