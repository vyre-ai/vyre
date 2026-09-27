// Calc: the Capsule answers "12 * 3.5" and "5 km in miles" itself, offline, as you type.
// A port of local/capsule/lib/calc.js; calc.test.js is ported case for case in Tests/CalcTests.swift.
//
// It runs on every keystroke, so it is pure, small and has no dependencies. There is no eval and
// no NSExpression: a recursive-descent parser reads a closed grammar, so nothing typed into the bar
// can run as code. The one rule that shapes everything else: a false positive is worse than a
// miss. nil lets the query fall through to apps, files and the assistant, so anything that is
// not clearly math or a conversion (a word, a lone number, a version, a date, a phone number)
// returns nil.
//
// Percent: `x%` is x/100, except as the right operand of + or -, where it is a share of the left
// side, the way Spotlight reads it: "200 + 10%" is 220, "50 - 20%" is 40. "15% of 80" is 12.
// `mod` is the JS remainder (sign follows the left side).
// Trig takes radians. `log` is base 10, `ln` is natural.
// Conversions need a target: "5 km in mi". A bare "5 km" returns nil, because "5 m" could as
// easily be the start of a file name. Currency lives in Currency.swift, with injected rates.
// Labels on conversions round to 4 significant digits (never dropping whole units); `copy`
// always carries 10.
//
// The number formatting reproduces JavaScript's (toPrecision, String(n), toExponential) so the
// labels read the same as the Electron Capsule's. The hot path scans characters by hand; the
// few regular expressions (dates, phone numbers, unit spellings) are compiled once.

import Foundation

public struct CalcAnswer: Sendable, Equatable {
    /// "calc:<normalized expression>", stable across spacing.
    public var id: String
    public var label: String
    public var sub: String
    public var value: Double
    public var copy: String
}

public enum Calc {
    static let maxInput = 200

    /// What the Capsule should show for this text, if it is math or a conversion.
    public static func evaluate(_ text: String) -> CalcAnswer? {
        if text.utf16.count > maxInput { return nil }
        var s = text.lowercased()
        for (a, b) in [("×", "*"), ("✕", "*"), ("÷", "/"), ("\u{2212}", "-"), ("\u{2013}", "-"), ("**", "^"), ("π", "pi")] where s.contains(a) {
            s = s.replacingOccurrences(of: a, with: b)
        }
        s = s.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        if s.hasSuffix("=") { s.removeLast(); while s.last == " " { s.removeLast() } }
        if s.isEmpty { return nil }
        if !(s.contains(where: \.isASCIIDigit) || s.contains("pi") || CalcRx.loneE.matches(s)) { return nil }
        if s.contains(where: { $0 >= "a" && $0 <= "z" }),
           s.contains("=") || s.contains(" in ") || s.contains(" to ") || s.contains(" as ") || s.contains(" into ") {
            if let c = conversion(s) { return c }
        }
        return arithmetic(s)
    }

    // -----------------------------------------------------------------------------------------
    // Formatting

    static func group(_ int: String) -> String {
        let cs = Array(int)
        var out = ""
        for (i, c) in cs.enumerated() {
            if i > 0, (cs.count - i) % 3 == 0 { out.append(",") }
            out.append(c)
        }
        return out
    }

    /// JavaScript's String(n) for 1e-6 <= |n| < 1e15: the shortest round-trip digits, positional.
    static func plain(_ n: Double) -> String {
        let d = "\(abs(n))"
        let parts = d.split(separator: "e", maxSplits: 1)
        let exp = parts.count > 1 ? Int(parts[1]) ?? 0 : 0
        let mant = parts[0].split(separator: ".", maxSplits: 1)
        let intPart = String(mant[0])
        let frac = mant.count > 1 && mant[1] != "0" ? String(mant[1]) : ""
        let digits = intPart + frac
        let point = intPart.count + exp
        var whole: String, fraction: String
        if point <= 0 { whole = "0"; fraction = String(repeating: "0", count: -point) + digits }
        else if point >= digits.count { whole = digits + String(repeating: "0", count: point - digits.count); fraction = "" }
        else { whole = String(digits.prefix(point)); fraction = String(digits.dropFirst(point)) }
        while whole.count > 1, whole.first == "0" { whole.removeFirst() }
        while fraction.last == "0" { fraction.removeLast() }
        return (n < 0 ? "-" : "") + whole + (fraction.isEmpty ? "" : "." + fraction)
    }

