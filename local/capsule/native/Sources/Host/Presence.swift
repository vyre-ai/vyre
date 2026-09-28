// Presence: proving a person is at the Mac before a human-only call (ADR 0004, method "capsule").
//
// The Capsule holds one P-256 key per Vyre home, made in this Mac's Secure Enclave with
// kSecAccessControlBiometryCurrentSet: the private key never leaves the enclave, and every use of
// it demands a live Touch ID from the enclave itself, not merely an app-level gate. (An earlier
// Ed25519 key sat in the login keychain as ordinary bytes: any program running as the same uid --
// a model's own shell, in the ordinary case, not an escape -- could read and reuse it, which is
// what made method-capsule proofs forgeable; e2e2's server-side fix, 9bfc452e, refuses that old
// kind outright.) The panel shows the words being approved and asks for Touch ID inside itself
// (LAAuthenticationView, no system dialog): evaluatePolicy() runs on a fresh LAContext per proof,
// and that same already-authenticated context is then handed to the Secure Enclave for the
// signature itself, so the one Touch ID the person sees is also the one the hardware requires --
// never a second, separate system prompt, and never a reused authentication from an earlier call.
//
// The signed message is unchanged from the Ed25519 scheme:
//
//     vyre-presence-v1\n<tool>\n<base64url sha256 of the canonical input>\n<ts>\n<nonce>
//
// which vyred checks (ES256, DER) against the enrolled public key. The key is enrolled once, with
// vyred's own Touch ID dialog (x-vyre-presence: touchid), the first time a proof is needed; if the
// keychain holds a handle this Mac's enclave no longer recognises -- foreign, or the old
// raw-bytes Ed25519 shape -- proof() deletes it and enrolls again, once, quietly, since the
// person already proved presence for the very call that found it missing.
//
// Nothing here runs under tests except through fakes: no keychain, no Secure Enclave, no Touch
// ID, no dialog unless dialogsAllowed() says a person may be asked.

import AppKit
import CryptoKit
import Foundation
import LocalAuthentication
import Security

// MARK: the words a proof is bound to

public enum PresenceCanonical {
    /// core/presence canonical(): JSON with object keys sorted at every depth and no spaces.
    public static func encode(_ v: Any?) -> String {
        guard let v, !(v is NSNull) else { return "null" }
        if let d = v as? [String: Any] {
            return "{" + d.keys.sorted { a, b in a.utf16.lexicographicallyPrecedes(b.utf16) }.map { string($0) + ":" + encode(d[$0]) }.joined(separator: ",") + "}"
        }
        if let a = v as? [Any] { return "[" + a.map { encode($0) }.joined(separator: ",") + "]" }
        if let s = v as? String { return string(s) }
        if VJ.isBool(v) { return (v as! NSNumber).boolValue ? "true" : "false" }
        if let n = VJ.num(v) { return number(n) }
        return "null"
    }

    /// JSON.stringify for a string: quotes, backslashes and control characters escaped, the rest as is.
    static func string(_ s: String) -> String {
        var out = "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if u.value < 0x20 { out += String(format: "\\u%04x", u.value) } else { out.unicodeScalars.append(u) }
            }
        }
        return out + "\""
    }

    /// JSON.stringify for a number: integers without a point, others shortest.
    static func number(_ n: Double) -> String {
        if !n.isFinite { return "null" }
        if n == n.rounded(), abs(n) < 1e21 { return String(format: "%.0f", n) }
        return "\(n)"
    }

    /// base64url SHA-256 of the canonical input.
    public static func hash(_ input: [String: Any]) -> String {
        b64url(Data(SHA256.hash(data: Data(encode(input).utf8))))
    }

    static func b64url(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}

// MARK: where the key is kept

public protocol PresenceKeyStore: AnyObject {
    /// The Secure Enclave key's opaque handle (SecureEnclave.P256.Signing.PrivateKey's
    /// dataRepresentation) -- useless anywhere but this Mac's own enclave, and even there it
    /// signs nothing without a live Touch ID -- or nil if there is none.
    func loadHandle() -> Data?
    func save(_ handle: Data) -> Bool
    func delete()
}

/// The login keychain. One item per Vyre home, holding only the Secure Enclave's own opaque
/// handle for the key, not key material -- reading this item without Touch ID gets you nothing
/// signable. (The keychain item's own ACL naming the Capsule alone is still worth having, same as
/// before, but it is no longer what makes the key safe: the enclave's per-use biometry is.)
final class KeychainKeyStore: PresenceKeyStore {
    let account: String
    static let service = "sh.vyre.capsule.presence"
    init(home: String) { account = PresenceCanonical.b64url(Data(SHA256.hash(data: Data(home.utf8)))).prefix(22).description }

