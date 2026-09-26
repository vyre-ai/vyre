// Colour: "#ff6347", "rgb(255 99 71)", "hsl(9, 100%, 64%)", "colour tomato" answered with the
// other forms and a swatch.
//
// Designers paste a colour in one notation and need it in another; the Capsule answers as they
// type, offline. The row carries every form as data (hex, rgb, hsl, the CSS name when it is
// exactly one) and the app decides which one ⌘C and the actions copy.
//
// A false positive is worse than a miss: hex needs its "#" ("cafe", "bad" and "add" are words and
// hex alike), and a CSS name needs the word "color" or "colour" beside it ("red", "tomato" and
// "chocolate" are more often files, notes or apps than colours).

import Foundation

public struct ColourAnswer: Sendable, Equatable {
    /// 0...255 channels and 0...1 alpha, as parsed.
    public var r: Double, g: Double, b: Double, a: Double
    public var hex: String
    public var rgb: String
    public var hsl: String
    /// The CSS name when the colour is exactly one, opaque.
    public var name: String?
    /// Which form the query was written in: "hex", "rgb", "hsl" or "name".
    public var input: String

    /// Every form, the input's own last, for the row and the ⌘K copy list.
    public var forms: [(kind: String, text: String)] {
        var all: [(String, String)] = [("hex", hex), ("rgb", rgb), ("hsl", hsl)]
        if let name { all.append(("name", name)) }
        let own = all.filter { $0.0 == input }
        return all.filter { $0.0 != input } + own
    }
}

public enum Colour {
    public static func evaluate(_ text: String) -> ColourAnswer? {
        let q = Query(text).normalized
        if q.isEmpty || q.count > 60 { return nil }
        if q.hasPrefix("#") { return hex(q) }
        if q.hasPrefix("rgb") { return rgbFunc(q) }
        if q.hasPrefix("hsl") { return hslFunc(q) }
        for p in ["color ", "colour "] where q.hasPrefix(p) { return named(String(q.dropFirst(p.count))) }
        for s in [" color", " colour"] where q.hasSuffix(s) { return named(String(q.dropLast(s.count))) }
        return nil
    }

    // -----------------------------------------------------------------------------------------
    // Parsing

    static func hex(_ q: String) -> ColourAnswer? {
        let h = Array(q.dropFirst())
        guard [3, 6, 8].contains(h.count), h.allSatisfy(\.isHexDigit) else { return nil }
        let full = h.count == 3 ? h.flatMap { [$0, $0] } : h
        func byte(_ i: Int) -> Double { Double(Int(String(full[i...i + 1]), radix: 16) ?? 0) }
        return make(byte(0), byte(2), byte(4), full.count == 8 ? byte(6) / 255 : 1, "hex")
    }

