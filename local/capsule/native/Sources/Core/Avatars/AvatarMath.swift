// AvatarMath: the JavaScript arithmetic the Deck's avatar renderers lean on, reproduced exactly so
// the Capsule's SVG is the Deck's byte for byte (deck/js/avatars.js and deck/vendor/vyrecode, ADR
// 0043). Three things differ between Swift and JS by default, and each is pinned here:
//
//   numbers   JS prints a double as its shortest round-trip digits with its own layout rules
//             ("60", not "60.0"; "1e-7", not "1e-07"); JSNumber.string does the same
//   rounding  Math.round sends a half up, toward +infinity; JSNumber.round does the same
//   trig      V8's Math.cos and Math.sin are not Darwin's libm: on 3 of the 55 angles the avatars
//             use they differ in the last bit, which the shortest-digits printing then shows.
//             The angles come only from small integer indices (a creature's 8 points, a blob's
//             10, the code ring's 36 slots, the marker at 12 o'clock), so V8's own results are
//             kept below as bit patterns rather than recomputed
//
// Hashes are FNV-1a over UTF-16 code units, since JS's charCodeAt reads those, with Math.imul's
// 32-bit wrap.

import Foundation

enum JSNumber {
    /// Number.prototype.toString() for a double.
    static func string(_ x: Double) -> String {
        if x.isNaN { return "NaN" }
        if x == 0 { return "0" }
        if x < 0 { return "-" + string(-x) }
        if x.isInfinite { return "Infinity" }
        // Swift's description is the shortest round-trip digits too; only the layout differs.
        let text = x.description
        let parts = text.split(separator: "e", maxSplits: 1)
        let mantissa = parts[0]
        let exp = parts.count > 1 ? Int(parts[1])! : 0
        var digits = Array(mantissa.replacingOccurrences(of: ".", with: ""))
        var point = (mantissa.firstIndex(of: ".").map { mantissa.distance(from: mantissa.startIndex, to: $0) } ?? mantissa.count) + exp
        while digits.first == "0" { digits.removeFirst(); point -= 1 }
        while digits.last == "0" { digits.removeLast() }
        let s = String(digits), k = digits.count, n = point
        if k <= n && n <= 21 { return s + String(repeating: "0", count: n - k) }
        if 0 < n && n <= 21 { return String(digits[..<n]) + "." + String(digits[n...]) }
        if -6 < n && n <= 0 { return "0." + String(repeating: "0", count: -n) + s }
        let e = n - 1
        let tail = (e < 0 ? "e-" : "e+") + String(abs(e))
        return k == 1 ? s + tail : String(digits[0]) + "." + String(digits[1...]) + tail
    }

    /// Math.round: to the nearest integer, a half toward +infinity.
    static func round(_ x: Double) -> Double {
        let f = x.rounded(.down)
        return x - f >= 0.5 ? f + 1 : f
    }
}

enum AvatarHash {
    static let fnvBasis: UInt32 = 2166136261
    static let fnvPrime: UInt32 = 16777619

    /// FNV-1a over the string's UTF-16 code units from `basis`, as avatars.js's fnv.
    static func fnv(_ s: String, basis: UInt32 = fnvBasis) -> UInt32 {
        var h = basis
        for u in s.utf16 { h ^= UInt32(u); h = h &* fnvPrime }
        return h
    }
}

/// The renderers' seeded stream (hashSeed in identity.js, creature.js and characters.js): FNV-1a
/// of the seed, then xorshift32, each draw in [0, 1).
struct AvatarRandom {
    private var h: UInt32
    init(_ seed: String) { h = AvatarHash.fnv(seed) }
    mutating func next() -> Double {
        h ^= h << 13; h ^= h >> 17; h ^= h << 5
        return Double(h) / 4294967296
    }
    mutating func pick<T>(_ list: [T]) -> T { list[Int((next() * Double(list.count)).rounded(.down))] }
    mutating func chance(_ p: Double) -> Bool { next() < p }
}

