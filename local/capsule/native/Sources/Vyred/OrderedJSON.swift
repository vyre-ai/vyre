// OrderedJSON: JSON that keeps the order of an object's keys.
//
// A module's `shows.capsule` is an object whose key order is the order its actions are listed
// in, and Enter runs the first (lib/providers.js). JSONSerialization hands back an NSDictionary,
// which forgets that order, so the one listing where order means something (GET /v1/modules) is
// read with this small parser instead.

import Foundation

public indirect enum OJ: Sendable {
    case object([(String, OJ)])
    case array([OJ])
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    public subscript(key: String) -> OJ? {
        if case .object(let kv) = self { return kv.first { $0.0 == key }?.1 }
        return nil
    }

    public var string: String? { if case .string(let s) = self { return s }; return nil }
    public var array: [OJ]? { if case .array(let a) = self { return a }; return nil }
    public var pairs: [(String, OJ)]? { if case .object(let kv) = self { return kv }; return nil }
    public var isObject: Bool { if case .object = self { return true }; return false }

    /// As Foundation values, for passing on as a tool's input.
    public var any: Any {
        switch self {
        case .object(let kv): var d: [String: Any] = [:]; for (k, v) in kv { d[k] = v.any }; return d
        case .array(let a): return a.map(\.any)
        case .string(let s): return s
        case .number(let n): return n == n.rounded() && abs(n) < 1e15 ? Int(n) as Any : n as Any
        case .bool(let b): return b
        case .null: return NSNull()
        }
    }

    /// From Foundation values. Key order is whatever the dictionary gives: use parse() when it matters.
    public init(any v: Any?) {
        if let d = v as? [String: Any] { self = .object(d.map { ($0.key, OJ(any: $0.value)) }) }
        else if let a = v as? [Any] { self = .array(a.map { OJ(any: $0) }) }
        else if let s = v as? String { self = .string(s) }
        else if let b = VJ.bool(v) { self = .bool(b) }
        else if let n = VJ.num(v) { self = .number(n) }
        else { self = .null }
    }

    public static func parse(_ data: Data) -> OJ? {
        var p = Parser(bytes: [UInt8](data))
        p.ws()
        guard let v = p.value() else { return nil }
        p.ws()
        return p.i == p.bytes.count ? v : nil
    }

    private struct Parser {
        let bytes: [UInt8]
        var i = 0
        var depth = 0

        mutating func ws() { while i < bytes.count, [0x20, 0x09, 0x0A, 0x0D].contains(bytes[i]) { i += 1 } }

        mutating func value() -> OJ? {
            guard i < bytes.count, depth < 256 else { return nil }
            switch bytes[i] {
            case UInt8(ascii: "{"): return object()
            case UInt8(ascii: "["): return array()
            case UInt8(ascii: "\""): return string().map(OJ.string)
            case UInt8(ascii: "t"): return word("true", .bool(true))
            case UInt8(ascii: "f"): return word("false", .bool(false))
            case UInt8(ascii: "n"): return word("null", .null)
            default: return number()
            }
        }

        mutating func word(_ w: String, _ v: OJ) -> OJ? {
            let u = Array(w.utf8)
            guard i + u.count <= bytes.count, Array(bytes[i..<i + u.count]) == u else { return nil }
            i += u.count
            return v
        }

        mutating func number() -> OJ? {
            let start = i
            while i < bytes.count, "+-0123456789.eE".utf8.contains(bytes[i]) { i += 1 }
            guard i > start, let d = Double(String(decoding: bytes[start..<i], as: UTF8.self)) else { return nil }
            return .number(d)
        }

        mutating func string() -> String? {
            i += 1
            var out = [UInt8]()
            while i < bytes.count {
                let c = bytes[i]
                if c == UInt8(ascii: "\"") { i += 1; return String(decoding: out, as: UTF8.self) }
                if c == UInt8(ascii: "\\") {
                    i += 1
                    guard i < bytes.count else { return nil }
                    let e = bytes[i]
                    switch e {
                    case UInt8(ascii: "n"): out.append(0x0A)
                    case UInt8(ascii: "t"): out.append(0x09)
                    case UInt8(ascii: "r"): out.append(0x0D)
                    case UInt8(ascii: "b"): out.append(0x08)
                    case UInt8(ascii: "f"): out.append(0x0C)
                    case UInt8(ascii: "u"):
                        guard var scalar = hex4() else { return nil }
                        // A surrogate pair is one character.
                        if (0xD800...0xDBFF).contains(scalar), i + 2 < bytes.count, bytes[i + 1] == UInt8(ascii: "\\"), bytes[i + 2] == UInt8(ascii: "u") {
                            i += 2
                            guard let low = hex4() else { return nil }
                            scalar = 0x10000 + ((scalar - 0xD800) << 10) + (low - 0xDC00)
                        }
                        out.append(contentsOf: Array(String(Character(Unicode.Scalar(scalar) ?? "?")).utf8))
                    default: out.append(e)
                    }
                    i += 1
                    continue
                }
                out.append(c); i += 1
            }
            return nil
        }

        /// Four hex digits after `\u`; leaves i on the last one.
        mutating func hex4() -> UInt32? {
            guard i + 4 < bytes.count, let v = UInt32(String(decoding: bytes[(i + 1)...(i + 4)], as: UTF8.self), radix: 16) else { return nil }
            i += 4
            return v
        }

        mutating func object() -> OJ? {
            i += 1; depth += 1; defer { depth -= 1 }
            var kv: [(String, OJ)] = []
            ws()
            if i < bytes.count, bytes[i] == UInt8(ascii: "}") { i += 1; return .object(kv) }
            while true {
                ws()
                guard i < bytes.count, bytes[i] == UInt8(ascii: "\""), let k = string() else { return nil }
                ws()
                guard i < bytes.count, bytes[i] == UInt8(ascii: ":") else { return nil }
                i += 1; ws()
                guard let v = value() else { return nil }
                kv.append((k, v))
                ws()
                guard i < bytes.count else { return nil }
                if bytes[i] == UInt8(ascii: ",") { i += 1; continue }
                if bytes[i] == UInt8(ascii: "}") { i += 1; return .object(kv) }
                return nil
            }
        }

        mutating func array() -> OJ? {
            i += 1; depth += 1; defer { depth -= 1 }
            var a: [OJ] = []
            ws()
            if i < bytes.count, bytes[i] == UInt8(ascii: "]") { i += 1; return .array(a) }
            while true {
                ws()
                guard let v = value() else { return nil }
                a.append(v)
                ws()
                guard i < bytes.count else { return nil }
                if bytes[i] == UInt8(ascii: ",") { i += 1; continue }
                if bytes[i] == UInt8(ascii: "]") { i += 1; return .array(a) }
                return nil
            }
        }
    }
}
