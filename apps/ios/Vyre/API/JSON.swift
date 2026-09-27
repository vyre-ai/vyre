import Foundation

/// Any JSON value. Tool inputs are built from it (so the canonical form and the hash are taken
/// over exactly what is sent), and tool outputs are read through it with the small accessors
/// below: vyred's shapes are wide and tolerant, so the app reads what it needs and ignores the rest.
enum JSON: Sendable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSON])
    case object([String: JSON])

    subscript(key: String) -> JSON {
        if case .object(let o) = self { return o[key] ?? .null }
        return .null
    }
    subscript(index: Int) -> JSON {
        if case .array(let a) = self, index >= 0, index < a.count { return a[index] }
        return .null
    }

    var string: String? { if case .string(let s) = self { return s }; return nil }
    var double: Double? { if case .number(let n) = self { return n }; return nil }
    var int: Int? { double.flatMap { $0.isFinite && abs($0) < 9.0e15 ? Int($0) : nil } }
    var bool: Bool? { if case .bool(let b) = self { return b }; return nil }
    var array: [JSON]? { if case .array(let a) = self { return a }; return nil }
    var object: [String: JSON]? { if case .object(let o) = self { return o }; return nil }
    var isNull: Bool { if case .null = self { return true }; return false }
    /// An array, or empty. For lists that may be absent.
    var list: [JSON] { array ?? [] }
    /// A string, or the empty string.
    var text: String { string ?? "" }
    /// `["a","b"]` or `"a"` as strings.
    var strings: [String] {
        if let s = string { return [s] }
        return list.compactMap(\.string)
    }
    /// Epoch ms as a Date.
    var date: Date? { double.map { Date(timeIntervalSince1970: $0 / 1000) } }

    /// This value with `key` set; a non-object becomes an object.
    func with(_ key: String, _ value: JSON?) -> JSON {
        var o = object ?? [:]
        o[key] = value
        return .object(o)
    }

    /// The canonical form, as vyred's core/presence canonical() writes it.
    var canonical: String { Canonical.encode(self) }
}

extension JSON: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral,
    ExpressibleByBooleanLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral, ExpressibleByNilLiteral {
    init(stringLiteral value: String) { self = .string(value) }
    init(integerLiteral value: Int) { self = .number(Double(value)) }
    init(floatLiteral value: Double) { self = .number(value) }
    init(booleanLiteral value: Bool) { self = .bool(value) }
    init(arrayLiteral elements: JSON...) { self = .array(elements) }
    init(dictionaryLiteral elements: (String, JSON)...) {
        var o: [String: JSON] = [:]
        for (k, v) in elements { o[k] = v }
        self = .object(o)
    }
    init(nilLiteral: ()) { self = .null }
}

extension JSON {
    init(_ s: String?) { self = s.map(JSON.string) ?? .null }
    init(_ n: Int) { self = .number(Double(n)) }
    init(_ strings: [String]) { self = .array(strings.map(JSON.string)) }
}

extension JSON: Codable {
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([JSON].self) { self = .array(a); return }
        if let o = try? c.decode([String: JSON].self) { self = .object(o); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "not JSON")
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    /// Parse bytes. Numbers come back as Double, as in JavaScript.
    static func parse(_ data: Data) throws -> JSON {
        try JSONDecoder().decode(JSON.self, from: data)
    }
}