    /// A number as a person reads it. Nil for anything not finite.
    static func format(_ x: Double, _ sig: Int, _ grouped: Bool) -> String? {
        if !x.isFinite { return nil }
        guard let n = Double(String(format: "%.*g", sig, x)) else { return nil }
        if n == 0 { return "0" }
        let a = abs(n)
        if a >= 1e15 || a < 1e-6 {
            let e = String(format: "%.*e", sig - 1, n).split(separator: "e", maxSplits: 1)
            var m = String(e[0])
            if m.contains(".") { while m.last == "0" { m.removeLast() }; if m.last == "." { m.removeLast() } }
            return "\(m)e\(Int(e[1]) ?? 0)"
        }
        let s = plain(n)
        let neg = s.hasPrefix("-")
        let body = neg ? String(s.dropFirst()) : s
        let p = body.split(separator: ".", maxSplits: 1)
        let int = String(p[0])
        return (neg ? "-" : "") + (grouped ? group(int) : int) + (p.count > 1 ? "." + p[1] : "")
    }

    /// Significant digits for a conversion label: 4, but never fewer than the whole units.
    static func labelSig(_ x: Double) -> Int {
        let a = abs(x)
        if a < 1000 { return 4 }
        return min(15, Int(floor(log10(a))) + 1)
    }

    // -----------------------------------------------------------------------------------------
    // Arithmetic

    enum Tok: Equatable { case num(Double, String), id(String), op(Character) }

    /// sin(pi) is 1.2e-16 in floating point; a person expects 0. Only trig results are snapped.
    static func snap(_ x: Double) -> Double { abs(x) < 1e-12 ? 0 : x }

    /// JavaScript's Math.round: halves go up, toward +infinity (round(-2.5) is -2).
    static func jsRound(_ x: Double) -> Double { let f = x.rounded(.down); return x - f >= 0.5 ? f + 1 : f }

    static let funcs: [String: (Double) -> Double] = [
        "sqrt": { $0.squareRoot() }, "sin": { snap(sin($0)) }, "cos": { snap(cos($0)) }, "tan": { snap(tan($0)) },
        "log": { log10($0) }, "ln": { log($0) },
        "abs": { abs($0) }, "round": jsRound, "floor": { floor($0) }, "ceil": { ceil($0) },
    ]
    static let consts: [String: Double] = ["pi": Double.pi, "e": M_E]
    static let wordOps: Set<String> = ["mod", "of", "x"]

    /// The NUM grammar of calc.js, scanned by hand:
    /// (?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?
    /// Returns the end index, or nil when no number starts at `i`.
    static func scanNumber(_ c: [Character], _ i: Int, exponent: Bool = true) -> Int? {
        func digit(_ k: Int) -> Bool { k < c.count && c[k].isASCIIDigit }
        var j = i
        if digit(j) {
            var k = j
            while digit(k) { k += 1 }
            let run = k - j
            if run <= 3, k < c.count, c[k] == ",", digit(k + 1), digit(k + 2), digit(k + 3) {
                // thousands form: take as many ",ddd" groups as follow
                while k < c.count, c[k] == ",", digit(k + 1), digit(k + 2), digit(k + 3) { k += 4 }
            }
            j = k
            if j < c.count, c[j] == ".", digit(j + 1) { j += 1; while digit(j) { j += 1 } }
        } else if j < c.count, c[j] == ".", digit(j + 1) {
            j += 1; while digit(j) { j += 1 }
        } else { return nil }
        if exponent, j < c.count, c[j] == "e" {
            var k = j + 1
            if k < c.count, c[k] == "+" || c[k] == "-" { k += 1 }
            if digit(k) { while digit(k) { k += 1 }; j = k }
        }
        return j
    }

