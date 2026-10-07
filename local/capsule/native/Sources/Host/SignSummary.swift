// What the person is told they are signing (KP-3). The page hands the shell bytes to sign and, until now, the words for the Touch ID sheet. A page the person does not control (a team server's
// JavaScript) could then ask for a signature over "add this device" and call it "Unlock Drive". So the shell reads the bytes itself and writes the words itself:
//   - an identity-list change ("vyre-chain-v1" and the op's JSON): add, remove, replace-code, recover, genesis
//   - a yes-moment proof (the canonical proof JSON): only when the page also hands the card's fields and they hash to the proof's payload_hash, the same check the phone's card does
// Anything else has no summary, and no summary means no prompt and no signature. The page's own caption is never read.

import CryptoKit
import Foundation

enum SignSummary {
    static let chainTag = "vyre-chain-v1\n"

    /// The plain words for `message`, or nil when the shell cannot read it (then it is not signed). `fields` and `space` are the card's, for a yes-moment proof.
    static func of(message: Data, fields: [String: Any]? = nil, space: String? = nil) -> String? {
        if let tag = chainTag.data(using: .utf8), message.starts(with: tag) { return chain(message.dropFirst(tag.count)) }
        return proof(message, fields: fields, space: space)
    }

    private static func clean(_ s: Any?, _ max: Int = 40) -> String {
        let t = String(((s as? String) ?? "").unicodeScalars.filter { $0.value >= 0x20 && $0.value != 0x7f }.map(Character.init)).trimmingCharacters(in: .whitespaces)
        return t.count > max ? String(t.prefix(max)) + "..." : t
    }

    private static func name(_ entry: [String: Any]) -> String {
        let l = clean(entry["label"]).isEmpty ? clean(entry["subject"]) : clean(entry["label"])
        return l.isEmpty ? "unnamed" : l
    }

    private static func chain(_ body: Data) -> String? {
        guard let op = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any], let type = op["type"] as? String else { return nil }
        let entry = op["entry"] as? [String: Any]
        switch type {
        case "add":
            guard let e = entry, let kind = e["kind"] as? String else { return nil }
            switch kind {
            case "device": return "Add a device: \(name(e))"
            case "contact": return "Add a recovery contact: \(name(e))"
            case "code": return "Add a recovery code"
            case "owner": return "Make \(name(e)) an owner"
            default: return nil
            }
        case "remove":
            guard let target = op["target"] as? String, !target.isEmpty else { return nil }
            return "Remove a sign-in (\(clean(target, 12)))"
        case "replace-code": return entry?["kind"] as? String == "code" ? "Replace your recovery code" : nil
        case "recover":
            guard let e = entry, e["kind"] as? String == "device" else { return nil }
            return "Recover your name onto a new device: \(name(e))"
        case "agree": return op["target"] is String ? "Add a sharing key to this device" : nil
        case "genesis":
            guard let e = entry else { return nil }
            return "Start an identity with this device: \(name(e))"
        default: return nil
        }
    }

    // MARK: A yes-moment proof

    /// kernel/seal canonical: sorted keys, no spaces, JSON.stringify strings. Strings, whole numbers, booleans, null, arrays and objects only; anything else (a fraction) is nil, so it is refused.
    static func canonical(_ v: Any) -> String? {
        switch v {
        case let s as String: return quote(s)
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue ? "true" : "false" }
            let d = n.doubleValue
            guard d == d.rounded(), abs(d) < 9_007_199_254_740_992 else { return nil }
            return String(n.int64Value)
        case is NSNull: return "null"
        case let a as [Any]:
            var parts: [String] = []
            for x in a { guard let c = canonical(x) else { return nil }; parts.append(c) }
            return "[" + parts.joined(separator: ",") + "]"
        case let o as [String: Any]:
            var parts: [String] = []
            for k in o.keys.sorted(by: { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }) { guard let c = canonical(o[k]!) else { return nil }; parts.append(quote(k) + ":" + c) }
            return "{" + parts.joined(separator: ",") + "}"
        default: return nil
        }
    }

    private static func quote(_ s: String) -> String {
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
            default: out += u.value < 0x20 ? String(format: "\\u%04x", u.value) : String(u)
            }
        }
        return out + "\""
    }

    private static func b64url(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    static func payloadHash(op: String, space: String, fields: [String: Any]) -> String? {
        guard let c = canonical(["op": op, "space": space, "fields": fields] as [String: Any]) else { return nil }
        return b64url(Data(SHA256.hash(data: Data(c.utf8))))
    }

    private static func proof(_ message: Data, fields: [String: Any]?, space: String?) -> String? {
        guard let fields, let space, let p = (try? JSONSerialization.jsonObject(with: message)) as? [String: Any],
              let decision = p["decision"] as? String, let hash = p["payload_hash"] as? String, p["nonce"] != nil,
              payloadHash(op: decision, space: space, fields: fields) == hash else { return nil }
        let what = clean(decision.replacingOccurrences(of: "_", with: " "), 60)
        let lines = fields.keys.sorted().prefix(6).map { k -> String in
            let v: String
            switch fields[k] {
            case let s as String: v = clean(s, 60)
            case let n as NSNumber: v = n.stringValue
            default: v = "..."
            }
            return "\(clean(k, 24)): \(v)"
        }
        return (["Approve: \(what)"] + lines).joined(separator: "\n")
    }
}