    func loadHandle() -> Data? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service,
                                kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return d
    }

    func save(_ handle: Data) -> Bool {
        delete()
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service,
                                kSecAttrAccount as String: account, kSecAttrLabel as String: "Vyre Capsule presence key",
                                kSecValueData as String: handle]
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }

    func delete() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service,
                       kSecAttrAccount as String: account] as CFDictionary)
    }
}

// MARK: the proof

/// What the panel shows while a proof is wanted: the words, and the context Touch ID answers in.
@MainActor
public final class PresenceAsk: ObservableObject, Identifiable {
    public let id = UUID()
    public let tool: String
    public let summary: String
    let context: LAContext
    var done: ((Bool) -> Void)?
    private var begun = false
    init(tool: String, summary: String, context: LAContext) { self.tool = tool; self.summary = summary; self.context = context }

    /// Ask for Touch ID (drawn in the panel's glyph) or, without it, the Mac's password.
    func begin() {
        guard !begun else { return }
        begun = true
        let biometric = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        context.evaluatePolicy(biometric ? .deviceOwnerAuthenticationWithBiometrics : .deviceOwnerAuthentication,
                               localizedReason: summary) { [weak self] ok, _ in
            DispatchQueue.main.async { self?.done?(ok) }
        }
    }
}

// MARK: signing, abstracted over where the key lives

/// What header()/proof() need from a P-256 signing key -- true of both the real Secure Enclave
/// key production code makes and an ordinary in-memory P256.Signing.PrivateKey, which needs no
/// hardware or Touch ID and so is what tests construct to check the signed header's shape and a
/// verifier's happy path without ever touching the keychain or the enclave.
protocol CapsuleSigningKey {
    var publicKey: P256.Signing.PublicKey { get }
    func signature(for data: Data) throws -> P256.Signing.ECDSASignature
}
extension SecureEnclave.P256.Signing.PrivateKey: CapsuleSigningKey {}
extension P256.Signing.PrivateKey: CapsuleSigningKey {}

@MainActor
public final class CapsulePresence {
    let home: String
    let store: PresenceKeyStore
    let vyred: VyredClient
    let now: () -> Double
    /// Shows the ask in the panel and returns whether the person proved it. Set by the app.
    var ask: ((PresenceAsk) async -> Bool)?
    /// Makes the LAContext (a fake in tests).
    var makeContext: () -> LAContext = { LAContext() }
    /// CapsulePin.swift's pinSelf(): the cdhash last successfully pinned with vyred, in memory
    /// only, so a reconnect for the same build never re-signs or re-asks Touch ID.
    var pinnedCdhash: String?

    struct Enrolled: Codable { var id: String; var publicKey: String }

    init(home: String, vyred: VyredClient, store: PresenceKeyStore? = nil, now: @escaping () -> Double = { vyNowMs() }) {
        self.home = home
        self.vyred = vyred
        self.store = store ?? KeychainKeyStore(home: home)
        self.now = now
    }

    var file: URL { URL(fileURLWithPath: home).appendingPathComponent("capsule/presence.json") }

    var enrolled: Enrolled? {
        guard let d = try? Data(contentsOf: file) else { return nil }
        return try? JSONDecoder().decode(Enrolled.self, from: d)
    }