    static func tokenize(_ s: String) -> [Tok]? {
        let c = Array(s)
        var out: [Tok] = []
        var i = 0
        while i < c.count {
            let ch = c[i]
            if ch == " " { i += 1; continue }
            if ch.isASCIIDigit || ch == "." {
                guard let j = scanNumber(c, i) else { return nil }
                let raw = String(c[i..<j])
                guard let v = Double(raw.replacingOccurrences(of: ",", with: "")) else { return nil }
                out.append(.num(v, raw)); i = j; continue
            }
            if ch >= "a" && ch <= "z" {
                var j = i
                while j < c.count, c[j] >= "a" && c[j] <= "z" { j += 1 }
                let w = String(c[i..<j])
                if funcs[w] == nil && consts[w] == nil && !wordOps.contains(w) { return nil }
                out.append(.id(w)); i = j; continue
            }
            if "+-*/^()%".contains(ch) { out.append(.op(ch)); i += 1; continue }
            return nil
        }
        return out
    }

    private struct Fail: Error {}
    private struct Val { var v: Double; var pct: Bool }

    /// Recursive descent over the tokens. Each rule returns a value and whether it is a bare
    /// `n%`, so + and - can read it as a share of the left side.
    private struct Parser {
        let toks: [Tok]
        var p = 0
        var ops = 0

        func isOp(_ v: String) -> Bool {
            guard p < toks.count else { return false }
            switch toks[p] {
            case .op(let c): return String(c) == v
            case .id(let w): return w == v
            case .num: return false
            }
        }
        func ok(_ v: Double) throws -> Double { if !v.isFinite { throw Fail() }; return v }

        mutating func expr() throws -> Val {
            var left = try term()
            while isOp("+") || isOp("-") {
                let plus = isOp("+"); p += 1
                let right = try term()
                ops += 1
                let r = right.pct && !left.pct ? left.v * right.v : right.v
                left = Val(v: try ok(plus ? left.v + r : left.v - r), pct: false)
            }
            return left
        }

        mutating func term() throws -> Val {
            var left = try unary()
            while true {
                if isOp("*") || isOp("x") { p += 1; ops += 1; left = Val(v: try ok(left.v * (try unary()).v), pct: false) }
                else if isOp("/") {
                    p += 1; ops += 1
                    let d = try unary().v
                    if d == 0 { throw Fail() }
                    left = Val(v: try ok(left.v / d), pct: false)
                } else if isOp("mod") {
                    p += 1; ops += 1
                    let d = try unary().v
                    if d == 0 { throw Fail() }
                    left = Val(v: try ok(left.v.truncatingRemainder(dividingBy: d)), pct: false)
                } else if isOp("of") {
                    if !left.pct { throw Fail() }
                    p += 1; ops += 1
                    left = Val(v: try ok(left.v * (try unary()).v), pct: false)
                } else { return left }
            }
        }

        mutating func unary() throws -> Val {
            if isOp("-") { p += 1; let u = try unary(); return Val(v: -u.v, pct: u.pct) }
            return try power()
        }

        mutating func power() throws -> Val {
            let base = try postfix()
            if isOp("^") {
                p += 1; ops += 1
                return Val(v: try ok(pow(base.v, (try unary()).v)), pct: false)
            }
            return base
        }

        mutating func postfix() throws -> Val {
            let v = try primary()
            if isOp("%") { p += 1; return Val(v: v / 100, pct: true) }
            return Val(v: v, pct: false)
        }

