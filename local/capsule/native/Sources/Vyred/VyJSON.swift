// VyJSON: reading vyred's JSON the way the JS did, without a Codable type for every tool.
//
// vyred's tools answer loosely shaped JSON ({data} holding arrays, objects or both, fields that
// may be a string or a number), and the JS read it with `x || ""` and `String(x)`. Codable would
// turn every missing or oddly typed field into a thrown error and an empty screen, which is the
// opposite of what the Capsule wants: show what is there. So these read an `Any` from
// JSONSerialization and give back what the JS would have.

import Foundation

enum VJ {
    /// A JSON boolean. NSNumber carries both numbers and booleans, so this checks the real type:
    /// `1 as? Bool` would say true.
    static func isBool(_ v: Any?) -> Bool {
        guard let n = v as? NSNumber else { return false }
        return CFGetTypeID(n) == CFBooleanGetTypeID()
    }

    static func bool(_ v: Any?) -> Bool? { isBool(v) ? (v as! NSNumber).boolValue : nil }

    static func num(_ v: Any?) -> Double? {
        if isBool(v) { return nil }
        if let n = v as? NSNumber { return n.doubleValue }
        if let d = v as? Double { return d }
        if let i = v as? Int { return Double(i) }
        return nil
    }

    static func int(_ v: Any?) -> Int? { num(v).flatMap { $0.isFinite ? Int($0) : nil } }

    /// A string, or a number written as JS writes it ("7", "0.5"); nil for null, missing or other.
    static func str(_ v: Any?) -> String? {
        if let s = v as? String { return s }
        if let b = bool(v) { return b ? "true" : "false" }
        if let d = num(v) { return d == d.rounded() && abs(d) < 1e15 ? String(Int(d)) : String(d) }
        return nil
    }

    /// The JS `s()`: "" for null or missing, else the value as a string.
    static func s(_ v: Any?) -> String { str(v) ?? "" }

    /// A non-empty string, or nil: what `x || null` read in the JS.
    static func nonEmpty(_ v: Any?) -> String? { str(v).flatMap { $0.isEmpty ? nil : $0 } }

    static func obj(_ v: Any?) -> [String: Any]? { v as? [String: Any] }
    static func arr(_ v: Any?) -> [Any]? { v as? [Any] }

    /// JS truthiness, for the few places the JS branched on it.
    static func truthy(_ v: Any?) -> Bool {
        guard let v, !(v is NSNull) else { return false }
        if let b = bool(v) { return b }
        if let d = num(v) { return d != 0 && !d.isNaN }
        if let s = v as? String { return !s.isEmpty }
        return true
    }

    /// Rows from `data`, whether it is the array itself or an object holding it under `key`.
    static func rows(_ data: Any?, _ key: String) -> [[String: Any]] {
        if let a = data as? [Any] { return a.compactMap { $0 as? [String: Any] } }
        if let o = data as? [String: Any], let a = o[key] as? [Any] { return a.compactMap { $0 as? [String: Any] } }
        return []
    }

    static func encode(_ v: Any) -> Data? {
        guard JSONSerialization.isValidJSONObject(v) else { return nil }
        return try? JSONSerialization.data(withJSONObject: v, options: [])
    }

    static func decode(_ d: Data) -> Any? { try? JSONSerialization.jsonObject(with: d, options: [.fragmentsAllowed]) }
}

/// Milliseconds since 1970, the unit every vyred timestamp is in.
public func vyNowMs() -> Double { (Date().timeIntervalSince1970 * 1000).rounded() }