/// V8's Math.cos and Math.sin for every angle the renderers use, as (cos, sin) bit patterns.
/// Written by the Capsule's avatar vector script from node; see the note at the top of the file.
enum AvatarTrig {
    static func at(_ bits: (UInt64, UInt64)) -> (cos: Double, sin: Double) {
        (Double(bitPattern: bits.0), Double(bitPattern: bits.1))
    }
    /// (i / 8) * Math.PI * 2, i in 0..<8.
    static let creature: [(UInt64, UInt64)] = [
        (0x3ff0000000000000, 0x0000000000000000),
        (0x3fe6a09e667f3bcd, 0x3fe6a09e667f3bcc),
        (0x3c91a62633145c07, 0x3ff0000000000000),
        (0xbfe6a09e667f3bcc, 0x3fe6a09e667f3bcd),
        (0xbff0000000000000, 0x3ca1a62633145c07),
        (0xbfe6a09e667f3bce, 0xbfe6a09e667f3bcc),
        (0xbcaa79394c9e8a0a, 0xbff0000000000000),
        (0x3fe6a09e667f3bcb, 0xbfe6a09e667f3bce),
    ]
    /// (i / 10) * Math.PI * 2, i in 0..<10.
    static let blob: [(UInt64, UInt64)] = [
        (0x3ff0000000000000, 0x0000000000000000),
        (0x3fe9e3779b97f4a8, 0x3fe2cf2304755a5e),
        (0x3fd3c6ef372fe950, 0x3fee6f0e134454ff),
        (0xbfd3c6ef372fe94e, 0x3fee6f0e13445500),
        (0xbfe9e3779b97f4a7, 0x3fe2cf2304755a5f),
        (0xbff0000000000000, 0x3ca1a62633145c07),
        (0xbfe9e3779b97f4a8, 0xbfe2cf2304755a5d),
        (0xbfd3c6ef372fe952, 0xbfee6f0e134454ff),
        (0x3fd3c6ef372fe94c, 0xbfee6f0e13445500),
        (0x3fe9e3779b97f4a7, 0xbfe2cf2304755a60),
    ]
    /// (slot * 10 - 90) * Math.PI / 180, the code ring's 36 slots.
    static let ring: [(UInt64, UInt64)] = [
        (0x3c91a62633145c07, 0xbff0000000000000),
        (0x3fc63a1a7e0b738c, 0xbfef838b8c811c17),
        (0x3fd5e3a8748a0bf7, 0xbfee11f642522d1b),
        (0x3fe0000000000001, 0xbfebb67ae8584caa),
        (0x3fe491b7523c161d, 0xbfe8836fa2cf5039),
        (0x3fe8836fa2cf5039, 0xbfe491b7523c161c),
        (0x3febb67ae8584cab, 0xbfdfffffffffffff),
        (0x3fee11f642522d1c, 0xbfd5e3a8748a0bf5),
        (0x3fef838b8c811c17, 0xbfc63a1a7e0b7389),
        (0x3ff0000000000000, 0x0000000000000000),
        (0x3fef838b8c811c17, 0x3fc63a1a7e0b7389),
        (0x3fee11f642522d1c, 0x3fd5e3a8748a0bf5),
        (0x3febb67ae8584cab, 0x3fdfffffffffffff),
        (0x3fe8836fa2cf5039, 0x3fe491b7523c161c),
        (0x3fe491b7523c161d, 0x3fe8836fa2cf5039),
        (0x3fe0000000000001, 0x3febb67ae8584caa),
        (0x3fd5e3a8748a0bf7, 0x3fee11f642522d1b),
        (0x3fc63a1a7e0b738c, 0x3fef838b8c811c17),
        (0x3c91a62633145c07, 0x3ff0000000000000),
        (0xbfc63a1a7e0b7388, 0x3fef838b8c811c17),
        (0xbfd5e3a8748a0bf5, 0x3fee11f642522d1c),
        (0xbfdffffffffffffc, 0x3febb67ae8584cab),
        (0xbfe491b7523c161d, 0x3fe8836fa2cf5039),
        (0xbfe8836fa2cf5038, 0x3fe491b7523c161e),
        (0xbfebb67ae8584cab, 0x3fdfffffffffffff),
        (0xbfee11f642522d1b, 0x3fd5e3a8748a0bf8),
        (0xbfef838b8c811c17, 0x3fc63a1a7e0b7387),
        (0xbff0000000000000, 0x3ca1a62633145c07),
        (0xbfef838b8c811c17, 0xbfc63a1a7e0b738e),
        (0xbfee11f642522d1c, 0xbfd5e3a8748a0bf4),
        (0xbfebb67ae8584caa, 0xbfe0000000000001),
        (0xbfe8836fa2cf503a, 0xbfe491b7523c161c),
        (0xbfe491b7523c161e, 0xbfe8836fa2cf5038),
        (0xbfe0000000000004, 0xbfebb67ae8584ca9),
        (0xbfd5e3a8748a0c01, 0xbfee11f642522d1a),
        (0xbfc63a1a7e0b7389, 0xbfef838b8c811c17),
    ]
    /// -Math.PI / 2, the orientation marker.
    static let marker: (UInt64, UInt64) = (0x3c91a62633145c07, 0xbff0000000000000)
}

/// Colour arithmetic the palettes use: hex parsing, identity.js's WCAG contrast, and
/// vyrecode2.js's hexMix (lowercase hex out, as JS's toString(16) gives).
enum AvatarColour {
    static func rgb(_ hex: String) -> [Double] {
        let v = Int(hex.dropFirst(), radix: 16) ?? 0
        return [Double((v >> 16) & 255), Double((v >> 8) & 255), Double(v & 255)]
    }
    static func luminance(_ hex: String) -> Double {
        let c = rgb(hex).map { v -> Double in
            let c = v / 255
            return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    }
    static func contrast(_ a: String, _ b: String) -> Double {
        let l1 = luminance(a), l2 = luminance(b)
        return (max(l1, l2) + 0.05) / (min(l1, l2) + 0.05)
    }
    /// a mixed toward b by t.
    static func mix(_ a: String, _ b: String, _ t: Double) -> String {
        let pa = rgb(a), pb = rgb(b)
        return "#" + (0..<3).map { i in
            let v = Int(JSNumber.round(pa[i] * (1 - t) + pb[i] * t))
            let h = String(v, radix: 16)
            return h.count < 2 ? "0" + h : h
        }.joined()
    }
}