        mutating func primary() throws -> Double {
            guard p < toks.count else { throw Fail() }
            let t = toks[p]
            if case .num(let v, _) = t { p += 1; return v }
            if case .id(let w) = t, let k = Calc.consts[w] { p += 1; return k }
            if case .id(let w) = t, let f = Calc.funcs[w] {
                p += 1; ops += 1
                let arg = isOp("(") ? try primary() : try power().v
                return try ok(f(arg))
            }
            if isOp("(") {
                p += 1
                let v = try expr().v
                if !isOp(")") { throw Fail() }
                p += 1
                return v
            }
            throw Fail()
        }
    }

    /// How the expression was read, for the sub line: "12 × 3.5", "-(2 + 3) × π", "sqrt(16)".
    static func describe(_ toks: [Tok]) -> String {
        var out = ""
        var prev: Tok?
        var prevUnary = false
        func isFunc(_ t: Tok?) -> Bool { if case .id(let w)? = t { return funcs[w] != nil }; return false }
        for t in toks {
            var unaryMinus = false
            if case .op("-") = t {
                switch prev {
                case nil: unaryMinus = true
                case .op(let c)?: unaryMinus = c != ")" && c != "%"
                case .id(let w)?: unaryMinus = wordOps.contains(w) || funcs[w] != nil
                default: break
                }
            }
            let s: String
            switch t {
            case .num(_, let raw): s = raw
            case .id(let w): s = w == "pi" ? "π" : w == "x" ? "×" : w
            case .op(let c): s = c == "*" ? "×" : c == "/" ? "÷" : String(c)
            }
            var glue = prev == nil || prevUnary
            if case .op(let c) = t, c == ")" || c == "%" { glue = true }
            if case .op("(")? = prev { glue = true }
            if case .op("(") = t, isFunc(prev) { glue = true }
            out += (glue ? "" : " ") + s
            prev = t
            prevUnary = unaryMinus
        }
        return out
    }

    static func arithmetic(_ s: String) -> CalcAnswer? {
        if CalcRx.date.matches(s) || CalcRx.phones.contains(where: { $0.matches(s) }) { return nil }
        guard let toks = tokenize(s), !toks.isEmpty else { return nil }
        var parser = Parser(toks: toks)
        let v: Double
        do {
            let r = try parser.expr()
            if parser.p != toks.count { return nil }
            v = r.v
        } catch { return nil }
        if parser.ops == 0 || !v.isFinite { return nil }
        let x = v == 0 ? 0 : v
        guard let label = format(x, 10, true), let copy = format(x, 10, false), let value = Double(copy) else { return nil }
        return CalcAnswer(id: "calc:" + s, label: label, sub: describe(toks), value: value, copy: copy)
    }

    // -----------------------------------------------------------------------------------------
    // Units

    struct Unit: Sendable { let dim: String, f: Double, o: Double, sym: String, name: String, plural: String? }

