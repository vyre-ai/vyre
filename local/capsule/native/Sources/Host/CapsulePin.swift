// CapsulePin: the Capsule tells vyred which build is really running (presence.capsule.pin),
// using its own already-enrolled presence key (Presence.swift, "capsule" kind) rather than a new
// one -- no box needed, no new crypto, the lead's approved pivot after the SE-key-file scheme
// (core/cli/commands/capsule.js's pinCapsule, reverted) turned out to need a key only the Capsule
// binary itself could ever read anyway.
//
// Self-verified (reviewer, 28 Sep): the cdhash pinned is read from this process's own code, via
// SecCode, never a value handed in from anywhere else. A model cannot get the Capsule to vouch
// for a different binary by asking it to pin some other cdhash, because there is no "some other
// cdhash" parameter at all -- pinSelf() takes none. The Touch ID prompt (CapsulePresence.proof's
// summary) names the build by its own shortened cdhash, so the person has something concrete to
// eyeball, not just a generic sentence.
//
// Asked on every fresh connect (App.swift's follower.onState), a no-op once this process's own
// cdhash has already been pinned successfully -- never a repeat prompt for the same build. Silent
// on any refusal: no Secure Enclave, an ad hoc build, Touch ID declined, or off under a test. The
// Capsule works either way; it just cannot vouch for itself yet.
//
// No nagging (the reviewer's LOW on 268404c0, 28 Sep): vyred refuses an ad hoc or unsigned build
// only after the proof, so asking first meant a Touch ID for nothing on every reconnect, and people
// build the Capsule on their own Mac. Now pinSelf checks its own signature first, the same test
// vyred makes (signed, not ad hoc), and asks only when the pin can succeed; and any refusal (vyred
// says denied, or the person says "Not now") is remembered for this process, so it is asked once.

import Foundation
import Security

extension CapsulePresence {
    /// This process's own cdhash (lower-case hex), read from the kernel via SecCode -- never a
    /// value handed in. nil off a Mac, or if the code cannot be read (should not happen for a
    /// running process asking about itself).
    nonisolated static func ownCdhash() -> String? {
        var code: SecCode?
        guard SecCodeCopySelf(SecCSFlags(rawValue: 0), &code) == errSecSuccess, let code else { return nil }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, SecCSFlags(rawValue: 0), &staticCode) == errSecSuccess, let staticCode else { return nil }
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let dict = info as? [String: Any], let data = dict[kSecCodeInfoUnique as String] as? Data else { return nil }
        return data.map { String(format: "%02x", $0) }.joined()
    }

    /// This process's own signature: its cdhash, and whether it is signed with an identity (not
    /// ad hoc), read from its own code flags. nil when the code cannot be read.
    nonisolated static func readOwnSignature() -> CapsuleSignature? {
        var code: SecCode?
        guard SecCodeCopySelf(SecCSFlags(rawValue: 0), &code) == errSecSuccess, let code else { return nil }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, SecCSFlags(rawValue: 0), &staticCode) == errSecSuccess, let staticCode else { return nil }
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let dict = info as? [String: Any], let data = dict[kSecCodeInfoUnique as String] as? Data else { return nil }
        let flags = (dict[kSecCodeInfoFlags as String] as? NSNumber)?.uint32Value ?? 0
        let adhoc = flags & SecCodeSignatureFlags.adhoc.rawValue != 0 || dict[kSecCodeInfoCertificates as String] == nil
        return CapsuleSignature(cdhash: data.map { String(format: "%02x", $0) }.joined(), adhoc: adhoc)
    }

    /// Whether pinSelf would ask for Touch ID now, and if not, why.
    enum PinStep: Equatable { case ask(String), pinned, refusedBefore, adhoc, unreadable }

    func pinStep() -> PinStep {
        guard let sig = ownSignature() else { return .unreadable }
        if sig.cdhash == pinnedCdhash { return .pinned }
        if sig.cdhash == pinRefused { return .refusedBefore }
        // vyred refuses an unsigned or ad hoc build after the proof: never ask for that.
        if sig.adhoc { return .adhoc }
        return .ask(sig.cdhash)
    }

    /// Pin this build with vyred if it is not already pinned and can be. Idempotent per process:
    /// a second call for the same cdhash (the common case, a reconnect) does nothing, whether the
    /// first was pinned or refused.
    func pinSelf() async {
        guard case .ask(let cdhash) = pinStep() else { return }
        let short = String(cdhash.prefix(16))
        let summary = "Pin this Mac's Capsule build (\(short))"
        let proved: Result<String, VyredFailure>
        if let pinProof { proved = await pinProof("presence.capsule.pin", ["cdhash": cdhash], summary) }
        else { proved = await proof(tool: "presence.capsule.pin", input: ["cdhash": cdhash], summary: summary) }
        guard case .success(let header) = proved else {
            // "Not now" is an answer; off under tests is not, so a test run remembers nothing.
            if dialogsAllowed() || pinProof != nil { pinRefused = cdhash }
            return
        }
        let r = await vyred.call("presence.capsule.pin", ["cdhash": cdhash], timeout: 30, headers: ["x-vyre-presence": header])
        if r.error == nil { pinnedCdhash = cdhash } else if r.errorCode == "denied" { pinRefused = cdhash }
    }
}

/// A process's own code signature, as vyred judges it for presence.capsule.pin.
struct CapsuleSignature: Equatable {
    var cdhash: String
    var adhoc: Bool
}