    /// The arguments of "fn(a, b, c)", "fn(a b c / d)" or "fn(a,b,c,d)", as strings.
    static func args(_ q: String, _ names: [String]) -> [String]? {
        guard let open = q.firstIndex(of: "("), q.last == ")" else { return nil }
        guard names.contains(q[..<open].trimmingCharacters(in: .whitespaces)) else { return nil }
        let inner = q[q.index(after: open)..<q.index(before: q.endIndex)]
        var parts: [String]
        if inner.contains(",") {
            parts = inner.split(separator: ",", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        } else {
            let halves = inner.split(separator: "/", omittingEmptySubsequences: false)
            guard halves.count <= 2 else { return nil }
            parts = halves[0].split(separator: " ").map(String.init)
            if halves.count == 2 { parts.append(halves[1].trimmingCharacters(in: .whitespaces)) }
        }
        guard parts.count == 3 || parts.count == 4, parts.allSatisfy({ !$0.isEmpty }) else { return nil }
        return parts
    }

    /// "50%" -> 0.5 of `scale`, "128" -> 128. Nil for anything else.
    static func number(_ s: String, percentOf scale: Double?, unit: String? = nil) -> Double? {
        var t = s
        if let unit, t.hasSuffix(unit) { t.removeLast(unit.count) }
        var pct = false
        if t.hasSuffix("%") { pct = true; t.removeLast() }
        let c = Array(t)
        var i = 0
        if i < c.count, c[i] == "-" { i += 1 }
        guard let end = Calc.scanNumber(c, i, exponent: false), end == c.count, !t.contains(","), let v = Double(t) else { return nil }
        if pct { guard let scale else { return nil }; return v / 100 * scale }
        return v
    }

    static func alpha(_ parts: [String]) -> Double? {
        guard parts.count == 4 else { return 1 }
        guard let a = number(parts[3], percentOf: 1), a >= 0, a <= 1 else { return nil }
        return a
    }

    static func rgbFunc(_ q: String) -> ColourAnswer? {
        guard let p = args(q, ["rgb", "rgba"]) else { return nil }
        let ch = p.prefix(3).map { number($0, percentOf: 255) }
        guard ch.allSatisfy({ $0 != nil && $0! >= 0 && $0! <= 255 }), let a = alpha(p) else { return nil }
        return make(ch[0]!.rounded(), ch[1]!.rounded(), ch[2]!.rounded(), a, "rgb")
    }

    static func hslFunc(_ q: String) -> ColourAnswer? {
        guard let p = args(q, ["hsl", "hsla"]) else { return nil }
        guard let h = number(p[0], percentOf: nil, unit: "deg"), let s = number(p[1], percentOf: 100), let l = number(p[2], percentOf: 100),
              p[1].hasSuffix("%") || p[1] == "0", p[2].hasSuffix("%") || p[2] == "0",
              s >= 0, s <= 100, l >= 0, l <= 100, let a = alpha(p) else { return nil }
        let (r, g, b) = hslToRGB(h, s / 100, l / 100)
        return make(r, g, b, a, "hsl")
    }

    static func named(_ n: String) -> ColourAnswer? {
        let k = n.replacingOccurrences(of: " ", with: "")
        guard let hex = names[k] else { return nil }
        var c = Colour.hex("#" + hex)
        c?.input = "name"
        return c
    }

    // -----------------------------------------------------------------------------------------
    // Forms

    static func make(_ r: Double, _ g: Double, _ b: Double, _ a: Double, _ input: String) -> ColourAnswer {
        let ri = Int(r), gi = Int(g), bi = Int(b)
        var hex = String(format: "#%02X%02X%02X", ri, gi, bi)
        let (h, s, l) = rgbToHSL(r, g, b)
        let aText = Calc.format(a, 3, false) ?? "1"
        let opaque = a >= 1
        if !opaque { hex += String(format: "%02X", Int((a * 255).rounded())) }
        let rgb = opaque ? "rgb(\(ri), \(gi), \(bi))" : "rgba(\(ri), \(gi), \(bi), \(aText))"
        let hsl = opaque ? "hsl(\(h), \(s)%, \(l)%)" : "hsla(\(h), \(s)%, \(l)%, \(aText))"
        let name = opaque ? byHex[String(hex.dropFirst()).lowercased()] : nil
        return ColourAnswer(r: r, g: g, b: b, a: a, hex: hex, rgb: rgb, hsl: hsl, name: name, input: input)
    }

    /// Whole degrees and percents, the way people write them.
    static func rgbToHSL(_ r: Double, _ g: Double, _ b: Double) -> (Int, Int, Int) {
        let r = r / 255, g = g / 255, b = b / 255
        let mx = max(r, g, b), mn = min(r, g, b), l = (mx + mn) / 2
        var h = 0.0, s = 0.0
        let d = mx - mn
        if d > 0 {
            s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
            if mx == r { h = (g - b) / d + (g < b ? 6 : 0) }
            else if mx == g { h = (b - r) / d + 2 }
            else { h = (r - g) / d + 4 }
            h *= 60
        }
        return (Int(h.rounded()) % 360, Int((s * 100).rounded()), Int((l * 100).rounded()))
    }

    static func hslToRGB(_ h: Double, _ s: Double, _ l: Double) -> (Double, Double, Double) {
        let hh = (h.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) / 360
        if s == 0 { let v = (l * 255).rounded(); return (v, v, v) }
        let q = l < 0.5 ? l * (1 + s) : l + s - l * s
        let p = 2 * l - q
        func f(_ t0: Double) -> Double {
            var t = t0
            if t < 0 { t += 1 }
            if t > 1 { t -= 1 }
            if t < 1.0 / 6 { return p + (q - p) * 6 * t }
            if t < 0.5 { return q }
            if t < 2.0 / 3 { return p + (q - p) * (2.0 / 3 - t) * 6 }
            return p
        }
        return ((f(hh + 1.0 / 3) * 255).rounded(), (f(hh) * 255).rounded(), (f(hh - 1.0 / 3) * 255).rounded())
    }

    /// The 148 CSS named colours (CSS Color 4), name to hex.
    static let names: [String: String] = {
        let table = """
        aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 black 000000
        blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00
        chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b
        darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b
        darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon e9967a darkseagreen 8fbc8f
        darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493
        deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 forestgreen 228b22
        fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f
        grey 808080 honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa
        lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff
        lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a
        lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0
        lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd
        mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a
        mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5
        navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6
        palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9
        peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f
        royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna a0522d
        silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa springgreen 00ff7f
        steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3
        white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32
        """
        let w = table.split(whereSeparator: \.isWhitespace).map(String.init)
        var m: [String: String] = [:]
        for i in stride(from: 0, to: w.count - 1, by: 2) { m[w[i]] = w[i + 1] }
        return m
    }()

    /// Hex to the name to show. Where CSS has two names for one colour, the first alphabetically
    /// wins (aqua, fuchsia, gray), so the answer is the same on every run.
    static let byHex: [String: String] = {
        var m: [String: String] = [:]
        for (n, h) in names.sorted(by: { $0.key < $1.key }) where m[h] == nil { m[h] = n }
        return m
    }()
}

/// A colour row with a swatch. Enter copies the title form; every form is in the payload.
public func colourResult(_ q: Query) -> ResultItem? {
    guard let c = Colour.evaluate(q.text) else { return nil }
    let f = c.forms
    var payload = ["hex": c.hex, "rgb": c.rgb, "hsl": c.hsl, "input": c.input]
    if let n = c.name { payload["name"] = n }
    return ResultItem(id: "colour:\(c.hex)", kind: "colour", title: f[0].text,
                      subtitle: f.dropFirst().map(\.text).joined(separator: " · "),
                      icon: .swatch(r: c.r / 255, g: c.g / 255, b: c.b / 255), section: .answer, score: 1,
                      copyText: f[0].text, payload: payload)
}