    static let units: [String: Unit] = {
        var m: [String: Unit] = [:]
        func unit(_ dim: String, _ f: Double, _ o: Double, _ sym: String, _ name: String, _ keys: [String], _ plural: String? = nil) {
            let u = Unit(dim: dim, f: f, o: o, sym: sym, name: name, plural: plural)
            for k in keys { m[k] = u }
        }
        let FT = 0.3048, IN = 0.0254, MI = 1609.344, YD = 0.9144, LB = 0.45359237, GAL = 3.785411784
        // length (m)
        unit("length", 1, 0, "m", "meters", ["m", "meter", "meters", "metre", "metres"])
        unit("length", 1000, 0, "km", "kilometers", ["km", "kms", "kilometer", "kilometers", "kilometre", "kilometres"])
        unit("length", 0.01, 0, "cm", "centimeters", ["cm", "centimeter", "centimeters", "centimetre", "centimetres"])
        unit("length", 0.001, 0, "mm", "millimeters", ["mm", "millimeter", "millimeters", "millimetre", "millimetres"])
        unit("length", MI, 0, "mi", "miles", ["mi", "mile", "miles"])
        unit("length", YD, 0, "yd", "yards", ["yd", "yds", "yard", "yards"])
        unit("length", FT, 0, "ft", "feet", ["ft", "foot", "feet", "'"])
        unit("length", IN, 0, "in", "inches", ["in", "inch", "inches", "\""])
        unit("length", 1852, 0, "nmi", "nautical miles", ["nmi", "nautical mile", "nautical miles"])
        // mass (kg)
        unit("mass", 1, 0, "kg", "kilograms", ["kg", "kgs", "kilo", "kilos", "kilogram", "kilograms"])
        unit("mass", 0.001, 0, "g", "grams", ["g", "gram", "grams", "gramme", "grammes"])
        unit("mass", 1e-6, 0, "mg", "milligrams", ["mg", "milligram", "milligrams"])
        unit("mass", LB, 0, "lb", "pounds", ["lb", "lbs", "pound", "pounds"])
        unit("mass", LB / 16, 0, "oz", "ounces", ["oz", "ounce", "ounces"])
        unit("mass", LB * 14, 0, "st", "stone", ["st", "stone", "stones"])
        unit("mass", 1000, 0, "t", "tonnes", ["t", "tonne", "tonnes", "metric ton", "metric tons"])
        unit("mass", LB * 2000, 0, "ton", "short tons", ["ton", "tons", "short ton", "short tons"], "tons")
        // volume (L)
        unit("volume", 1, 0, "L", "liters", ["l", "liter", "liters", "litre", "litres"])
        unit("volume", 0.001, 0, "mL", "milliliters", ["ml", "milliliter", "milliliters", "millilitre", "millilitres"])
        unit("volume", 1000, 0, "m³", "cubic meters", ["m3", "cu m", "cubic meter", "cubic meters", "cubic metre", "cubic metres"])
        unit("volume", GAL, 0, "gal", "gallons", ["gal", "gals", "gallon", "gallons"])
        unit("volume", GAL / 4, 0, "qt", "quarts", ["qt", "qts", "quart", "quarts"])
        unit("volume", GAL / 8, 0, "pt", "pints", ["pt", "pts", "pint", "pints"])
        unit("volume", GAL / 16, 0, "cup", "cups", ["cup", "cups"], "cups")
        unit("volume", GAL / 128, 0, "fl oz", "fluid ounces", ["fl oz", "floz", "fluid ounce", "fluid ounces"])
        unit("volume", GAL / 256, 0, "tbsp", "tablespoons", ["tbsp", "tbs", "tablespoon", "tablespoons"])
        unit("volume", GAL / 768, 0, "tsp", "teaspoons", ["tsp", "teaspoon", "teaspoons"])
        // temperature (K), with offsets
        unit("temperature", 1, 273.15, "°C", "Celsius", ["c", "celsius", "centigrade", "degc"])
        unit("temperature", 5.0 / 9, 273.15 - 32 * 5.0 / 9, "°F", "Fahrenheit", ["f", "fahrenheit", "degf"])
        unit("temperature", 1, 0, "K", "kelvin", ["k", "kelvin", "kelvins"])
        // time (s)
        unit("time", 0.001, 0, "ms", "milliseconds", ["ms", "millisecond", "milliseconds"])
        unit("time", 1, 0, "s", "seconds", ["s", "sec", "secs", "second", "seconds"])
        unit("time", 60, 0, "min", "minutes", ["min", "mins", "minute", "minutes"])
        unit("time", 3600, 0, "h", "hours", ["h", "hr", "hrs", "hour", "hours"])
        unit("time", 86400, 0, "d", "days", ["d", "day", "days"])
        unit("time", 604800, 0, "wk", "weeks", ["wk", "wks", "week", "weeks"])
        unit("time", 31557600.0 / 12, 0, "mo", "months", ["mo", "month", "months"])
        unit("time", 31557600, 0, "yr", "years", ["yr", "yrs", "year", "years"])
        // data (byte); "b" is a byte, bits are spelled out
        unit("data", 1.0 / 8, 0, "bit", "bits", ["bit", "bits"], "bits")
        unit("data", 1, 0, "B", "bytes", ["b", "byte", "bytes"])
        let dec = [["kB", "kilobytes", "kb", "kilobyte"], ["MB", "megabytes", "mb", "megabyte"], ["GB", "gigabytes", "gb", "gigabyte"],
                   ["TB", "terabytes", "tb", "terabyte"], ["PB", "petabytes", "pb", "petabyte"]]
        for (i, d) in dec.enumerated() { unit("data", pow(1000, Double(i + 1)), 0, d[0], d[1], [d[2], d[3], d[3] + "s"]) }
        let bin = [["KiB", "kibibytes", "kib", "kibibyte"], ["MiB", "mebibytes", "mib", "mebibyte"], ["GiB", "gibibytes", "gib", "gibibyte"],
                   ["TiB", "tebibytes", "tib", "tebibyte"]]
        for (i, d) in bin.enumerated() { unit("data", pow(1024, Double(i + 1)), 0, d[0], d[1], [d[2], d[3], d[3] + "s"]) }
        // speed (m/s)
        unit("speed", 1, 0, "m/s", "meters per second", ["m/s", "mps", "meters per second", "metres per second"])
        unit("speed", 1000.0 / 3600, 0, "km/h", "kilometers per hour", ["km/h", "kmh", "kph", "kmph", "km/hr", "kilometers per hour", "kilometres per hour"])
        unit("speed", MI / 3600, 0, "mph", "miles per hour", ["mph", "mi/h", "miles per hour"])
        unit("speed", 1852.0 / 3600, 0, "kn", "knots", ["kn", "kt", "kts", "knot", "knots"])
        unit("speed", FT, 0, "ft/s", "feet per second", ["ft/s", "fps", "feet per second"])
        // area (m²)
        unit("area", 1, 0, "m²", "square meters", ["m2", "sq m", "sqm", "sq meter", "sq meters", "sq metre", "sq metres"])
        unit("area", 1e6, 0, "km²", "square kilometers", ["km2", "sq km", "sq kilometer", "sq kilometers", "sq kilometre", "sq kilometres"])
        unit("area", 1e-4, 0, "cm²", "square centimeters", ["cm2", "sq cm", "sq centimeter", "sq centimeters"])
        unit("area", FT * FT, 0, "ft²", "square feet", ["ft2", "sq ft", "sqft", "sq foot", "sq feet"])
        unit("area", IN * IN, 0, "in²", "square inches", ["in2", "sq in", "sq inch", "sq inches"])
        unit("area", YD * YD, 0, "yd²", "square yards", ["yd2", "sq yd", "sq yard", "sq yards"])
        unit("area", MI * MI, 0, "mi²", "square miles", ["mi2", "sq mi", "sq mile", "sq miles"])
        unit("area", 4046.8564224, 0, "acre", "acres", ["acre", "acres", "ac"], "acres")
        unit("area", 10000, 0, "ha", "hectares", ["ha", "hectare", "hectares"])
        return m
    }()

