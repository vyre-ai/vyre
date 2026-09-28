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
// on any refusal: no Secure Enclave, an ad hoc build (vyred refuses presence.capsule.pin outright
// until a stable identity exists, "vyre-core" per ADR 0040 eventually), Touch ID declined, or off
// under a test. The Capsule works either way; it just cannot vouch for itself yet.

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

    /// Pin this build with vyred if it is not already pinned. Idempotent per process: a second
    /// call for the same cdhash (the common case, a reconnect) does nothing.
    func pinSelf() async {
        guard let cdhash = Self.ownCdhash(), cdhash != pinnedCdhash else { return }
        let short = String(cdhash.prefix(16))
        let proved = await proof(tool: "presence.capsule.pin", input: ["cdhash": cdhash], summary: "Pin this Mac's Capsule build (\(short))")
        guard case .success(let header) = proved else { return }
        let r = await vyred.call("presence.capsule.pin", ["cdhash": cdhash], timeout: 30, headers: ["x-vyre-presence": header])
        if r.error == nil { pinnedCdhash = cdhash }
    }
}
