// Presence: proving a person is at the Mac before a human-only call (ADR 0004, method "capsule").
//
// The Capsule holds one Ed25519 key per Vyre home, in the login keychain, readable only by the
// Capsule. Before each signature the panel shows the words being approved and asks for Touch ID
// inside itself (LAAuthenticationView, no system dialog); only a proven LAContext lets the
// Capsule read the key and sign
//
//     vyre-presence-v1\n<tool>\n<base64url sha256 of the canonical input>\n<ts>\n<nonce>
//
// which vyred checks against the enrolled public key. The key is enrolled once, with vyred's own
// Touch ID dialog (x-vyre-presence: touchid), the first time a proof is needed.
//
// Nothing here runs under tests except through fakes: no keychain, no Touch ID, no dialog unless
// dialogsAllowed() says a person may be asked.

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
    /// The private key, read with `context` (an authenticated LAContext), or nil if there is none.
    func load(context: LAContext?) -> Curve25519.Signing.PrivateKey?
    func save(_ key: Curve25519.Signing.PrivateKey) -> Bool
    func delete()
}

/// The login keychain. One item per Vyre home, readable without a prompt only by the app that
/// made it (the item's access list names the Capsule alone, so another process reading it gets
/// the keychain's own password prompt). The person's proof is the Touch ID in the panel, asked
/// before each signature; the keychain keeps the key from other programs. (Presence-gated items
/// need the data protection keychain, which a locally signed app cannot use.)
final class KeychainKeyStore: PresenceKeyStore {
    let account: String
    static let service = "sh.vyre.capsule.presence"
    init(home: String) { account = PresenceCanonical.b64url(Data(SHA256.hash(data: Data(home.utf8)))).prefix(22).description }

    func load(context: LAContext?) -> Curve25519.Signing.PrivateKey? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service,
                                kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return try? Curve25519.Signing.PrivateKey(rawRepresentation: d)
    }

    func save(_ key: Curve25519.Signing.PrivateKey) -> Bool {
        delete()
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service,
                                kSecAttrAccount as String: account, kSecAttrLabel as String: "Vyre Capsule presence key",
                                kSecValueData as String: key.rawRepresentation]
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
        guard let priv = store.load(context: context) else {
            return .failure(VyredFailure("The Capsule's key could not be read from the keychain. Remove it in Settings and enroll again."))
        }
        return .success(Self.header(tool: tool, input: input, key: priv, keyId: key.id, ts: now()))
    }

    /// `capsule key=<id> ts=<ms> nonce=<n> sig=<s>` over the bound message.
    nonisolated static func header(tool: String, input: [String: Any], key: Curve25519.Signing.PrivateKey, keyId: String, ts: Double, nonce: String? = nil) -> String {
        let n = nonce ?? PresenceCanonical.b64url(Data((0..<18).map { _ in UInt8.random(in: 0...255) }))
        let t = String(format: "%.0f", ts)
        let msg = "vyre-presence-v1\n\(tool)\n\(PresenceCanonical.hash(input))\n\(t)\n\(n)"
        let sig = (try? key.signature(for: Data(msg.utf8))).map { PresenceCanonical.b64url($0) } ?? ""
        return "capsule key=\(keyId) ts=\(t) nonce=\(n) sig=\(sig)"
    }

    /// A tool's name and a short form of its input, when the caller has no words of its own.
    nonisolated static func defaultSummary(_ tool: String, _ input: [String: Any]) -> String {
        String("\(tool) \(PresenceCanonical.encode(input))".prefix(160))
    }

    /// SPKI DER for an Ed25519 public key: the fixed 12-byte prefix, then the 32 raw bytes.
    nonisolated static func spki(_ pub: Curve25519.Signing.PublicKey) -> Data {
        Data([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]) + pub.rawRepresentation
    }

    /// Make the key, keep it behind presence, and enroll its public half with vyred, which shows
    /// its own Touch ID dialog for this one call. Returns why not, or nil when enrolled.
    func enroll() async -> String? {
        let key = Curve25519.Signing.PrivateKey()
        guard store.save(key) else { return "The Capsule could not keep its key in your keychain." }
        let pub = PresenceCanonical.b64url(Self.spki(key.publicKey))
        let r = await vyred.call("presence.enroll", ["kind": "capsule", "name": "Capsule on \(Host.current().localizedName ?? "this Mac")", "public_key": pub],
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
    nonisolated func proofFromAnyThread(tool: String, input: UncheckedBox) async -> Result<String, VyredFailure> {
        await proof(tool: tool, input: input.value)
    }
}