    static func lookupUnit(_ raw: String) -> Unit? {
        var k = raw.replacingOccurrences(of: "°", with: "").replacingOccurrences(of: "²", with: "2").replacingOccurrences(of: "³", with: "3")
        k = CalcRx.degrees.replace(k, "deg")
        k = CalcRx.square.replace(k, "sq ")
        k = CalcRx.sqDot.replace(k, "sq ")
        k = CalcRx.slash.replace(k, "/")
        k = k.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        if let u = units[k] { return u }
        if k.hasPrefix("deg"), let u = units[String(k.dropFirst(3))] { return u }
        return units[k.replacingOccurrences(of: " ", with: "")]
    }

    static let connectors: Set<String> = ["in", "to", "as", "=", "into"]

    /// QTY of calc.js: -?NUMBER (no exponent), optional spaces, then a non-empty rest.
    static func quantity(_ s: String) -> (Double, String)? {
        let c = Array(s)
        var i = 0
        if i < c.count, c[i] == "-" { i += 1 }
        guard let j = scanNumber(c, i, exponent: false) else { return nil }
        var k = j
        while k < c.count, c[k].isWhitespace { k += 1 }
        if k >= c.count { return nil }
        guard let n = Double(String(c[0..<j]).replacingOccurrences(of: ",", with: "")) else { return nil }
        return (n, String(c[k...]))
    }

