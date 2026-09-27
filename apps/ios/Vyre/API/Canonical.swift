import CryptoKit
import Foundation

/// Canonical JSON exactly as core/presence/index.js `canonical()` writes it: object keys sorted
/// (by UTF-16 code units, as JavaScript's sort does) at every depth, no spaces, strings and
/// numbers as JSON.stringify writes them. A presence proof is bound to the base64url SHA-256 of
/// this, so a single differing byte makes the box refuse the proof. Tested byte for byte against
/// vectors node wrote (VyreTests/Fixtures/canonical-vectors.json).
enum Canonical {
    static func encode(_ v: JSON) -> String {
        var out = ""
        write(v, into: &out)
        return out
    }

    /// base64url(sha256(canonical(input))), the `<input hash>` line of a signed presence message.
    static func inputHash(_ v: JSON) -> String {
        Data(SHA256.hash(data: Data(encode(v).utf8))).base64URL
    }

    private static func write(_ v: JSON, into out: inout String) {
        switch v {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .number(let n): out += number(n)
        case .string(let s): string(s, into: &out)
        case .array(let a):
            out += "["
            for (i, x) in a.enumerated() {
                if i > 0 { out += "," }
                write(x, into: &out)
            }
            out += "]"
        case .object(let o):
            out += "{"
            let keys = o.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
            for (i, k) in keys.enumerated() {
                if i > 0 { out += "," }
                string(k, into: &out)
                out += ":"
                write(o[k]!, into: &out)
            }
            out += "}"
        }
    }

    /// JSON.stringify's string quoting.
    static func string(_ s: String, into out: inout String) {
        out += "\""
        for u in s.unicodeScalars {
            switch u.value {
            case 0x22: out += "\\\""
            case 0x5C: out += "\\\\"
            case 0x08: out += "\\b"
            case 0x09: out += "\\t"
            case 0x0A: out += "\\n"
            case 0x0C: out += "\\f"
            case 0x0D: out += "\\r"
            case 0..<0x20: out += String(format: "\\u%04x", u.value)
            default: out.unicodeScalars.append(u)
            }
        }
        out += "\""
    }

    /// ECMAScript Number::toString(10), which JSON.stringify uses; NaN and the infinities are "null".
    static func number(_ d: Double) -> String {
        guard d.isFinite else { return "null" }
        if d == 0 { return "0" }
        // Swift's description is the shortest digits that round-trip, the same digits JavaScript
        // picks; only the layout differs, so take the digits and the exponent and lay them out
        // as the spec says.
        var repr = "\(abs(d))"
        var exp = 0
        if let e = repr.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            exp = Int(repr[repr.index(after: e)...]) ?? 0
            repr = String(repr[..<e])
        }
        let parts = repr.split(separator: ".", omittingEmptySubsequences: false)
        let intPart = String(parts[0])
        let frac = parts.count > 1 ? String(parts[1]) : ""
        var digits = Array(intPart + frac)
        var point = intPart.count + exp
        while digits.first == "0" { digits.removeFirst(); point -= 1 }
        while digits.last == "0" { digits.removeLast() }
        if digits.isEmpty { return "0" }
        let k = digits.count
        let n = point
        let s = String(digits)
        let sign = d < 0 ? "-" : ""
        if k <= n && n <= 21 { return sign + s + String(repeating: "0", count: n - k) }
        if 0 < n && n <= 21 {
            let i = s.index(s.startIndex, offsetBy: n)
            return sign + s[..<i] + "." + s[i...]
        }
        if -6 < n && n <= 0 { return sign + "0." + String(repeating: "0", count: -n) + s }
        let e = n - 1
        let es = e < 0 ? "-\(-e)" : "+\(e)"
        if k == 1 { return sign + s + "e" + es }
        return sign + String(s.first!) + "." + s.dropFirst() + "e" + es
    }
}