    /// The key behind `handle`, unlocked with `context` -- an already-authenticated LAContext
    /// satisfies the Secure Enclave's biometryCurrentSet with no second prompt; an
    /// unauthenticated one raises the system Touch ID sheet in its place. nil for a missing,
    /// foreign, or pre-Secure-Enclave (Ed25519, wrong byte shape) handle.
    private func loadPrivate(context: LAContext) -> CapsuleSigningKey? {
        guard let handle = store.loadHandle() else { return nil }
        return try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: handle, authenticationContext: context)
    }

    /// The header for one call, signed with the key after the person proved it in the panel.
    func proof(tool: String, input: [String: Any], summary: String? = nil) async -> Result<String, VyredFailure> {
        guard dialogsAllowed() else { return .failure(VyredFailure("Proving you are here is off under tests.")) }
        if enrolled == nil, let why = await enroll() { return .failure(VyredFailure(why)) }
        guard let key = enrolled else { return .failure(VyredFailure("The Capsule's key is not enrolled.")) }
        let context = makeContext()
        context.localizedCancelTitle = "Not now"
        let words = summary ?? Self.defaultSummary(tool, input)
        let a = PresenceAsk(tool: tool, summary: words, context: context)
        guard let ask, await ask(a) else { return .failure(VyredFailure("Not approved. Nothing was done.")) }
        if let priv = loadPrivate(context: context), let header = Self.header(tool: tool, input: input, key: priv, keyId: key.id, ts: now()) {
            return .success(header)
        }
        // Either the keychain handle is missing or foreign (an old Ed25519-era one included, the
        // wrong byte shape for a Secure Enclave handle), or the key would not sign: the person
        // just proved presence for this very call, so re-enroll once, quietly, rather than asking
        // again for the same click. A signing failure with a live handle is unexpected (the enclave
        // itself refusing after the panel's own Touch ID succeeded), so re-enrolling is also the
        // only thing left to try, not a special case.
        store.delete()
        if let why = await enroll() { return .failure(VyredFailure(why)) }
        guard let key2 = enrolled, let priv2 = loadPrivate(context: context), let header2 = Self.header(tool: tool, input: input, key: priv2, keyId: key2.id, ts: now()) else {
            return .failure(VyredFailure("The Capsule's key could not be made on this Mac. Remove it in Settings and enroll again."))
        }
        return .success(header2)
    }

    /// `capsule key=<id> ts=<ms> nonce=<n> sig=<s>` over the bound message: an ES256 (P-256) DER
    /// signature, which vyred checks with crypto.verify's default sha256 digest and dsaEncoding
    /// "der". nil, never a header with an empty sig, if the key would not sign (e2e2's ask,
    /// 28 Sep) -- an empty sig is not "no proof", it is a malformed one vyred still has to parse.
    nonisolated static func header(tool: String, input: [String: Any], key: CapsuleSigningKey, keyId: String, ts: Double, nonce: String? = nil) -> String? {
        let n = nonce ?? PresenceCanonical.b64url(Data((0..<18).map { _ in UInt8.random(in: 0...255) }))
        let t = String(format: "%.0f", ts)
        let msg = "vyre-presence-v1\n\(tool)\n\(PresenceCanonical.hash(input))\n\(t)\n\(n)"
        guard let sig = try? key.signature(for: Data(msg.utf8)) else { return nil }
        return "capsule key=\(keyId) ts=\(t) nonce=\(n) sig=\(PresenceCanonical.b64url(sig.derRepresentation))"
    }

    /// A tool's name and a short form of its input, when the caller has no words of its own.
    nonisolated static func defaultSummary(_ tool: String, _ input: [String: Any]) -> String {
        String("\(tool) \(PresenceCanonical.encode(input))".prefix(160))
    }

    /// Make the key in this Mac's Secure Enclave (P-256, alg -7) behind a live Touch ID on every
    /// use (kSecAccessControlBiometryCurrentSet -- invalidated too if the enrolled fingerprints
    /// change, so a stolen unlocked Mac still cannot sign with someone else's finger), keep its
    /// opaque handle, and enroll the public half with vyred, which shows its own Touch ID dialog
    /// for this one call. Returns why not, or nil when enrolled.
    func enroll() async -> String? {
        guard SecureEnclave.isAvailable else { return "This Mac has no Secure Enclave, so the Capsule cannot make a presence key." }
        // biometryCurrentSet demands a live fingerprint on every single use; a key made without
        // one enrolled would never sign again (e2e2's ask, 28 Sep: never offer the capsule method
        // at all on a Mac with no Touch ID, rather than make a key doomed to fail every proof).
        guard makeContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) else {
            return "This Mac has no Touch ID enrolled, so the Capsule cannot prove you are here. Use a passkey or a paired phone instead."
        }
        var cfError: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet], &cfError) else {
            return "The Capsule could not set up a Touch ID key on this Mac."
        }
        guard let key = try? SecureEnclave.P256.Signing.PrivateKey(accessControl: access) else {
            return "The Capsule could not make a Secure Enclave key on this Mac."
        }
        guard store.save(key.dataRepresentation) else { return "The Capsule could not keep its key in your keychain." }
        let pub = PresenceCanonical.b64url(key.publicKey.derRepresentation)
        let r = await vyred.call("presence.enroll", ["kind": "capsule", "name": "Capsule on \(Host.current().localizedName ?? "this Mac")", "public_key": pub, "alg": -7],
                                 timeout: 120, headers: ["x-vyre-presence": "touchid"])
        guard let d = r.data as? [String: Any], let id = VJ.nonEmpty(d["id"]) else {
            store.delete()
            return Bridge.explain(r).map { "The Capsule's key was not enrolled: \($0)" } ?? "The Capsule's key was not enrolled."
        }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(Enrolled(id: id, publicKey: pub)) { try? data.write(to: file, options: .atomic) }
        return nil
    }
}

/// Carries a JSON dictionary across an actor hop; it is only read.
struct UncheckedBox: @unchecked Sendable { let value: [String: Any]; init(_ v: [String: Any]) { value = v } }

extension CapsulePresence {
    nonisolated func proofFromAnyThread(tool: String, input: UncheckedBox, summary: String? = nil) async -> Result<String, VyredFailure> {
        await proof(tool: tool, input: input.value, summary: summary)
    }
}