    static func conversion(_ s: String) -> CalcAnswer? {
        let words = s.replacingOccurrences(of: "=", with: " = ").split(separator: " ").map(String.init)
        guard words.count >= 3 else { return nil }
        for i in 1..<(words.count - 1) {
            if !connectors.contains(words[i]) { continue }
            guard let (n, fromText) = quantity(words[0..<i].joined(separator: " ")) else { continue }
            guard let from = lookupUnit(fromText), let to = lookupUnit(words[(i + 1)...].joined(separator: " ")),
                  from.dim == to.dim else { continue }
            let base = n * from.f + from.o
            if from.dim == "temperature" && base < 0 { return nil }
            let v = (base - to.o) / to.f
            if !v.isFinite { return nil }
            let out = v == 0 || abs(v) < 1e-12 ? 0 : v
            guard let num = format(out, labelSig(out), true), let copy = format(out, 10, false), let value = Double(copy),
                  let nf = format(n, 10, true) else { return nil }
            let sym = to.plural != nil && value != 1 ? to.plural! : to.sym
            let fromSym = from.plural != nil && n != 1 ? from.plural! : from.sym
            return CalcAnswer(id: "calc:" + s, label: "\(num) \(sym)", sub: "\(nf) \(fromSym) in \(to.name)", value: value, copy: copy)
        }
        return nil
    }
}

/// A calc row: Enter copies (the app wires the action from copyText).
public func calcResult(_ q: Query) -> ResultItem? {
    guard let a = Calc.evaluate(q.text) else { return nil }
    return ResultItem(id: a.id, kind: "calc", title: a.label, subtitle: a.sub, icon: .symbol("equal.circle", .signal),
                      section: .answer, score: 1, copyText: a.copy, payload: ["copy": a.copy])
}

/// Regular expressions compiled once, for the rules that are clearer as patterns than as code.
struct CoreRegex: @unchecked Sendable {
    let rx: NSRegularExpression
    init(_ pattern: String) { rx = try! NSRegularExpression(pattern: pattern) }
    func matches(_ s: String) -> Bool { rx.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil }
    func replace(_ s: String, _ with: String) -> String {
        rx.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: NSRegularExpression.escapedTemplate(for: with))
    }
    func groups(_ s: String) -> [String?]? {
        guard let m = rx.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) else { return nil }
        return (0..<m.numberOfRanges).map { i in Range(m.range(at: i), in: s).map { String(s[$0]) } }
    }
}

private enum CalcRx {
    static let loneE = CoreRegex(#"\be\b"#)
    static let date = CoreRegex(#"^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})$"#)
    static let phones = [
        CoreRegex(#"^\+"#), // international numbers; a leading + is never how arithmetic starts here
        CoreRegex(#"^\(?\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}$"#),
        CoreRegex(#"^\d{3}[-.]\d{4}$"#),
        CoreRegex(#"^\d{1,4}(?:-\d{2,4}){2,}$"#),
    ]
    static let degrees = CoreRegex(#"\b(?:degrees?|deg)\s+"#)
    static let square = CoreRegex(#"\bsquare\s+"#)
    static let sqDot = CoreRegex(#"\bsq\.\s*"#)
    static let slash = CoreRegex(#"\s*/\s*"#)
}

fileprivate extension Character {
    var isASCIIDigit: Bool { self >= "0" && self <= "9" }
}
